import { createHash } from "node:crypto";
import type {
  XAIFunctionCallOutputInput,
  XAIFunctionTool,
  XAIInputImage,
  XAIInputItem,
  XAIInputPart,
  XAIInputText,
  XAIMessageInput,
} from "../xai/types";

/**
 * Local structural types keep this codec independent from the runtime VS Code
 * module. vscode.LanguageModel* values are assignable to these shapes through
 * the thin adapter in the provider.
 */
export interface VSCodeChatMessageLike {
  readonly role: number | "user" | "assistant" | "system" | "developer";
  readonly content: string | ReadonlyArray<unknown>;
  readonly name?: string;
}

export interface VSCodeChatToolLike {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: object;
}

export interface VSCodeToolCallLike {
  readonly callId: string;
  readonly name: string;
  readonly input: object;
}

export interface XAIInputFunctionCall {
  readonly type: "function_call";
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface XAIToolCallLike {
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ToolNameAliasMap {
  readonly vscodeToXai: ReadonlyMap<string, string>;
  readonly xaiToVscode: ReadonlyMap<string, string>;
}

export interface EncodedTools {
  readonly tools: readonly XAIFunctionTool[];
  readonly aliases: ToolNameAliasMap;
}

export interface EncodedChatRequestParts extends EncodedTools {
  readonly input: readonly XAIInputItem[];
}

export class MessageCodecError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MessageCodecError";
  }
}

const XAI_FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_MIME_TYPE = /^image\/[A-Za-z0-9.+-]+$/;
const GROK_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const GROK_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readableToolName(name: string): string {
  const readable = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return readable || "tool";
}

function createInvalidNameAlias(name: string, reserved: Set<string>): string {
  // Twelve digest characters make aliases compact. Rehash with a deterministic
  // counter in the extremely unlikely event of a collision or a matching
  // native tool name. Every candidate remains within the 64-character limit.
  for (let counter = 0; counter < 10_000; counter += 1) {
    const hash = digest(counter === 0 ? name : `${name}\0${counter}`);
    const suffix = `_${hash.slice(0, 12)}`;
    const prefixBudget = 64 - "vsc_".length - suffix.length;
    const prefix = readableToolName(name).slice(0, Math.max(1, prefixBudget));
    const alias = `vsc_${prefix}${suffix}`;
    if (!reserved.has(alias)) {
      return alias;
    }
  }

  throw new MessageCodecError(`Unable to create a unique xAI alias for tool: ${name}`);
}

/**
 * Create a deterministic, reversible mapping to xAI's function-name grammar.
 * Valid names are preserved; aliases for invalid names do not depend on input
 * ordering.
 */
export function createToolNameAliasMap(
  toolNames: readonly string[],
): ToolNameAliasMap {
  const uniqueNames = new Set(toolNames);
  if (uniqueNames.size !== toolNames.length) {
    throw new MessageCodecError("VS Code tool names must be unique");
  }

  const sortedNames = [...uniqueNames].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const vscodeToXai = new Map<string, string>();
  const xaiToVscode = new Map<string, string>();
  const reserved = new Set(
    sortedNames.filter((name) => XAI_FUNCTION_NAME.test(name)),
  );

  for (const name of sortedNames) {
    const alias = XAI_FUNCTION_NAME.test(name)
      ? name
      : createInvalidNameAlias(name, reserved);
    reserved.add(alias);
    vscodeToXai.set(name, alias);
    xaiToVscode.set(alias, name);
  }

  return { vscodeToXai, xaiToVscode };
}

export function encodeToolName(
  aliases: ToolNameAliasMap,
  vscodeName: string,
): string {
  const alias = aliases.vscodeToXai.get(vscodeName);
  if (!alias) {
    throw new MessageCodecError(`Tool is not present in the alias map: ${vscodeName}`);
  }
  return alias;
}

export function decodeToolName(
  aliases: ToolNameAliasMap,
  xaiName: string,
): string {
  const name = aliases.xaiToVscode.get(xaiName);
  if (!name) {
    throw new MessageCodecError(`xAI returned an unknown tool name: ${xaiName}`);
  }
  return name;
}

/** Convert VS Code tool declarations to Responses API function tools. */
export function encodeTools(tools: readonly VSCodeChatToolLike[]): EncodedTools {
  const aliases = createToolNameAliasMap(tools.map((tool) => tool.name));
  return { tools: encodeToolsWithAliases(tools, aliases), aliases };
}

function encodeToolsWithAliases(
  tools: readonly VSCodeChatToolLike[],
  aliases: ToolNameAliasMap,
): readonly XAIFunctionTool[] {
  return tools.map<XAIFunctionTool>((tool) => ({
    type: "function",
    name: encodeToolName(aliases, tool.name),
    description: tool.description,
    parameters: (tool.inputSchema ?? {
      type: "object",
      properties: {},
    }) as Record<string, unknown>,
  }));
}

/** Reverse an xAI function call into the shape expected by VS Code. */
export function decodeToolCall(
  call: XAIToolCallLike,
  aliases: ToolNameAliasMap,
): VSCodeToolCallLike {
  let input: unknown;
  try {
    input = JSON.parse(call.arguments) as unknown;
  } catch {
    throw new MessageCodecError(
      `xAI returned invalid JSON arguments for tool ${call.name}`,
    );
  }

  if (!isRecord(input) || Array.isArray(input)) {
    throw new MessageCodecError(
      `xAI returned non-object arguments for tool ${call.name}`,
    );
  }

  return {
    callId: call.call_id,
    name: decodeToolName(aliases, call.name),
    input,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextPart(value: unknown): value is { readonly value: string } {
  return isRecord(value) && typeof value.value === "string";
}

function isToolCallPart(value: unknown): value is VSCodeToolCallLike {
  return (
    isRecord(value) &&
    typeof value.callId === "string" &&
    typeof value.name === "string" &&
    isRecord(value.input) &&
    !Array.isArray(value.input)
  );
}

function isToolResultPart(
  value: unknown,
): value is { readonly callId: string; readonly content: readonly unknown[] } {
  return (
    isRecord(value) &&
    typeof value.callId === "string" &&
    Array.isArray(value.content) &&
    !("name" in value)
  );
}

function getBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

function encodeDataUri(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function detectedImageMimeType(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }

  return undefined;
}

function normalizeImageMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function unsupportedImageError(mimeType: string): MessageCodecError {
  return new MessageCodecError(
    `Grok 4.5 accepts only JPEG and PNG images up to 20 MiB; ${mimeType} is not supported`,
  );
}

function validateImageBytes(
  bytes: Uint8Array,
  declaredMimeType: string | undefined,
): { readonly bytes: Uint8Array; readonly mimeType: string } {
  if (bytes.byteLength === 0) {
    throw new MessageCodecError("Images sent to Grok 4.5 must not be empty");
  }
  if (bytes.byteLength > GROK_IMAGE_MAX_BYTES) {
    throw new MessageCodecError(
      `Images sent to Grok 4.5 must be 20 MiB or smaller (received ${bytes.byteLength} bytes)`,
    );
  }

  const normalizedDeclared = declaredMimeType
    ? normalizeImageMimeType(declaredMimeType)
    : undefined;
  if (
    normalizedDeclared &&
    IMAGE_MIME_TYPE.test(normalizedDeclared) &&
    !GROK_IMAGE_MIME_TYPES.has(normalizedDeclared)
  ) {
    throw unsupportedImageError(normalizedDeclared);
  }
  if (normalizedDeclared && !IMAGE_MIME_TYPE.test(normalizedDeclared)) {
    throw new MessageCodecError(
      `Binary content with MIME type ${declaredMimeType} cannot be sent to Grok 4.5; only JPEG and PNG images up to 20 MiB are supported`,
    );
  }

  const detected = detectedImageMimeType(bytes);
  if (detected && !GROK_IMAGE_MIME_TYPES.has(detected)) {
    throw unsupportedImageError(detected);
  }
  if (!detected) {
    throw new MessageCodecError(
      "Binary content is not a valid JPEG or PNG image; Grok 4.5 accepts only JPEG and PNG images up to 20 MiB",
    );
  }
  if (normalizedDeclared && normalizedDeclared !== detected) {
    throw new MessageCodecError(
      `Image MIME type ${normalizedDeclared} does not match the detected ${detected} data`,
    );
  }

  return { bytes, mimeType: detected };
}

function decodeImageDataUri(value: string): {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
} {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match) {
    throw new MessageCodecError(
      "Image data URIs must contain valid base64-encoded JPEG or PNG data",
    );
  }

  const mimeType = match[1];
  const base64 = match[2];
  if (!mimeType || base64 === undefined || base64.length % 4 === 1) {
    throw new MessageCodecError(
      "Image data URIs must contain valid base64-encoded JPEG or PNG data",
    );
  }

  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const decodedByteLength = Math.floor((base64.length * 3) / 4) - padding;
  if (decodedByteLength > GROK_IMAGE_MAX_BYTES) {
    throw new MessageCodecError(
      `Images sent to Grok 4.5 must be 20 MiB or smaller (received ${decodedByteLength} bytes)`,
    );
  }

  const bytes = Buffer.from(base64, "base64");
  const canonicalInput = base64.replace(/=+$/, "");
  const canonicalDecoded = bytes.toString("base64").replace(/=+$/, "");
  if (canonicalInput !== canonicalDecoded) {
    throw new MessageCodecError(
      "Image data URIs must contain valid base64-encoded JPEG or PNG data",
    );
  }

  return validateImageBytes(bytes, mimeType);
}

function validateRemoteImageUrl(value: string, mimeType: string | undefined): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MessageCodecError("Image URLs must be valid http(s) URLs");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MessageCodecError("Image URLs must be an http(s) URL");
  }

  if (mimeType) {
    const normalized = normalizeImageMimeType(mimeType);
    if (!GROK_IMAGE_MIME_TYPES.has(normalized)) {
      if (IMAGE_MIME_TYPE.test(normalized)) {
        throw unsupportedImageError(normalized);
      }
      throw new MessageCodecError(
        `Remote binary content with MIME type ${mimeType} cannot be sent to Grok 4.5; only JPEG and PNG images are supported`,
      );
    }
  }

  const unsupportedExtension = /\.(gif|webp|bmp|svg|tiff?)$/i.exec(url.pathname)?.[1];
  if (unsupportedExtension) {
    throw unsupportedImageError(`.${unsupportedExtension.toLowerCase()} image`);
  }
}

function imagePart(value: unknown): XAIInputImage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const nestedValue = isRecord(value.value) ? value.value : undefined;

  const mimeType =
    typeof value.mimeType === "string"
      ? value.mimeType
      : typeof value.mime_type === "string"
        ? value.mime_type
        : typeof nestedValue?.mimeType === "string"
          ? nestedValue.mimeType
          : typeof nestedValue?.mime_type === "string"
            ? nestedValue.mime_type
            : undefined;
  const directUrl =
    typeof value.imageUrl === "string"
      ? value.imageUrl
      : typeof value.image_url === "string"
        ? value.image_url
        : typeof value.dataUri === "string"
          ? value.dataUri
          : typeof nestedValue?.imageUrl === "string"
            ? nestedValue.imageUrl
            : typeof nestedValue?.image_url === "string"
              ? nestedValue.image_url
              : typeof nestedValue?.dataUri === "string"
                ? nestedValue.dataUri
                : undefined;

  if (directUrl) {
    if (/^data:/i.test(directUrl)) {
      const image = decodeImageDataUri(directUrl);
      return {
        type: "input_image",
        image_url: encodeDataUri(image.mimeType, image.bytes),
      };
    }
    validateRemoteImageUrl(directUrl, mimeType);
    return { type: "input_image", image_url: directUrl };
  }

  // Proposed/new VS Code data parts have used either `data` or `value` for
  // their Uint8Array payload. Supporting both keeps the adapter version-light.
  const bytes =
    getBytes(value) ??
    getBytes(value.data) ??
    getBytes(value.value) ??
    getBytes(nestedValue?.data) ??
    getBytes(nestedValue?.value);
  if (!bytes) {
    return undefined;
  }
  const image = validateImageBytes(bytes, mimeType);

  return {
    type: "input_image",
    image_url: encodeDataUri(image.mimeType, image.bytes),
  };
}

function roleOf(role: VSCodeChatMessageLike["role"]): XAIMessageInput["role"] {
  switch (role) {
    case 1:
    case "user":
      return "user";
    case 2:
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "developer":
      return "developer";
    default:
      throw new MessageCodecError(`Unsupported VS Code chat role: ${String(role)}`);
  }
}

function stableJson(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  try {
    return JSON.stringify(value);
  } catch {
    throw new MessageCodecError("Tool arguments contain a non-JSON value");
  }
}

function stringifyToolResultPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }
  if (isTextPart(part)) {
    return part.value;
  }
  if (isRecord(part) && "value" in part) {
    return stableJson(part.value);
  }
  return stableJson(part);
}

interface EncodedToolResultContent {
  readonly output: string;
  readonly images: readonly XAIInputImage[];
}

function encodeToolResultContent(
  parts: readonly unknown[],
): EncodedToolResultContent {
  const outputParts: string[] = [];
  const images: XAIInputImage[] = [];

  for (const part of parts) {
    const image = imagePart(part);
    if (image) {
      images.push(image);
    } else {
      outputParts.push(stringifyToolResultPart(part));
    }
  }

  let output = outputParts.join("");
  if (images.length > 0) {
    const notice = `[Tool returned ${images.length} JPEG/PNG image${images.length === 1 ? "" : "s"}; attached immediately after this tool result.]`;
    output = output.length > 0 ? `${output}\n${notice}` : notice;
  }

  return { output, images };
}

/** Convert a direct vscode.LanguageModelToolResult when its call ID is known. */
export function encodeToolResult(
  callId: string,
  result: { readonly content: readonly unknown[] },
): XAIFunctionCallOutputInput {
  const encoded = encodeToolResultContent(result.content);
  if (encoded.images.length > 0) {
    throw new MessageCodecError(
      "Tool result images must be encoded with encodeChatRequestParts so they can be attached to the following user message",
    );
  }
  return {
    type: "function_call_output",
    call_id: callId,
    output: encoded.output,
  };
}

/**
 * Convert VS Code chat history into Responses API input items. Calls and their
 * results are emitted as top-level items, while adjacent text/image parts stay
 * grouped into messages. Tool-result images are deferred until all parallel
 * function outputs in the same message have been emitted.
 */
export function encodeMessages(
  messages: readonly VSCodeChatMessageLike[],
  aliases: ToolNameAliasMap,
): readonly XAIInputItem[] {
  const result: XAIInputItem[] = [];

  for (const message of messages) {
    const role = roleOf(message.role);
    const sourceParts =
      typeof message.content === "string" ? [message.content] : message.content;
    let pendingParts: XAIInputPart[] = [];
    const deferredToolImageParts: XAIInputPart[] = [];

    const flushMessage = (): void => {
      if (pendingParts.length === 0) {
        return;
      }
      result.push({ role, content: pendingParts });
      pendingParts = [];
    };

    for (const part of sourceParts) {
      if (typeof part === "string") {
        pendingParts.push({ type: "input_text", text: part } satisfies XAIInputText);
        continue;
      }
      if (isToolCallPart(part)) {
        flushMessage();
        result.push({
          type: "function_call",
          call_id: part.callId,
          name: encodeToolName(aliases, part.name),
          arguments: stableJson(part.input),
        } satisfies XAIInputFunctionCall);
        continue;
      }
      if (isToolResultPart(part)) {
        flushMessage();
        const encodedResult = encodeToolResultContent(part.content);
        result.push({
          type: "function_call_output",
          call_id: part.callId,
          output: encodedResult.output,
        } satisfies XAIFunctionCallOutputInput);
        if (encodedResult.images.length > 0) {
          deferredToolImageParts.push({
            type: "input_text",
            text: `JPEG/PNG image output from tool call ${part.callId}:`,
          });
          deferredToolImageParts.push(...encodedResult.images);
        }
        continue;
      }

      const image = imagePart(part);
      if (image) {
        pendingParts.push(image);
        continue;
      }
      if (isTextPart(part)) {
        pendingParts.push({ type: "input_text", text: part.value });
        continue;
      }

      throw new MessageCodecError("Unsupported VS Code language-model content part");
    }

    flushMessage();
    if (deferredToolImageParts.length > 0) {
      result.push({ role: "user", content: deferredToolImageParts });
    }
  }

  return result;
}

/**
 * One-shot conversion for a provider request. Historical calls are included in
 * the alias map even when their tools are no longer offered in this turn.
 */
export function encodeChatRequestParts(
  messages: readonly VSCodeChatMessageLike[],
  tools: readonly VSCodeChatToolLike[],
): EncodedChatRequestParts {
  const historicalToolNames: string[] = [];
  for (const message of messages) {
    const parts =
      typeof message.content === "string" ? [] : message.content;
    for (const part of parts) {
      if (isToolCallPart(part)) {
        historicalToolNames.push(part.name);
      }
    }
  }

  const aliases = createToolNameAliasMap([
    ...new Set([...tools.map((tool) => tool.name), ...historicalToolNames]),
  ]);
  return {
    input: encodeMessages(messages, aliases),
    tools: encodeToolsWithAliases(tools, aliases),
    aliases,
  };
}
