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

The modal attaches to `document.body` via a throwaway `<div>` with
`attachShadow({mode: 'open'})` and `z-index: 2147483647`, so the
host page's DOM and CSS are unaffected. When dismissed the overlay
is removed completely.

Toggle interactive mode from the popup:

- **Masking enabled** — master on/off (same as before).
- **送信前に確認する (インタラクティブ・モード)** — when off the
  modal is skipped and the gateway-sanitised payload is sent
  automatically (Phase 1 behaviour).

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
  review-modal.js    Main-world Shadow-DOM modal for per-detection review
  background.js      Service worker — badge + per-tab counts + storage seed
  popup.html/css/js  Toolbar popup (enabled toggle, interactive toggle, gateway health, count)
  icons/             16/48/128 px RGBA PNGs (generated from scripts/)
  scripts/
    generate-icons.py Regenerate icons inside local-mask-mcp:latest container
```
