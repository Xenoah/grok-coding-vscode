import type * as vscode from "vscode";

/**
 * Model metadata used both by VS Code's model picker and by the xAI client.
 * `apiModelId` is kept separate so a future display/picker id can be changed
 * without changing the identifier sent to xAI.
 */
export interface GrokModelDefinition extends vscode.LanguageModelChatInformation {
  readonly apiModelId: string;
}

/**
 * Conservative defaults for the current xAI coding model.
 *
 * Grok 4.5 has a 500k context window. xAI does not currently publish a
 * separate maximum-output figure, so the provider uses a conservative 32k
 * operational cap and leaves the remainder for input. Users can replace this
 * catalog through GrokProviderSettings when xAI publishes a precise limit.
 */
export const DEFAULT_GROK_MODELS: readonly GrokModelDefinition[] = Object.freeze([
  Object.freeze({
    id: "grok-4.5",
    apiModelId: "grok-4.5",
    name: "Grok 4.5",
    family: "grok-4.5",
    version: "4.5",
    detail: "xAI coding and agent model",
    tooltip: "Grok 4.5 via the xAI API",
    maxInputTokens: 467_232,
    maxOutputTokens: 32_768,
    capabilities: Object.freeze({
      imageInput: true,
      toolCalling: 128,
    }),
  }),
]);

export function selectModelCatalog(
  configured: readonly GrokModelDefinition[] | undefined,
): readonly GrokModelDefinition[] {
  if (!configured || configured.length === 0) {
    return DEFAULT_GROK_MODELS;
  }

  return configured;
}
