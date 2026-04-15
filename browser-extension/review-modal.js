// Page-world (MAIN world) script.
//
// Injected by content.js at ``document_start`` alongside injected.js.
// Exposes a Shadow-DOM-scoped review modal the fetch interceptor can
// await when interactive mode is on. The modal presents every
// gateway-side detection in a scrollable list and lets the user
// un-tick false positives before the masked payload leaves the page.
//
// Exposed on ``window.__localMaskMCP.reviewModal`` so injected.js can
// reach it without cross-world messaging (both scripts live in MAIN).
//
// Design decisions
// ~~~~~~~~~~~~~~~~
//
// * **Shadow DOM** — the entire UI lives inside an ``attachShadow``
//   tree on a throwaway ``<div>`` appended to ``document.body``. The
//   page's CSS cannot bleed in and our styles never touch the page.
//   When the promise resolves the host element is removed from the
//   DOM completely.
// * **z-index: 2147483647** (max signed 32-bit int) so the overlay
//   always sits above whatever layer the host page is using.
// * **No innerHTML** — every node is built via ``createElement`` /
//   ``textContent`` so user-controlled strings from detections
//   can never be reinterpreted as HTML.
// * **No dependencies** — vanilla JS.
// * **Keyboard** — Enter submits (mapped to the primary confirm
//   button); Esc cancels; Tab cycles focus; Space toggles the
//   currently-focused checkbox.
// * **Accessibility** — ``role="dialog"`` + ``aria-modal="true"``
//   so screen readers announce the overlay correctly. The confirm
//   button receives focus on open so Enter immediately completes
//   the common-case flow.

(() => {
  "use strict";

  const NS = (window.__localMaskMCP = window.__localMaskMCP || {});
  if (NS.reviewModal) {
    // Idempotent — content.js may re-inject after an SPA navigation
    // and we must not install the modal twice.
    return;
  }

  // Entity-type → badge colour. Unknown types fall through to a
  // neutral grey so new entity names from future analyzers still
  // render legibly instead of exploding the modal.
  const HIGH_SENSITIVITY = new Set([
    "API_KEY",
    "SECRET",
    "EMAIL_ADDRESS",
    "CREDIT_CARD",
    "MY_NUMBER",
    "PASSPORT",
    "DRIVERS_LICENSE",
    "BANK_ACCOUNT",
    "DB_CONNECTION",
    "PHONE_NUMBER",
  ]);
  const NAME_TYPES = new Set([
    "PERSON",
    "PROPER_NOUN",
    "PROPER_NOUN_PERSON",
    "KATAKANA_NAME",
  ]);
  const LOCATION_TYPES = new Set([
    "LOCATION",
    "PROPER_NOUN_LOCATION",
    "PROPER_NOUN_ORG",
    "ADDRESS",
    "COMPANY",
  ]);

  function badgeColor(entityType) {
    if (HIGH_SENSITIVITY.has(entityType)) return "#b00020"; // red
    if (NAME_TYPES.has(entityType)) return "#b84a00"; // orange
    if (LOCATION_TYPES.has(entityType)) return "#2166cc"; // blue
    return "#5a5a63"; // grey
  }

  const STYLE = `
    :host {
      all: initial;
    }
    .backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      color: #1b1b1f;
    }
    .panel {
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.25);
      width: min(92vw, 520px);
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .panel header {
      padding: 16px 20px 8px 20px;
      border-bottom: 1px solid #e2e2e7;
    }
    .panel header h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }
    .panel header p {
      margin: 6px 0 0 0;
      font-size: 12px;
      color: #5a5a63;
      line-height: 1.5;
    }
    .list {
      overflow-y: auto;
      padding: 8px 20px;
      flex: 1 1 auto;
    }
    .empty {
      padding: 24px 0;
      text-align: center;
      color: #5a5a63;
      font-size: 13px;
    }
    .row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 0;
      border-bottom: 1px solid #f0f0f3;
    }
    .row:last-child {
      border-bottom: none;
    }
    .row input[type="checkbox"] {
      margin-top: 3px;
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      accent-color: #2166cc;
    }
    .row .meta {
      flex: 1 1 auto;
      min-width: 0;
    }
    .badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: #ffffff;
      padding: 2px 6px;
      border-radius: 4px;
      margin-right: 6px;
      vertical-align: middle;
      text-transform: uppercase;
    }
    .match {
      font-family: ui-monospace, SFMono-Regular, "Menlo", Consolas,
        "Liberation Mono", monospace;
      font-size: 12px;
      background: #f4f4f7;
      padding: 1px 4px;
      border-radius: 3px;
      word-break: break-all;
    }
    .context {
      display: block;
      margin-top: 4px;
      font-size: 11px;
      color: #5a5a63;
      word-break: break-all;
      white-space: pre-wrap;
    }
    .mask-preview {
      display: inline-block;
      margin-left: 6px;
      font-size: 11px;
      color: #2166cc;
    }
    footer {
      padding: 12px 20px;
      border-top: 1px solid #e2e2e7;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      background: #fafafb;
    }
    button {
      font: inherit;
      padding: 8px 14px;
      border-radius: 6px;
      border: 1px solid transparent;
      cursor: pointer;
    }
    button.secondary {
      background: #ffffff;
      border-color: #cbcbd1;
      color: #1b1b1f;
    }
    button.primary {
      background: #2166cc;
      color: #ffffff;
      font-weight: 600;
    }
    button.primary:focus-visible,
    button.secondary:focus-visible {
      outline: 2px solid #2166cc;
      outline-offset: 2px;
    }
  `;

  // Build one detection row entirely via DOM APIs. Nothing here
  // ever sets ``innerHTML`` on untrusted strings — detection text
  // only reaches the DOM through ``textContent``.
  //
  // ``number`` is the placeholder suffix so the row preview shows
  // ``→ <PROPER_NOUN_PERSON_1>`` instead of the ambiguous bare
  // ``<PROPER_NOUN_PERSON>``. Same (entity, surface) must share a
  // number across rows so the user sees repeated mentions collapse
  // into one referent.
  function buildRow(detection, index, number) {
    const entity = String(detection.entity_type || "UNKNOWN");
    const text = String(detection.text || "");
    const before = String(detection.context_before || "");
    const after = String(detection.context_after || "");
    const color = badgeColor(entity);
    const id = `mcp-det-${index}`;
    const n = Number.isInteger(number) && number > 0 ? number : 1;

    const row = document.createElement("label");
    row.className = "row";
    row.setAttribute("for", id);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = id;
    checkbox.dataset.index = String(index);
    checkbox.checked = true;

    const meta = document.createElement("div");
    meta.className = "meta";

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.style.background = color;
    badge.textContent = entity;

    const match = document.createElement("span");
    match.className = "match";
    match.textContent = text;

    const preview = document.createElement("span");
    preview.className = "mask-preview";
    preview.textContent = `\u2192 <${entity}_${n}>`;

    const context = document.createElement("span");
    context.className = "context";
    context.appendChild(document.createTextNode(before));
    const bold = document.createElement("b");
    bold.textContent = `[${text}]`;
    context.appendChild(bold);
    context.appendChild(document.createTextNode(after));

    meta.appendChild(badge);
    meta.appendChild(match);
    meta.appendChild(preview);
    meta.appendChild(context);

    row.appendChild(checkbox);
    row.appendChild(meta);
    return row;
  }

  /**
   * Show the review modal.
   *
   * @param {Array<Object>} detections - Gateway detections with
   *   ``entity_type`` / ``start`` / ``end`` / ``text`` /
   *   ``context_before`` / ``context_after``.
   * @param {string} _originalText - Kept for future use (currently
   *   not rendered; the context snippets already carry enough
   *   surrounding text).
   * @returns {Promise<{accepted: boolean, maskedDetectionIds: Set<number>}>}
   */
  async function show(detections, _originalText) {
    detections = Array.isArray(detections) ? detections : [];

    // When the gateway returned no detections, short-circuit — no UI
    // needed, and the caller will just forward the original body.
    if (detections.length === 0) {
      return { accepted: true, maskedDetectionIds: new Set() };
    }

    return new Promise((resolve) => {
      const host = document.createElement("div");
      host.setAttribute("data-mask-mcp-modal", "");
      // Keep the host element itself minimally styled so broken
      // stylesheets on the page cannot push it around. Everything
      // visual lives inside the shadow root.
      host.style.all = "initial";
      host.style.position = "fixed";
      host.style.inset = "0";
      host.style.zIndex = "2147483647";
      const shadow = host.attachShadow({ mode: "open" });

      const style = document.createElement("style");
      style.textContent = STYLE;
      shadow.appendChild(style);

      const backdrop = document.createElement("div");
      backdrop.className = "backdrop";
      backdrop.setAttribute("role", "dialog");
      backdrop.setAttribute("aria-modal", "true");
      backdrop.setAttribute("aria-labelledby", "mcp-title");

      const panel = document.createElement("div");
      panel.className = "panel";
      panel.setAttribute("tabindex", "-1");

      const header = document.createElement("header");
      const title = document.createElement("h2");
      title.id = "mcp-title";
      title.textContent = "マスク対象の確認";
      const desc = document.createElement("p");
      desc.textContent =
        "以下の項目がマスクされます。問題なければ「選択したものをマスクして送信」を押してください。誤検知があればチェックを外して元の文字列のまま送信できます。";
      header.appendChild(title);
      header.appendChild(desc);

      const list = document.createElement("div");
      list.className = "list";

      // Precompute (entity_type, surface) → number so every row's
      // placeholder preview matches what the gateway will actually
      // bake into ``sanitized_text``. Same invariant as
      // MaskingService._tag_mask on the server: left-to-right,
      // shared number for repeated surfaces.
      const sortedForNumbering = detections
        .map((d, idx) => ({ d, idx }))
        .filter(({ d }) => Number.isInteger(d.start) && Number.isInteger(d.end))
        .sort((a, b) => a.d.start - b.d.start || a.d.end - b.d.end);
      const counters = new Map();
      const rowNumber = new Array(detections.length).fill(1);
      const assigned = new Map();
      for (const { d, idx } of sortedForNumbering) {
        const key = `${d.entity_type}\x00${d.text}`;
        if (!assigned.has(key)) {
          const n = (counters.get(d.entity_type) || 0) + 1;
          counters.set(d.entity_type, n);
          assigned.set(key, n);
        }
        rowNumber[idx] = assigned.get(key);
      }

      detections.forEach((det, idx) =>
        list.appendChild(buildRow(det, idx, rowNumber[idx]))
      );

      const footer = document.createElement("footer");

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "secondary";
      cancelBtn.dataset.action = "cancel";
      cancelBtn.textContent = "キャンセル (Esc)";

      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "primary";
      confirmBtn.dataset.action = "confirm";
      confirmBtn.textContent = "選択したものをマスクして送信 (Enter)";

      footer.appendChild(cancelBtn);
      footer.appendChild(confirmBtn);

      panel.appendChild(header);
      panel.appendChild(list);
      panel.appendChild(footer);
      backdrop.appendChild(panel);
      shadow.appendChild(backdrop);

      document.body.appendChild(host);

      function cleanup() {
        document.removeEventListener("keydown", onKeyDown, true);
        if (host.parentNode) host.parentNode.removeChild(host);
      }

      function collectSelected() {
        const picked = new Set();
        shadow
          .querySelectorAll('input[type="checkbox"][data-index]')
          .forEach((input) => {
            if (input.checked) {
              const idx = Number(input.getAttribute("data-index"));
              if (Number.isInteger(idx)) picked.add(idx);
            }
          });
        return picked;
      }

      function onConfirm() {
        const picked = collectSelected();
        cleanup();
        resolve({ accepted: true, maskedDetectionIds: picked });
      }

      function onCancel() {
        cleanup();
        resolve({ accepted: false, maskedDetectionIds: new Set() });
      }

      confirmBtn.addEventListener("click", onConfirm);
      cancelBtn.addEventListener("click", onCancel);

      function onKeyDown(event) {
        // We listen on ``document`` in capture phase so the page
        // never sees these keys while the modal is up. That way a
        // chat app's own Enter-to-send handler cannot fire while
        // the user is reviewing masks.
        if (event.key === "Escape") {
          event.stopPropagation();
          event.preventDefault();
          onCancel();
          return;
        }
        if (event.key === "Enter") {
          // Enter submits unless the user is inside a multiline
          // textarea (none in this modal today, but future-proof).
          const tag = event.target && event.target.tagName;
          if (tag !== "TEXTAREA") {
            event.stopPropagation();
            event.preventDefault();
            onConfirm();
            return;
          }
        }
        // Tab / Shift-Tab: rely on native focus cycling — browsers
        // honour the tabindex order inside a shadow root correctly.
      }
      document.addEventListener("keydown", onKeyDown, true);

      // Focus the primary confirm button so Enter immediately
      // completes the happy-path flow.
      setTimeout(() => confirmBtn.focus(), 0);
    });
  }

  NS.reviewModal = { show };
})();
