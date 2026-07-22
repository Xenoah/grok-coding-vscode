import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

import { getGrokConfiguration } from '../config';
import type { ApiKeyManager } from '../credentials';
import { DEFAULT_GROK_MODELS } from '../provider/modelCatalog';
import { XAIClient, XAIClientError } from '../xai/client';
import type { XAIInputItem, XAIResponse } from '../xai/types';

const CHAT_STATE_KEY = 'grokCode.chatState.v1';
const MAX_SESSIONS = 50;
const MAX_MESSAGES_PER_SESSION = 100;
const MAX_INPUT_LENGTH = 50_000;

type ChatRole = 'user' | 'assistant';
type ChatMessageStatus = 'complete' | 'streaming' | 'error';

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  status: ChatMessageStatus;
}

interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

interface StoredChatState {
  activeSessionId: string;
  sessions: ChatSession[];
}

interface ActiveRequest {
  controller: AbortController;
  sessionId: string;
  assistantMessageId: string;
  stopped: boolean;
  timedOut: boolean;
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'send'; text?: unknown }
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'selectChat'; sessionId?: unknown }
  | { type: 'deleteChat'; sessionId?: unknown }
  | { type: 'configureApiKey' }
  | { type: 'openNativeChat' };

export class GrokChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'grokCode.chatView';

  private readonly sessions: ChatSession[];
  private activeSessionId: string;
  private view: vscode.WebviewView | undefined;
  private activeRequest: ActiveRequest | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly apiKeys: ApiKeyManager
  ) {
    const stored = readStoredState(context.globalState.get<unknown>(CHAT_STATE_KEY));
    this.sessions = stored.sessions;
    this.activeSessionId = stored.activeSessionId;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    view.webview.html = createWebviewHtml(view.webview, this.context.extensionUri);

    const messageSubscription = view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });
    const disposeSubscription = view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
      messageSubscription.dispose();
      disposeSubscription.dispose();
    });
  }

  async show(): Promise<void> {
    await vscode.commands.executeCommand(`${GrokChatViewProvider.viewType}.focus`);
  }

  async newChat(): Promise<void> {
    if (this.activeRequest) {
      this.stopGeneration();
    }
    const session = createSession();
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    this.trimSessions();
    await this.persistAndPostState();
  }

  refresh(): void {
    void this.postState();
  }

  dispose(): void {
    this.stopGeneration();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.postState();
        break;
      case 'send':
        if (typeof message.text === 'string') {
          await this.sendMessage(message.text);
        }
        break;
      case 'stop':
        this.stopGeneration();
        break;
      case 'newChat':
        await this.newChat();
        break;
      case 'selectChat':
        if (typeof message.sessionId === 'string') {
          await this.selectChat(message.sessionId);
        }
        break;
      case 'deleteChat':
        if (typeof message.sessionId === 'string') {
          await this.deleteChat(message.sessionId);
        }
        break;
      case 'configureApiKey':
        await this.apiKeys.manage();
        await this.postState();
        break;
      case 'openNativeChat':
        await vscode.commands.executeCommand('workbench.action.chat.open');
        break;
    }
  }

  private async selectChat(sessionId: string): Promise<void> {
    if (!this.sessions.some(session => session.id === sessionId)) {
      return;
    }
    this.activeSessionId = sessionId;
    await this.persistAndPostState();
  }

  private async deleteChat(sessionId: string): Promise<void> {
    const index = this.sessions.findIndex(session => session.id === sessionId);
    if (index === -1) {
      return;
    }
    if (this.activeRequest?.sessionId === sessionId) {
      this.stopGeneration();
    }
    this.sessions.splice(index, 1);
    if (this.sessions.length === 0) {
      this.sessions.push(createSession());
    }
    if (!this.sessions.some(session => session.id === this.activeSessionId)) {
      this.activeSessionId = this.sessions[0]!.id;
    }
    await this.persistAndPostState();
  }

  private async sendMessage(rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text || this.activeRequest) {
      return;
    }
    if (text.length > MAX_INPUT_LENGTH) {
      void vscode.window.showWarningMessage(
        `メッセージは${MAX_INPUT_LENGTH.toLocaleString()}文字以内にしてください。`
      );
      return;
    }

    const apiKey = await this.apiKeys.get(false);
    if (!apiKey) {
      await this.postState();
      return;
    }

    const session = this.getActiveSession();
    const now = Date.now();
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: text,
      createdAt: now,
      status: 'complete'
    };
    session.messages.push(userMessage);
    if (session.messages.filter(message => message.role === 'user').length === 1) {
      session.title = createTitle(text);
    }

    const requestInput = session.messages.map<XAIInputItem>(message => ({
      type: 'message',
      role: message.role,
      content: message.content
    }));
    const assistantMessage: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: '',
      createdAt: now + 1,
      status: 'streaming'
    };
    session.messages.push(assistantMessage);
    session.messages.splice(0, Math.max(0, session.messages.length - MAX_MESSAGES_PER_SESSION));
    session.updatedAt = now;

    const controller = new AbortController();
    const request: ActiveRequest = {
      controller,
      sessionId: session.id,
      assistantMessageId: assistantMessage.id,
      stopped: false,
      timedOut: false
    };
    this.activeRequest = request;
    await this.persistAndPostState();

    const configuration = getGrokConfiguration();
    const timeout = setTimeout(() => {
      request.timedOut = true;
      controller.abort(new Error('The xAI request timed out.'));
    }, configuration.requestTimeoutMs);

    try {
      const client = new XAIClient({
        apiKey,
        baseUrl: 'https://api.x.ai/v1',
        defaultStore: false,
        includeEncryptedReasoning: false
      });
      const response = await client.streamResponse(
        {
          model: DEFAULT_GROK_MODELS[0]!.apiModelId,
          input: requestInput,
          instructions:
            'You are Grok Code, a concise coding assistant inside VS Code. ' +
            "Reply in the user's language. Use Markdown when it improves readability.",
          reasoning: { effort: configuration.reasoningEffort },
          max_output_tokens: configuration.maxOutputTokens,
          store: false
        },
        {
          signal: controller.signal,
          onTextDelta: delta => {
            if (!delta || this.activeRequest !== request) {
              return;
            }
            assistantMessage.content += delta;
            void this.view?.webview.postMessage({
              type: 'delta',
              sessionId: session.id,
              messageId: assistantMessage.id,
              delta
            });
          }
        }
      );

      if (!assistantMessage.content) {
        assistantMessage.content = extractResponseText(response);
      }
      assistantMessage.status = 'complete';
    } catch (error) {
      if (request.stopped) {
        assistantMessage.status = 'complete';
        if (!assistantMessage.content) {
          assistantMessage.content = '（生成を停止しました）';
        }
      } else {
        assistantMessage.status = 'error';
        const message = request.timedOut
          ? '応答がタイムアウトしました。設定のリクエストタイムアウトを延長して再試行してください。'
          : formatError(error);
        assistantMessage.content = assistantMessage.content
          ? `${assistantMessage.content}\n\nエラー: ${message}`
          : `エラー: ${message}`;
      }
    } finally {
      clearTimeout(timeout);
      if (this.activeRequest === request) {
        this.activeRequest = undefined;
      }
      session.updatedAt = Date.now();
      this.sortSessions();
      await this.persistAndPostState();
    }
  }

  private stopGeneration(): void {
    const request = this.activeRequest;
    if (!request) {
      return;
    }
    request.stopped = true;
    request.controller.abort(new Error('Stopped by user'));
  }

  private getActiveSession(): ChatSession {
    const active = this.sessions.find(session => session.id === this.activeSessionId);
    if (active) {
      return active;
    }
    const session = createSession();
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    return session;
  }

  private sortSessions(): void {
    this.sessions.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private trimSessions(): void {
    this.sortSessions();
    this.sessions.splice(MAX_SESSIONS);
  }

  private async persistAndPostState(): Promise<void> {
    this.trimSessions();
    await this.context.globalState.update(CHAT_STATE_KEY, {
      activeSessionId: this.activeSessionId,
      sessions: this.sessions
    } satisfies StoredChatState);
    await this.postState();
  }

  private async postState(): Promise<void> {
    const view = this.view;
    if (!view) {
      return;
    }
    const apiConfigured = await this.apiKeys.has();
    await view.webview.postMessage({
      type: 'state',
      activeSessionId: this.activeSessionId,
      sessions: this.sessions,
      apiConfigured,
      busy: Boolean(this.activeRequest),
      model: DEFAULT_GROK_MODELS[0]!.name
    });
  }
}

function createSession(): ChatSession {
  const now = Date.now();
  return {
    id: randomUUID(),
    title: '新しいチャット',
    createdAt: now,
    updatedAt: now,
    messages: []
  };
}

function readStoredState(value: unknown): StoredChatState {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    const session = createSession();
    return { activeSessionId: session.id, sessions: [session] };
  }

  const sessions = value.sessions
    .map(readSession)
    .filter((session): session is ChatSession => Boolean(session))
    .slice(0, MAX_SESSIONS);
  if (sessions.length === 0) {
    const session = createSession();
    return { activeSessionId: session.id, sessions: [session] };
  }

  const requestedActiveId = typeof value.activeSessionId === 'string' ? value.activeSessionId : '';
  const activeSessionId = sessions.some(session => session.id === requestedActiveId)
    ? requestedActiveId
    : sessions[0]!.id;
  return { activeSessionId, sessions };
}

function readSession(value: unknown): ChatSession | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.messages)) {
    return undefined;
  }
  const now = Date.now();
  const messages = value.messages
    .map(readMessage)
    .filter((message): message is ChatMessage => Boolean(message))
    .slice(-MAX_MESSAGES_PER_SESSION);
  return {
    id: value.id,
    title: typeof value.title === 'string' && value.title.trim() ? value.title : '新しいチャット',
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now,
    messages
  };
}

function readMessage(value: unknown): ChatMessage | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    (value.role !== 'user' && value.role !== 'assistant') ||
    typeof value.content !== 'string'
  ) {
    return undefined;
  }
  return {
    id: value.id,
    role: value.role,
    content: value.content,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    status: value.status === 'error' ? 'error' : 'complete'
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createTitle(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() || '新しいチャット';
  return firstLine.length > 36 ? `${firstLine.slice(0, 35)}…` : firstLine;
}

function extractResponseText(response: XAIResponse): string {
  const chunks: string[] = [];
  for (const item of response.output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string') {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join('');
}

function formatError(error: unknown): string {
  if (error instanceof XAIClientError) {
    if (error.status === 401 || error.status === 403) {
      return 'APIキーを確認してください。';
    }
    if (error.status === 429) {
      return 'xAI APIの利用上限に達しました。時間を置いて再試行してください。';
    }
    return error.message;
  }
  return error instanceof Error ? error.message : '不明なエラーが発生しました。';
}

function createWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.js'));
  return /* html */ `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <link rel="stylesheet" href="${cssUri}">
  <title>Grok Code</title>
</head>
<body>
  <main class="app">
    <header class="header">
      <div class="brand">GROK</div>
      <div class="header-actions">
        <button class="icon-button" id="nativeChat" title="VS Code Agentで開く" aria-label="VS Code Agentで開く">⌁</button>
        <button class="icon-button" id="settings" title="APIキー設定" aria-label="APIキー設定">⚙</button>
        <button class="icon-button" id="newChat" title="新しいチャット" aria-label="新しいチャット">＋</button>
      </div>
    </header>
    <section class="history" id="history">
      <button class="history-heading" id="historyToggle"><span class="chevron">▼</span><span>Chats</span></button>
      <div class="history-list" id="historyList"></div>
      <button class="show-all hidden" id="showAll"></button>
    </section>
    <section class="conversation" id="conversation" aria-live="polite"></section>
    <div class="api-notice hidden" id="apiNotice"><span>xAI APIキーが未設定です</span><button id="configureApiKey">設定</button></div>
    <div class="composer-wrap">
      <div class="composer">
        <textarea id="prompt" rows="1" maxlength="${MAX_INPUT_LENGTH}" placeholder="Grokにメッセージを送信" aria-label="メッセージ"></textarea>
        <div class="composer-footer">
          <span class="model" id="model">Grok</span>
          <button class="send" id="send" title="送信" aria-label="送信">↑</button>
        </div>
      </div>
    </div>
  </main>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
