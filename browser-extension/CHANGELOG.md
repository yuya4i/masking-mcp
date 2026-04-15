# Changelog

## 0.2.0 — Interactive review UI (2026-04-15)

- `review-modal.js` (new) — Shadow-DOM-scoped overlay on
  `document.body` at `z-index: 2147483647`. Every gateway detection
  becomes a checkbox row with a colour-coded entity badge and a
  contextual snippet. Enter confirms, Esc cancels, Tab cycles focus.
  No `innerHTML` on untrusted strings: every node is built via
  `createElement` / `textContent`.
- `injected.js` — reads the `interactive` setting from
  `chrome.storage.local` (via postMessage from `content.js`) and,
  when on, awaits `reviewModal.show(detections, text)`. On confirm,
  rebuilds the masked payload client-side from the ticked indices
  using the `<ENTITY_TYPE>` tag strategy. On cancel, rejects the
  fetch / aborts the XHR so no payload leaves the browser.
- `content.js` — injects `review-modal.js` before `injected.js` and
  re-broadcasts the `interactive` setting on every
  `chrome.storage.onChanged`.
- `popup.html` / `popup.js` / `popup.css` — new "送信前に確認する
  (インタラクティブ・モード)" toggle, default ON. Popup widened
  from 260px to 300px for the Japanese label.
- `background.js` — seeds both `enabled` and `interactive` to
  `true` on first install.
- `manifest.json` — adds `review-modal.js` to
  `web_accessible_resources`.

## 0.1.0 — Phase 1 (2026-04-15)

Initial scaffolding.

- Chrome MV3 manifest targeting Claude.ai, ChatGPT, Gemini, Manus,
  and the local gateway at `127.0.0.1:8081`.
- Split content script + injected script pattern: `content.js` runs
  in the isolated world for `chrome.*` access; `injected.js` runs in
  the page's MAIN world and monkey-patches `window.fetch` and
  `XMLHttpRequest.prototype.send`.
- Per-service adapter registry with `match` / `extractInputs` /
  `replaceInputs`. Four adapters shipped: Claude.ai is the primary
  target; ChatGPT / Gemini / Manus are partial and flagged in the
  README.
- Service worker (`background.js`) keeps per-tab detection counts
  and renders them on the toolbar badge.
- Minimal popup — enabled toggle, gateway health probe, per-tab
  count, link to the gateway Swagger UI.
- Icons generated from Pillow inside the existing
  `local-mask-mcp:latest` runtime image; see
  `scripts/generate-icons.py`.

Depends on gateway-side `POST /v1/extension/sanitize` +
`CORSMiddleware` (both shipped in the same feature branch).
