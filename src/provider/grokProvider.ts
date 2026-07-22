import { createHash } from "node:crypto";
import * as vscode from "vscode";

import type { XAIClient } from "../xai/client";
import type {
  XAIFunctionCallOutput,
  XAIInputItem,
  XAIResponse,
  XAIResponseRequest,
  XAIStreamUpdate,
} from "../xai/types";
import {
  MessageCodecError,
  decodeToolCall,
  encodeChatRequestParts,
  type ToolNameAliasMap,
} from "./messageCodec";
import {
  selectModelCatalog,
  type GrokModelDefinition,
} from "./modelCatalog";
import { ReasoningStateCache } from "./reasoningCache";

type MaybePromise<T> = T | PromiseLike<T>;

export interface GrokProviderSettings {
  /** Optional replacement for the built-in model catalog. */
  readonly models?: readonly GrokModelDefinition[];
  /** Per-request output cap. It is clamped to the selected model's limit. */
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly reasoningEffort?: "low" | "medium" | "high";
  readonly requestTimeoutMs?: number;

  /** Values consumed by the injected XAIClient factory. */
  readonly baseUrl?: string;
  readonly store?: boolean;
  readonly includeEncryptedReasoning?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface GrokApiKeyRequest {
  /** Interactive UI must not be shown when true. */
  readonly silent: boolean;
}

export type GrokApiKeyGetter = (
  request: GrokApiKeyRequest,
) => MaybePromise<string | undefined>;

export type GrokSettingsGetter = () => MaybePromise<GrokProviderSettings>;

/** Public aliases make the provider/client boundary explicit without a shim. */
export type GrokClientRequest = XAIResponseRequest;
export type GrokClientUpdate = XAIStreamUpdate;
export type GrokResponseClient = Pick<XAIClient, "iterateResponse">;

export interface GrokClientFactoryOptions {
  readonly apiKey: string;
  readonly settings: GrokProviderSettings;
}

export type GrokClientFactory = (
  options: GrokClientFactoryOptions,
) => GrokResponseClient;

export interface GrokProviderDependencies {
  readonly getApiKey: GrokApiKeyGetter;
  readonly getSettings: GrokSettingsGetter;
  readonly createClient: GrokClientFactory;
}

/**
 * VS Code 1.104's stable language-model provider for xAI Grok.
 *
 * The provider only translates requests and streams model output. VS Code's
 * native chat agent remains responsible for invoking tools, showing approvals,
 * applying edits as diffs, and undo/checkpoint UX.
 */
export class GrokLanguageModelProvider
  implements
    vscode.LanguageModelChatProvider<GrokModelDefinition>,
    vscode.Disposable
{
  private readonly modelChangeEmitter = new vscode.EventEmitter<void>();
  private readonly reasoningState = new ReasoningStateCache();

  public readonly onDidChangeLanguageModelChatInformation =
    this.modelChangeEmitter.event;

  public constructor(private readonly dependencies: GrokProviderDependencies) {}

  /** Notify VS Code after credentials or configured models change. */
  public refreshModels(): void {
    this.reasoningState.clear();
    this.modelChangeEmitter.fire();
  }

  public dispose(): void {
    this.reasoningState.clear();
    this.modelChangeEmitter.dispose();
  }

  public async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<GrokModelDefinition[]> {
    throwIfCancelled(token);

    const apiKey = normalizeApiKey(
      await this.dependencies.getApiKey({ silent: options.silent }),
    );
    throwIfCancelled(token);

    if (!apiKey) {
      return [];
    }

    const settings = await this.dependencies.getSettings();
    throwIfCancelled(token);
    return [...selectModelCatalog(settings.models)];
  }

  public async provideLanguageModelChatResponse(
    model: GrokModelDefinition,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    throwIfCancelled(token);

    const apiKey = normalizeApiKey(
      await this.dependencies.getApiKey({ silent: true }),
    );
    if (!apiKey) {
      throw vscode.LanguageModelError.NoPermissions(
        "An xAI API key is required. Configure the Grok model provider first.",
      );
    }

    const settings = await this.dependencies.getSettings();
    throwIfCancelled(token);

    const selectedModel = selectModelCatalog(settings.models).find(
      (candidate) => candidate.id === model.id,
    );
    if (!selectedModel) {
      throw vscode.LanguageModelError.NotFound(
        `The Grok model '${model.id}' is no longer configured.`,
      );
    }

    const encoded = encodeChatRequestParts(messages, options.tools ?? []);
    const conversationNamespace = createConversationNamespace(
      selectedModel.apiModelId,
      encoded.input,
    );
    const encodedWithReasoning = {
      ...encoded,
      input: conversationNamespace
        ? this.reasoningState.augment(conversationNamespace, encoded.input)
        : [...encoded.input],
    };
    const request = buildClientRequest(
      selectedModel,
      encodedWithReasoning,
      options,
      settings,
    );
    const offeredTools = new Set((options.tools ?? []).map((tool) => tool.name));

    const abortController = new AbortController();
    let timedOut = false;
    const cancellationSubscription = token.onCancellationRequested(() => {
      abortController.abort(new vscode.CancellationError());
    });
    const timeout = createRequestTimeout(settings.requestTimeoutMs, () => {
      timedOut = true;
      abortController.abort(new Error("The xAI request timed out."));
    });

    const emittedCalls = new Map<string, string>();
    let emittedText = false;

    try {
      const client = this.dependencies.createClient({ apiKey, settings });
      for await (const update of client.iterateResponse(request, {
        signal: abortController.signal,
      })) {
        throwIfCancelled(token);

        switch (update.kind) {
          case "text_delta":
            if (update.delta.length > 0) {
              emittedText = true;
              progress.report(new vscode.LanguageModelTextPart(update.delta));
            }
            break;

          case "function_call":
            reportFunctionCall(
              update.call,
              encoded.aliases,
              offeredTools,
              emittedCalls,
              progress,
            );
            break;

          case "response":
            if (conversationNamespace) {
              this.reasoningState.record(conversationNamespace, update.response);
            }
            for (const call of extractFunctionCalls(update.response)) {
              reportFunctionCall(
                call,
                encoded.aliases,
                offeredTools,
                emittedCalls,
                progress,
              );
            }

            // Compatible endpoints may only yield the final response object.
            if (!emittedText) {
              const finalText = extractResponseText(update.response);
              if (finalText.length > 0) {
                emittedText = true;
                progress.report(new vscode.LanguageModelTextPart(finalText));
              }
            }
            break;

          case "event":
            // Unknown/forward-compatible events intentionally remain transport
            // details until VS Code adds a matching stable response-part type.
            break;
        }
      }

      throwIfCancelled(token);
    } catch (error) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      if (timedOut) {
        throw new Error("The xAI request timed out. Increase grokCode.requestTimeoutMs and retry.");
      }
      throw mapProviderError(error, apiKey);
    } finally {
      cancellationSubscription.dispose();
      if (timeout) {
        clearTimeout(timeout);
      }
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    }
  }

  public async provideTokenCount(
    _model: GrokModelDefinition,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Promise<number> {
    throwIfCancelled(token);
    const count =
      typeof text === "string"
        ? estimateTextTokens(text)
        : estimateMessageTokens(text);
    throwIfCancelled(token);
    return count;
  }
}

interface EncodedRequestParts {
  readonly input: ReturnType<typeof encodeChatRequestParts>["input"];
  readonly tools: ReturnType<typeof encodeChatRequestParts>["tools"];
}

function buildClientRequest(
  model: GrokModelDefinition,
  encoded: EncodedRequestParts,
  options: vscode.ProvideLanguageModelChatResponseOptions,
  settings: GrokProviderSettings,
): XAIResponseRequest {
  const optionMaxOutput = readFiniteNumber(
    options.modelOptions,
    "maxOutputTokens",
    "max_output_tokens",
  );
  const maxOutputTokens = clampInteger(
    optionMaxOutput ?? settings.maxOutputTokens ?? model.maxOutputTokens,
    1,
    model.maxOutputTokens,
  );

  const optionTemperature = readFiniteNumber(
    options.modelOptions,
    "temperature",
  );
  const temperature = optionTemperature ?? settings.temperature;
  const reasoningEffort =
    readReasoningEffort(options.modelOptions) ??
    settings.reasoningEffort ??
    "low";

  return {
    model: model.apiModelId,
    input: [...encoded.input],
    prompt_cache_key: createPromptCacheKey(encoded.input),
    tools: encoded.tools.length > 0 ? [...encoded.tools] : undefined,
    tool_choice:
      encoded.tools.length === 0
        ? undefined
        : options.toolMode === vscode.LanguageModelChatToolMode.Required
          ? "required"
          : "auto",
    parallel_tool_calls: encoded.tools.length > 0 ? true : undefined,
    max_output_tokens: maxOutputTokens,
    temperature:
      temperature === undefined
        ? undefined
        : Math.min(2, Math.max(0, temperature)),
    reasoning: { effort: reasoningEffort },
    store: settings.store ?? false,
  };
}

function createPromptCacheKey(input: readonly XAIInputItem[]): string | undefined {
  const firstUserIndex = input.findIndex(
    item => 'role' in item && item.role === 'user'
  );
  if (firstUserIndex < 0) {
    return undefined;
  }

  const stablePrefix = JSON.stringify(input.slice(0, firstUserIndex + 1));
  const digest = createHash('sha256').update(stablePrefix, 'utf8').digest('hex');
  return `vscode-grok-${digest.slice(0, 32)}`;
}

function createConversationNamespace(
  modelId: string,
  input: readonly XAIInputItem[],
): string | undefined {
  const promptKey = createPromptCacheKey(input);
  return promptKey ? `${modelId}:${promptKey}` : undefined;
}

function reportFunctionCall(
  call: XAIFunctionCallOutput,
  aliases: ToolNameAliasMap,
  offeredTools: ReadonlySet<string>,
  emittedCalls: Map<string, string>,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
  if (!call.call_id || call.call_id.length > 1_024) {
    throw new MessageCodecError("xAI returned an invalid tool call ID");
  }

  const signature = `${call.name.length}:${call.name}${call.arguments}`;
  const existingSignature = emittedCalls.get(call.call_id);
  if (existingSignature !== undefined) {
    if (existingSignature !== signature) {
      throw new MessageCodecError(
        `xAI reused tool call ID ${call.call_id} for a different call`,
      );
    }
    return;
  }

  const decoded = decodeToolCall(call, aliases);
  if (!offeredTools.has(decoded.name)) {
    throw new MessageCodecError(
      `xAI requested a tool that was not offered in this turn: ${decoded.name}`,
    );
  }

  emittedCalls.set(decoded.callId, signature);
  progress.report(
    new vscode.LanguageModelToolCallPart(
      decoded.callId,
      decoded.name,
      decoded.input,
    ),
  );
}

function extractFunctionCalls(response: XAIResponse): XAIFunctionCallOutput[] {
  return response.output.filter(
    (item): item is XAIFunctionCallOutput =>
      item.type === "function_call" &&
      typeof item.call_id === "string" &&
      typeof item.name === "string" &&
      typeof item.arguments === "string",
  );
}

function extractResponseText(response: XAIResponse): string {
  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  const result: string[] = [];
  for (const item of response.output) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (part.type === "output_text" && typeof part.text === "string") {
        result.push(part.text);
      }
    }
  }
  return result.join("");
}

function estimateMessageTokens(
  message: vscode.LanguageModelChatRequestMessage,
): number {
  let tokens = 4;
  if (message.name) {
    tokens += estimateTextTokens(message.name);
  }

  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      tokens += estimateTextTokens(part.value);
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      tokens += 8 + estimateTextTokens(part.name);
      tokens += estimateValueTokens(part.input);
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      tokens += 8 + estimateTextTokens(part.callId);
      tokens += estimateValueTokens(part.content);
    } else {
      tokens += estimateValueTokens(part);
    }
  }

  return Math.max(1, tokens);
}

/**
 * Conservative local approximation. It avoids an extra request and errs high
 * for Japanese text and source code, which is safer for context budgeting.
 */
export function estimateTextTokens(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  // Token counting is advisory. Avoid a multi-megabyte scan on the extension
  // host while still returning a value beyond the supported context window.
  if (value.length > 1_000_000) {
    return 500_000;
  }

  let asciiCharacters = 0;
  let nonAsciiTokens = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      asciiCharacters += 1;
    } else {
      nonAsciiTokens += codePoint > 0xffff ? 2 : 1;
    }
  }

  return Math.max(1, Math.ceil(asciiCharacters / 4) + nonAsciiTokens);
}

const BINARY_PART_TOKEN_ESTIMATE = 4_096;
const MAX_ESTIMATED_TOKENS_PER_VALUE = 500_000;
const MAX_COUNTED_COLLECTION_ITEMS = 1_024;
const MAX_COUNTING_DEPTH = 12;

/** Count structured values without expanding Uint8Array images into JSON. */
function estimateValueTokens(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): number {
  if (typeof value === "string") {
    return estimateTextTokens(value);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return 1;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return BINARY_PART_TOKEN_ESTIMATE;
  }
  if (typeof value !== "object") {
    return estimateTextTokens(String(value));
  }
  if (seen.has(value) || depth >= MAX_COUNTING_DEPTH) {
    return 8;
  }
  seen.add(value);

  let tokens = 2;
  if (Array.isArray(value)) {
    const count = Math.min(value.length, MAX_COUNTED_COLLECTION_ITEMS);
    for (let index = 0; index < count; index += 1) {
      tokens += estimateValueTokens(value[index], seen, depth + 1);
      if (tokens >= MAX_ESTIMATED_TOKENS_PER_VALUE) {
        return MAX_ESTIMATED_TOKENS_PER_VALUE;
      }
    }
    if (value.length > count) {
      return MAX_ESTIMATED_TOKENS_PER_VALUE;
    }
    return tokens;
  }

  let entries = 0;
  try {
    for (const key of Object.keys(value)) {
      entries += 1;
      if (entries > MAX_COUNTED_COLLECTION_ITEMS) {
        return MAX_ESTIMATED_TOKENS_PER_VALUE;
      }
      tokens += estimateTextTokens(key);
      tokens += estimateValueTokens(
        (value as Record<string, unknown>)[key],
        seen,
        depth + 1,
      );
      if (tokens >= MAX_ESTIMATED_TOKENS_PER_VALUE) {
        return MAX_ESTIMATED_TOKENS_PER_VALUE;
      }
    }
  } catch {
    return 8;
  }
  return tokens;
}

function normalizeApiKey(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function readFiniteNumber(
  options: Readonly<Record<string, unknown>> | undefined,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = options?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function readReasoningEffort(
  options: Readonly<Record<string, unknown>> | undefined,
): "low" | "medium" | "high" | undefined {
  const value = options?.reasoningEffort ?? options?.reasoning_effort;
  return value === "low" || value === "medium" || value === "high"
    ? value
    : undefined;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return maximum;
  }
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function createRequestTimeout(
  timeoutMs: number | undefined,
  callback: () => void,
): ReturnType<typeof setTimeout> | undefined {
  if (
    timeoutMs === undefined ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return undefined;
  }
  return setTimeout(callback, timeoutMs);
}

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
}

function mapProviderError(error: unknown, apiKey: string): Error {
  if (error instanceof vscode.LanguageModelError) {
    return error;
  }

  const status = readErrorStatus(error);
  const message = redactApiKey(
    error instanceof Error ? error.message : String(error),
    apiKey,
  );

  if (status === 401 || status === 403) {
    return vscode.LanguageModelError.NoPermissions(
      message || "xAI rejected the configured API key.",
    );
  }
  if (status === 404) {
    return vscode.LanguageModelError.NotFound(
      message || "The configured xAI model was not found.",
    );
  }
  if (status === 429) {
    return vscode.LanguageModelError.Blocked(
      message || "xAI rate-limited this request. Retry shortly.",
    );
  }

  return new Error(message || "The xAI request failed.");
}

function readErrorStatus(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  return undefined;
}

function redactApiKey(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}
