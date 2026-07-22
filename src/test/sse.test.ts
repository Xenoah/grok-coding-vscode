import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseSSE,
  parseSSEJson,
  SSEParseError,
  type SSEMessage,
} from "../xai/sse";

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SSEMessage[]> {
  const messages: SSEMessage[] = [];
  for await (const message of parseSSE(stream)) {
    messages.push(message);
  }
  return messages;
}

function findSubsequence(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return index;
  }
  return -1;
}

test("parses CRLF events across arbitrary UTF-8 and line chunk boundaries", async () => {
  const encoder = new TextEncoder();
  const source =
    'data: {"type":"response.output_text.delta","delta":"🙂"}\r\n\r\n' +
    'data: {"type":"response.completed","response":{"id":"resp_1"}}\r\n\r\n';
  const bytes = encoder.encode(source);
  const emojiStart = findSubsequence(bytes, encoder.encode("🙂"));
  assert.notEqual(emojiStart, -1);

  const chunks = [
    bytes.slice(0, emojiStart + 1),
    bytes.slice(emojiStart + 1, emojiStart + 3),
    bytes.slice(emojiStart + 3, source.indexOf("\r\n") + 1),
    bytes.slice(source.indexOf("\r\n") + 1),
  ];

  const messages = await collect(byteStream(chunks));
  assert.equal(messages.length, 2);
  assert.deepEqual(parseSSEJson(messages[0]!), {
    type: "response.output_text.delta",
    delta: "🙂",
  });
  assert.deepEqual(parseSSEJson(messages[1]!), {
    type: "response.completed",
    response: { id: "resp_1" },
  });
});

test("joins data lines and preserves event metadata", async () => {
  const source = [
    ": heartbeat",
    "id: evt-42",
    "event: custom",
    "retry: 1500",
    "data: first line",
    "data: second line",
    "",
    "data: next event",
    "",
  ].join("\n");

  const messages = await collect(
    byteStream([new TextEncoder().encode(source)]),
  );

  assert.deepEqual(messages, [
    {
      event: "custom",
      data: "first line\nsecond line",
      id: "evt-42",
      retry: 1500,
    },
    {
      event: "message",
      data: "next event",
      id: "evt-42",
    },
  ]);
});

test("accepts lone CR delimiters and an event without a final blank line", async () => {
  const source = "data: one\r\rdata: two";
  const bytes = new TextEncoder().encode(source);
  const messages = await collect(
    byteStream([bytes.slice(0, 10), bytes.slice(10)]),
  );

  assert.deepEqual(
    messages.map((message) => message.data),
    ["one", "two"],
  );
});

test("exposes the Responses stream sentinel without trying to parse it", async () => {
  const messages = await collect(
    byteStream([new TextEncoder().encode("data: [DONE]\n\n")]),
  );

  assert.equal(messages[0]?.data, "[DONE]");
});

test("reports malformed JSON with the original SSE data", () => {
  const message: SSEMessage = {
    event: "message",
    data: '{"broken":',
  };

  assert.throws(
    () => parseSSEJson(message),
    (error: unknown) => {
      assert.ok(error instanceof SSEParseError);
      assert.equal(error.data, message.data);
      return true;
    },
  );
});

test("enforces line, event, and cumulative body byte limits and cancels", async () => {
  const encoder = new TextEncoder();
  const cases: Array<{
    name: string;
    chunks: Uint8Array[];
    limits: {
      maxLineBytes: number;
      maxEventBytes: number;
      maxBodyBytes: number;
    };
  }> = [
    {
      name: "line",
      chunks: [encoder.encode("data: 1234")],
      limits: { maxLineBytes: 8, maxEventBytes: 100, maxBodyBytes: 100 },
    },
    {
      name: "event",
      chunks: [encoder.encode("data: a\ndata: b\n")],
      limits: { maxLineBytes: 100, maxEventBytes: 12, maxBodyBytes: 100 },
    },
    {
      name: "body",
      chunks: [encoder.encode(":a\n\n"), encoder.encode(":bbbb\n\n")],
      limits: { maxLineBytes: 100, maxEventBytes: 100, maxBodyBytes: 8 },
    },
  ];

  for (const testCase of cases) {
    let cancelled = false;
    const never = new Promise<void>(() => {});
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of testCase.chunks) {
          controller.enqueue(chunk);
        }
      },
      cancel() {
        cancelled = true;
        return never;
      },
    });

    await assert.rejects(
      async () => {
        for await (const _message of parseSSE(
          stream,
          undefined,
          testCase.limits,
        )) {
          // No event should escape before these malformed bodies are rejected.
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof SSEParseError);
        assert.match(error.message, new RegExp(`SSE ${testCase.name} exceeded`));
        return true;
      },
    );
    assert.equal(cancelled, true, `${testCase.name} stream was not cancelled`);
  }
});

test("abort exits promptly even when reader.cancel never settles", async () => {
  let cancelled = false;
  const never = new Promise<void>(() => {});
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      return never;
    },
    cancel() {
      cancelled = true;
      return never;
    },
  });
  const controller = new AbortController();
  const reason = new DOMException("stop now", "AbortError");
  const generator = parseSSE(stream, controller.signal);
  const pendingRead = generator.next();
  controller.abort(reason);

  let timeout: NodeJS.Timeout | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("parseSSE waited for reader.cancel()")),
      250,
    );
  });
  try {
    await assert.rejects(
      Promise.race([pendingRead, timeoutFailure]),
      (error: unknown) => error === reason,
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
  assert.equal(cancelled, true);
});
