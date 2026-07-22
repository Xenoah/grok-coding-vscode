import * as vscode from 'vscode';

import { getGrokConfiguration } from './config';
import { ApiKeyManager } from './credentials';
import { GrokLanguageModelProvider } from './provider/grokProvider';
import { XAIClient } from './xai/client';

const PROVIDER_ID = 'grok-code-agent-xai';

export function activate(context: vscode.ExtensionContext): void {
  const apiKeys = new ApiKeyManager(context.secrets);
  const provider = new GrokLanguageModelProvider({
    getApiKey: ({ silent }) => apiKeys.get(silent),
    getSettings: () => {
      const configuration = getGrokConfiguration();
      return {
        reasoningEffort: configuration.reasoningEffort,
        requestTimeoutMs: configuration.requestTimeoutMs,
        maxOutputTokens: configuration.maxOutputTokens,
        store: false,
        includeEncryptedReasoning: true
      };
    },
    createClient: ({ apiKey, settings }) =>
      new XAIClient({
        apiKey,
        baseUrl: 'https://api.x.ai/v1',
        defaultStore: settings.store ?? false,
        includeEncryptedReasoning: settings.includeEncryptedReasoning ?? true
      })
  });

  context.subscriptions.push(
    apiKeys,
    provider,
    vscode.lm.registerLanguageModelChatProvider(PROVIDER_ID, provider),
    apiKeys.onDidChange(() => provider.refreshModels()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('grokCode')) {
        provider.refreshModels();
      }
    }),
    vscode.commands.registerCommand('grokCode.manageApiKey', () => apiKeys.manage()),
    vscode.commands.registerCommand('grokCode.clearApiKey', () => apiKeys.clear()),
    vscode.commands.registerCommand('grokCode.openChat', () =>
      vscode.commands.executeCommand('workbench.action.chat.open')
    )
  );
}

export function deactivate(): void {
  // VS Code disposes everything registered in ExtensionContext.subscriptions.
}
