# Changelog

## 0.5.0 — Local-LLM proxy + context-aware detection (2026-04-18)

End-to-end local-LLM augmentation. The extension can now route
outbound PII text through a user-configured Ollama / LM Studio /
llama.cpp server for contextual detection or tag-based
replacement. All traffic stays on the user's machine or LAN —
no extension author involvement.

### Highlights

- **Three operation modes** selectable in `options.html`:
    * `Regex のみ` — original v0.4 behaviour
    * `検出補助 (Regex + AI)` — LLM augments regex/Sudachi; entities
      with the same surface are replaced by LLM-labelled versions
    * `AI 置換 (実験的)` — LLM rewrites the full message into
      `<tag_N>` placeholders; outbound payload never contains the
      original text
- **Mode pill** in the sidebar header so the active dispatch is
  always visible at a glance.
- **Unique numbered tags** (`applyUniqueTagsToReplace` in
  injected.js): same surface → same tag, distinct values →
  distinct numbers. 1:1 mapping preserved for a future
  "restore tags in AI response" feature.
- **Model management panel**: 7 curated models with on-disk +
  VRAM chips, badges (軽量 / 推奨 / 高精度 / 最高精度 / 代替),
  one-click **ダウンロード** (streaming NDJSON with progress bar)
  and **削除** (`DELETE /api/delete`).

### Architecture

- Service worker proxy for every LLM call — bypasses Chrome's
  Private Network Access block and enforces sender-id + host-lock
  so the SW can't be repurposed as a generic proxy.
- `think: false` + `format: "json"` + `num_predict: 2048` in every
  Ollama request so Qwen3 thinking variants emit visible JSON.
- Two-tier retry budget: 6× warming-up on `500/503 "loading model"`,
  2× on AbortError.
- Inner bridge timeout = `cfg.timeoutMs × 3 + 30s` so the
  postMessage bridge outlives the SW retry loop.
- `_llmStatus` field (`failed` / `ok_empty` / `ok_entities`) lets
  the sidebar distinguish "LLM returned nothing" from "LLM never
  responded".

### UX

- In-sidebar centered overlay (not a top-right pill) for both
  analyze and replace paths, with double-ring pulsing spinner.
- Row stagger-in on reveal (80 ms × index).
- ✨ sparkle icon + purple `AI 検出` badge on LLM-detected rows.
- Final row interaction rules: long-press **only** on critical
  rows currently masked; everything else (incl. locked
  force-masked) is one-tap.
- Chat pane shrinks via `transform: translateZ(0)` +
  `contain: layout` on the wrapper so `position: fixed` composers
  respect the sidebar's reservation — always side-by-side,
  never covered.
- 4-column grid on each row — value / arrow / placeholder line
  up vertically across every entry. `text-overflow: ellipsis`
  on long values with `title` tooltip.
- `出現回数 N回` instead of `N件` for per-row counts.
- 🔒 lock icon only on category headers (not every row).
- Sidebar host gets `position: relative` + `z-index: 2147483647`
  + `isolation: isolate` so no chat CSS can overlay the panel.

### Detection

- Vendor-specific API-key regex coverage: OpenAI (`sk-proj-` /
  `sk-ant-` / etc.), Anthropic, Notion (`ntn_` + legacy
  `secret_`), GitHub (`ghp_` / `gho_` / `github_pat_`), Slack
  (`xox[baprs]-`), Google (`AIza…` / `ya29.`), AWS
  (`AKIA/ASIA/…`), Stripe, Twilio, SendGrid, Groq, Replicate,
  Tavily, GitLab (`glpat-`), Mailgun, npm, Fireworks, Airtable,
  Linear, Figma, Discord, Cloudflare, JWT, Bearer headers, PEM
  private key blocks.
- COMPANY char class tightened to katakana + CJK + latin so
  hiragana particles break the match ("株式会社アクメの田中部長"
  no longer captures the whole phrase).
- LLM denylist (job titles / credential-type names / polite
  phrases / common tech) runs as a post-filter so Qwen3
  over-detection is neutralised client-side.

### Security

- Fail-closed on replace mode (any LLM failure aborts the entire
  outbound request).
- Fail-open on detect mode (LLM timeout → regex-only sidebar
  with an error toast).
- Main branch protection enabled (PR required, linear history,
  no force-push / deletion, conversation resolution).

### Known limits

- 9B thinking models take 20–60 s on cold start; the retry loop
  covers this transparently.
- Gemini Bard-frontend `f.req` framing remains detect-only;
  rewriting it back is out of scope until the framing is round-
  trip safe.

## 0.4.0 — v1.0.0 Chrome Web Store build (2026-04-15)

Stabilization pass between 0.3.0 and the 0.5.0 local-LLM work.
Shipped as the v1.0.0 Web Store submission under
`manifest.name = "PII Guard"`.

- Sidebar modernised — glass header, category cards, segment-
  control severity tabs, gradient primary button, micro-
  animations.
- Theme auto-sync to host background (luminance < 0.5 activates
  dark palette).
- Hold-duration slider 0 s – 1.5 s for force-masked categories.
- Before/After arrow visualisation with reverse-arrow + green
  right-border marker for unmasked rows.
- Per-row 除外 button writes directly to
  `chrome.storage.local.maskAllowlist`; other open tabs
  auto-unmask matching rows on the fly via CustomEvent
  `mask-mcp:settings-updated`.
- Options page — allowlist CRUD + JSON import/export.
- Socket.IO / manus.im WebSocket hook for chats that bypass
  fetch/XHR.
- Chrome Web Store submission package: icons, screenshots,
  `PRIVACY.md`, `STORE.md`, `STORE_DESCRIPTION.md`.
- Fail-closed on masking-pipeline error (rejected fetch instead
  of silent pass-through).

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
