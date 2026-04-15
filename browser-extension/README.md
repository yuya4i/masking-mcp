# Local Mask MCP — Browser Extension (Phase 1)

Chrome MV3 extension that masks PII in outbound AI-service traffic
before it leaves the browser. Targets Claude.ai, ChatGPT, Gemini,
and Manus. Requires the `local-mask-mcp` gateway running at
`http://127.0.0.1:8081`.

## Install (developer mode)

1. Start the gateway so the extension has something to talk to:

   ```bash
   cd /path/to/mask-mcp
   make up
   ```

   Wait for `ok (<N>s)` — this means `/health` is up.

2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave:
   `brave://extensions`).

3. Enable **Developer mode** (top-right toggle).

4. Click **Load unpacked** and pick this directory
   (`browser-extension/`). The extension icon should appear in the
   toolbar with a blue `M` glyph.

5. Visit <https://claude.ai/> (or a supported service below). Open
   the browser devtools console and look for:

   ```
   [mask-mcp] content script installed on claude.ai
   [mask-mcp] injected hooks installed on claude.ai
   ```

6. Type a message containing PII (e.g. `田中太郎に連絡`). The
   extension icon badge should increment; the masked payload is what
   actually leaves your browser.

## Supported services

| Service | URL pattern | Status |
|---|---|---|
| Claude.ai | `claude.ai`, `*.claude.com` | working |
| ChatGPT | `chatgpt.com`, `chat.openai.com` | partial — needs manual tuning |
| Gemini | `gemini.google.com` | partial — `f.req` form is read-only |
| Manus | `manus.im`, `*.manus.im` | partial — schema drifts often |

Claude.ai is the primary target. The other three use best-effort
adapters; if you hit a missed case, the `console.debug` logs in
devtools will show `[mask-mcp]` entries tagged with the adapter
name — grep for those when reporting adapter bugs.

## Interactive review mode

Interactive mode is **ON by default**. Before an intercepted fetch
leaves the browser, a Shadow-DOM-isolated panel shows every
detection the gateway returned and lets you un-tick false
positives. Press `Enter` (or click the primary button) to send the
masked payload; press `Esc` (or the secondary button) to abort the
request entirely.

There are now **two UI modes** to pick between in the popup
(`UI モード`):

- **サイドバー (推奨)** — Milestone 8 Wave B default. Right-side
  fixed panel with category-grouped, aggregated rows.
- **モーダル (従来)** — Phase 2 modal, one row per occurrence.

Both modes call the same gateway under the hood; only the rendering
and the request endpoint differ:

| | サイドバーモード | モーダルモード |
|---|---|---|
| Endpoint | `POST /v1/extension/sanitize/aggregated` | `POST /v1/extension/sanitize` |
| Per-row granularity | One row per unique `(category, value)` pair (e.g. `田中太郎 (2件)`) | One row per occurrence |
| Category grouping | ▾ collapsible section per big category with a tri-state parent toggle | flat list |
| Force-mask lock | 🔒 icon + disabled checkbox for categories the gateway forced via `force_mask_keywords` | n/a |
| Bulk actions | すべて選択 / すべて解除 | n/a |
| Live preview | ✓ updates client-side on every checkbox change | n/a |

### サイドバーモード

```
┌───────────────────────────────────────────────────────────┐
│ マスク対象の確認                                       ×  │
│───────────────────────────────────────────────────────────│
│ [すべて選択]  [すべて解除]                                │
│                                                           │
│ ▼ PERSON 🔒 (3件)                              [■]       │
│     ☑ 田中太郎 (2件) [PROPER_NOUN_PERSON] 🔒              │
│     ☑ 山田花子 (1件) [KATAKANA_NAME]      🔒              │
│                                                           │
│ ▼ CONTACT (2件)                                [■]       │
│     ☑ foo@example.com (1件) [EMAIL_ADDRESS]              │
│     ☑ 〒651-0087 (1件)      [POSTAL_CODE]                │
│                                                           │
│ ▼ FINANCIAL 🔒 (1件)                           [■]       │
│     ☑ 年収1200万円 (1件) [ANNUAL_INCOME]  🔒              │
│                                                           │
│ ──────────────────────────────────────────────            │
│ プレビュー                                                │
│ ┌───────────────────────────────────────────────────────┐ │
│ │ <PROPER_NOUN_PERSON>は<EMAIL_ADDRESS>まで連絡。       │ │
│ │ <ANNUAL_INCOME>。〒<POSTAL_CODE>                      │ │
│ └───────────────────────────────────────────────────────┘ │
│                                                           │
│ [キャンセル (Esc)]  [選択したものをマスクして送信 (Enter)]│
└───────────────────────────────────────────────────────────┘
```

* **Aggregated rows** — `田中太郎 (2件)` is one row, not two. Only
  one toggle per unique `(category, value)` pair.
* **Category-level toggle** — tri-state checkbox flips every row
  beneath it.
* **🔒 Lock icon** — categories listed in
  `force_masked_categories` (gateway-side
  `RuntimeConfig.force_mask_keywords` triggered by 機密 / 未公開 /
  リーク / `confidential` / `leak`) cannot be unchecked.
* **Live preview** at the bottom shows the final `<TAG>`-style
  output as you toggle. Pure client-side, no extra fetches.

### モーダルモード (従来)

```
+---------------------------------------------------+
| マスク対象の確認                                  |
| 以下の項目がマスクされます…                       |
|---------------------------------------------------|
| [x] [EMAIL]    hogehoge@fugafuga.fizz  → <EMAIL>  |
|     …連絡先 [hogehoge@fugafuga.fizz] まで…        |
| [x] [PERSON]   タカハシユウヤ       → <PERSON>    |
|     [タカハシユウヤ]と申します…                   |
| [ ] [COMPANY]  プロジェクト        → <COMPANY>    |
|     …開発中の[プロジェクト]名は…                  |
|---------------------------------------------------|
|       [キャンセル (Esc)]  [マスクして送信 (Enter)]|
+---------------------------------------------------+
```

Both surfaces attach to `document.body` via a throwaway `<div>` with
`attachShadow({mode: 'open'})` and `z-index: 2147483647`, so the
host page's DOM and CSS are unaffected. When dismissed the overlay
is removed completely.

Toggle from the popup:

- **Masking enabled** — master on/off (same as before).
- **送信前に確認する (インタラクティブ・モード)** — when off the
  review UI is skipped and the gateway-sanitised payload is sent
  automatically (Phase 1 behaviour).
- **UI モード** — radio between サイドバー and モーダル. Default
  サイドバー.

Colour-coded badges per entity category:

| Colour | Categories |
|---|---|
| red | API_KEY, SECRET, EMAIL_ADDRESS, CREDIT_CARD, MY_NUMBER, PASSPORT, DRIVERS_LICENSE, BANK_ACCOUNT, DB_CONNECTION, PHONE_NUMBER |
| orange | PERSON, PROPER_NOUN*, KATAKANA_NAME |
| blue | LOCATION, PROPER_NOUN_LOCATION, PROPER_NOUN_ORG, ADDRESS, COMPANY |
| grey | anything else (future analyzer entity types) |

Keyboard:

- `Enter` — confirm with the currently-ticked selection
- `Esc` — cancel, abort the send
- `Tab` / `Shift-Tab` — cycle focus through checkboxes + buttons
- `Space` — toggle the focused checkbox

## Known limitations

- Non-JSON request bodies (FormData, multipart) are passed through
  untouched. Every supported service uses `application/json` for
  user-text today, but this will need extending if a future service
  uses protobuf/gRPC.
- Streaming responses are not intercepted in either direction. The
  hook only rewrites the outbound request body, not the assistant's
  reply. This is the intended Phase 1 scope (Q3 = 送信のみ).
- Gemini's Bard-frontend `f.req` parameter is complex nested JSON
  inside form-encoding; we extract the user text for the mask-count
  badge but do not rewrite it back, so Gemini submissions are
  detected-only until the Bard framing is safe to round-trip.
- No TLS interception. All masking happens in-browser.

## Uninstall

`chrome://extensions` → find "Local Mask MCP — PII Guard" → Remove.

## Files

```
browser-extension/
  manifest.json      MV3 manifest (host_permissions, scripts, icons)
  content.js         Isolated-world bridge (chrome.* access + postMessage relay)
  injected.js        Main-world fetch/XHR hooks + per-service adapters
                     + dispatch by uiMode (sidebar | modal)
  review-modal.js    Main-world Shadow-DOM modal for per-detection review
                     (used when uiMode === "modal")
  sidebar.js         Main-world Shadow-DOM sidebar for aggregated review
                     (used when uiMode === "sidebar", default)
  background.js      Service worker — badge + per-tab counts + storage seed
                     (seeds enabled / interactive / uiMode)
  popup.html/css/js  Toolbar popup (enabled toggle, interactive toggle,
                     UI mode radio, gateway health, count)
  icons/             16/48/128 px RGBA PNGs (generated from scripts/)
  scripts/
    generate-icons.py Regenerate icons inside local-mask-mcp:latest container
```
