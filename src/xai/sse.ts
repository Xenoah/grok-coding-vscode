/** A fully assembled Server-Sent Event. */
export interface SSEMessage {
  /** The SSE event field, or "message" when it was omitted. */
  event: string;
  /** Multiple data fields are joined with a single newline. */
  data: string;
  id?: string;
  retry?: number;
}

export class SSEParseError extends Error {
  readonly data: string;

  constructor(message: string, data: string) {
    super(message);
    this.name = "SSEParseError";
    this.data = data;
  }
}

interface PendingEvent {
  event?: string;
  data: string[];
  hasData: boolean;
  retry?: number;
  byteLength: number;
}

interface LineResult {
  line: string;
  rest: string;
  delimiterBytes: number;
}

/**
 * Extract one SSE line while preserving a trailing CR until the next chunk.
 * This handles LF, CRLF and lone CR line endings, including split CRLF pairs.
 */
function takeLine(buffer: string, endOfStream: boolean): LineResult | undefined {
  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer.charCodeAt(index);

    if (character === 0x0a) {
      return {
        line: buffer.slice(0, index),
        rest: buffer.slice(index + 1),
        delimiterBytes: 1,
      };
    }

    if (character === 0x0d) {
      if (index + 1 === buffer.length && !endOfStream) {
        return undefined;
      }

      const hasLineFeed = buffer.charCodeAt(index + 1) === 0x0a;
      return {
        line: buffer.slice(0, index),
        rest: buffer.slice(index + (hasLineFeed ? 2 : 1)),
        delimiterBytes: hasLineFeed ? 2 : 1,
      };
    }
  }

  if (endOfStream && buffer.length > 0) {
    return { line: buffer, rest: "", delimiterBytes: 0 };
  }

  return undefined;
}

function newPendingEvent(): PendingEvent {
  return { data: [], hasData: false, byteLength: 0 };
}

function parseRetry(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }

  const retry = Number(value);
  return Number.isSafeInteger(retry) ? retry : undefined;
}

/** Defensive wire limits for a single xAI streaming response. */
export interface SSEParseLimits {
  /** Maximum UTF-8 bytes before a line delimiter. */
  maxLineBytes: number;
  /** Maximum UTF-8 bytes between event delimiters. */
  maxEventBytes: number;
  /** Maximum raw bytes read from the complete HTTP body. */
  maxBodyBytes: number;
}

export const DEFAULT_SSE_PARSE_LIMITS: Readonly<SSEParseLimits> = Object.freeze({
  maxLineBytes: 8 * 1024 * 1024,
  maxEventBytes: 8 * 1024 * 1024,
  maxBodyBytes: 64 * 1024 * 1024,
});

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validatedLimits(overrides: Partial<SSEParseLimits>): SSEParseLimits {
  const result = { ...DEFAULT_SSE_PARSE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  return result;
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) {
    return signal.reason;
  }

  const error = new Error("The SSE stream was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  cancel: (reason: unknown) => void,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) {
    return reader.read();
  }
  if (signal.aborted) {
    const reason = abortReason(signal);
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
      const reason = abortReason(signal);
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

/**
 * Parse an SSE byte stream without relying on EventSource (which cannot attach
 * the xAI Authorization header). UTF-8 and line boundaries may occur anywhere.
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  limitOverrides: Partial<SSEParseLimits> = {},
): AsyncGenerator<SSEMessage, void, void> {
  const limits = validatedLimits(limitOverrides);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bufferBytes = 0;
  let pending = newPendingEvent();
  let lastEventId: string | undefined;
  let reachedEnd = false;
  let totalBytes = 0;
  let cancelRequested = false;
  let cancellationReason: unknown;

  // Cancellation is deliberately fire-and-forget. A hostile/broken stream can
  // return a never-settling promise from cancel(); abort and protocol failures
  // must still reach the caller immediately.
  const cancelReader = (reason: unknown): void => {
    cancellationReason = reason;
    if (cancelRequested) {
      return;
    }
    cancelRequested = true;
    void reader.cancel(reason).catch(() => {
      // A broken/aborted network stream may also reject cancellation.
    });
  };

  const limitError = (scope: string, limit: number): SSEParseError =>
    new SSEParseError(
      `xAI SSE ${scope} exceeded the ${limit}-byte protocol limit`,
      "",
    );

  const processLine = (
    line: string,
    lineBytes = byteLength(line),
    delimiterBytes = 1,
  ): SSEMessage | undefined => {
    if (line === "") {
      if (!pending.hasData) {
        pending = newPendingEvent();
        return undefined;
      }

      const message: SSEMessage = {
        event: pending.event || "message",
        data: pending.data.join("\n"),
      };
      if (lastEventId !== undefined) {
        message.id = lastEventId;
      }
      if (pending.retry !== undefined) {
        message.retry = pending.retry;
      }

      pending = newPendingEvent();
      return message;
    }

    if (lineBytes > limits.maxLineBytes) {
      throw limitError("line", limits.maxLineBytes);
    }
    if (
      lineBytes + delimiterBytes >
      limits.maxEventBytes - pending.byteLength
    ) {
      throw limitError("event", limits.maxEventBytes);
    }
    pending.byteLength += lineBytes + delimiterBytes;

    // Comments/keep-alives have no effect on the current event.
    if (line.startsWith(":")) {
      return undefined;
    }

    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    switch (field) {
      case "event":
        pending.event = value;
        break;
      case "data":
        pending.data.push(value);
        pending.hasData = true;
        break;
      case "id":
        // Per the SSE spec, IDs containing NUL are ignored.
        if (!value.includes("\0")) {
          lastEventId = value;
        }
        break;
      case "retry": {
        const retry = parseRetry(value);
        if (retry !== undefined) {
          pending.retry = retry;
        }
        break;
      }
      default:
        // Forward-compatible: unknown SSE fields are intentionally ignored.
        break;
    }

    return undefined;
  };

  try {
    while (true) {
      throwIfAborted(signal);
      const result = await readWithAbort(reader, signal, cancelReader);
      if (result.done) {
        reachedEnd = true;
        const finalDecoded = decoder.decode();
        buffer += finalDecoded;
        bufferBytes += byteLength(finalDecoded);
        break;
      }

      if (result.value.byteLength > limits.maxBodyBytes - totalBytes) {
        throw limitError("body", limits.maxBodyBytes);
      }
      totalBytes += result.value.byteLength;

      const decoded = decoder.decode(result.value, { stream: true });
      buffer += decoded;
      bufferBytes += byteLength(decoded);
      let lineResult = takeLine(buffer, false);
      while (lineResult) {
        const lineBytes = byteLength(lineResult.line);
        bufferBytes -= lineBytes + lineResult.delimiterBytes;
        buffer = lineResult.rest;
        const message = processLine(
          lineResult.line,
          lineBytes,
          lineResult.delimiterBytes,
        );
        if (message) {
          yield message;
        }
        lineResult = takeLine(buffer, false);
      }
      if (bufferBytes > limits.maxLineBytes) {
        throw limitError("line", limits.maxLineBytes);
      }
    }

    let lineResult = takeLine(buffer, true);
    while (lineResult) {
      const lineBytes = byteLength(lineResult.line);
      bufferBytes -= lineBytes + lineResult.delimiterBytes;
      buffer = lineResult.rest;
      const message = processLine(
        lineResult.line,
        lineBytes,
        lineResult.delimiterBytes,
      );
      if (message) {
        yield message;
      }
      lineResult = takeLine(buffer, true);
    }

    // Be liberal at EOF: some HTTP stacks omit the final blank line.
    const finalMessage = processLine("");
    if (finalMessage) {
      yield finalMessage;
    }
  } catch (error) {
    cancellationReason = error;
    throw error;
  } finally {
    if (!reachedEnd) {
      cancelReader(cancellationReason);
    }
    try {
      reader.releaseLock();
    } catch {
      // releaseLock can throw while a cancelled read is still pending. Do not
      // let a hostile cancel() promise delay or mask the original failure.
    }
  }
}

/** Parse the JSON payload of an SSE message with a useful protocol error. */
export function parseSSEJson(message: SSEMessage): unknown {
  try {
    return JSON.parse(message.data) as unknown;
  } catch {
    throw new SSEParseError("xAI returned invalid JSON in an SSE event", message.data);
  }
}
