# Changelog

## 0.3.0 — Severity colors + long-press critical guard (2026-04-15)

Wave C of Milestone 7/8 — frontend + backend half of the new
severity tiering. Gateway-side schema field lands alongside.

- `sidebar.js` — every row carries a left coloured border
  matching `entity.severity` (red `#dc2626` / orange `#f97316`
  / amber `#eab308` / gray `#6b7280`) plus a
  `[critical|high|medium|low]` pill after the entity label.
  Category headers render at the worst severity of their
  children. Critical rows replace the native checkbox with a
  custom `<svg>`-based long-press control: press and hold 800 ms
  (50 ms tick animation on `stroke-dashoffset`) to toggle. Early
  release / pointer leave / cancel resets the ring without
  toggling. Works on touch via `pointer*` events. When a
  critical row is ALSO in `force_masked_categories` the control
  is replaced with a disabled lock glyph. Bulk "すべて解除"
  now confirms with a native `window.confirm` and only clears
  non-critical / non-locked rows on accept.
- `review-modal.js` — same severity palette + long-press guard
  for parity. Rows sort severity-first (critical → low) so the
  riskiest detections float to the top while original detection
  indices are preserved for `collectSelected`.
- `manifest.json` — version bumped to `0.3.0`.

## 0.2.0 — UI masking control layer (2026-04-15)

Wave B of Milestone 8 — frontend half of the new aggregated
detection layer. Wave A (backend aggregation, force-mask trigger,
15 new business-document presets) shipped on `main` immediately
before this.

- `sidebar.js` (new) — Shadow-DOM-scoped right-side panel at
  `z-index: 2147483647` on `document.body`. Hand-rolled CSS
  variables (indigo `#4f46e5`, danger `#dc2626`, gray `#f9fafb`,
  rounded-xl `12px`, `0 10px 25px rgba(0,0,0,0.12)` shadow). Slide-in
  animation via `transform: translateX(...)`. Click-outside on the
  semi-transparent overlay does NOT auto-cancel — explicit
  Confirm/Cancel only. Renders one row per unique
  `(category, value)` pair with a `(N件)` count badge instead of
  listing every occurrence. Tri-state category checkboxes,
  per-row checkboxes, bulk すべて選択 / すべて解除, plus a live
  preview pane that re-applies tag substitutions client-side on
  every checkbox change. Categories listed in
  `force_masked_categories` show 🔒 and have their checkboxes
  `disabled` so neither row nor parent toggle nor bulk actions
  can ever uncheck them. Focus trap wraps Tab through the panel;
  Enter confirms; Esc cancels. No `innerHTML` on untrusted
  strings.
- `injected.js` — dispatch layer reads
  `window.__localMaskMCP.settings.uiMode` (default `"sidebar"`)
  on every intercept and routes to the matching helper:
  - `"sidebar"` → `POST /v1/extension/sanitize/aggregated` then
    `sidebar.show(aggResp, originalText)`. Result is a flat
    `[start, end, label]` triple list fed into the new
    `applyTriples()` helper (back-to-front substitution).
  - `"modal"` → unchanged Phase 2 path (`/sanitize` then
    `reviewModal.show(...)`).
  - Either UI helper missing or `interactive: false` → auto-mask
    via the gateway-sanitised text.
- `content.js` — inject `sidebar.js` between `review-modal.js`
  and `injected.js` so both helpers exist before the first fetch.
  Adds `GATEWAY_AGGREGATED_URL` + a new
  `handleSanitizeAggregated` bridge sharing a `callGateway()`
  helper with the legacy handler. Settings broadcast now
  includes `uiMode` and re-fires when either
  `interactive` or `uiMode` changes in `chrome.storage`.
- `popup.html` / `popup.css` / `popup.js` — new `UI モード` radio
  group (`サイドバー` / `モーダル`). Defaults to サイドバー and
  normalises any non-`modal` value back to サイドバー so a corrupt
  storage entry can never leave the radio blank.
- `background.js` — `onInstalled` seeds three keys (`enabled`,
  `interactive`, `uiMode`) instead of two; `uiMode` defaults
  `"sidebar"`.
- `manifest.json` — adds `sidebar.js` to
  `web_accessible_resources`. Version bumped to `0.2.0`.

## 0.1.1 — Interactive review UI (2026-04-15)

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
