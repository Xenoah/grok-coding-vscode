/**
 * Small, dependency-free types for the xAI Responses API.
 *
 * The API deliberately has an open-ended schema: xAI can add output item and
 * stream event types without a client release. Known fields are typed below,
 * while index signatures preserve forward compatibility.
 */

export type XAIRole = "system" | "developer" | "user" | "assistant";

export interface XAIInputText {
  type: "input_text";
  text: string;
  [key: string]: unknown;
}

export interface XAIInputImage {
  type: "input_image";
  image_url: string;
  detail?: "auto" | "low" | "high";
  [key: string]: unknown;
}

export interface XAIInputFile {
  type: "input_file";
  file_id?: string;
  file_url?: string;
  [key: string]: unknown;
}

export interface XAIUnknownInputPart {
  type: string;
  [key: string]: unknown;
}

export type XAIInputPart =
  | XAIInputText
  | XAIInputImage
  | XAIInputFile
  | XAIUnknownInputPart;

export interface XAIMessageInput {
  type?: "message";
  role: XAIRole;
  content: string | XAIInputPart[];
  [key: string]: unknown;
}

export interface XAIFunctionCallOutputInput {
  type: "function_call_output";
  call_id: string;
  /** String output is the wire format expected by the Responses API. */
  output: string;
  [key: string]: unknown;
}

export interface XAIUnknownInputItem {
  type: string;
  [key: string]: unknown;
}

export type XAIInputItem =
  | XAIMessageInput
  | XAIFunctionCallOutputInput
  | XAIUnknownInputItem;

export interface XAIFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  [key: string]: unknown;
}

export interface XAIBuiltInTool {
  type:
    | "web_search"
    | "x_search"
    | "code_interpreter"
    | "file_search"
    | "mcp";
  [key: string]: unknown;
}

export interface XAIUnknownTool {
  type: string;
  [key: string]: unknown;
}

export type XAITool = XAIFunctionTool | XAIBuiltInTool | XAIUnknownTool;

export type XAIReasoningEffort = "low" | "medium" | "high";

export interface XAIReasoningOptions {
  effort?: XAIReasoningEffort;
  summary?: "auto" | "concise" | "detailed" | null;
  [key: string]: unknown;
}

export type XAIToolChoice =
  | "auto"
  | "required"
  | "none"
  | Record<string, unknown>;

export interface XAIResponseRequest {
  model: string;
  input: string | XAIInputItem[];
  instructions?: string;
  tools?: XAITool[];
  tool_choice?: XAIToolChoice;
  parallel_tool_calls?: boolean;
  previous_response_id?: string;
  store?: boolean;
  include?: string[];
  reasoning?: XAIReasoningOptions;
  max_output_tokens?: number;
  max_tool_calls?: number;
  temperature?: number;
  top_p?: number;
  /** Controlled by XAIClient; accepted here so callers can serialize requests. */
  stream?: boolean;
  [key: string]: unknown;
}

export interface XAIOutputText {
  type: "output_text";
  text: string;
  annotations?: unknown[];
  [key: string]: unknown;
}

export interface XAIUnknownOutputContent {
  type: string;
  [key: string]: unknown;
}

export type XAIOutputContent = XAIOutputText | XAIUnknownOutputContent;

export interface XAIMessageOutput {
  type: "message";
  id?: string;
  role: "assistant";
  status?: string;
  content: XAIOutputContent[];
  [key: string]: unknown;
}

export interface XAIFunctionCallOutput {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  /** JSON encoded arguments. Validate and parse before executing a tool. */
  arguments: string;
  status?: string;
  [key: string]: unknown;
}

export interface XAIReasoningOutput {
  type: "reasoning";
  id?: string;
  status?: string;
  encrypted_content?: string;
  summary?: unknown[];
  [key: string]: unknown;
}

export interface XAIUnknownOutputItem {
  type: string;
  [key: string]: unknown;
}

export type XAIResponseOutputItem =
  | XAIMessageOutput
  | XAIFunctionCallOutput
  | XAIReasoningOutput
  | XAIUnknownOutputItem;

export interface XAIErrorPayload {
  message?: string;
  type?: string;
  code?: string | number | null;
  param?: string | null;
  [key: string]: unknown;
}

export interface XAIResponse {
  id: string;
  object: "response" | string;
  status: "completed" | "in_progress" | "incomplete" | "failed" | string;
  model?: string;
  output: XAIResponseOutputItem[];
  error?: XAIErrorPayload | null;
  previous_response_id?: string | null;
  usage?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface XAIRawStreamEvent {
  type: string;
  sequence_number?: number;
  [key: string]: unknown;
}

/** Normalized updates emitted by XAIClient.iterateResponse(). */
export type XAIStreamUpdate =
  | {
      kind: "text_delta";
      delta: string;
      event: XAIRawStreamEvent;
    }
  | {
      kind: "function_call";
      call: XAIFunctionCallOutput;
      event: XAIRawStreamEvent;
    }
  | {
      kind: "response";
      response: XAIResponse;
      event: XAIRawStreamEvent;
    }
  | {
      kind: "event";
      event: XAIRawStreamEvent;
    };

export type MaybePromise<T> = T | Promise<T>;

export interface XAIRequestOptions {
  signal?: AbortSignal;
}

export interface XAIStreamOptions extends XAIRequestOptions {
  /** Called in wire order for every normalized stream update. */
  onEvent?: (update: XAIStreamUpdate) => MaybePromise<void>;
  /** Convenience callback for response.output_text.delta events. */
  onTextDelta?: (
    delta: string,
    event: XAIRawStreamEvent,
  ) => MaybePromise<void>;
}

export interface XAIClientOptions {
  apiKey: string;
  /** Defaults to https://api.x.ai/v1. */
  baseUrl?: string;
  /** Privacy-first default is false. A request-level value takes precedence. */
  defaultStore?: boolean;
  /**
   * Adds reasoning.encrypted_content to include. Defaults to true so a caller
   * can keep agentic state locally when store is false.
   */
  includeEncryptedReasoning?: boolean;
  /** Injectable for tests or custom runtimes; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

