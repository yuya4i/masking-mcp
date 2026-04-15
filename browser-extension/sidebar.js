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
      font-size: 13px;
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
    .row-lock {
      font-size: 11px;
      color: var(--danger);
      margin-left: 6px;
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
          for (const row of items) {
            if (row.locked) continue;
            row.masked = checked;
            const ctl = rowControls.get(row.key);
            if (ctl) ctl.checkbox.checked = checked;
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
        const wrap = document.createElement("label");
        wrap.className = "row";
        wrap.setAttribute("for", id);

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
            // Defensive: should be unreachable because disabled
            // checkboxes do not fire change events, but keep the
            // invariant explicit.
            checkbox.checked = true;
            row.masked = true;
            return;
          }
          row.masked = !!checkbox.checked;
          syncCategoryToggle(row.category);
          updatePreview();
        });

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

        meta.appendChild(value);
        meta.appendChild(count);
        meta.appendChild(labelTag);
        if (row.locked) {
          const lockIcon = document.createElement("span");
          lockIcon.className = "row-lock";
          lockIcon.title = "force-mask: ロック中";
          lockIcon.textContent = "\ud83d\udd12"; // 🔒
          meta.appendChild(lockIcon);
        }

        wrap.appendChild(checkbox);
        wrap.appendChild(meta);
        rowControls.set(row.key, { checkbox, row });
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

      // --- Bulk action handlers (defined here so they can see rows) -------
      selectAllBtn.addEventListener("click", () => {
        for (const row of rows) {
          if (row.locked) continue;
          row.masked = true;
          const ctl = rowControls.get(row.key);
          if (ctl) ctl.checkbox.checked = true;
        }
        for (const cat of categoryOrder) syncCategoryToggle(cat);
        updatePreview();
      });
      deselectAllBtn.addEventListener("click", () => {
        for (const row of rows) {
          if (row.locked) continue;
          row.masked = false;
          const ctl = rowControls.get(row.key);
          if (ctl) ctl.checkbox.checked = false;
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
