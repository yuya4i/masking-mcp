# プライバシーポリシー — PII Guard

最終更新: 2026-04-18 (v0.5.0 ローカル LLM 連携 対応)

## 概要

PII Guard (本拡張機能) は、ブラウザで AI チャットサービスを利用する際に、送信前のテキストから個人情報 (PII) を検出してマスキングする目的で動作します。**既定では、すべての処理はあなたのブラウザ内で完結し、拡張機能の開発者および第三者への通信は一切行いません。**

**ユーザーが明示的に有効化した場合に限り**、オプション画面で指定された**ローカル/LAN 上の LLM サーバー** (Ollama / LM Studio / llama.cpp 等) に対してのみ、検出・置換のためのテキストを送信します。送信先はあなたが明示的に入力した URL に限定され、`chrome-extension://` ドメインからそれ以外のホストへは送信できません (Service Worker による host-lock 検証)。

## 収集する情報

### ローカルストレージに保存する情報

`chrome.storage.local` API 経由で以下を保存します:

| キー | 内容 | 目的 |
|---|---|---|
| `enabled` | マスキング機能の ON/OFF | ユーザー設定の永続化 |
| `interactive` | 送信前確認モードの ON/OFF | 同上 |
| `uiMode` | サイドバー / モーダルの選択 | 同上 |
| `maskAllowlist` | マスキング除外する文字列の配列 | 同上 |
| `mask_mcp_pref_hybrid` | エンジン動作モード | 同上 |
| `localLlmEnabled` (v0.5.0+) | ローカル LLM 連携の ON/OFF | 既定 `false` |
| `localLlmUrl` (v0.5.0+) | ユーザー指定の LLM サーバー URL | 空または未設定なら LLM 連携は動作しない |
| `localLlmModel` (v0.5.0+) | 使用モデル名 | 例: `qwen3:4b` |
| `localLlmMode` (v0.5.0+) | 動作モード (`detect` / `replace`) | 既定 `detect` |
| `localLlmTimeoutMs` (v0.5.0+) | LLM タイムアウト (ms) | 既定 120000 |
| `localLlmKind` (v0.5.0+) | LLM サーバーの API 形式 (`ollama` / `openai-compat`) | 接続確認で自動判定 |

これらはすべてあなたの端末内の Chrome ストレージにのみ保存され、本拡張機能の開発者を含む第三者がアクセスすることはありません。

### 一時的にメモリで扱う情報

- AI チャット入力時の本文テキスト (PII 検出のため)
- 検出された PII の位置・種類・重要度
- タブごとのマスク件数 (バッジ表示用)

これらの情報は **ブラウザのメモリ内にのみ存在し**、ファイルや外部サービスには一切送信・保存しません。

## 外部送信

**既定では送信しません。** 本拡張機能は初期状態で完全オフラインで動作し、PII 検出ロジックはすべて拡張機能内にバンドルされた JavaScript コードで実行されます。リモート CDN からのコード読み込みも行いません。

対象 AI サービス (claude.ai / chatgpt.com / openai.com / gemini.google.com / manus.im) **本来の通信** はそのまま通過させますが、その通信はあなたとそのサービス間の直接接続であり、本拡張機能の開発者には届きません。

## ローカル LLM 連携 (v0.5.0+)

v0.5.0 以降、オプション画面でユーザーが明示的に有効化した場合に限り、次の 1 つだけ例外的な外部通信が発生します:

- **送信先**: オプション画面 `エンドポイント URL` にユーザーが入力した URL (例: `http://localhost:11434`)
- **送信内容**: 検出または置換対象のテキスト本文、および検出指示用のシステムプロンプト
- **送信プロトコル**: HTTP POST (`/api/chat` または `/v1/chat/completions`)
- **送信タイミング**: AI チャット画面で送信するメッセージ 1 件ごとに 1 回
- **送信しない情報**: 閲覧しているページの URL、Cookie、タブ情報、他のタブの内容、アカウント情報
- **許可するホスト**: `chrome.storage.local.localLlmUrl` に保存された URL のホスト/プロトコルと完全一致するもののみ。Service Worker が受信する `LLM_FETCH` メッセージを host-lock で検証し、他ホストへの転用は物理的に不可能です (違反時は `forbidden: host mismatch` でリジェクト)。
- **拡張機能 ID 検証**: Service Worker は `sender.id !== chrome.runtime.id` のメッセージをすべて拒否するため、他の拡張機能から本拡張のプロキシを悪用することはできません。
- **デフォルトでは無効**: `localLlmEnabled: false` が初期値。ユーザーが自発的にトグルを ON にするまで一切の外部通信は発生しません。
- **本拡張機能の開発者には届きません**: 送信先はあなたが指定した自宅/社内 PC 上の Ollama 等であり、拡張機能の開発者が運営するサーバーは含まれません。

このローカル LLM 連携を無効化したい場合は、オプション画面の「LLM 補助検出を有効化」スイッチを OFF にしてください。`localLlmUrl` を空に戻しても連携は無効化されます。

## 必要な権限

| 権限 | 用途 |
|---|---|
| `storage` | 上記の設定・除外リスト保存 |
| `activeTab` | アクティブタブのマスク件数を拡張アイコンに表示 |
| `host_permissions` (claude.ai, chatgpt.com, *.openai.com, gemini.google.com, *.manus.im) | これら 5 サービス上での content script 注入 (他サイトでは一切動作しません) |
| `host_permissions` (`http://*/*`, v0.5.0-dev のみ) | ユーザーが指定したローカル/LAN 上の LLM サーバーへの HTTP 接続を行うため。**Service Worker は `chrome.storage.local.localLlmUrl` と一致するホストのみ許可**します。未指定または `localLlmEnabled: false` の場合、この権限は実行時に使用されません |

## データの保持と削除

- ストレージに保存された設定・除外リストは、Chrome の通常の拡張機能管理 UI から拡張機能をアンインストールすると同時に削除されます
- 拡張機能内 options ページから「全削除」ボタンで除外リストを即時クリアできます

## 第三者への提供

提供しません。

## 子供のプライバシー

本拡張機能は 13 歳未満の子供を対象としていません。

## 変更履歴

このプライバシーポリシーが変更された場合、本拡張機能のリポジトリ (https://github.com/yuya4i/pii-masking) の `browser-extension/PRIVACY.md` を更新します。

## 連絡先

質問や懸念がある場合は、リポジトリの issue として報告してください:
https://github.com/yuya4i/pii-masking/issues
