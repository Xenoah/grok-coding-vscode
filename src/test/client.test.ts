import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { XAIClient, XAIClientError } from '../xai/client';
import type { XAIStreamUpdate } from '../xai/types';

function sseResponse(events: readonly unknown[]): Response {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-test' }
  });
}

describe('XAIClient', () => {
  it('streams text and tool calls with privacy-first request defaults', async () => {
    let sentUrl = '';
    let sentInit: RequestInit | undefined;
    const finalResponse = {
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"README.md"}'
        }
      ]
    };
    const fetchMock: typeof fetch = async (input, init) => {
      sentUrl = String(input);
      sentInit = init;
      return sseResponse([
        { type: 'response.output_text.delta', delta: '確認します。' },
        {
          type: 'response.output_item.done',
          item: finalResponse.output[0]
        },
        { type: 'response.completed', response: finalResponse }
      ]);
    };
    const updates: XAIStreamUpdate[] = [];
    let text = '';

    const client = new XAIClient({ apiKey: 'xai-test-secret-key', fetch: fetchMock });
    const response = await client.streamResponse(
      {
        model: 'grok-4.5',
        input: [{ role: 'user', content: 'READMEを確認して' }]
      },
      {
        onEvent(update) {
          updates.push(update);
        },
        onTextDelta(delta) {
          text += delta;
        }
      }
    );

    assert.equal(sentUrl, 'https://api.x.ai/v1/responses');
    assert.equal(sentInit?.method, 'POST');
    const body = JSON.parse(String(sentInit?.body)) as Record<string, unknown>;
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    assert.equal(text, '確認します。');
    assert.equal(updates.some(update => update.kind === 'function_call'), true);
    assert.deepEqual(response, finalResponse);

    const headers = sentInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer xai-test-secret-key');
  });

  it('returns structured HTTP errors without putting the API key in the message', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(
        JSON.stringify({ error: { message: 'Invalid API key', code: 'bad_key' } }),
        { status: 401, statusText: 'Unauthorized' }
      );
    const client = new XAIClient({ apiKey: 'xai-never-show-this', fetch: fetchMock });

    await assert.rejects(
      () => client.createResponse({ model: 'grok-4.5', input: 'hello' }),
      (error: unknown) => {
        assert.ok(error instanceof XAIClientError);
        assert.equal(error.kind, 'http');
        assert.equal(error.status, 401);
        assert.equal(error.code, 'bad_key');
        assert.doesNotMatch(error.message, /xai-never-show-this/);
        return true;
      }
    );
  });

  it('honors an already-cancelled AbortSignal before network access', async () => {
    let called = false;
    const fetchMock: typeof fetch = async () => {
      called = true;
      throw new Error('must not run');
    };
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    const client = new XAIClient({ apiKey: 'xai-test-secret-key', fetch: fetchMock });

    await assert.rejects(
      () =>
        client.createResponse(
          { model: 'grok-4.5', input: 'hello' },
          { signal: controller.signal }
        ),
      /cancelled/
    );
    assert.equal(called, false);
  });

  it('bounds and cancels an oversized non-SSE HTTP error body', async () => {
    let cancelled = false;
    const never = new Promise<void>(() => {});
    const oversized = new Uint8Array(1024 * 1024 + 1).fill(0x61);
    const fetchMock: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(oversized);
          },
          cancel() {
            cancelled = true;
            return never;
          }
        }),
        { status: 502, statusText: 'Bad Gateway' }
      );
    const client = new XAIClient({ apiKey: 'xai-test-secret-key', fetch: fetchMock });

    await assert.rejects(
      () => client.createResponse({ model: 'grok-4.5', input: 'hello' }),
      (error: unknown) => {
        assert.ok(error instanceof XAIClientError);
        assert.equal(error.kind, 'protocol');
        assert.equal(error.status, 502);
        assert.match(error.message, /HTTP error body exceeded/);
        return true;
      }
    );
    assert.equal(cancelled, true);
  });

  it('bounds and cancels an oversized successful JSON body', async () => {
    let cancelled = false;
    const never = new Promise<void>(() => {});
    const oversized = new Uint8Array(16 * 1024 * 1024 + 1).fill(0x61);
    const fetchMock: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(oversized);
          },
          cancel() {
            cancelled = true;
            return never;
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    const client = new XAIClient({ apiKey: 'xai-test-secret-key', fetch: fetchMock });

    await assert.rejects(
      () => client.createResponse({ model: 'grok-4.5', input: 'hello' }),
      (error: unknown) => {
        assert.ok(error instanceof XAIClientError);
        assert.equal(error.kind, 'protocol');
        assert.match(error.message, /JSON response body exceeded/);
        return true;
      }
    );
    assert.equal(cancelled, true);
  });

  it('aborts a pending JSON body without waiting for cancel to settle', async () => {
    let cancelled = false;
    const never = new Promise<void>(() => {});
    const fetchMock: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            return never;
          },
          cancel() {
            cancelled = true;
            return never;
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    const controller = new AbortController();
    const reason = new DOMException('stop JSON read', 'AbortError');
    const client = new XAIClient({ apiKey: 'xai-test-secret-key', fetch: fetchMock });
    const pending = client.createResponse(
      { model: 'grok-4.5', input: 'hello' },
      { signal: controller.signal }
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort(reason);

    let timeout: NodeJS.Timeout | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('JSON reader waited for cancel()')),
        250
      );
    });
    try {
      await assert.rejects(
        Promise.race([pending, timeoutFailure]),
        (error: unknown) => error === reason
      );
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
    assert.equal(cancelled, true);
  });

  it('rejects empty and oversized tool call IDs as protocol errors', async () => {
    for (const callId of ['', 'x'.repeat(1025)]) {
      const fetchMock: typeof fetch = async () =>
        sseResponse([
          {
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id: callId,
              name: 'read_file',
              arguments: '{}'
            }
          }
        ]);
      const client = new XAIClient({ apiKey: 'xai-test-secret-key', fetch: fetchMock });

      await assert.rejects(
        () => client.streamResponse({ model: 'grok-4.5', input: 'hello' }),
        (error: unknown) => {
          assert.ok(error instanceof XAIClientError);
          assert.equal(error.kind, 'protocol');
          assert.match(error.message, /call_id/);
          return true;
        }
      );
    }
  });

  it('rejects oversized tool arguments and encrypted reasoning', async () => {
    const cases = [
      {
        item: {
          type: 'function_call',
          call_id: 'call_oversized',
          name: 'tool',
          arguments: 'x'.repeat(1024 * 1024 + 1)
        },
        message: /tool arguments exceeded/
      },
      {
        item: {
          type: 'reasoning',
          encrypted_content: 'x'.repeat(4 * 1024 * 1024 + 1)
        },
        message: /encrypted reasoning exceeded/
      }
    ];

    for (const testCase of cases) {
      const fetchMock: typeof fetch = async () =>
        sseResponse([
          { type: 'response.output_item.done', item: testCase.item }
        ]);
      const client = new XAIClient({ apiKey: 'xai-test-secret-key', fetch: fetchMock });

      await assert.rejects(
        () => client.streamResponse({ model: 'grok-4.5', input: 'hello' }),
        (error: unknown) => {
          assert.ok(error instanceof XAIClientError);
          assert.equal(error.kind, 'protocol');
          assert.match(error.message, testCase.message);
          return true;
        }
      );
    }
  });

  it('does not yield buffered tool calls when the response is incomplete', async () => {
    const call = {
      type: 'function_call',
      call_id: 'call_partial',
      name: 'write_file',
      arguments: '{"path":"partial.txt"}'
    };
    const incompleteResponse = {
      id: 'resp_incomplete',
      object: 'response',
      status: 'incomplete',
      output: [call],
      incomplete_details: { reason: 'max_output_tokens' }
    };
    const fetchMock: typeof fetch = async () =>
      sseResponse([
        { type: 'response.output_text.delta', delta: 'partial text' },
        { type: 'response.output_item.done', item: call },
        { type: 'response.incomplete', response: incompleteResponse }
      ]);
    const updates: XAIStreamUpdate[] = [];
    const client = new XAIClient({ apiKey: 'xai-test-secret-key', fetch: fetchMock });

    await assert.rejects(
      () =>
        client.streamResponse(
          { model: 'grok-4.5', input: 'hello' },
          {
            onEvent(update) {
              updates.push(update);
            }
          }
        ),
      (error: unknown) => {
        assert.ok(error instanceof XAIClientError);
        assert.equal(error.kind, 'api');
        assert.match(error.message, /incomplete.*max_output_tokens/);
        return true;
      }
    );
    assert.equal(updates.some(update => update.kind === 'text_delta'), true);
    assert.equal(updates.some(update => update.kind === 'function_call'), false);
    assert.equal(updates.some(update => update.kind === 'response'), false);
  });

  it('stops and cancels immediately after a terminal completion event', async () => {
    const completedResponse = {
      id: 'resp_terminal',
      object: 'response',
      status: 'completed',
      output: []
    };
    const body = new TextEncoder().encode(
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: completedResponse
      })}\n\n`
    );
    let cancelled = false;
    const never = new Promise<void>(() => {});
    const fetchMock: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body);
          },
          cancel() {
            cancelled = true;
            return never;
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    const client = new XAIClient({ apiKey: 'xai-test-secret-key', fetch: fetchMock });

    let timeout: NodeJS.Timeout | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('client waited past response.completed')),
        250
      );
    });
    try {
      const response = await Promise.race([
        client.streamResponse({ model: 'grok-4.5', input: 'hello' }),
        timeoutFailure
      ]);
      assert.deepEqual(response, completedResponse);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
    assert.equal(cancelled, true);
  });

  it('rejects an incomplete non-streaming response', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: 'resp_incomplete',
          object: 'response',
          status: 'incomplete',
          output: [],
          incomplete_details: { reason: 'max_output_tokens' }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    const client = new XAIClient({ apiKey: 'xai-test-secret-key', fetch: fetchMock });

    await assert.rejects(
      () => client.createResponse({ model: 'grok-4.5', input: 'hello' }),
      (error: unknown) => {
        assert.ok(error instanceof XAIClientError);
        assert.equal(error.kind, 'api');
        assert.match(error.message, /incomplete/);
        return true;
      }
    );
  });

  it('rejects non-terminal statuses at completion boundaries', async () => {
    const inProgress = {
      id: 'resp_in_progress',
      object: 'response',
      status: 'in_progress',
      output: []
    };
    const streaming = new XAIClient({
      apiKey: 'xai-test-secret-key',
      fetch: async () =>
        sseResponse([{ type: 'response.completed', response: inProgress }])
    });
    await assert.rejects(
      () => streaming.streamResponse({ model: 'grok-4.5', input: 'hello' }),
      /non-terminal stream completion status/
    );

    const nonStreaming = new XAIClient({
      apiKey: 'xai-test-secret-key',
      fetch: async () => new Response(JSON.stringify(inProgress), { status: 200 })
    });
    await assert.rejects(
      () => nonStreaming.createResponse({ model: 'grok-4.5', input: 'hello' }),
      /non-terminal JSON response status/
    );
  });
});
