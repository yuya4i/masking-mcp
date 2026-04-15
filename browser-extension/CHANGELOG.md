# Changelog

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
