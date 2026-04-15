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
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483647;
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
    .overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 400px;
      bottom: 0;
      background: rgba(0, 0, 0, 0.10);
      pointer-events: auto;
    }
    .panel {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 400px;
      max-width: 100vw;
      background: var(--bg-panel);
      border-left: 1px solid var(--border);
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      transform: translateX(100%);
      transition: transform 0.18s ease-out;
      pointer-events: auto;
      overflow: hidden;
    }
    .panel.is-open {
      transform: translateX(0);
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
    .body {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 12px 16px;
      background: var(--bg);
    }
    .bulk-bar {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
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
    }
    .category-header:hover {
      background: var(--row-bg-hover);
    }
    .category.is-locked .category-header:hover {
      background: #fee2e2;
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
    .row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 12px 8px 30px;
      border-bottom: 1px solid var(--border);
      border-left: 4px solid var(--sev-low);
      font-size: 13px;
      transition: background-color 0.18s ease-out, box-shadow 0.18s ease-out;
    }
    .row.sev-critical { border-left-color: var(--sev-critical); }
    .row.sev-high     { border-left-color: var(--sev-high); }
    .row.sev-medium   { border-left-color: var(--sev-medium); }
    .row.sev-low      { border-left-color: var(--sev-low); }
    .row.long-press-pulse {
      box-shadow: inset 4px 0 0 var(--sev-critical-bg);
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
    .category.is-locked .row:hover {
      background: #fee2e2;
    }
    .row-checkbox {
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      margin-top: 2px;
      accent-color: var(--primary);
      cursor: pointer;
    }
    .row-checkbox:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .row-meta {
      flex: 1 1 auto;
      min-width: 0;
    }
    .row-value {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas,
        "Liberation Mono", monospace;
      font-size: 12px;
      background: var(--bg);
      padding: 1px 5px;
      border-radius: 4px;
      word-break: break-all;
    }
    .category.is-locked .row-value {
      background: #fff;
    }
    .row-count {
      font-size: 11px;
      color: var(--text-muted);
      margin-left: 6px;
    }
    .row-label {
      display: inline-block;
      font-size: 10px;
      color: var(--text-muted);
      margin-left: 6px;
      padding: 1px 5px;
      border-radius: 3px;
      border: 1px solid var(--border);
      background: #fff;
    }
    .sev-pill {
      display: inline-block;
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin-left: 6px;
      padding: 1px 6px;
      border-radius: 8px;
      text-transform: uppercase;
      vertical-align: middle;
      line-height: 1.4;
    }
    .sev-pill.sev-critical { background: var(--sev-critical-bg); color: var(--sev-critical); border: 1px solid var(--sev-critical); }
    .sev-pill.sev-high     { background: var(--sev-high-bg);     color: var(--sev-high);     border: 1px solid var(--sev-high); }
    .sev-pill.sev-medium   { background: var(--sev-medium-bg);   color: #a16207;             border: 1px solid var(--sev-medium); }
    .sev-pill.sev-low      { background: var(--sev-low-bg);      color: var(--sev-low);      border: 1px solid var(--sev-low); }
    .row-lock {
      font-size: 11px;
      color: var(--danger);
      margin-left: 6px;
    }
    /* --- Long-press control for critical rows ------------------------- */
    .longpress {
      width: 20px;
      height: 20px;
      flex: 0 0 auto;
      margin-top: 1px;
      position: relative;
      cursor: pointer;
      user-select: none;
      touch-action: none;
      -webkit-tap-highlight-color: transparent;
    }
    .longpress .lp-ring {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      transform: rotate(-90deg);
    }
    .longpress .lp-track {
      fill: none;
      stroke: var(--sev-critical);
      stroke-width: 2;
      opacity: 0.25;
    }
    .longpress .lp-progress {
      fill: none;
      stroke: var(--sev-critical);
      stroke-width: 2;
      stroke-linecap: round;
      stroke-dasharray: 56.548; /* 2 * pi * 9  */
      stroke-dashoffset: 56.548;
      transition: stroke-dashoffset 0.05s linear;
    }
    .longpress.is-on .lp-core {
      fill: var(--sev-critical);
    }
    .longpress .lp-core {
      fill: #ffffff;
      stroke: var(--sev-critical);
      stroke-width: 1.2;
    }
    .longpress.is-locked {
      cursor: not-allowed;
      opacity: 0.7;
    }
    .longpress .lp-lock {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      color: var(--sev-critical);
    }
    .preview-section {
      margin-top: 14px;
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
      max-height: 180px;
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
    };
  }

  // Build a SVG long-press control and wire ``pointer*`` events so
  // the caller's ``onToggle`` only fires when the user holds the
  // control for 800 ms. Uses ``stroke-dashoffset`` animation on a
  // circular SVG track; fully self-contained inside the Shadow DOM.
  //
  // ``locked`` replaces the control with a non-interactive lock
  // glyph — used when a critical row is ALSO force-masked.
  const LONG_PRESS_MS = 800;
  const LONG_PRESS_TICK_MS = 50;
  const LP_RING_CIRCUMFERENCE = 56.548; // 2π·9, matches the CSS dash length
  function buildLongPressControl({ initial, locked, onToggle, row }) {
    const wrap = document.createElement("div");
    wrap.className = "longpress";
    wrap.setAttribute("role", "switch");
    wrap.setAttribute("tabindex", "0");
    wrap.setAttribute("aria-checked", initial ? "true" : "false");
    wrap.setAttribute("aria-label", `${row.value} を長押しで切り替え`);
    wrap.title = locked
      ? "force-mask: ロック中 (解除不可)"
      : "長押し (800ms) で解除";
    if (initial) wrap.classList.add("is-on");

    if (locked) {
      wrap.classList.add("is-locked");
      const lock = document.createElement("span");
      lock.className = "lp-lock";
      lock.textContent = "\ud83d\udd12"; // 🔒
      wrap.appendChild(lock);
      return { element: wrap, isOn: () => true, setOn: () => {} };
    }

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("class", "lp-ring");

    const track = document.createElementNS(svgNS, "circle");
    track.setAttribute("cx", "10");
    track.setAttribute("cy", "10");
    track.setAttribute("r", "9");
    track.setAttribute("class", "lp-track");

    const progress = document.createElementNS(svgNS, "circle");
    progress.setAttribute("cx", "10");
    progress.setAttribute("cy", "10");
    progress.setAttribute("r", "9");
    progress.setAttribute("class", "lp-progress");

    const core = document.createElementNS(svgNS, "circle");
    core.setAttribute("cx", "10");
    core.setAttribute("cy", "10");
    core.setAttribute("r", "4");
    core.setAttribute("class", "lp-core");

    svg.appendChild(track);
    svg.appendChild(progress);
    svg.appendChild(core);
    wrap.appendChild(svg);

    let timerId = null;
    let tickId = null;
    let startedAt = 0;

    function resetRing() {
      progress.style.strokeDashoffset = String(LP_RING_CIRCUMFERENCE);
    }

    function commit() {
      const next = !wrap.classList.contains("is-on");
      wrap.classList.toggle("is-on", next);
      wrap.setAttribute("aria-checked", next ? "true" : "false");
      wrap.classList.add("long-press-pulse");
      setTimeout(() => wrap.classList.remove("long-press-pulse"), 200);
      onToggle(next);
    }

    function clearTimers() {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (tickId !== null) {
        clearInterval(tickId);
        tickId = null;
      }
    }

    function onDown(event) {
      event.preventDefault();
      event.stopPropagation();
      if (timerId !== null) return;
      startedAt = Date.now();
      resetRing();
      try {
        wrap.setPointerCapture(event.pointerId);
      } catch (_) {
        /* Some older WebViews throw on setPointerCapture for
           synthesised pointer events; non-fatal — the fill animation
           simply cannot follow a finger that slides off. */
      }
      tickId = setInterval(() => {
        const elapsed = Math.min(LONG_PRESS_MS, Date.now() - startedAt);
        const remaining = LP_RING_CIRCUMFERENCE * (1 - elapsed / LONG_PRESS_MS);
        progress.style.strokeDashoffset = String(Math.max(0, remaining));
      }, LONG_PRESS_TICK_MS);
      timerId = setTimeout(() => {
        clearTimers();
        progress.style.strokeDashoffset = "0";
        commit();
        // Reset the ring after the pulse animation so the user can
        // press again to toggle back.
        setTimeout(resetRing, 250);
      }, LONG_PRESS_MS);
    }

    function onUp() {
      clearTimers();
      resetRing();
    }

    wrap.addEventListener("pointerdown", onDown);
    wrap.addEventListener("pointerup", onUp);
    wrap.addEventListener("pointercancel", onUp);
    wrap.addEventListener("pointerleave", onUp);
    // Keyboard: hold Space / Enter for 800 ms. We reuse the same
    // pointer machinery so the ring animates identically.
    wrap.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        if (timerId !== null) return;
        onDown({ pointerId: -1, preventDefault() {}, stopPropagation() {} });
      }
    });
    wrap.addEventListener("keyup", (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        onUp();
      }
    });

    return {
      element: wrap,
      isOn: () => wrap.classList.contains("is-on"),
      setOn: (next) => {
        wrap.classList.toggle("is-on", !!next);
        wrap.setAttribute("aria-checked", next ? "true" : "false");
        resetRing();
      },
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
      const host = document.createElement("div");
      host.setAttribute("data-mask-mcp-sidebar", "");
      host.style.all = "initial";
      host.style.position = "fixed";
      host.style.inset = "0";
      host.style.zIndex = "2147483647";
      host.style.pointerEvents = "none";
      const shadow = host.attachShadow({ mode: "open" });

      const style = document.createElement("style");
      style.textContent = STYLE;
      shadow.appendChild(style);

      const root = document.createElement("div");
      root.className = "root";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.setAttribute("aria-labelledby", "mcp-sb-title");

      const overlay = document.createElement("div");
      overlay.className = "overlay";
      // Note: clicking the overlay does NOT auto-cancel — the spec
      // requires an explicit user choice via Cancel / Confirm.
      overlay.addEventListener("click", (event) => {
        event.stopPropagation();
        // Yank focus back to the panel so screen readers stay anchored.
        panel.focus();
      });

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
        // For critical rows we use a custom long-press control, so
        // the outer node is a plain <div>; the built-in ``<label>``
        // click-to-toggle behaviour would bypass the 800 ms guard.
        const isCritical = row.severity === "critical";
        const wrap = document.createElement(isCritical ? "div" : "label");
        wrap.className = `row sev-${row.severity}`;
        if (!isCritical) wrap.setAttribute("for", id);

        let control; // { element, isOn(), setOn() } — must expose these three

        if (isCritical) {
          const lp = buildLongPressControl({
            initial: row.masked,
            locked: row.locked,
            row,
            onToggle: (next) => {
              if (row.locked) return;
              row.masked = !!next;
              syncCategoryToggle(row.category);
              updatePreview();
            },
          });
          control = lp;
          wrap.appendChild(lp.element);
        } else {
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

          checkbox.addEventListener("change", () => {
            if (row.locked) {
              checkbox.checked = true;
              row.masked = true;
              return;
            }
            row.masked = !!checkbox.checked;
            syncCategoryToggle(row.category);
            updatePreview();
          });

          control = {
            element: checkbox,
            isOn: () => !!checkbox.checked,
            setOn: (next) => {
              checkbox.checked = !!next;
            },
          };
          wrap.appendChild(checkbox);
        }

        const meta = document.createElement("div");
        meta.className = "row-meta";

        const value = document.createElement("span");
        value.className = "row-value";
        value.textContent = row.value;

        const count = document.createElement("span");
        count.className = "row-count";
        count.textContent = `(${row.count}件)`;

        const labelTag = document.createElement("span");
        labelTag.className = "row-label";
        labelTag.textContent = row.label;

        const sevPill = document.createElement("span");
        sevPill.className = `sev-pill sev-${row.severity}`;
        sevPill.textContent = row.severity;

        meta.appendChild(value);
        meta.appendChild(count);
        meta.appendChild(labelTag);
        meta.appendChild(sevPill);
        if (isCritical) {
          const lockHint = document.createElement("span");
          lockHint.className = "row-lock";
          lockHint.title = row.locked
            ? "force-mask: ロック中 (解除不可)"
            : "長押し (800ms) で解除";
          lockHint.textContent = "\ud83d\udd12"; // 🔒
          meta.appendChild(lockHint);
        } else if (row.locked) {
          const lockIcon = document.createElement("span");
          lockIcon.className = "row-lock";
          lockIcon.title = "force-mask: ロック中";
          lockIcon.textContent = "\ud83d\udd12"; // 🔒
          meta.appendChild(lockIcon);
        }

        wrap.appendChild(meta);
        // Expose a normalised control interface to the rest of the
        // sidebar. ``checkbox`` alias keeps existing code paths (bulk
        // actions, category toggle) working without branching on
        // severity everywhere.
        rowControls.set(row.key, {
          checkbox: control.element,
          control,
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

      // Render every category up front. Categories without rows are
      // simply skipped because categoryMap only contains categories the
      // aggregator returned.
      for (const cat of categoryOrder) {
        body.appendChild(renderCategory(cat));
      }
      // Now that all rows + toggles exist, sync the parent toggles
      // to match the initial row state (everything masked => fully
      // checked, except where force-mask already locked it).
      for (const cat of categoryOrder) {
        syncCategoryToggle(cat);
      }

      // --- Preview pane ----------------------------------------------------
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

      root.appendChild(overlay);
      root.appendChild(panel);
      shadow.appendChild(root);

      document.body.appendChild(host);

      function cleanup() {
        document.removeEventListener("keydown", onKeyDown, true);
        if (host.parentNode) host.parentNode.removeChild(host);
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
      requestAnimationFrame(() => panel.classList.add("is-open"));

      // Focus the primary confirm button so Enter immediately
      // completes the happy-path flow (mirrors review-modal.js).
      setTimeout(() => confirmBtn.focus(), 0);
    });
  }

  NS.sidebar = { show, applyMasks };
})();
