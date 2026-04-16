// Page-world (MAIN world) script.
//
// Injected by content.js at ``document_start`` alongside injected.js
// (and the legacy review-modal.js). Exposes a Shadow-DOM-scoped
// **sidebar** the fetch interceptor can ``await`` when ``uiMode``
// is ``"sidebar"`` — which is the new default for Milestone 8 Wave B.
//
// Companion to ``review-modal.js`` (still used when ``uiMode === "modal"``):
//   * The modal renders the per-occurrence ``DetectionResult`` list
//     returned by ``POST /v1/extension/sanitize`` (legacy contract).
//   * The sidebar renders the **aggregated** ``AggregatedEntity`` list
//     returned by ``POST /v1/extension/sanitize/aggregated`` (Milestone
//     8 Wave A). One row per unique ``(category, value)`` pair, with a
//     count badge instead of repeating the same surface.
//
// Exposed on ``window.__localMaskMCP.sidebar`` so injected.js can reach
// it without cross-world messaging.
//
// Design decisions
// ~~~~~~~~~~~~~~~~
//
// * **Shadow DOM** — entire UI lives inside ``attachShadow`` on a
//   throwaway ``<div>`` appended to ``document.body``. Page CSS cannot
//   bleed in and our styles never touch the page. When the promise
//   resolves the host element is removed completely.
// * **z-index: 2147483647** (max signed 32-bit int) so the sidebar
//   always sits above whatever layer the host page is using.
// * **No innerHTML** — every node is built via ``createElement`` /
//   ``textContent``; user-controlled strings (entity values, labels,
//   categories, original text) only ever reach the DOM through
//   ``textContent``.
// * **No dependencies** — vanilla JS. Indigo / red / gray palette
//   defined as CSS variables in the shadow root style block.
// * **Keyboard** — Enter confirms; Esc cancels; Tab cycles; Space
//   toggles focused checkbox. Tab is wrapped via a focus trap so it
//   never escapes the sidebar.
// * **Force-mask lock** — categories appearing in
//   ``force_masked_categories`` are rendered with a 🔒 icon and their
//   checkboxes are ``disabled`` so neither the row nor the parent
//   category nor the bulk "全解除" button can ever uncheck them.
// * **Severity colour-coding** — every row carries a left coloured
//   border (red / orange / amber / gray) matching its ``severity``
//   field, plus a ``[critical|high|medium|low]`` pill after the label.
//   Category headers show the pill at the highest severity of their
//   children (e.g. a ``CREDENTIAL`` header with one ``API_KEY`` inside
//   renders as ``critical``).
// * **Critical long-press guard** — ``severity === "critical"`` rows
//   replace the checkbox with a circular progress ring control. A
//   user must press and hold for 800 ms (via ``pointer*`` events so
//   it works on touch) to toggle the row off. Bulk "すべて解除" shows
//   a native ``window.confirm`` and, if accepted, clears only the
//   non-critical rows — critical ones still require the long-press
//   gesture. When a row is ALSO force-masked the long-press UI is
//   replaced with a disabled lock icon so the row is truly immutable.

(() => {
  "use strict";

  const NS = (window.__localMaskMCP = window.__localMaskMCP || {});
  if (NS.sidebar) {
    // Idempotent — content.js may re-inject after an SPA navigation
    // and we must not install the sidebar twice.
    return;
  }

  // Build a stable "row key" for an aggregated entity. Used as the
  // ``data-row-key`` on each checkbox AND as the entry in the
  // ``maskedEntityKeys`` set the caller receives so a downstream
  // consumer can correlate UI selections with the aggregated rows.
  function rowKeyOf(entity) {
    return `${String(entity.category || "")}|${String(entity.value || "")}`;
  }

  // Pure function — used both at build-time (initial preview) and on
  // every checkbox change. Same logic the gateway-side ``tag`` strategy
  // uses, just executed client-side so we can update the preview
  // without round-tripping through the gateway.
  //
  // ``keepers`` is an Array<[start, end, label]>. We replace each span
  // back-to-front so earlier offsets stay valid as the string shrinks.
  function applyMasks(originalText, keepers) {
    if (!keepers || keepers.length === 0) return originalText;

    // Pass 1 — number every (label, surface) pair left-to-right so
    // repeated mentions of the same surface share a placeholder
    // (``<PERSON_1>`` used twice means "same person referenced
    // twice", matching the server-side _tag_mask invariant).
    const counters = new Map();
    const numbering = new Map();
    const ascending = [...keepers].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [s, e, label] of ascending) {
      if (!Number.isInteger(s) || !Number.isInteger(e) || e <= s) continue;
      const surface = originalText.slice(s, e);
      const key = `${label}\x00${surface}`;
      if (!numbering.has(key)) {
        const n = (counters.get(label) || 0) + 1;
        counters.set(label, n);
        numbering.set(key, n);
      }
    }

    // Pass 2 — substitute back-to-front so earlier offsets remain
    // valid as later substrings shrink or grow.
    const descending = [...keepers].sort((a, b) => b[0] - a[0]);
    let result = originalText;
    for (const [s, e, label] of descending) {
      if (
        !Number.isInteger(s) ||
        !Number.isInteger(e) ||
        e <= s ||
        s < 0 ||
        e > result.length
      ) {
        // Defensive: skip malformed positions instead of throwing,
        // so a single bad row never breaks the whole preview.
        continue;
      }
      const surface = originalText.slice(s, e);
      const lbl = String(label || "MASKED");
      const n = numbering.get(`${lbl}\x00${surface}`) || 1;
      result = result.slice(0, s) + `<${lbl}_${n}>` + result.slice(e);
    }
    return result;
  }

  const STYLE = `
    :host {
      all: initial;
    }
    .root {
      position: relative;
      width: 100%;
      height: 100%;
      pointer-events: none;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto,
        "Helvetica Neue", sans-serif;
      font-size: 14px;
      color: var(--text);

      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --danger: #dc2626;
      --bg: #f9fafb;
      --bg-panel: #ffffff;
      --border: #e5e7eb;
      --text: #111827;
      --text-muted: #6b7280;
      --shadow: 0 10px 25px rgba(0, 0, 0, 0.12);
      --radius: 12px;
      --row-bg-hover: #f3f4f6;
      --locked-bg: #fef2f2;

      /* Severity palette — Tailwind 500/100 pairs. Mirrored in
         review-modal.js so both surfaces flash the same colour for
         the same risk tier. */
      --sev-critical: #dc2626;    /* red-600  */
      --sev-critical-bg: #fee2e2; /* red-100  */
      --sev-high: #f97316;        /* orange-500 */
      --sev-high-bg: #ffedd5;     /* orange-100 */
      --sev-medium: #eab308;      /* amber-500 */
      --sev-medium-bg: #fef3c7;   /* amber-100 */
      --sev-low: #6b7280;         /* gray-500 */
      --sev-low-bg: #f3f4f6;      /* gray-100 */
    }
    @media (prefers-color-scheme: dark) {
      .root {
        --primary: #818cf8;
        --primary-hover: #6366f1;
        --danger: #f87171;
        --bg: #1f2937;
        --bg-panel: #111827;
        --border: #374151;
        --text: #f9fafb;
        --text-muted: #9ca3af;
        --shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
        --row-bg-hover: #374151;
        --locked-bg: #450a0a;
        --sev-critical: #f87171;
        --sev-critical-bg: #450a0a;
        --sev-high: #fb923c;
        --sev-high-bg: #431407;
        --sev-medium: #facc15;
        --sev-medium-bg: #422006;
        --sev-low: #9ca3af;
        --sev-low-bg: #1f2937;
      }
    }
    .panel {
      position: relative;
      width: 100%;
      height: 100%;
      background: var(--bg-panel);
      border-left: 1px solid var(--border);
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      pointer-events: auto;
      overflow: hidden;
    }
    .panel header {
      flex: 0 0 auto;
      padding: 14px 16px 12px 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      background: var(--bg-panel);
    }
    .panel header h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: var(--text);
    }
    .close-btn {
      background: transparent;
      border: none;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 6px;
      color: var(--text-muted);
    }
    .close-btn:hover,
    .close-btn:focus-visible {
      background: var(--row-bg-hover);
      color: var(--text);
      outline: none;
    }
    /* The .body is now a flex column so the preview can be pinned at
       the bottom and only the category list scrolls. Vertical layout:
         [bulk-bar]    flex 0 0 auto  (fixed)
         [categories]  flex 1 1 auto  (scrolls)
         [preview]     flex 0 0 auto  (pinned, capped height)
       The outer footer (confirm / cancel) still sits below .body.
    */
    .body {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      padding: 12px 16px 0 16px;
      background: var(--bg);
      overflow: hidden;
    }
    .bulk-bar {
      flex: 0 0 auto;
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
    .categories {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      padding-right: 4px;
      margin-right: -4px;
      /* Leave a little air between the last category card and the
         pinned preview above it. */
      padding-bottom: 6px;
    }
    .sev-tabs {
      flex: 0 0 auto;
      display: flex;
      gap: 4px;
      margin-bottom: 8px;
    }
    .sev-tab {
      flex: 1 1 0;
      padding: 4px 0;
      font: inherit;
      font-size: 11px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--bg-panel);
      color: var(--text-muted);
      cursor: pointer;
      text-align: center;
      white-space: nowrap;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .sev-tab:hover { background: var(--row-bg-hover); }
    .sev-tab.active { font-weight: 600; color: #fff; }
    .sev-tab.active[data-sev="all"]      { background: var(--text-muted); border-color: var(--text-muted); }
    .sev-tab.active[data-sev="critical"] { background: var(--sev-critical); border-color: var(--sev-critical); }
    .sev-tab.active[data-sev="high"]     { background: var(--sev-high); border-color: var(--sev-high); }
    .sev-tab.active[data-sev="medium"]   { background: var(--sev-medium); border-color: var(--sev-medium); }
    .sev-tab.active[data-sev="low"]      { background: var(--sev-low); border-color: var(--sev-low); }

    .bulk-btn {
      flex: 1 1 0;
      padding: 6px 10px;
      font: inherit;
      font-size: 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg-panel);
      color: var(--text);
      cursor: pointer;
    }
    .bulk-btn:hover,
    .bulk-btn:focus-visible {
      background: var(--row-bg-hover);
      outline: none;
    }
    .hold-slider-bar {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      font-size: 11px;
      color: var(--text-muted);
    }
    .hold-slider-bar label {
      white-space: nowrap;
    }
    .hold-slider-bar input[type="range"] {
      flex: 1 1 auto;
      height: 4px;
      accent-color: var(--sev-critical);
    }
    .hold-slider-bar .hold-val {
      min-width: 28px;
      text-align: right;
      font-weight: 600;
      color: var(--text);
    }
    .empty {
      padding: 24px 0;
      text-align: center;
      color: var(--text-muted);
      font-size: 13px;
    }
    .category {
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 10px;
      overflow: hidden;
    }
    .category.is-locked {
      background: var(--locked-bg);
      border-color: #fecaca;
    }
    .category-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      cursor: pointer;
      user-select: none;
      border-left: 4px solid transparent;
    }
    .category.cat-sev-critical .category-header {
      border-left-color: var(--sev-critical);
      background: var(--sev-critical-bg);
    }
    .category.cat-sev-high .category-header {
      border-left-color: var(--sev-high);
      background: var(--sev-high-bg);
    }
    .category.cat-sev-medium .category-header {
      border-left-color: var(--sev-medium);
      background: var(--sev-medium-bg);
    }
    .category.cat-sev-low .category-header {
      border-left-color: var(--sev-low);
      background: var(--sev-low-bg);
    }
    .category-header:hover {
      filter: brightness(0.95);
    }
    .category.is-locked .category-header:hover {
      filter: brightness(0.92);
    }
    .twisty {
      width: 14px;
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
      transition: transform 0.12s ease-out;
    }
    .category.is-collapsed .twisty {
      transform: rotate(-90deg);
    }
    .category-name {
      flex: 1 1 auto;
      font-weight: 600;
      font-size: 13px;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .category-count {
      color: var(--text-muted);
      font-weight: 400;
      font-size: 12px;
    }
    .lock-icon {
      font-size: 12px;
      color: var(--danger);
    }
    .category-toggle {
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      accent-color: var(--primary);
      cursor: pointer;
    }
    .category-toggle:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .rows {
      border-top: 1px solid var(--border);
    }
    .category.is-locked .rows {
      border-top-color: #fecaca;
    }
    .category.is-collapsed .rows {
      display: none;
    }
    /* --- New 2-line row layout ---------------------------------------
       Line 1:  icon + value -> <PLACEHOLDER>
       Line 2:  N-ken + severity pill + long-press hint (critical only)
       The whole row element (.row) is the interactive surface for
       critical items so the long-press gesture fires wherever the
       user presses -- no tiny SVG target to hunt for. An absolute-
       positioned fill (.lp-fill) animates left-to-right across the
       full row width during the hold. Note: backticks MUST NOT
       appear inside this CSS block because the surrounding string
       is a JS template literal and any backtick terminates it.
    */
    .row {
      display: block;
      position: relative;
      padding: 10px 14px 10px 18px;
      border-bottom: 1px solid var(--border);
      border-left: 4px solid var(--sev-low);
      font-size: 13px;
      transition: background-color 0.18s ease-out, box-shadow 0.18s ease-out;
      overflow: hidden;
      cursor: pointer;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    .row.sev-critical {
      border-left-color: var(--sev-critical);
      background: var(--sev-critical-bg);
      /* touch-action: none on critical so long-press gesture is not
         hijacked by browser scrolling on mobile. */
      touch-action: none;
    }
    .row.sev-high     { border-left-color: var(--sev-high); }
    .row.sev-medium   { border-left-color: var(--sev-medium); }
    .row.sev-low      { border-left-color: var(--sev-low); }
    .row.is-unmasked { opacity: 0.55; background: #fafafa; }
    .row.sev-critical.is-unmasked { opacity: 0.7; background: #fff7ed; }
    .row.long-press-pulse {
      animation: lp-pulse 0.45s ease-out;
    }
    @keyframes lp-pulse {
      0%   { box-shadow: inset 0 0 0 0 var(--sev-critical); }
      30%  { box-shadow: inset 0 0 0 4px var(--sev-critical); }
      100% { box-shadow: inset 0 0 0 0 var(--sev-critical); }
    }
    .row.unlock-flash {
      animation: unlock-glow 0.6s ease-out;
    }
    @keyframes unlock-glow {
      0%   { box-shadow: inset 0 0 0 0 #22c55e; background: #f0fdf4; }
      40%  { box-shadow: inset 0 0 0 4px #22c55e; background: #dcfce7; }
      100% { box-shadow: inset 0 0 0 0 #22c55e; background: transparent; }
    }
    .category.is-locked .row {
      border-bottom-color: #fecaca;
    }
    .row:last-child {
      border-bottom: none;
    }
    .row:hover {
      background: var(--row-bg-hover);
    }
    .row.sev-critical:hover {
      background: #fecaca;
    }
    .category.is-locked .row:hover {
      background: #fee2e2;
    }
    /* Long-press progress fill: sits behind the row text, animates
       its width from 0 to 100 percent over 800ms while the user
       holds. No backticks in this comment -- the enclosing string
       is a JS template literal. */
    .row .lp-fill {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 0%;
      background: rgba(220, 38, 38, 0.22);
      pointer-events: none;
      transition: width 0.05s linear;
      z-index: 0;
    }
    .row .row-line1,
    .row .row-line2 {
      position: relative;
      z-index: 1;
    }
    .row-line1 {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .row-icon {
      flex: 0 0 auto;
      font-size: 14px;
      line-height: 1;
    }
    .row-value {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas,
        "Liberation Mono", monospace;
      font-size: 12.5px;
      background: var(--bg);
      padding: 2px 6px;
      border-radius: 4px;
      word-break: break-all;
      font-weight: 600;
    }
    .row.sev-critical .row-value {
      background: #fff;
      color: var(--sev-critical);
    }
    .row-arrow {
      flex: 0 0 auto;
      color: var(--text-muted);
      font-weight: 700;
    }
    .row-placeholder {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas,
        "Liberation Mono", monospace;
      font-size: 12px;
      color: var(--primary);
      background: #eef2ff;
      padding: 2px 6px;
      border-radius: 4px;
      word-break: break-all;
    }
    .row-line2 {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 4px;
      font-size: 11px;
      color: var(--text-muted);
    }
    .row-count { font-variant-numeric: tabular-nums; }
    .sev-pill {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.4px;
      padding: 1px 7px;
      border-radius: 8px;
      text-transform: uppercase;
    }
    .sev-pill.sev-critical { background: var(--sev-critical-bg); color: var(--sev-critical); border: 1px solid var(--sev-critical); }
    .sev-pill.sev-high     { background: var(--sev-high-bg);     color: var(--sev-high);     border: 1px solid var(--sev-high); }
    .sev-pill.sev-medium   { background: var(--sev-medium-bg);   color: #a16207;             border: 1px solid var(--sev-medium); }
    .sev-pill.sev-low      { background: var(--sev-low-bg);      color: var(--sev-low);      border: 1px solid var(--sev-low); }
    .row-lock {
      color: var(--danger);
      font-weight: 600;
    }
    /* Hide the built-in checkbox: we drive state from the row itself.
       The checkbox still exists in the DOM for keyboard accessibility
       (it receives focus via Tab) but is visually suppressed. */
    .row-checkbox {
      position: absolute;
      opacity: 0;
      pointer-events: none;
      width: 1px;
      height: 1px;
    }
    .preview-section {
      flex: 0 0 auto;
      margin-top: 8px;
      padding: 12px 0 12px 0;
      border-top: 1px solid var(--border);
      background: var(--bg);
      position: relative;
    }
    .preview-section::before {
      /* Soft gradient fade at the top edge so content scrolling
         behind the preview does not clip abruptly. Pure decoration;
         the border-top above it is the real separator. */
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      top: -14px;
      height: 14px;
      background: linear-gradient(to bottom, rgba(249, 250, 251, 0), var(--bg));
      pointer-events: none;
    }
    .preview-section h3 {
      margin: 0 0 6px 0;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .preview {
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 10px 12px;
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      /* Capped so a long AI prompt does not steal scroll real-estate
         from the category list above. The preview itself scrolls
         internally when content exceeds this height. */
      max-height: 22vh;
      min-height: 60px;
      overflow-y: auto;
      color: var(--text);
    }
    footer {
      flex: 0 0 auto;
      padding: 12px 16px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      background: var(--bg-panel);
    }
    button.primary,
    button.secondary {
      font: inherit;
      font-size: 13px;
      padding: 8px 14px;
      border-radius: 8px;
      cursor: pointer;
      border: 1px solid transparent;
    }
    button.secondary {
      background: var(--bg-panel);
      border-color: var(--border);
      color: var(--text);
    }
    button.secondary:hover,
    button.secondary:focus-visible {
      background: var(--row-bg-hover);
      outline: none;
    }
    button.primary {
      background: var(--primary);
      color: #ffffff;
      font-weight: 600;
    }
    button.primary:hover,
    button.primary:focus-visible {
      background: var(--primary-hover);
      outline: none;
    }
  `;

  // Normalise severity to one of the four tiers the CSS knows about.
  // Unknown values fall back to ``low`` so the UI never renders an
  // un-styled row even when a future server-side tier is added.
  const KNOWN_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
  const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
  function normaliseSeverity(sev) {
    const s = String(sev || "").toLowerCase();
    return KNOWN_SEVERITIES.has(s) ? s : "low";
  }
  // Pick the highest-risk (lowest rank) severity from an iterable of
  // row states. Category headers render at this severity so the pill
  // reflects the worst offender in the group.
  function worstSeverity(rows) {
    let best = "low";
    let bestRank = SEVERITY_RANK.low;
    for (const row of rows) {
      const rank = SEVERITY_RANK[row.severity] ?? SEVERITY_RANK.low;
      if (rank < bestRank) {
        best = row.severity;
        bestRank = rank;
      }
    }
    return best;
  }

  // Internal model for one row. Built once in show() and mutated
  // in-place when the user toggles checkboxes.
  function buildRowState(entity) {
    return {
      key: rowKeyOf(entity),
      value: String(entity.value || ""),
      label: String(entity.label || "MASKED"),
      category: String(entity.category || "OTHER"),
      count: Number(entity.count) || (Array.isArray(entity.positions) ? entity.positions.length : 0),
      positions: Array.isArray(entity.positions)
        ? entity.positions
            .map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : null))
            .filter((p) => p && Number.isInteger(p[0]) && Number.isInteger(p[1]) && p[1] > p[0])
        : [],
      masked: entity.masked !== false, // default true
      locked: false, // set by show() after force_masked_categories is read
      severity: normaliseSeverity(entity.severity),
      // Gateway-computed ``<ENTITY_TYPE_N>`` placeholder so the row
      // preview shows the exact token the AI service will see.
      // Falls back to ``<LABEL>`` (unnumbered) when the server did
      // not emit one, e.g. if the extension is talking to an older
      // gateway build.
      placeholder: typeof entity.placeholder === "string" && entity.placeholder
        ? entity.placeholder
        : `<${String(entity.label || "MASKED")}>`,
    };
  }

  /**
   * Show the sidebar.
   *
   * @param {Object} aggregatedResponse - Shape:
   *   {
   *     original_text: string,
   *     aggregated: AggregatedEntity[],
   *     audit_id: string,
   *     force_masked_categories: string[],
   *   }
   * @param {string} originalText - Echo of the source text. Used both
   *   as a rendering fallback and to keep ``maskedPositions`` valid
   *   even if ``aggregatedResponse.original_text`` is mutated.
   * @returns {Promise<{
   *   accepted: boolean,
   *   maskedEntityKeys: Set<string>,
   *   maskedPositions: Array<[number, number, string]>,
   * }>}
   */
  async function show(aggregatedResponse, originalText) {
    const safeText =
      typeof originalText === "string"
        ? originalText
        : typeof aggregatedResponse?.original_text === "string"
        ? aggregatedResponse.original_text
        : "";
    const aggregated = Array.isArray(aggregatedResponse?.aggregated)
      ? aggregatedResponse.aggregated
      : [];
    const forcedCategories = new Set(
      Array.isArray(aggregatedResponse?.force_masked_categories)
        ? aggregatedResponse.force_masked_categories.map(String)
        : []
    );

    // Short-circuit when nothing to review — happens when the gateway
    // returned zero detections (e.g. the user was just typing "hi").
    // The caller then forwards the original body untouched.
    if (aggregated.length === 0) {
      return {
        accepted: true,
        maskedEntityKeys: new Set(),
        maskedPositions: [],
      };
    }

    // Build the per-row internal model and group by category in
    // first-occurrence order so the UI lists categories in the same
    // order the gateway returned them.
    const rows = aggregated.map(buildRowState);
    for (const row of rows) {
      if (forcedCategories.has(row.category)) {
        row.locked = true;
        row.masked = true;
      }
    }
    const categoryOrder = [];
    const categoryMap = new Map(); // category name → array of rows
    for (const row of rows) {
      if (!categoryMap.has(row.category)) {
        categoryOrder.push(row.category);
        categoryMap.set(row.category, []);
      }
      categoryMap.get(row.category).push(row);
    }

    return new Promise((resolve) => {
      // --- Push layout: wrap existing body children in a flex sibling ---
      // Instead of position:fixed (which overlays), we make <body> a
      // flex row. Existing content goes into a wrapper (flex:1) and the
      // sidebar host sits beside it (flex:0 0 auto). This keeps both
      // in the same document flow so they never overlap.
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-mask-mcp-wrapper", "");
      wrapper.style.cssText = "flex:1 1 0;min-width:0;overflow:auto;height:100vh;";
      while (document.body.firstChild) {
        wrapper.appendChild(document.body.firstChild);
      }
      document.body.appendChild(wrapper);
      document.body.style.cssText += ";display:flex!important;flex-direction:row!important;margin:0!important;overflow:hidden!important;height:100vh!important;";

      const host = document.createElement("div");
      host.setAttribute("data-mask-mcp-sidebar", "");
      host.style.all = "initial";
      host.style.display = "block";
      host.style.height = "100vh";
      host.style.zIndex = "2147483647";

      function sidebarWidth() {
        return Math.min(400, Math.floor(window.innerWidth * 0.45));
      }
      function applySidebarLayout() {
        const sw = sidebarWidth();
        host.style.width = sw + "px";
        host.style.minWidth = sw + "px";
      }
      const shadow = host.attachShadow({ mode: "open" });

      const style = document.createElement("style");
      style.textContent = STYLE;
      shadow.appendChild(style);

      const root = document.createElement("div");
      root.className = "root";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.setAttribute("aria-labelledby", "mcp-sb-title");

      // Push layout — no overlay. The host element is constrained to
      // 400px on the right edge so the chat area stays fully interactive.

      const panel = document.createElement("div");
      panel.className = "panel";
      panel.setAttribute("tabindex", "-1");

      const header = document.createElement("header");
      const title = document.createElement("h2");
      title.id = "mcp-sb-title";
      title.textContent = "マスク対象の確認";
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "close-btn";
      closeBtn.setAttribute("aria-label", "閉じる");
      closeBtn.textContent = "\u00d7"; // ×
      header.appendChild(title);
      header.appendChild(closeBtn);

      const body = document.createElement("div");
      body.className = "body";

      const bulkBar = document.createElement("div");
      bulkBar.className = "bulk-bar";
      const selectAllBtn = document.createElement("button");
      selectAllBtn.type = "button";
      selectAllBtn.className = "bulk-btn";
      selectAllBtn.textContent = "すべて選択";
      const deselectAllBtn = document.createElement("button");
      deselectAllBtn.type = "button";
      deselectAllBtn.className = "bulk-btn";
      deselectAllBtn.textContent = "すべて解除";
      bulkBar.appendChild(selectAllBtn);
      bulkBar.appendChild(deselectAllBtn);
      body.appendChild(bulkBar);

      // --- Hold-duration slider ---
      let lockHoldMs = 1000;
      const lockHoldLabel = () =>
        lockHoldMs === 0
          ? "\ud83d\udd12 クリックで解除"
          : "\ud83d\udd12 長押しで解除 (" + (lockHoldMs / 1000) + "s)";
      const holdSliderBar = document.createElement("div");
      holdSliderBar.className = "hold-slider-bar";
      const holdLabel = document.createElement("label");
      holdLabel.textContent = "\ud83d\udd12 解除長押し";
      const holdSlider = document.createElement("input");
      holdSlider.type = "range";
      holdSlider.min = "0";
      holdSlider.max = "1.5";
      holdSlider.step = "0.1";
      holdSlider.value = "1";
      const holdVal = document.createElement("span");
      holdVal.className = "hold-val";
      holdVal.textContent = "1s";
      holdSlider.addEventListener("input", () => {
        lockHoldMs = Math.round(parseFloat(holdSlider.value) * 1000);
        holdVal.textContent = holdSlider.value + "s";
        for (const el of categoriesWrap.querySelectorAll(".row-lock")) {
          if (el.textContent.includes("長押しで解除")) {
            el.textContent = lockHoldLabel();
          }
        }
      });
      holdSliderBar.appendChild(holdLabel);
      holdSliderBar.appendChild(holdSlider);
      holdSliderBar.appendChild(holdVal);
      body.appendChild(holdSliderBar);

      // --- Severity filter tabs ---
      const sevTabs = document.createElement("div");
      sevTabs.className = "sev-tabs";
      let activeFilter = "all";
      const SEV_KEYS = ["all", "critical", "high", "medium", "low"];
      const SEV_LABELS = { all: "All", critical: "Critical", high: "High", medium: "Medium", low: "Low" };
      for (const key of SEV_KEYS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sev-tab" + (key === "all" ? " active" : "");
        btn.dataset.sev = key;
        btn.textContent = SEV_LABELS[key];
        btn.addEventListener("click", () => {
          activeFilter = key;
          for (const t of sevTabs.children) t.classList.remove("active");
          btn.classList.add("active");
          applySevFilter();
        });
        sevTabs.appendChild(btn);
      }
      body.appendChild(sevTabs);

      function applySevFilter() {
        const cats = categoriesWrap.querySelectorAll(".category");
        for (const cat of cats) {
          const rows = cat.querySelectorAll(".row");
          let visibleCount = 0;
          for (const r of rows) {
            const show = activeFilter === "all" || r.dataset.severity === activeFilter;
            r.style.display = show ? "" : "none";
            if (show) visibleCount++;
          }
          cat.style.display = visibleCount > 0 ? "" : "none";
        }
      }

      // Track the DOM nodes per row/category so toggles can reach the
      // corresponding checkboxes without touching textContent.
      const rowControls = new Map(); // key → { checkbox, row }
      const categoryControls = new Map(); // category → { toggle, all rows[] }

      function renderCategory(categoryName) {
        const items = categoryMap.get(categoryName) || [];
        const wrap = document.createElement("section");
        wrap.className = "category";
        const isLocked = items.every((r) => r.locked) && items.length > 0;
        if (isLocked) wrap.classList.add("is-locked");

        const head = document.createElement("div");
        head.className = "category-header";
        head.setAttribute("role", "button");
        head.setAttribute("tabindex", "0");

        const twisty = document.createElement("span");
        twisty.className = "twisty";
        twisty.textContent = "\u25be"; // ▾

        const name = document.createElement("span");
        name.className = "category-name";
        const nameLabel = document.createElement("span");
        nameLabel.textContent = categoryName;
        name.appendChild(nameLabel);
        // Category severity = worst severity of any row in the group.
        // Renders the same pill style as individual rows so the user
        // can tell at a glance that a PERSON group is actually critical
        // because it hides an API_KEY.
        const groupSeverity = worstSeverity(items);
        wrap.classList.add(`cat-sev-${groupSeverity}`);
        const groupPill = document.createElement("span");
        groupPill.className = `sev-pill sev-${groupSeverity}`;
        groupPill.textContent = groupSeverity;
        name.appendChild(groupPill);
        if (forcedCategories.has(categoryName)) {
          const lockIcon = document.createElement("span");
          lockIcon.className = "lock-icon";
          lockIcon.title = "force-mask: ロック中";
          lockIcon.textContent = "\ud83d\udd12"; // 🔒
          name.appendChild(lockIcon);
        }
        const cnt = document.createElement("span");
        cnt.className = "category-count";
        cnt.textContent = `(${items.length}件)`;
        name.appendChild(cnt);

        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.className = "category-toggle";
        toggle.setAttribute("aria-label", `${categoryName} を一括切り替え`);
        if (forcedCategories.has(categoryName)) {
          toggle.disabled = true;
          toggle.checked = true;
        }

        // Clicks on the header (but not the toggle) collapse/expand.
        head.appendChild(twisty);
        head.appendChild(name);
        head.appendChild(toggle);

        head.addEventListener("click", (event) => {
          if (event.target === toggle) return;
          wrap.classList.toggle("is-collapsed");
        });
        head.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            wrap.classList.toggle("is-collapsed");
          }
        });

        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
        });
        toggle.addEventListener("change", (event) => {
          if (toggle.disabled) return;
          const checked = !!toggle.checked;
          // Unchecking a category MUST NOT bypass the long-press
          // guard on individual critical rows. If the user is trying
          // to turn the category OFF and any child is critical, run
          // the same native confirm() path the "すべて解除" button
          // uses; on accept, we only clear the non-critical children.
          if (!checked) {
            const criticalKids = items.filter(
              (r) => !r.locked && r.severity === "critical"
            );
            if (criticalKids.length > 0) {
              const cleared = confirmCriticalBulkUncheck(criticalKids.length);
              if (!cleared) {
                // Restore the toggle to match the un-changed row
                // state — user declined, nothing was cleared.
                syncCategoryToggle(categoryName);
                return;
              }
              // Proceed, but leave critical rows masked=true.
              for (const row of items) {
                if (row.locked) continue;
                if (row.severity === "critical") continue;
                row.masked = false;
                const ctl = rowControls.get(row.key);
                if (ctl) ctl.control.setOn(false);
              }
              syncCategoryToggle(categoryName);
              updatePreview();
              return;
            }
          }
          for (const row of items) {
            if (row.locked) continue;
            row.masked = checked;
            const ctl = rowControls.get(row.key);
            if (ctl) ctl.control.setOn(checked);
          }
          syncCategoryToggle(categoryName);
          updatePreview();
        });

        const rowsWrap = document.createElement("div");
        rowsWrap.className = "rows";
        for (const row of items) {
          rowsWrap.appendChild(renderRow(row));
        }

        wrap.appendChild(head);
        wrap.appendChild(rowsWrap);

        categoryControls.set(categoryName, { toggle, items });
        return wrap;
      }

      function renderRow(row) {
        const id = `mcp-sb-${row.key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        const isCritical = row.severity === "critical";

        // New layout: every row is a ``<div>`` with the whole surface
        // being the interactive target. Critical rows attach a long-
        // press gesture handler to the div itself (not to a tiny SVG
        // ring) so the user can press anywhere on the row. Non-critical
        // rows toggle on a single click/tap.
        const wrap = document.createElement("div");
        wrap.className = `row sev-${row.severity}${row.masked ? "" : " is-unmasked"}`;
        wrap.dataset.severity = row.severity;
        wrap.setAttribute("role", "switch");
        wrap.setAttribute("tabindex", "0");
        wrap.setAttribute("aria-checked", row.masked ? "true" : "false");
        wrap.setAttribute(
          "aria-label",
          `${row.value} を${isCritical ? "長押しで" : "クリックで"}切り替え`
        );

        // Hidden checkbox — kept in the DOM so Tab focus + aria state
        // map cleanly, and so the rest of the sidebar's bulk-action
        // code can still address it via ``rowControls.checkbox``.
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "row-checkbox";
        checkbox.id = id;
        checkbox.checked = row.masked;
        checkbox.dataset.rowKey = row.key;
        if (row.locked) {
          checkbox.disabled = true;
          checkbox.checked = true;
        }
        wrap.appendChild(checkbox);

        // Long-press progress fill (critical only, absolute-positioned
        // behind the text; width animates 0% → 100% during a hold).
        let fill = null;
        if (isCritical || row.locked) {
          fill = document.createElement("div");
          fill.className = "lp-fill";
          if (row.locked) fill.style.background = "var(--sev-critical-bg)";
          wrap.appendChild(fill);
        }

        // ----- Line 1: 🔑 value → <PLACEHOLDER> ------------------------
        const line1 = document.createElement("div");
        line1.className = "row-line1";

        const icon = document.createElement("span");
        icon.className = "row-icon";
        icon.textContent = row.locked
          ? "\ud83d\udd12"  // 🔒 force-masked
          : isCritical
            ? "\ud83d\udd11" // 🔑 critical
            : "\ud83d\udd0d"; // 🔍 non-critical
        line1.appendChild(icon);

        const value = document.createElement("span");
        value.className = "row-value";
        value.textContent = row.value;
        line1.appendChild(value);

        const arrow = document.createElement("span");
        arrow.className = "row-arrow";
        arrow.textContent = "\u2192"; // →
        line1.appendChild(arrow);

        const ph = document.createElement("span");
        ph.className = "row-placeholder";
        ph.textContent = row.placeholder || `<${row.label}>`;
        line1.appendChild(ph);

        // ----- Line 2: N件 · [SEV] · 🔒 長押しで解除 -------------------
        const line2 = document.createElement("div");
        line2.className = "row-line2";

        const count = document.createElement("span");
        count.className = "row-count";
        count.textContent = `${row.count}件`;
        line2.appendChild(count);

        const dot1 = document.createElement("span");
        dot1.textContent = "·";
        line2.appendChild(dot1);

        const sevPill = document.createElement("span");
        sevPill.className = `sev-pill sev-${row.severity}`;
        sevPill.textContent = row.severity;
        line2.appendChild(sevPill);

        if (isCritical) {
          const dot2 = document.createElement("span");
          dot2.textContent = "·";
          line2.appendChild(dot2);
          const hint = document.createElement("span");
          hint.className = "row-lock";
          hint.textContent = row.locked
            ? lockHoldLabel()
            : "\ud83d\udd12 長押しで解除 (800ms)";
          line2.appendChild(hint);
        } else if (row.locked) {
          const dot2 = document.createElement("span");
          dot2.textContent = "·";
          line2.appendChild(dot2);
          const lock = document.createElement("span");
          lock.className = "row-lock";
          lock.textContent = lockHoldLabel();
          line2.appendChild(lock);
        }

        wrap.appendChild(line1);
        wrap.appendChild(line2);

        // ------ Interaction wiring ---------------------------------
        const syncAria = () => {
          wrap.setAttribute("aria-checked", row.masked ? "true" : "false");
          wrap.classList.toggle("is-unmasked", !row.masked);
        };

        const unlockRow = () => {
          row._wasLocked = true;
          row.locked = false;
          checkbox.disabled = false;
          icon.textContent = isCritical ? "\ud83d\udd11" : "\ud83d\udd0d";
          wrap.classList.remove("is-locked");
          const hintEl = wrap.querySelector(".row-lock");
          if (hintEl) {
            hintEl.textContent = isCritical
              ? "\ud83d\udd12 長押しで解除 (800ms)"
              : "";
          }
          const catEl = wrap.closest(".category");
          if (catEl) catEl.classList.remove("is-locked");
        };

        const relockRow = () => {
          row.locked = true;
          checkbox.disabled = true;
          checkbox.checked = true;
          icon.textContent = "\ud83d\udd12";
          wrap.classList.add("is-locked");
          wrap.classList.remove("is-unmasked");
          const hintEl = wrap.querySelector(".row-lock");
          if (hintEl) {
            hintEl.textContent = lockHoldLabel();
          }
          const catEl = wrap.closest(".category");
          if (catEl) catEl.classList.add("is-locked");
        };

        const setState = (next) => {
          if (row.locked) unlockRow();
          row.masked = !!next;
          if (row._wasLocked && row.masked) {
            relockRow();
          } else {
            checkbox.checked = row.masked;
          }
          syncAria();
          syncCategoryToggle(row.category);
          updatePreview();
        };

        if (!isCritical && !row.locked) {
          // Single click anywhere on the row toggles.
          wrap.addEventListener("click", () => setState(!row.masked));
          wrap.addEventListener("keydown", (event) => {
            if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              setState(!row.masked);
            }
          });
        } else {
          // Long-press: critical = 800ms, locked = slider value (live).
          // When slider is 0, locked rows get single-click toggle.
          const getHoldMs = () => row.locked ? lockHoldMs : 800;
          let timerId = null;
          let tickId = null;
          let startedAt = 0;

          const resetFill = () => {
            if (!fill) return;
            fill.style.transition = "width 0.2s ease-out";
            fill.style.width = "0%";
          };
          const clearTimers = () => {
            if (timerId !== null) { clearTimeout(timerId); timerId = null; }
            if (tickId !== null) { clearInterval(tickId); tickId = null; }
          };
          const onDown = (event) => {
            if (timerId !== null) return;
            if (event.preventDefault) event.preventDefault();
            startedAt = Date.now();
            if (fill) {
              fill.style.transition = "width 0.05s linear";
              fill.style.width = "0%";
            }
            try {
              if (event.pointerId !== undefined) wrap.setPointerCapture(event.pointerId);
            } catch (_) {
              /* Safari / older WebViews may throw on setPointerCapture. */
            }
            const ms = getHoldMs();
            const doToggle = () => {
              clearTimers();
              if (fill) fill.style.width = "100%";
              const wasLocked = row.locked;
              wrap.classList.add("long-press-pulse");
              setTimeout(() => wrap.classList.remove("long-press-pulse"), 450);
              setState(!row.masked);
              if (wasLocked) {
                wrap.classList.add("unlock-flash");
                setTimeout(() => wrap.classList.remove("unlock-flash"), 600);
              }
              setTimeout(resetFill, 350);
            };
            if (ms === 0) {
              doToggle();
              return;
            }
            tickId = setInterval(() => {
              const elapsed = Math.min(ms, Date.now() - startedAt);
              if (fill) fill.style.width = `${(elapsed / ms) * 100}%`;
            }, 50);
            timerId = setTimeout(doToggle, ms);
          };
          const onUp = () => {
            clearTimers();
            resetFill();
          };
          wrap.addEventListener("pointerdown", onDown);
          wrap.addEventListener("pointerup", onUp);
          wrap.addEventListener("pointercancel", onUp);
          wrap.addEventListener("pointerleave", onUp);
          // Keyboard: hold Space/Enter for 800ms.
          let keyHeld = false;
          wrap.addEventListener("keydown", (event) => {
            if ((event.key === " " || event.key === "Enter") && !keyHeld) {
              event.preventDefault();
              keyHeld = true;
              onDown({ pointerId: -1, preventDefault() {} });
            }
          });
          wrap.addEventListener("keyup", (event) => {
            if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              keyHeld = false;
              onUp();
            }
          });
        }

        rowControls.set(row.key, {
          checkbox,
          control: {
            element: wrap,
            isOn: () => !!row.masked,
            setOn: (next) => {
              if (row.locked) return;
              row.masked = !!next;
              checkbox.checked = row.masked;
              syncAria();
            },
          },
          row,
        });
        return wrap;
      }

      function syncCategoryToggle(categoryName) {
        const ctl = categoryControls.get(categoryName);
        if (!ctl) return;
        if (ctl.toggle.disabled) return; // locked categories stay checked
        const total = ctl.items.length;
        const checked = ctl.items.filter((r) => r.masked).length;
        if (checked === 0) {
          ctl.toggle.checked = false;
          ctl.toggle.indeterminate = false;
        } else if (checked === total) {
          ctl.toggle.checked = true;
          ctl.toggle.indeterminate = false;
        } else {
          ctl.toggle.checked = false;
          ctl.toggle.indeterminate = true;
        }
      }

      function collectKeepers() {
        // Build the [start, end, label] triples for the rows the user
        // wants masked. Each row contributes one triple per occurrence.
        const triples = [];
        for (const row of rows) {
          if (!row.masked) continue;
          for (const [s, e] of row.positions) {
            triples.push([s, e, row.label]);
          }
        }
        return triples;
      }

      function updatePreview() {
        const triples = collectKeepers();
        previewBox.textContent = applyMasks(safeText, triples);
      }

      // Render every category into a dedicated scroll region. The
      // ``.categories`` wrapper gets ``flex: 1 1 auto; overflow-y: auto``
      // from the stylesheet so only the category list scrolls while
      // the preview below stays pinned in view.
      const categoriesWrap = document.createElement("div");
      categoriesWrap.className = "categories";
      for (const cat of categoryOrder) {
        categoriesWrap.appendChild(renderCategory(cat));
      }
      body.appendChild(categoriesWrap);
      // Now that all rows + toggles exist, sync the parent toggles
      // to match the initial row state (everything masked => fully
      // checked, except where force-mask already locked it).
      for (const cat of categoryOrder) {
        syncCategoryToggle(cat);
      }

      // --- Preview pane (pinned at the bottom of .body) --------------------
      const previewSection = document.createElement("div");
      previewSection.className = "preview-section";
      const previewTitle = document.createElement("h3");
      previewTitle.textContent = "プレビュー";
      const previewBox = document.createElement("div");
      previewBox.className = "preview";
      previewBox.id = "mcp-sb-preview";
      previewSection.appendChild(previewTitle);
      previewSection.appendChild(previewBox);
      body.appendChild(previewSection);
      updatePreview();

      // Bulk-uncheck gate for the critical tier. Returns ``true`` if
      // the user confirmed the clearance (non-critical rows should be
      // cleared), ``false`` if they cancelled. Centralised so both
      // the per-category toggle and the "すべて解除" button share the
      // exact same confirmation copy.
      function confirmCriticalBulkUncheck(criticalCount) {
        const msg =
          `Critical な ${criticalCount} 件の項目は長押しで個別に解除してください。` +
          `それ以外だけ解除しますか？`;
        try {
          return window.confirm(msg);
        } catch (_) {
          // Extremely locked-down pages (sandboxed iframes, some
          // PWA contexts) can throw when confirm() is called. In
          // that case we abort — critical rows stay masked.
          return false;
        }
      }

      // --- Bulk action handlers (defined here so they can see rows) -------
      selectAllBtn.addEventListener("click", () => {
        for (const row of rows) {
          if (row.locked) continue;
          row.masked = true;
          const ctl = rowControls.get(row.key);
          if (ctl) ctl.control.setOn(true);
        }
        for (const cat of categoryOrder) syncCategoryToggle(cat);
        updatePreview();
      });
      deselectAllBtn.addEventListener("click", () => {
        // "すべて解除" must NOT silently bypass the critical
        // long-press gate. When any non-locked critical row exists,
        // confirm with the user and, on accept, clear only the
        // non-critical / non-locked rows. The user still has to
        // long-press each critical row individually if they want it
        // unchecked.
        const criticals = rows.filter(
          (r) => !r.locked && r.severity === "critical"
        );
        if (criticals.length > 0) {
          const ok = confirmCriticalBulkUncheck(criticals.length);
          if (!ok) return;
          for (const row of rows) {
            if (row.locked) continue;
            if (row.severity === "critical") continue;
            row.masked = false;
            const ctl = rowControls.get(row.key);
            if (ctl) ctl.control.setOn(false);
          }
          for (const cat of categoryOrder) syncCategoryToggle(cat);
          updatePreview();
          return;
        }
        for (const row of rows) {
          if (row.locked) continue;
          row.masked = false;
          const ctl = rowControls.get(row.key);
          if (ctl) ctl.control.setOn(false);
        }
        for (const cat of categoryOrder) syncCategoryToggle(cat);
        updatePreview();
      });

      // --- Footer ----------------------------------------------------------
      const footer = document.createElement("footer");
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "secondary";
      cancelBtn.textContent = "キャンセル (Esc)";
      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "primary";
      confirmBtn.textContent = "選択したものをマスクして送信 (Enter)";
      footer.appendChild(cancelBtn);
      footer.appendChild(confirmBtn);

      panel.appendChild(header);
      panel.appendChild(body);
      panel.appendChild(footer);

      root.appendChild(panel);
      shadow.appendChild(root);

      document.body.appendChild(host);

      function cleanup() {
        document.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("resize", onResize);
        if (host.parentNode) host.parentNode.removeChild(host);
        // Unwrap: move children back to <body> and remove wrapper.
        if (wrapper.parentNode === document.body) {
          while (wrapper.firstChild) {
            document.body.appendChild(wrapper.firstChild);
          }
          wrapper.remove();
          document.body.style.cssText = document.body.style.cssText
            .replace(/display:\s*flex\s*!important;?/g, "")
            .replace(/flex-direction:\s*row\s*!important;?/g, "")
            .replace(/overflow:\s*hidden\s*!important;?/g, "")
            .replace(/height:\s*100vh\s*!important;?/g, "")
            .replace(/margin:\s*0\s*!important;?/g, "");
        }
      }

      function onConfirm() {
        const triples = collectKeepers();
        const keys = new Set(rows.filter((r) => r.masked).map((r) => r.key));
        cleanup();
        resolve({
          accepted: true,
          maskedEntityKeys: keys,
          maskedPositions: triples,
        });
      }

      function onCancel() {
        cleanup();
        resolve({
          accepted: false,
          maskedEntityKeys: new Set(),
          maskedPositions: [],
        });
      }

      cancelBtn.addEventListener("click", onCancel);
      confirmBtn.addEventListener("click", onConfirm);
      closeBtn.addEventListener("click", onCancel);

      // --- Focus trap + global keys ---------------------------------------

      function focusableNodes() {
        return Array.from(
          panel.querySelectorAll(
            'button, [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute("disabled"));
      }

      function onKeyDown(event) {
        // Listen on document in capture phase so the host page's own
        // Enter/Escape handlers (chat-app send-on-enter, dialog
        // dismissers, etc.) never fire while the sidebar is open.
        if (event.key === "Escape") {
          event.stopPropagation();
          event.preventDefault();
          onCancel();
          return;
        }
        if (event.key === "Enter") {
          const tag = event.target && event.target.tagName;
          // Don't hijack Enter inside the bulk buttons themselves —
          // the user wants the click handler to fire, not Confirm.
          if (
            tag !== "TEXTAREA" &&
            event.target !== selectAllBtn &&
            event.target !== deselectAllBtn &&
            event.target !== cancelBtn &&
            event.target !== closeBtn
          ) {
            event.stopPropagation();
            event.preventDefault();
            onConfirm();
            return;
          }
        }
        if (event.key === "Tab") {
          const nodes = focusableNodes();
          if (nodes.length === 0) return;
          const first = nodes[0];
          const last = nodes[nodes.length - 1];
          // Active element inside a Shadow DOM is the host's
          // ``shadowRoot.activeElement``, not document.activeElement.
          const active = shadow.activeElement;
          if (event.shiftKey) {
            if (active === first || !panel.contains(active)) {
              event.preventDefault();
              last.focus();
            }
          } else {
            if (active === last || !panel.contains(active)) {
              event.preventDefault();
              first.focus();
            }
          }
        }
      }
      document.addEventListener("keydown", onKeyDown, true);

      // Trigger the slide-in animation on the next frame so the
      // transition actually fires (initial paint has the panel
      // off-screen at translateX(100%)).
      const onResize = () => applySidebarLayout();
      requestAnimationFrame(() => {
        applySidebarLayout();
        window.addEventListener("resize", onResize);
      });

      // Focus the primary confirm button so Enter immediately
      // completes the happy-path flow (mirrors review-modal.js).
      setTimeout(() => confirmBtn.focus(), 0);
    });
  }

  NS.sidebar = { show, applyMasks };
})();
