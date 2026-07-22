import * as vscode from 'vscode';

const SECRET_KEY = 'grokCode.xaiApiKey';
const CONTINUE = '理解して続行';

export class ApiKeyManager implements vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidChange = this.changedEmitter.event;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.disposables.push(
      this.secrets.onDidChange(event => {
        if (event.key === SECRET_KEY) {
          this.changedEmitter.fire();
        }
      })
    );
  }

  async get(silent: boolean): Promise<string | undefined> {
    const existing = await this.secrets.get(SECRET_KEY);
    if (existing || silent) {
      return existing;
    }

    const configured = await this.configure();
    return configured ? this.secrets.get(SECRET_KEY) : undefined;
  }

  async has(): Promise<boolean> {
    return Boolean(await this.secrets.get(SECRET_KEY));
  }

  async configure(): Promise<boolean> {
    const consent = await vscode.window.showWarningMessage(
      'Chatへ追加したプロンプト、コード、画像、ツール結果は、応答生成のためxAI APIへ送信されます。API利用料金は設定したxAIアカウントに発生します。',
      { modal: true },
      CONTINUE
    );
    if (consent !== CONTINUE) {
      return false;
    }

    const value = await vscode.window.showInputBox({
      title: 'Grok Code Agent — xAI APIキー',
      prompt: 'xAI Consoleで作成したAPIキーを入力してください',
      placeHolder: 'xai-…',
      password: true,
      ignoreFocusOut: true,
      validateInput: input => {
        const trimmed = input.trim();
        if (!trimmed) {
          return 'APIキーを入力してください。';
        }
        if (trimmed.length < 12) {
          return 'APIキーが短すぎます。';
        }
        return undefined;
      }
    });

    if (!value) {
      return false;
    }

    await this.secrets.store(SECRET_KEY, value.trim());
    void vscode.window.showInformationMessage('xAI APIキーを安全なSecret Storageへ保存しました。');
    return true;
  }

  async clear(confirm = true): Promise<boolean> {
    if (!(await this.has())) {
      void vscode.window.showInformationMessage('保存済みのxAI APIキーはありません。');
      return false;
    }

    if (confirm) {
      const remove = '削除';
      const selected = await vscode.window.showWarningMessage(
        '保存済みのxAI APIキーを削除しますか？',
        { modal: true },
        remove
      );
      if (selected !== remove) {
        return false;
      }
    }

    await this.secrets.delete(SECRET_KEY);
    void vscode.window.showInformationMessage('xAI APIキーを削除しました。');
    return true;
  }

  async manage(): Promise<void> {
    if (!(await this.has())) {
      await this.configure();
      return;
    }

    const selected = await vscode.window.showQuickPick(
      [
        { label: '$(key) APIキーを更新', action: 'configure' as const },
        { label: '$(trash) APIキーを削除', action: 'clear' as const },
        { label: '$(link-external) xAI Consoleを開く', action: 'console' as const }
      ],
      {
        title: 'Grok Code Agent — APIキー管理',
        placeHolder: '操作を選択してください'
      }
    );

    if (selected?.action === 'configure') {
      await this.configure();
    } else if (selected?.action === 'clear') {
      await this.clear();
    } else if (selected?.action === 'console') {
      await vscode.env.openExternal(vscode.Uri.parse('https://console.x.ai/'));
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changedEmitter.dispose();
  }
}
