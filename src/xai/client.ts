import { parseSSE, parseSSEJson, SSEParseError } from "./sse";
import type {
  XAIClientOptions,
  XAIErrorPayload,
  XAIFunctionCallOutput,
  XAIRawStreamEvent,
  XAIRequestOptions,
  XAIResponse,
  XAIResponseRequest,
  XAIStreamOptions,
  XAIStreamUpdate,
} from "./types";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const ENCRYPTED_REASONING_INCLUDE = "reasoning.encrypted_content";
const MAX_HTTP_ERROR_BODY_BYTES = 1024 * 1024;
const MAX_JSON_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 1024 * 1024;
const MAX_ENCRYPTED_REASONING_BYTES = 4 * 1024 * 1024;
const MAX_CALL_ID_BYTES = 1024;

export type XAIClientErrorKind = "http" | "api" | "protocol";

export interface XAIClientErrorDetails {
  kind: XAIClientErrorKind;
  status?: number;
  statusText?: string;
  code?: string | number | null;
  type?: string;
  param?: string | null;
  requestId?: string;
  body?: unknown;
}

/** An HTTP, xAI API, or wire-protocol error with UI-friendly metadata. */
export class XAIClientError extends Error {
  readonly kind: XAIClientErrorKind;
  readonly status?: number;
  readonly statusText?: string;
  readonly code?: string | number | null;
  readonly type?: string;
  readonly param?: string | null;
  readonly requestId?: string;
  readonly body?: unknown;

  constructor(message: string, details: XAIClientErrorDetails) {
    super(message);
    this.name = "XAIClientError";
    this.kind = details.kind;
    this.status = details.status;
    this.statusText = details.statusText;
    this.code = details.code;
    this.type = details.type;
    this.param = details.param;
    this.requestId = details.requestId;
    this.body = details.body;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalCode(value: unknown): string | number | null | undefined {
  return typeof value === "string" || typeof value === "number" || value === null
    ? value
    : undefined;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function protocolError(message: string, body?: unknown): XAIClientError {
  return new XAIClientError(message, { kind: "protocol", body });
}

function validateCallId(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw protocolError(`${context} contained an empty or invalid call_id`);
  }
  if (byteLength(value) > MAX_CALL_ID_BYTES) {
    throw protocolError(
      `${context} call_id exceeded the ${MAX_CALL_ID_BYTES}-byte protocol limit`,
    );
  }
}

function validateOutputItem(value: unknown, context: string): void {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw protocolError(`${context} contained an invalid output item`, value);
  }

  if (value.type === "function_call") {
    validateCallId(value.call_id, context);
    if (typeof value.name !== "string" || value.name.trim().length === 0) {
      throw protocolError(`${context} contained an invalid function name`);
    }
    if (typeof value.arguments !== "string") {
      throw protocolError(`${context} contained non-string tool arguments`);
    }
    if (byteLength(value.arguments) > MAX_TOOL_ARGUMENT_BYTES) {
      throw protocolError(
        `${context} tool arguments exceeded the ${MAX_TOOL_ARGUMENT_BYTES}-byte protocol limit`,
      );
    }
    return;
  }

  if (value.type === "reasoning" && value.encrypted_content !== undefined) {
    if (typeof value.encrypted_content !== "string") {
      throw protocolError(
        `${context} contained invalid encrypted reasoning content`,
      );
    }
    if (byteLength(value.encrypted_content) > MAX_ENCRYPTED_REASONING_BYTES) {
      throw protocolError(
        `${context} encrypted reasoning exceeded the ${MAX_ENCRYPTED_REASONING_BYTES}-byte protocol limit`,
      );
    }
  }
}

function extractErrorPayload(value: unknown): XAIErrorPayload {
  if (!isRecord(value)) {
    return {};
  }

  const nested = isRecord(value.error) ? value.error : value;
  return {
    ...nested,
    message: optionalString(nested.message),
    type: optionalString(nested.type),
    code: optionalCode(nested.code),
    param:
      typeof nested.param === "string" || nested.param === null
        ? nested.param
        : undefined,
  };
}

function requireResponse(value: unknown, context: string): XAIResponse {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.object !== "string" ||
    typeof value.status !== "string" ||
    !Array.isArray(value.output)
  ) {
    throw new XAIClientError(`xAI returned an invalid ${context} response`, {
      kind: "protocol",
      body: value,
    });
  }

  for (const [index, item] of value.output.entries()) {
    validateOutputItem(item, `${context} response output[${index}]`);
  }

  return value as unknown as XAIResponse;
}

function requireStreamEvent(value: unknown): XAIRawStreamEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new XAIClientError("xAI returned an invalid Responses stream event", {
      kind: "protocol",
      body: value,
    });
  }

  return value as XAIRawStreamEvent;
}

function functionCallFromEvent(
  event: XAIRawStreamEvent,
): XAIFunctionCallOutput | undefined {
  if (event.type !== "response.output_item.done") {
    return undefined;
  }

  validateOutputItem(event.item, "response.output_item.done");
  const item = event.item as Record<string, unknown>;

  if (item.type !== "function_call") {
    return undefined;
  }

  return item as unknown as XAIFunctionCallOutput;
}

function incompleteResponseError(
  response: XAIResponse,
  status?: number,
): XAIClientError {
  const details = isRecord(response.incomplete_details)
    ? response.incomplete_details
    : undefined;
  const reason = details ? optionalString(details.reason) : undefined;
  return new XAIClientError(
    reason ? `xAI response was incomplete: ${reason}` : "xAI response was incomplete",
    { kind: "api", status, body: response },
  );
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  const error = new Error("The xAI request was aborted");
  error.name = "AbortError";
  throw error;
}

function requestAbortReason(signal: AbortSignal): unknown {
  try {
    abortIfRequested(signal);
  } catch (error) {
    return error;
  }
  return new Error("The xAI request was aborted");
}

function readBodyChunkWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  cancel: (reason: unknown) => void,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) {
    return reader.read();
  }
  if (signal.aborted) {
    const reason = requestAbortReason(signal);
    cancel(reason);
    return Promise.reject(reason);
  }

  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      const reason = requestAbortReason(signal);
      cancel(reason);
      finish(() => reject(reason));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Dependency-free xAI Responses API client for a VS Code extension host.
 *
 * It intentionally uses global fetch rather than an SDK. Requests default to
 * store:false and include encrypted reasoning so agent state can remain local.
 */
export class XAIClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultStore: boolean;
  private readonly includeEncryptedReasoning: boolean;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: XAIClientOptions) {
    if (!options.apiKey.trim()) {
      throw new TypeError("XAIClient requires a non-empty apiKey");
    }

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new TypeError(
        "This runtime does not provide fetch; pass a fetch implementation to XAIClient",
      );
    }

    const baseUrl = trimTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
    if (!baseUrl) {
      throw new TypeError("XAIClient requires a non-empty baseUrl");
    }

    this.apiKey = options.apiKey;
    this.baseUrl = baseUrl;
    this.defaultStore = options.defaultStore ?? false;
    this.includeEncryptedReasoning =
      options.includeEncryptedReasoning ?? true;
    this.fetchImpl = fetchImpl.bind(globalThis);
    this.extraHeaders = { ...(options.headers ?? {}) };
  }

  /** Create a non-streaming response. */
  async createResponse(
    request: XAIResponseRequest,
    options: XAIRequestOptions = {},
  ): Promise<XAIResponse> {
    abortIfRequested(options.signal);
    const response = await this.post(
      this.buildRequest(request, false),
      "application/json",
      options.signal,
    );

    const value = await this.readJsonResponse(response, options.signal);
    const result = requireResponse(value, "JSON");
    if (result.status === "failed") {
      throw this.apiError(result.error ?? result, response.status);
    }
    if (result.status === "incomplete") {
      throw incompleteResponseError(result, response.status);
    }
    if (result.status !== "completed") {
      throw protocolError(
        `xAI returned a non-terminal JSON response status: ${result.status}`,
        result,
      );
    }
    return result;
  }

  /**
   * Low-level streaming API. Each yielded update is normalized, while unknown
   * xAI events remain available as kind:"event". The generator's return value
   * is the final response object.
   */
  async *iterateResponse(
    request: XAIResponseRequest,
    options: XAIRequestOptions = {},
  ): AsyncGenerator<XAIStreamUpdate, XAIResponse, void> {
    abortIfRequested(options.signal);
    const response = await this.post(
      this.buildRequest(request, true),
      "text/event-stream",
      options.signal,
    );

    if (!response.body) {
      throw new XAIClientError("xAI returned an empty SSE response body", {
        kind: "protocol",
        status: response.status,
        requestId: this.requestId(response),
      });
    }

    let finalResponse: XAIResponse | undefined;
    const bufferedFunctionCalls: Array<{
      call: XAIFunctionCallOutput;
      event: XAIRawStreamEvent;
    }> = [];

    try {
      for await (const message of parseSSE(response.body, options.signal)) {
        abortIfRequested(options.signal);

        if (message.data.trim() === "[DONE]") {
          break;
        }

        const event = requireStreamEvent(parseSSEJson(message));

        if (event.type === "error" || event.type === "response.failed") {
          const source =
            event.type === "response.failed" && isRecord(event.response)
              ? event.response.error ?? event.response
              : event.error ?? event;
          throw this.apiError(source, response.status);
        }

        if (
          event.type === "response.output_text.delta" ||
          event.type === "response.text.delta"
        ) {
          if (typeof event.delta !== "string") {
            throw new XAIClientError(
              `${event.type} did not contain a string delta`,
              { kind: "protocol", body: event },
            );
          }
          yield { kind: "text_delta", delta: event.delta, event };
          continue;
        }

        const functionCall = functionCallFromEvent(event);
        if (functionCall) {
          // A later response.incomplete event invalidates otherwise-complete
          // output items. Hold tool calls until terminal completion so a
          // partial call can never escape to VS Code for execution.
          bufferedFunctionCalls.push({ call: functionCall, event });
          continue;
        }

        if (
          event.type === "response.completed" ||
          event.type === "response.incomplete" ||
          event.type === "response.done"
        ) {
          const completedResponse = requireResponse(
            event.response,
            "stream completion",
          );
          if (
            event.type === "response.incomplete" ||
            completedResponse.status === "incomplete"
          ) {
            throw incompleteResponseError(completedResponse, response.status);
          }
          if (completedResponse.status === "failed") {
            throw this.apiError(
              completedResponse.error ?? completedResponse,
              response.status,
            );
          }
          if (completedResponse.status !== "completed") {
            throw protocolError(
              `xAI returned a non-terminal stream completion status: ${completedResponse.status}`,
              completedResponse,
            );
          }

          finalResponse = completedResponse;
          for (const buffered of bufferedFunctionCalls) {
            yield {
              kind: "function_call",
              call: buffered.call,
              event: buffered.event,
            };
          }
          bufferedFunctionCalls.length = 0;
          yield { kind: "response", response: finalResponse, event };
          // response.completed/response.done are terminal. Do not wait for a
          // proxy to close the connection or send an optional [DONE] marker.
          break;
        }

        yield { kind: "event", event };
      }
    } catch (error) {
      if (error instanceof SSEParseError) {
        throw new XAIClientError(error.message, {
          kind: "protocol",
          body: error.data,
        });
      }
      throw error;
    }

    abortIfRequested(options.signal);
    if (!finalResponse) {
      throw new XAIClientError(
        "xAI closed the SSE stream before returning a final response",
        { kind: "protocol" },
      );
    }

    return finalResponse;
  }

  /**
   * Convenient streaming API for UI code: callbacks receive deltas/events and
   * the Promise resolves to the final Responses API object.
   */
  async streamResponse(
    request: XAIResponseRequest,
    options: XAIStreamOptions = {},
  ): Promise<XAIResponse> {
    let finalResponse: XAIResponse | undefined;

    // for-await automatically closes/cancels the underlying body when a
    // callback throws, avoiding a leaked HTTP stream.
    for await (const update of this.iterateResponse(request, {
      signal: options.signal,
    })) {
      await options.onEvent?.(update);
      if (update.kind === "text_delta") {
        await options.onTextDelta?.(update.delta, update.event);
      } else if (update.kind === "response") {
        finalResponse = update.response;
      }
    }

    if (!finalResponse) {
      // iterateResponse already guards this; keep the public contract explicit.
      throw new XAIClientError(
        "xAI stream completed without a final response object",
        { kind: "protocol" },
      );
    }

    return finalResponse;
  }

  private buildRequest(
    request: XAIResponseRequest,
    stream: boolean,
  ): XAIResponseRequest {
    const include = [...(request.include ?? [])];
    if (
      this.includeEncryptedReasoning &&
      !include.includes(ENCRYPTED_REASONING_INCLUDE)
    ) {
      include.push(ENCRYPTED_REASONING_INCLUDE);
    }

    const result: XAIResponseRequest = {
      ...request,
      store: request.store ?? this.defaultStore,
      stream,
    };

    if (include.length > 0) {
      result.include = include;
    }

    return result;
  }

  private async post(
    body: XAIResponseRequest,
    accept: string,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          ...this.extraHeaders,
          Accept: accept,
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // Preserve native AbortError/AbortSignal reasons for callers.
      abortIfRequested(signal);
      throw error;
    }

    if (!response.ok) {
      throw await this.httpError(response, signal);
    }

    return response;
  }

  private async readResponseText(
    response: Response,
    maxBytes: number,
    label: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (!response.body) {
      return "";
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const textChunks: string[] = [];
    let totalBytes = 0;
    let reachedEnd = false;
    let cancelRequested = false;

    const cancelReader = (reason?: unknown): void => {
      if (cancelRequested) {
        return;
      }
      cancelRequested = true;
      void reader.cancel(reason).catch(() => {
        // Cancellation can reject for an already-failed network body.
      });
    };

    try {
      while (true) {
        const result = await readBodyChunkWithAbort(
          reader,
          signal,
          cancelReader,
        );
        if (result.done) {
          reachedEnd = true;
          textChunks.push(decoder.decode());
          return textChunks.join("");
        }
        if (result.value.byteLength > maxBytes - totalBytes) {
          const error = new XAIClientError(
            `xAI ${label} body exceeded the ${maxBytes}-byte protocol limit`,
            {
              kind: "protocol",
              status: response.status,
              statusText: response.statusText,
              requestId: this.requestId(response),
            },
          );
          cancelReader(error);
          throw error;
        }
        totalBytes += result.value.byteLength;
        textChunks.push(decoder.decode(result.value, { stream: true }));
      }
    } finally {
      if (!reachedEnd) {
        cancelReader();
      }
      try {
        reader.releaseLock();
      } catch {
        // Never mask the bounded-body/abort error with a lock error.
      }
    }
  }

  private async readJsonResponse(
    response: Response,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const text = await this.readResponseText(
      response,
      MAX_JSON_RESPONSE_BODY_BYTES,
      "JSON response",
      signal,
    );
    if (!text.trim()) {
      throw new XAIClientError("xAI returned an empty JSON response body", {
        kind: "protocol",
        status: response.status,
        requestId: this.requestId(response),
      });
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new XAIClientError("xAI returned invalid JSON", {
        kind: "protocol",
        status: response.status,
        requestId: this.requestId(response),
        body: text,
      });
    }
  }

  private async httpError(
    response: Response,
    signal: AbortSignal | undefined,
  ): Promise<XAIClientError> {
    const text = await this.readResponseText(
      response,
      MAX_HTTP_ERROR_BODY_BYTES,
      "HTTP error",
      signal,
    );
    let body: unknown = text;
    if (text.trim()) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        // Retain a non-JSON proxy/server error as text.
      }
    }

    const payload = extractErrorPayload(body);
    const fallback = `${response.status} ${response.statusText}`.trim();
    const message = payload.message || fallback || "Unknown xAI API error";

    return new XAIClientError(
      `xAI API request failed (${response.status}): ${message}`,
      {
        kind: "http",
        status: response.status,
        statusText: response.statusText,
        code: payload.code,
        type: payload.type,
        param: payload.param,
        requestId: this.requestId(response),
        body,
      },
    );
  }

  private apiError(value: unknown, status?: number): XAIClientError {
    const payload = extractErrorPayload(value);
    return new XAIClientError(payload.message || "xAI API generation failed", {
      kind: "api",
      status,
      code: payload.code,
      type: payload.type,
      param: payload.param,
      body: value,
    });
  }

  private requestId(response: Response): string | undefined {
    return (
      response.headers.get("x-request-id") ??
      response.headers.get("request-id") ??
      undefined
    );
  }
}
