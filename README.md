# Grok Code Agent

xAIの`Grok 4.5`を、VS CodeのChat / Agentへ追加するBYOK拡張機能です。

独自のチャット画面ではなく、VS CodeのネイティブUIとChat / Agent機能を利用します。以下の機能は本拡張が独自に実装するものではなく、利用中のVS Code Chatのバージョン、設定、プラン、組織ポリシーによって利用可否や表示が異なります。

- Agentモードとツール呼び出し
- Grok専用サイドバー（会話履歴、ストリーミング、生成停止）
- ファイル作成・編集とinline diff
- Keep / Undo・チェックポイント
- ターミナル実行や外部アクセスの承認
- Stop / Steer / Queue（対応する新しいVS Codeと実験設定で利用可能）
- 選択範囲、ファイル、画像などのコンテキスト
- Responses APIによるストリーミング

> xAI公式拡張ではありません。xAI APIの利用料金は利用者のアカウントに発生します。

## 必要なもの

- VS Code 1.104.0以降
- VS Code Chat / Agentを利用できる環境（VS Code側で必要なサインインやセットアップを含む）
- BYOKが許可されたプランまたは組織ポリシー（組織利用では管理者による許可が必要な場合があります）
- xAIアカウント、APIクレジット、APIキー

APIキーは[xAI Console](https://console.x.ai/)で作成できます。

## インストール

1. VS Codeで`Extensions: Install from VSIX...`を実行します。
2. `grok-code-agent-0.1.0.vsix`を選択します。
3. VS Codeから求められた場合は、ウィンドウを再読み込みします。
4. コマンドパレットから`Grok Code: APIキーを設定`を実行します。
5. アクティビティバーのGrokアイコン、またはコマンドパレットの`Grok Code: 専用チャットを開く`から専用チャットを開きます。
6. コード変更まで任せる場合はVS CodeのChatを開き、モデルピッカーから`xAI Grok > Grok 4.5`と`Agent`モードを選びます。

## 専用チャット

専用チャットでは、通常の質問やコード相談をGrokへ直接送信できます。会話履歴はVS Codeの拡張機能ストレージへ保存され、APIキーは従来どおりSecret Storageへ分離して保存されます。

- `Enter`で送信、`Shift+Enter`で改行
- 応答中の停止、新しいチャット、履歴の切り替えと削除
- `Grok Code: VS Code Agentで開く`でネイティブChatへ移動

専用チャットは会話用です。ファイル編集、ターミナル実行、承認、diffなどのAgent機能が必要な場合は、VS CodeのネイティブChatでGrokを選択してください。

Agentツールによるファイル編集、コマンド実行、外部アクセスは、利用中のVS Code Chatの承認設定に従います。xAI APIへの通信はこの承認画面の対象ではありません。

モデルが表示されない場合は、VS Code Chatが利用可能か、サインイン状態、BYOKに関するプランまたは組織ポリシー、保存したAPIキーを確認してください。Restricted Modeではモデル選択が制限される場合があります。

## 設定

| 設定 | 既定値 | 説明 |
| --- | ---: | --- |
| `grokCode.reasoningEffort` | `low` | 推論強度。`low` / `medium` / `high` |
| `grokCode.requestTimeoutMs` | `360000` | APIタイムアウト（ms） |
| `grokCode.maxOutputTokens` | `32768` | 1応答の最大出力トークン |

## セキュリティとプライバシー

- APIキーはSettings JSONではなくVS Code Secret Storageへ保存します。
- 拡張機能はファイルやシェルを独自実行しません。操作はVS Code Agentのツールと承認機構を通ります。
- APIキー設定時の同意後は、プロンプト、選択したコード、ツール結果、添付画像などが応答生成のため各リクエストで自動的にxAI APIへ送信されます。リクエストごとの承認画面は表示されません。
- APIリクエストは`store: false`を指定します。処理・保持条件はxAIの最新ポリシーも確認してください。
- Agentの連続tool callに必要な暗号化済み推論データと照合用のtool call識別情報を、会話ごとに分離して最大1時間メモリ内で引き継ぎます。VS Code終了時やAPIキー変更時にも破棄します。
- APIキーや会話本文をログ・telemetryへ記録しません。本拡張にはtelemetry自体がありません。

## 開発

Node.js 22以降を使用してください。

```bash
npm ci
npm run verify
npm run package
```

F5でExtension Development Hostを起動し、モデルピッカー、Agent tool call、承認、diff、キャンセルを確認してください。

## 仕組み

VS Codeの`LanguageModelChatProvider`へGrokを登録し、VS Codeのメッセージとツール定義をxAI Responses API形式へ変換します。Grokがtool callを返すと、それをVS Codeへ戻します。実際の承認・実行・差分表示はVS Codeが担当します。

## License

MIT
