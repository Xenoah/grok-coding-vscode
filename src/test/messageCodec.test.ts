import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MessageCodecError,
  createToolNameAliasMap,
  decodeToolCall,
  decodeToolName,
  encodeChatRequestParts,
  encodeMessages,
  encodeToolResult,
  encodeToolName,
  encodeTools,
} from "../provider/messageCodec";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function dataUri(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

describe("tool name aliases", () => {
  it("preserves valid names and reverses deterministic aliases", () => {
    const names = [
      "read_file",
      "mcp.server/tool with spaces",
      "日本語のツール",
    ];
    const first = createToolNameAliasMap(names);
    const reordered = createToolNameAliasMap([...names].reverse());

    assert.equal(encodeToolName(first, "read_file"), "read_file");
    for (const name of names) {
      const alias = encodeToolName(first, name);
      assert.match(alias, /^[A-Za-z0-9_-]{1,64}$/);
      assert.equal(alias, encodeToolName(reordered, name));
      assert.equal(decodeToolName(first, alias), name);
    }
  });

  it("does not collide when readable forms are identical", () => {
    const aliases = createToolNameAliasMap(["server.one/read", "server one read"]);
    assert.notEqual(
      encodeToolName(aliases, "server.one/read"),
      encodeToolName(aliases, "server one read"),
    );
  });

  it("rejects duplicate and unknown tool names", () => {
    assert.throws(
      () => createToolNameAliasMap(["same", "same"]),
      MessageCodecError,
    );
    const aliases = createToolNameAliasMap(["known"]);
    assert.throws(() => decodeToolName(aliases, "unknown"), MessageCodecError);
  });
});

describe("tool conversion", () => {
  it("converts VS Code tools and supplies a default object schema", () => {
    const converted = encodeTools([
      {
        name: "mcp.files/read",
        description: "Read one file",
        inputSchema: { type: "object", required: ["path"] },
      },
      { name: "clock", description: "Get the time" },
    ]);

    assert.equal(converted.tools[0]?.type, "function");
    assert.equal(converted.tools[0]?.description, "Read one file");
    assert.deepEqual(converted.tools[0]?.parameters, {
      type: "object",
      required: ["path"],
    });
    assert.deepEqual(converted.tools[1]?.parameters, {
      type: "object",
      properties: {},
    });
  });

  it("decodes an xAI call back to the original VS Code tool", () => {
    const aliases = createToolNameAliasMap(["mcp.files/read"]);
    const alias = encodeToolName(aliases, "mcp.files/read");
    assert.deepEqual(
      decodeToolCall(
        {
          call_id: "call-1",
          name: alias,
          arguments: '{"path":"README.md"}',
        },
        aliases,
      ),
      {
        callId: "call-1",
        name: "mcp.files/read",
        input: { path: "README.md" },
      },
    );
  });

  it("aliases historical calls even when the tool is absent this turn", () => {
    const encoded = encodeChatRequestParts(
      [
        {
          role: "assistant",
          content: [
            {
              callId: "old-call",
              name: "old.server/tool",
              input: { value: 1 },
            },
          ],
        },
      ],
      [],
    );
    const alias = encodeToolName(encoded.aliases, "old.server/tool");
    assert.deepEqual(encoded.tools, []);
    assert.deepEqual(encoded.input, [
      {
        type: "function_call",
        call_id: "old-call",
        name: alias,
        arguments: '{"value":1}',
      },
    ]);
  });
});

describe("message conversion", () => {
  it("converts text and binary image parts to a user input message", () => {
    const aliases = createToolNameAliasMap([]);
    const input = encodeMessages(
      [
        {
          role: 1,
          content: [
            { value: "What is in this image?" },
            {
              value: PNG_BYTES,
              mimeType: "image/png",
            },
          ],
        },
      ],
      aliases,
    );

    assert.deepEqual(input, [
      {
        role: "user",
        content: [
          { type: "input_text", text: "What is in this image?" },
          {
            type: "input_image",
            image_url: dataUri("image/png", PNG_BYTES),
          },
        ],
      },
    ]);
  });

  it("preserves order across assistant calls and user tool results", () => {
    const aliases = createToolNameAliasMap(["workspace.read/file"]);
    const toolAlias = encodeToolName(aliases, "workspace.read/file");
    const input = encodeMessages(
      [
        {
          role: "assistant",
          content: [
            { value: "I will inspect it." },
            {
              callId: "call-7",
              name: "workspace.read/file",
              input: { path: "src/index.ts" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              callId: "call-7",
              content: [{ value: "const answer = 42;" }],
            },
          ],
        },
      ],
      aliases,
    );

    assert.deepEqual(input, [
      {
        role: "assistant",
        content: [{ type: "input_text", text: "I will inspect it." }],
      },
      {
        type: "function_call",
        call_id: "call-7",
        name: toolAlias,
        arguments: '{"path":"src/index.ts"}',
      },
      {
        type: "function_call_output",
        call_id: "call-7",
        output: "const answer = 42;",
      },
    ]);
  });

  it("accepts JPEG/PNG data URIs and rejects unsupported images and binary parts", () => {
    const aliases = createToolNameAliasMap([]);
    const jpegDataUri = dataUri("image/jpeg", JPEG_BYTES);
    const input = encodeMessages(
      [
        {
          role: "user",
          content: [{ imageUrl: jpegDataUri }],
        },
      ],
      aliases,
    );
    assert.deepEqual(input, [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: jpegDataUri },
        ],
      },
    ]);

    assert.throws(
      () =>
        encodeMessages(
          [
            {
              role: "user",
              content: [{ imageUrl: "data:image/gif;base64,R0lGODlh" }],
            },
          ],
          aliases,
        ),
      (error: unknown) => {
        assert.ok(error instanceof MessageCodecError);
        assert.match(error.message, /only JPEG and PNG.*image\/gif/i);
        return true;
      },
    );

    for (const unsupported of [
      { value: new Uint8Array([0x42, 0x4d, 0, 0]), mimeType: "image/bmp" },
      {
        value: new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
        ]),
        mimeType: "image/webp",
      },
    ]) {
      assert.throws(
        () =>
          encodeMessages(
            [{ role: "user", content: [unsupported] }],
            aliases,
          ),
        /only JPEG and PNG images/,
      );
    }

    assert.throws(
      () =>
        encodeMessages(
          [
            {
              role: "user",
              content: [
                { value: new Uint8Array([1, 2]), mimeType: "application/pdf" },
              ],
            },
          ],
          aliases,
        ),
      (error: unknown) => {
        assert.ok(error instanceof MessageCodecError);
        assert.match(error.message, /only JPEG and PNG images up to 20 MiB/i);
        return true;
      },
    );
  });

  it("rejects spoofed and oversized image bytes before creating data URIs", () => {
    const aliases = createToolNameAliasMap([]);
    assert.throws(
      () =>
        encodeMessages(
          [
            {
              role: "user",
              content: [{ value: JPEG_BYTES, mimeType: "image/png" }],
            },
          ],
          aliases,
        ),
      /does not match the detected image\/jpeg data/,
    );

    const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
    assert.throws(
      () =>
        encodeMessages(
          [
            {
              role: "user",
              content: [{ value: oversized, mimeType: "image/png" }],
            },
          ],
          aliases,
        ),
      /20 MiB or smaller/,
    );
  });

  it("attaches JPEG/PNG tool-result images after all parallel call outputs", () => {
    const aliases = createToolNameAliasMap(["capture"]);
    const input = encodeMessages(
      [
        {
          role: "assistant",
          content: [
            { callId: "call-1", name: "capture", input: { target: "one" } },
            { callId: "call-2", name: "capture", input: { target: "two" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              callId: "call-1",
              content: [{ value: "first screenshot" }, PNG_BYTES],
            },
            {
              callId: "call-2",
              content: [{ value: { data: JPEG_BYTES, mimeType: "image/jpeg" } }],
            },
          ],
        },
      ],
      aliases,
    );

    assert.deepEqual(input.slice(2), [
      {
        type: "function_call_output",
        call_id: "call-1",
        output:
          "first screenshot\n[Tool returned 1 JPEG/PNG image; attached immediately after this tool result.]",
      },
      {
        type: "function_call_output",
        call_id: "call-2",
        output:
          "[Tool returned 1 JPEG/PNG image; attached immediately after this tool result.]",
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "JPEG/PNG image output from tool call call-1:" },
          { type: "input_image", image_url: dataUri("image/png", PNG_BYTES) },
          { type: "input_text", text: "JPEG/PNG image output from tool call call-2:" },
          { type: "input_image", image_url: dataUri("image/jpeg", JPEG_BYTES) },
        ],
      },
    ]);
  });

  it("never serializes unsupported tool-result Uint8Array values as JSON", () => {
    const aliases = createToolNameAliasMap([]);
    assert.throws(
      () =>
        encodeMessages(
          [
            {
              role: "user",
              content: [{ callId: "call-1", content: [new Uint8Array([1, 2, 3])] }],
            },
          ],
          aliases,
        ),
      /not a valid JPEG or PNG image/,
    );

    assert.throws(
      () => encodeToolResult("call-1", { content: [PNG_BYTES] }),
      /must be encoded with encodeChatRequestParts/,
    );
  });
});
