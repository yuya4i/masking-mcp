# Privacy Policy — Local Mask MCP (PII Guard)

**Last updated:** 2026-04-15

## Summary (English)

Local Mask MCP is a browser extension that detects and masks personal
information (PII) in the text you send to AI chat services — Claude,
ChatGPT, Gemini, Manus — **before** that text leaves your browser.

We collect nothing. We send nothing anywhere. Every byte of processing
happens on your own computer.

---

## 要約 (日本語)

Local Mask MCP は、Claude / ChatGPT / Gemini / Manus などの AI チャット
サービスに送信するテキストを、ブラウザから外部に出る**前**にブラウザ上で
検出・マスクする拡張機能です。

- **送信データ: なし** — すべての処理はお客様のブラウザ内で完結します。
- **収集データ: なし** — 拡張機能は外部サーバーに何も送りません。
- **保存データ: ローカルブラウザストレージのみ** — 設定 (マスクの
  有効/無効、対応サイト別の挙動など) だけを `chrome.storage.local` に
  保存します。テキスト本文や検出結果は保存しません。

---

## 1. Data we collect

**None.**

Specifically:

- No text you type is sent to any server under our control.
- No browsing history, cookies, authentication tokens, or account
  information of any site you visit is read or transmitted.
- No analytics, telemetry, error reporting, or usage statistics are
  collected.

## 2. Data we store

Local Mask MCP persists a small number of user preferences to
`chrome.storage.local` so your choices survive browser restarts:

| Key | Purpose |
|---|---|
| `enabled` | Global on/off toggle for the extension |
| `interactive` | Whether the review UI appears before sending |
| `uiMode` | `"sidebar"` (default) or `"modal"` review experience |
| `mask_mcp_pref_hybrid` | `"auto"` (default) / `"standalone"` / `"gateway"` |

`chrome.storage.local` data stays in your browser profile; it is not
synced to Google or transmitted anywhere by the extension.

## 3. Data flow (what actually happens on the page)

When you type a message into a supported AI chat service and press Send:

1. The extension intercepts the outgoing network request in your browser.
2. The message text is scanned locally using the pure-JavaScript
   masking engine bundled with the extension (Phase 1) or optionally
   a locally-running gateway at `http://127.0.0.1:8081` that you
   start yourself (Hybrid mode).
3. Detected PII (emails, phone numbers, API keys, postal codes, etc.)
   is replaced with placeholders like `<EMAIL_ADDRESS_1>` before the
   request continues to the AI provider.
4. The AI provider receives the masked text. The extension itself
   never forwards anything to third parties on your behalf.

The **optional local gateway** is a separate Docker service you install
voluntarily on your own machine. It binds to the loopback address
`127.0.0.1:8081` only — it is not reachable from the internet. If you
choose not to run it, the extension uses its built-in JavaScript engine
instead.

## 4. Third-party sharing

None. We do not sell, share, license, rent, or otherwise disclose any
information to anyone.

## 5. Host permissions

The extension requests `host_permissions` only for the AI chat sites it
supports:

- `https://claude.ai/*` / `https://*.claude.com/*`
- `https://chatgpt.com/*` / `https://*.openai.com/*`
- `https://gemini.google.com/*`
- `https://*.manus.im/*`
- `http://127.0.0.1:8081/*` (loopback only, for the optional local gateway)

These are the sites where PII masking actually needs to run. The
extension does not request `<all_urls>` or any broader access.

## 6. Your rights and choices

- **Disable any time.** Toggle the extension off from the popup, or
  uninstall it from `chrome://extensions`.
- **Data deletion.** Uninstalling the extension removes all its
  `chrome.storage.local` data automatically.
- **Inspect the code.** The extension is open source; you can audit
  exactly what it does at
  [`github.com/…/local-mask-mcp`](https://github.com/) (replace with
  your actual repo URL before publishing to the Chrome Web Store).
- **No account.** There is no registration, no login, no account to
  create or delete.

## 7. Children's privacy

The extension does not intentionally collect or process data from
users under 13. Because we collect no data at all, there is no child-
specific data flow to address.

## 8. Changes to this policy

If this policy changes, the updated version will be published in the
same repository. The "Last updated" date at the top reflects the most
recent revision. Because there is no data to collect, changes will
generally be clarifications rather than scope expansions.

## 9. Contact

Questions, concerns, or false-positive reports:

- GitHub Issues: https://github.com/ (update to your actual repo URL)
- Or the email address on your Chrome Web Store listing.

---

## Publishing this policy on GitHub Pages

The Chrome Web Store requires a public URL for the privacy policy.
The steps to host this file via GitHub Pages:

1. In your GitHub repo settings → **Pages**, set the source branch to
   `main` (or whatever you use for releases) and the folder to
   `/docs`.
2. Click **Save**. GitHub will build a Pages site at
   `https://<user>.github.io/<repo>/privacy-policy` (the `.md`
   extension is stripped by Jekyll).
3. Verify the URL returns HTTP 200 with the rendered policy before
   submitting to the Chrome Web Store.
4. Paste that URL into the **Privacy policy URL** field of the
   Developer Dashboard submission form.

Optional: add a `docs/_config.yml` with a theme (`theme: jekyll-theme-cayman`)
so the rendered page looks less like raw Markdown.
