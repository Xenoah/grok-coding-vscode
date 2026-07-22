import * as vscode from 'vscode';

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface GrokConfiguration {
  reasoningEffort: ReasoningEffort;
  requestTimeoutMs: number;
  maxOutputTokens: number;
}

export function getGrokConfiguration(): GrokConfiguration {
  const configuration = vscode.workspace.getConfiguration('grokCode');
  return {
    reasoningEffort: configuration.get<ReasoningEffort>('reasoningEffort', 'low'),
    requestTimeoutMs: configuration.get<number>('requestTimeoutMs', 360_000),
    maxOutputTokens: configuration.get<number>('maxOutputTokens', 32_768)
  };
}
