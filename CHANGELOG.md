# Changelog

## 0.2.0 - 2026-07-22

- Added a dedicated Grok sidebar with persistent chat history.
- Added streaming responses, stop generation, chat creation, switching, and deletion.
- Kept VS Code's native Chat available for agent tools, approvals, and diffs.
- Fixed dedicated chats stopping after the first response by preserving encrypted reasoning state locally for `store: false` follow-up turns.
- Added thinking spinners, account-aware model selection, per-chat instructions, and an overflow menu.

## 0.1.0

- xAI Grok 4.5をVS Code標準Chatのモデルとして登録
- Chat / Agentモード、VS Code標準ツール、承認、差分レビューに対応
- Responses APIのSSEストリーミングとtool callingに対応
- `store: false`と暗号化済み推論の会話別引き継ぎに対応
- JPEG / PNGの画像入力と画像tool resultに対応
- 応答サイズ上限、キャンセル、途中終了時のtool call抑止を追加
- APIキーをVS Code Secret Storageへ保存
- low / medium / highの推論強度設定を追加
