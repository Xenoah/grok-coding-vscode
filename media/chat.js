const vscode = acquireVsCodeApi();
const elements = {
  history: document.getElementById('history'),
  historyList: document.getElementById('historyList'),
  showAll: document.getElementById('showAll'),
  conversation: document.getElementById('conversation'),
  apiNotice: document.getElementById('apiNotice'),
  prompt: document.getElementById('prompt'),
  send: document.getElementById('send'),
  model: document.getElementById('model')
};
let state = {
  sessions: [],
  activeSessionId: '',
  apiConfigured: false,
  busy: false,
  model: 'Grok'
};
let showAllChats = false;

document.getElementById('newChat').addEventListener('click', () => {
  vscode.postMessage({ type: 'newChat' });
});
document.getElementById('settings').addEventListener('click', () => {
  vscode.postMessage({ type: 'configureApiKey' });
});
document.getElementById('configureApiKey').addEventListener('click', () => {
  vscode.postMessage({ type: 'configureApiKey' });
});
document.getElementById('nativeChat').addEventListener('click', () => {
  vscode.postMessage({ type: 'openNativeChat' });
});
document.getElementById('historyToggle').addEventListener('click', () => {
  elements.history.classList.toggle('collapsed');
});
elements.showAll.addEventListener('click', () => {
  showAllChats = !showAllChats;
  renderHistory();
});
elements.send.addEventListener('click', submitOrStop);
elements.prompt.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submitOrStop();
  }
});
elements.prompt.addEventListener('input', resizePrompt);

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'state') {
    state = message;
    render();
  } else if (message.type === 'delta' && message.sessionId === state.activeSessionId) {
    const session = state.sessions.find(item => item.id === message.sessionId);
    const target = session?.messages.find(item => item.id === message.messageId);
    if (target) {
      target.content += message.delta;
    }
    const selector = `[data-message-id="${CSS.escape(message.messageId)}"] .message-content`;
    const content = document.querySelector(selector);
    if (content) {
      renderMessageContent(content, target || { role: 'assistant', content: message.delta });
      scrollToBottom();
    }
  }
});

function submitOrStop() {
  if (state.busy) {
    vscode.postMessage({ type: 'stop' });
    return;
  }
  if (!state.apiConfigured) {
    vscode.postMessage({ type: 'configureApiKey' });
    return;
  }
  const text = elements.prompt.value.trim();
  if (!text) {
    return;
  }
  vscode.postMessage({ type: 'send', text });
  elements.prompt.value = '';
  resizePrompt();
}

function resizePrompt() {
  elements.prompt.style.height = 'auto';
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 160)}px`;
}

function render() {
  renderHistory();
  renderConversation();
  elements.apiNotice.classList.toggle('hidden', state.apiConfigured);
  elements.model.textContent = `${state.model}${state.busy ? ' · 生成中' : ''}`;
  elements.send.classList.toggle('stop', state.busy);
  elements.send.textContent = state.busy ? '■' : '↑';
  elements.send.title = state.busy ? '停止' : '送信';
  elements.send.setAttribute('aria-label', state.busy ? '生成を停止' : '送信');
}

function renderHistory() {
  elements.historyList.replaceChildren();
  const visible = showAllChats ? state.sessions : state.sessions.slice(0, 5);
  for (const session of visible) {
    const row = document.createElement('div');
    row.className = `history-row${session.id === state.activeSessionId ? ' active' : ''}`;

    const select = document.createElement('button');
    select.className = 'history-select';
    select.textContent = session.title;
    select.title = session.title;
    select.addEventListener('click', () => {
      vscode.postMessage({ type: 'selectChat', sessionId: session.id });
    });

    const remove = document.createElement('button');
    remove.className = 'history-delete';
    remove.textContent = '×';
    remove.title = 'チャットを削除';
    remove.setAttribute('aria-label', `${session.title}を削除`);
    remove.addEventListener('click', event => {
      event.stopPropagation();
      vscode.postMessage({ type: 'deleteChat', sessionId: session.id });
    });

    row.append(select, remove);
    elements.historyList.append(row);
  }
  const hasMore = state.sessions.length > 5;
  elements.showAll.classList.toggle('hidden', !hasMore);
  elements.showAll.textContent = showAllChats
    ? '最近の5件を表示'
    : `すべて表示 (${state.sessions.length})`;
}

function renderConversation() {
  elements.conversation.replaceChildren();
  const session = state.sessions.find(item => item.id === state.activeSessionId);
  if (!session || session.messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const mark = document.createElement('div');
    mark.className = 'empty-mark';
    mark.textContent = 'G';
    const title = document.createElement('p');
    title.className = 'empty-title';
    title.textContent = 'Grok Code';
    const subtitle = document.createElement('div');
    subtitle.className = 'empty-subtitle';
    subtitle.textContent = 'コードの相談、説明、設計をこの画面から始められます。';
    empty.append(mark, title, subtitle);
    elements.conversation.append(empty);
    return;
  }

  for (const message of session.messages) {
    const article = document.createElement('article');
    article.className = `message ${message.role}${message.status === 'error' ? ' error' : ''}`;
    article.dataset.messageId = message.id;
    const role = document.createElement('div');
    role.className = 'message-role';
    role.textContent = message.role === 'user' ? 'You' : 'Grok';
    const content = document.createElement('div');
    content.className = 'message-content';
    renderMessageContent(content, message);
    article.append(role, content);
    if (message.status === 'streaming' && !message.content) {
      const typing = document.createElement('span');
      typing.className = 'typing';
      typing.append(
        document.createElement('i'),
        document.createElement('i'),
        document.createElement('i')
      );
      content.append(typing);
    }
    elements.conversation.append(article);
  }
  requestAnimationFrame(scrollToBottom);
}

function renderMessageContent(container, message) {
  container.replaceChildren();
  if (message.role !== 'assistant' || !message.content.includes('```')) {
    container.textContent = message.content;
    return;
  }

  const fence = /```([^\n`]*)\n?([\s\S]*?)(```|$)/g;
  let cursor = 0;
  for (const match of message.content.matchAll(fence)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      container.append(document.createTextNode(message.content.slice(cursor, index)));
    }
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    const language = match[1].trim();
    if (language) {
      code.dataset.language = language;
      pre.title = language;
    }
    code.textContent = match[2];
    pre.append(code);
    container.append(pre);
    cursor = index + match[0].length;
  }
  if (cursor < message.content.length) {
    container.append(document.createTextNode(message.content.slice(cursor)));
  }
}

function scrollToBottom() {
  elements.conversation.scrollTop = elements.conversation.scrollHeight;
}

vscode.postMessage({ type: 'ready' });
