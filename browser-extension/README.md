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
  background.js      Service worker — badge + per-tab counts
  popup.html/css/js  Toolbar popup (enabled toggle, gateway health, count)
  icons/             16/48/128 px RGBA PNGs (generated from scripts/)
  scripts/
    generate-icons.py Regenerate icons inside local-mask-mcp:latest container
```
