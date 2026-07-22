import type {
  XAIFunctionCallOutput,
  XAIInputItem,
  XAIReasoningOutput,
  XAIResponse,
} from "../xai/types";

interface ReasoningBundle {
  readonly key: string;
  readonly namespace: string;
  readonly responseId: string;
  readonly expiresAt: number;
  readonly callSignatures: ReadonlyMap<string, string>;
  readonly items: readonly XAIReasoningOutput[];
}

const DEFAULT_TTL_MS = 60 * 60 * 1_000;
const MAX_NAMESPACE_CHARACTERS = 256;
const MAX_REASONING_ITEM_BYTES = 1 * 1024 * 1024;
const MAX_REASONING_BUNDLE_BYTES = 2 * 1024 * 1024;

/**
 * Keeps encrypted reasoning locally for stateless (`store:false`) tool loops.
 *
 * VS Code does not expose opaque reasoning items in chat history, so the
 * provider restores them before matching historical tool calls. State is
 * isolated by a hashed conversation namespace and requires an exact match of
 * call ID, tool name, and arguments before it can be reused.
 */
export class ReasoningStateCache {
  private readonly bundles = new Map<string, ReasoningBundle>();
  private readonly bundleByNamespacedCall = new Map<string, ReasoningBundle>();

  public constructor(
    private readonly maximumBundles = 128,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maximumBundles) || maximumBundles < 1) {
      throw new TypeError("maximumBundles must be a positive integer");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError("ttlMs must be positive");
    }
  }

  public record(namespace: string, response: XAIResponse): void {
    this.pruneExpired();
    if (!isSafeNamespace(namespace) || response.status !== "completed") {
      return;
    }

    const items = copySafeReasoningItems(response.output);
    const calls = response.output.filter(
      (item): item is XAIFunctionCallOutput =>
        item.type === "function_call" && isCompleteFunctionCall(item),
    );
    if (items.length === 0 || calls.length === 0) {
      return;
    }

    const callSignatures = new Map<string, string>();
    for (const call of calls) {
      const signature = functionCallSignature(call);
      const existing = callSignatures.get(call.call_id);
      if (existing !== undefined && existing !== signature) {
        // Ambiguous call IDs must never be used to recover hidden state.
        return;
      }
      callSignatures.set(call.call_id, signature);
    }

    const key = namespacedKey(namespace, response.id);
    const existing = this.bundles.get(key);
    if (existing) {
      this.removeBundle(existing);
    }

    const bundle: ReasoningBundle = {
      key,
      namespace,
      responseId: response.id,
      expiresAt: this.now() + this.ttlMs,
      callSignatures,
      items,
    };
    this.bundles.set(key, bundle);
    for (const callId of callSignatures.keys()) {
      const indexKey = namespacedKey(namespace, callId);
      const previous = this.bundleByNamespacedCall.get(indexKey);
      if (previous && previous !== bundle) {
        this.removeBundle(previous);
      }
      this.bundleByNamespacedCall.set(indexKey, bundle);
    }

    while (this.bundles.size > this.maximumBundles) {
      const oldest = this.bundles.values().next().value as
        | ReasoningBundle
        | undefined;
      if (!oldest) {
        break;
      }
      this.removeBundle(oldest);
    }
  }

  public augment(namespace: string, input: readonly XAIInputItem[]): XAIInputItem[] {
    this.pruneExpired();
    if (!isSafeNamespace(namespace)) {
      return [...input];
    }

    const insertions = new Map<number, ReasoningBundle[]>();
    const scheduled = new Set<string>();

    for (let index = 0; index < input.length; index += 1) {
      const item = input[index];
      if (!item || item.type !== "function_call" || !isCompleteFunctionCall(item)) {
        continue;
      }

      const bundle = this.bundleByNamespacedCall.get(
        namespacedKey(namespace, item.call_id),
      );
      if (
        !bundle ||
        scheduled.has(bundle.key) ||
        bundle.callSignatures.get(item.call_id) !== functionCallSignature(item)
      ) {
        continue;
      }

      let insertionIndex = index;
      while (insertionIndex > 0) {
        const previous = input[insertionIndex - 1];
        if (isAssistantMessage(previous)) {
          insertionIndex -= 1;
          continue;
        }
        if (
          previous?.type === "function_call" &&
          isCompleteFunctionCall(previous) &&
          bundle.callSignatures.get(previous.call_id) ===
            functionCallSignature(previous)
        ) {
          insertionIndex -= 1;
          continue;
        }
        break;
      }

      const atIndex = insertions.get(insertionIndex) ?? [];
      atIndex.push(bundle);
      insertions.set(insertionIndex, atIndex);
      scheduled.add(bundle.key);
    }

    if (insertions.size === 0) {
      return [...input];
    }

    const result: XAIInputItem[] = [];
    for (let index = 0; index <= input.length; index += 1) {
      for (const bundle of insertions.get(index) ?? []) {
        result.push(...bundle.items);
      }
      const item = input[index];
      if (item) {
        result.push(item);
      }
    }
    return result;
  }

  public clear(): void {
    this.bundles.clear();
    this.bundleByNamespacedCall.clear();
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const bundle of this.bundles.values()) {
      if (bundle.expiresAt <= now) {
        this.removeBundle(bundle);
      }
    }
  }

  private removeBundle(bundle: ReasoningBundle): void {
    this.bundles.delete(bundle.key);
    for (const callId of bundle.callSignatures.keys()) {
      const key = namespacedKey(bundle.namespace, callId);
      if (this.bundleByNamespacedCall.get(key) === bundle) {
        this.bundleByNamespacedCall.delete(key);
      }
    }
  }
}

function copySafeReasoningItems(
  output: XAIResponse["output"],
): XAIReasoningOutput[] {
  const result: XAIReasoningOutput[] = [];
  let totalBytes = 0;

  for (const item of output) {
    if (
      item.type !== "reasoning" ||
      typeof item.encrypted_content !== "string" ||
      item.encrypted_content.length === 0
    ) {
      continue;
    }

    const byteLength = Buffer.byteLength(item.encrypted_content, "utf8");
    if (
      byteLength > MAX_REASONING_ITEM_BYTES ||
      totalBytes + byteLength > MAX_REASONING_BUNDLE_BYTES
    ) {
      return [];
    }
    totalBytes += byteLength;

    const safe: XAIReasoningOutput = {
      type: "reasoning",
      encrypted_content: item.encrypted_content,
    };
    if (typeof item.id === "string" && item.id.length <= 256) {
      safe.id = item.id;
    }
    result.push(safe);
  }

  return result;
}

function isSafeNamespace(namespace: string): boolean {
  return namespace.length > 0 && namespace.length <= MAX_NAMESPACE_CHARACTERS;
}

function namespacedKey(namespace: string, value: string): string {
  return `${namespace.length}:${namespace}${value}`;
}

function isCompleteFunctionCall(
  item: Record<string, unknown>,
): item is Record<string, unknown> & {
  call_id: string;
  name: string;
  arguments: string;
} {
  return (
    typeof item.call_id === "string" &&
    item.call_id.length > 0 &&
    item.call_id.length <= 256 &&
    typeof item.name === "string" &&
    item.name.length > 0 &&
    item.name.length <= 64 &&
    typeof item.arguments === "string"
  );
}

function functionCallSignature(call: {
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}): string {
  return `${call.name.length}:${call.name}${call.arguments}`;
}

function isAssistantMessage(item: XAIInputItem | undefined): boolean {
  return Boolean(item && "role" in item && item.role === "assistant");
}
