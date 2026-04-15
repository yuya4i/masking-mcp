// Page-world (MAIN world) script.
//
// Injected by content.js at ``document_start``. Patches the real
// ``window.fetch`` and ``XMLHttpRequest.prototype.send`` so outgoing
// user-input POSTs to supported AI services are routed through the
// local gateway before leaving the browser.
//
// This script has no access to ``chrome.*`` APIs. It talks to the
// isolated content script via ``window.postMessage``:
//
//   injected → content: { source: "mask-mcp-inpage", id, type, ... }
//   content → injected: { source: "mask-mcp-content", id, type, ... }
//
// The content script relays sanitize calls to the gateway, reads the
// enabled flag from ``chrome.storage.local``, and forwards detection
// counts to the service worker for badge updates.

(() => {
  "use strict";

  const LOG = (...args) => console.debug("[mask-mcp]", ...args);
  const WARN = (...args) => console.warn("[mask-mcp]", ...args);

  const TAG_IN = "mask-mcp-inpage";   // outgoing to content script
  const TAG_OUT = "mask-mcp-content"; // incoming from content script

  let sequence = 0;
  const pending = new Map();

  // MAIN-world shared namespace used to hand data between
  // ``review-modal.js`` / ``sidebar.js`` and this script without
  // postMessage overhead. ``settings`` is refreshed whenever
  // content.js relays a new value (initial install + every
  // chrome.storage change). Defaults:
  //   * ``interactive: true``  — show review UI before sending.
  //   * ``uiMode: "sidebar"``  — Milestone 8 Wave B default. Old users
  //     who flip to "modal" in the popup get the legacy review-modal
  //     experience.
  const NS = (window.__localMaskMCP = window.__localMaskMCP || {});
  NS.settings = NS.settings || { interactive: true, uiMode: "sidebar" };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== TAG_OUT) return;
    // Settings broadcasts are a special "no id" message carrying the
    // latest ``interactive`` flag from chrome.storage.local.
    if (data.type === "settings" && data.settings) {
      NS.settings = {
        ...NS.settings,
        ...data.settings,
      };
      return;
    }
    if (typeof data.id !== "string") return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    entry.resolve(data);
  });

  function request(type, extra) {
    const id = `mcp-${++sequence}-${Date.now()}`;
    return new Promise((resolve) => {
      pending.set(id, { resolve });
      window.postMessage({ source: TAG_IN, id, type, ...extra }, "*");
      // Safety timeout — the content script should always reply;
      // this guards against a broken extension install.
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve(null);
        }
      }, 5000);
    });
  }

  // Hybrid mode state (Phase 1 of serverless engine).
  //
  // Decision rules, evaluated once per tab and cached:
  //
  //   1. pref === "standalone"  → always use local engine.
  //   2. pref === "gateway"     → always call gateway; no fallback.
  //   3. pref === "auto" (default) → probe gateway at warmup; if the
  //      probe says reachable, use gateway; otherwise use local engine.
  //
  // ``NS.settings.activeBackend`` is exposed for telemetry/debugging
  // (``window.__localMaskMCP.settings.activeBackend``).
  let hybridDecision = null; // "gateway" | "standalone"

  async function resolveBackend() {
    if (hybridDecision) return hybridDecision;
    const prefResp = await request("hybrid-pref", {});
    const pref =
      prefResp && prefResp.type === "hybrid-pref-result"
        ? prefResp.pref
        : "auto";
    if (pref === "standalone") {
      hybridDecision = "standalone";
    } else if (pref === "gateway") {
      hybridDecision = "gateway";
    } else {
      const probe = await request("backend-probe", {});
      const reachable =
        probe && probe.type === "backend-probe-result" && probe.reachable;
      hybridDecision = reachable ? "gateway" : "standalone";
    }
    NS.settings = { ...NS.settings, activeBackend: hybridDecision };
    return hybridDecision;
  }

  // Look up the shared pure-JS engine attached by bundle.js. Returns
  // null when the engine failed to load (user should see an error in
  // the console and we'll proceed with gateway-only semantics).
  function getEngine() {
    const e = NS.engine;
    if (e && e.ready && typeof e.maskAggregated === "function") return e;
    return null;
  }

  async function sanitizeOnce(text, service, sourceUrl) {
    const backend = await resolveBackend();
    if (backend === "standalone") {
      const engine = getEngine();
      if (!engine) {
        // Engine missing AND gateway not preferred: degrade by returning
        // the raw text so the fetch hook's unmasked-confirm prompt fires.
        WARN("standalone mode requested but engine unavailable");
        return null;
      }
      try {
        return engine.maskSanitize(text);
      } catch (e) {
        WARN("standalone maskSanitize failed:", e?.message || e);
        return null;
      }
    }
    const resp = await request("sanitize", {
      payload: { text, service, source_url: sourceUrl },
    });
    if (!resp || resp.type !== "sanitize-result") return null;
    return resp.result; // may be null on gateway failure
  }

  async function sanitizeAggregated(text, service, sourceUrl) {
    // Sidebar mode goes through the aggregated endpoint. Hybrid flow:
    //   * standalone  → call the local engine synchronously.
    //   * gateway     → ask the content script to proxy to the gateway.
    const backend = await resolveBackend();
    if (backend === "standalone") {
      const engine = getEngine();
      if (!engine) {
        WARN("standalone mode requested but engine unavailable");
        return null;
      }
      try {
        return engine.maskAggregated(text);
      } catch (e) {
        WARN("standalone maskAggregated failed:", e?.message || e);
        return null;
      }
    }
    const resp = await request("sanitize-aggregated", {
      payload: { text, service, source_url: sourceUrl },
    });
    if (!resp || resp.type !== "sanitize-aggregated-result") return null;
    return resp.result; // may be null on gateway failure
  }

  async function isEnabled() {
    const resp = await request("is-enabled", {});
    if (!resp || resp.type !== "is-enabled-result") return true;
    return resp.enabled !== false;
  }

  function reportDetectionCount(count) {
    if (!count || count <= 0) return;
    window.postMessage(
      {
        source: TAG_IN,
        id: `badge-${++sequence}-${Date.now()}`,
        type: "detection-count",
        count,
      },
      "*"
    );
  }

  // --- Service adapters (same registry pattern as the gateway side) ------

  const claudeAdapter = {
    name: "claude",
    match: (url) =>
      /(^https?:\/\/claude\.(ai|com)|\.claude\.com)/.test(url) &&
      /\/(api|completion|append_message|chat_conversations)/.test(url),
    extractInputs(body) {
      const out = [];
      if (typeof body?.prompt === "string" && body.prompt.trim()) {
        out.push(body.prompt);
      }
      if (Array.isArray(body?.messages)) {
        for (const m of body.messages) {
          if (m?.role === "user" && typeof m.content === "string") {
            out.push(m.content);
          } else if (Array.isArray(m?.content)) {
            for (const p of m.content) {
              if (p?.type === "text" && typeof p.text === "string") {
                out.push(p.text);
              }
            }
          }
        }
      }
      return out;
    },
    replaceInputs(body, masked) {
      let i = 0;
      const next = (orig) => (i < masked.length ? masked[i++] : orig);
      const clone = JSON.parse(JSON.stringify(body));
      if (typeof clone?.prompt === "string" && clone.prompt.trim()) {
        clone.prompt = next(clone.prompt);
      }
      if (Array.isArray(clone?.messages)) {
        for (const m of clone.messages) {
          if (m?.role === "user" && typeof m.content === "string") {
            m.content = next(m.content);
          } else if (Array.isArray(m?.content)) {
            for (const p of m.content) {
              if (p?.type === "text" && typeof p.text === "string") {
                p.text = next(p.text);
              }
            }
          }
        }
      }
      return clone;
    },
  };

  const chatgptAdapter = {
    name: "chatgpt",
    match: (url) =>
      /(chatgpt\.com|chat\.openai\.com)/.test(url) &&
      /\/backend-api\//.test(url) &&
      /(conversation|messages)/.test(url),
    extractInputs(body) {
      const out = [];
      if (Array.isArray(body?.messages)) {
        for (const m of body.messages) {
          if (m?.author?.role === "user" && Array.isArray(m?.content?.parts)) {
            for (const p of m.content.parts) {
              if (typeof p === "string" && p.trim()) out.push(p);
            }
          }
        }
      }
      return out;
    },
    replaceInputs(body, masked) {
      let i = 0;
      const next = (orig) => (i < masked.length ? masked[i++] : orig);
      const clone = JSON.parse(JSON.stringify(body));
      if (Array.isArray(clone?.messages)) {
        for (const m of clone.messages) {
          if (m?.author?.role === "user" && Array.isArray(m?.content?.parts)) {
            m.content.parts = m.content.parts.map((p) =>
              typeof p === "string" && p.trim() ? next(p) : p
            );
          }
        }
      }
      return clone;
    },
  };

  const geminiAdapter = {
    name: "gemini",
    match: (url) =>
      /gemini\.google\.com/.test(url) &&
      /(StreamGenerate|GenerateContent|assistant\.lamda|BardFrontendService)/i.test(
        url
      ),
    extractInputs(body) {
      const out = [];
      if (Array.isArray(body?.contents)) {
        for (const c of body.contents) {
          if ((c?.role === "user" || !c?.role) && Array.isArray(c?.parts)) {
            for (const p of c.parts) {
              if (typeof p?.text === "string" && p.text.trim()) out.push(p.text);
            }
          }
        }
      }
      if (typeof body?.["f.req"] === "string") {
        try {
          const parsed = JSON.parse(body["f.req"]);
          const walk = (v) => {
            if (typeof v === "string" && v.trim()) out.push(v);
            else if (Array.isArray(v)) v.forEach(walk);
          };
          walk(parsed);
        } catch (_) {
          // Not JSON — ignore.
        }
      }
      return out;
    },
    replaceInputs(body, masked) {
      let i = 0;
      const next = (orig) => (i < masked.length ? masked[i++] : orig);
      const clone = JSON.parse(JSON.stringify(body));
      if (Array.isArray(clone?.contents)) {
        for (const c of clone.contents) {
          if ((c?.role === "user" || !c?.role) && Array.isArray(c?.parts)) {
            for (const p of c.parts) {
              if (typeof p?.text === "string" && p.text.trim()) {
                p.text = next(p.text);
              }
            }
          }
        }
      }
      return clone;
    },
  };

  const manusAdapter = {
    name: "manus",
    match: (url) => /manus\.im/.test(url) && /\/api\//.test(url),
    extractInputs(body) {
      const out = [];
      if (typeof body?.input === "string" && body.input.trim()) out.push(body.input);
      if (typeof body?.prompt === "string" && body.prompt.trim()) out.push(body.prompt);
      if (Array.isArray(body?.messages)) {
        for (const m of body.messages) {
          if (m?.role === "user" && typeof m.content === "string") {
            out.push(m.content);
          }
        }
      }
      return out;
    },
    replaceInputs(body, masked) {
      let i = 0;
      const next = (orig) => (i < masked.length ? masked[i++] : orig);
      const clone = JSON.parse(JSON.stringify(body));
      if (typeof clone?.input === "string" && clone.input.trim()) {
        clone.input = next(clone.input);
      }
      if (typeof clone?.prompt === "string" && clone.prompt.trim()) {
        clone.prompt = next(clone.prompt);
      }
      if (Array.isArray(clone?.messages)) {
        for (const m of clone.messages) {
          if (m?.role === "user" && typeof m.content === "string") {
            m.content = next(m.content);
          }
        }
      }
      return clone;
    },
  };

  const SERVICES = [claudeAdapter, chatgptAdapter, geminiAdapter, manusAdapter];

  function pickAdapter(url) {
    if (typeof url !== "string") return null;
    for (const s of SERVICES) {
      try {
        if (s.match(url)) return s;
      } catch (_) {
        // Broken matcher → skip, never brick the page.
      }
    }
    return null;
  }

  function confirmSendUnmasked(serviceName) {
    try {
      return window.confirm(
        `[Local Mask MCP] Gateway at 127.0.0.1:8081 is unreachable.\n\n` +
          `Your input to ${serviceName} could NOT be masked.\n` +
          `Send anyway without masking?`
      );
    } catch (_) {
      return false;
    }
  }

  // Shared numbering helper — mirrors MaskingService._tag_mask's
  // pass-1 on the server. Same (label, surface) → same number; the
  // server and client therefore agree on exactly which placeholder
  // each occurrence resolves to, so the gateway's sanitized_text and
  // the client-side preview never disagree.
  //
  // Returns a function ``numberFor(label, surface) -> int`` that the
  // substitution loops below call without re-scanning the input.
  function buildNumberer(originalText, spans) {
    // spans: Array<{start, end, label}> OR Array<[start, end, label]>
    const counters = new Map();
    const numbering = new Map();
    const normalized = spans
      .map((x) => {
        if (Array.isArray(x)) return { start: x[0], end: x[1], label: x[2] };
        return { start: x.start, end: x.end, label: x.label || x.entity_type };
      })
      .filter(
        (x) =>
          Number.isInteger(x.start) && Number.isInteger(x.end) && x.end > x.start
      )
      .sort((a, b) => a.start - b.start || a.end - b.end);
    for (const { start, end, label } of normalized) {
      const surface = originalText.slice(start, end);
      const key = `${label}\x00${surface}`;
      if (!numbering.has(key)) {
        const n = (counters.get(label) || 0) + 1;
        counters.set(label, n);
        numbering.set(key, n);
      }
    }
    return (label, surface) =>
      numbering.get(`${label}\x00${surface}`) || 1;
  }

  // Apply the subset of gateway detections that the user kept
  // checked in the review modal. We use the numbered-tag strategy
  // (``<ENTITY_TYPE_N>``) so repeated mentions of the same surface
  // share a placeholder, matching the server-side invariant.
  function applyTagSubstitutions(originalText, detections, keptIds) {
    if (!keptIds || keptIds.size === 0) return originalText;
    const kept = detections
      .map((d, idx) => ({ ...d, __idx: idx }))
      .filter((d) => keptIds.has(d.__idx))
      .filter(
        (d) =>
          Number.isInteger(d.start) &&
          Number.isInteger(d.end) &&
          d.end > d.start
      );
    const numberFor = buildNumberer(originalText, kept);
    const descending = [...kept].sort((a, b) => b.start - a.start);
    let out = originalText;
    for (const d of descending) {
      const surface = originalText.slice(d.start, d.end);
      const n = numberFor(d.entity_type, surface);
      out = out.slice(0, d.start) + `<${d.entity_type}_${n}>` + out.slice(d.end);
    }
    return out;
  }

  // Sidebar variant: input is the flattened [start, end, label] list
  // returned from sidebar.show(). Same contract as
  // applyTagSubstitutions; kept as a separate function so injected.js
  // never imports from the sidebar global (the sidebar may legitimately
  // be missing if the user picked ``uiMode: "modal"`` and only
  // review-modal.js was loaded).
  function applyTriples(originalText, triples) {
    if (!triples || triples.length === 0) return originalText;
    const numberFor = buildNumberer(originalText, triples);
    const sorted = [...triples].sort((a, b) => b[0] - a[0]);
    let out = originalText;
    for (const [s, e, label] of sorted) {
      if (
        !Number.isInteger(s) ||
        !Number.isInteger(e) ||
        e <= s ||
        s < 0 ||
        e > out.length
      ) {
        continue;
      }
      const lbl = String(label || "MASKED");
      const surface = originalText.slice(s, e);
      const n = numberFor(lbl, surface);
      out = out.slice(0, s) + `<${lbl}_${n}>` + out.slice(e);
    }
    return out;
  }

  async function processBody(adapter, bodyJson, url) {
    const inputs = adapter.extractInputs(bodyJson);
    if (!inputs.length) {
      return { changed: false, body: bodyJson };
    }
    LOG(`${adapter.name}: ${inputs.length} input string(s) to mask`);

    const interactive = NS.settings && NS.settings.interactive !== false;
    const uiMode = (NS.settings && NS.settings.uiMode) || "sidebar";
    const sidebar = NS.sidebar;
    const modal = NS.reviewModal;
    // Dispatch policy:
    //   * interactive off  → auto-mask via /sanitize, no UI.
    //   * interactive on + uiMode "sidebar" + sidebar loaded
    //                       → /sanitize/aggregated + sidebar.show().
    //   * interactive on + uiMode "modal"  + modal loaded
    //                       → /sanitize + reviewModal.show() (legacy).
    //   * any other combo (UI helper missing) → fall back to auto-mask.
    const useSidebar = interactive && uiMode === "sidebar" && !!sidebar;
    const useModal = interactive && uiMode === "modal" && !!modal;

    const masked = [];
    let totalDetections = 0;
    let anyChanged = false;
    for (const text of inputs) {
      if (useSidebar) {
        const aggResp = await sanitizeAggregated(text, adapter.name, url);
        if (!aggResp) {
          if (!confirmSendUnmasked(adapter.name)) {
            throw new Error("mask-mcp: user cancelled unmasked send");
          }
          masked.push(text);
          continue;
        }
        const aggregated = Array.isArray(aggResp.aggregated)
          ? aggResp.aggregated
          : [];
        if (aggregated.length === 0) {
          // Nothing to review — forward verbatim. The aggregated
          // endpoint does not return ``sanitized_text``; we just
          // keep the original.
          masked.push(text);
          continue;
        }
        const decision = await sidebar.show(aggResp, text);
        if (!decision.accepted) {
          throw new Error("mask-mcp: user cancelled review");
        }
        const finalText = applyTriples(text, decision.maskedPositions);
        if (finalText !== text) anyChanged = true;
        masked.push(finalText);
        totalDetections += decision.maskedPositions
          ? decision.maskedPositions.length
          : 0;
        continue;
      }

      const result = await sanitizeOnce(text, adapter.name, url);
      if (!result) {
        if (!confirmSendUnmasked(adapter.name)) {
          throw new Error("mask-mcp: user cancelled unmasked send");
        }
        masked.push(text);
        continue;
      }

      const detections = Array.isArray(result.detections)
        ? result.detections
        : [];

      if (useModal && detections.length > 0) {
        const decision = await modal.show(detections, text);
        if (!decision.accepted) {
          // Cancelled — abort the whole outbound request. The fetch
          // hook translates this exception into a rejected Promise
          // so the page's send logic sees a normal network error.
          throw new Error("mask-mcp: user cancelled review");
        }
        const finalText = applyTagSubstitutions(
          text,
          detections,
          decision.maskedDetectionIds
        );
        if (finalText !== text) anyChanged = true;
        masked.push(finalText);
        totalDetections += decision.maskedDetectionIds.size;
        continue;
      }

      // Auto-mask path (interactive off, no UI helper loaded, or no
      // detections) — use the gateway-sanitised text as-is.
      if (result.sanitized_text !== text) anyChanged = true;
      masked.push(result.sanitized_text);
      totalDetections += detections.length;
    }

    reportDetectionCount(totalDetections);

    if (!anyChanged) {
      return { changed: false, body: bodyJson };
    }
    return { changed: true, body: adapter.replaceInputs(bodyJson, masked) };
  }

  // --- fetch hook --------------------------------------------------------

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function maskedFetch(input, init) {
    try {
      const url =
        typeof input === "string"
          ? input
          : input && typeof input.url === "string"
          ? input.url
          : "";
      const method =
        (init && init.method) || (input && input.method) || "GET";

      if (method.toUpperCase() !== "POST") {
        return originalFetch(input, init);
      }
      const adapter = pickAdapter(url);
      if (!adapter) {
        return originalFetch(input, init);
      }
      if (!(await isEnabled())) {
        return originalFetch(input, init);
      }

      const rawBody = init ? init.body : input && input.body;
      if (typeof rawBody !== "string") {
        return originalFetch(input, init);
      }
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch (_) {
        return originalFetch(input, init);
      }

      const result = await processBody(adapter, parsed, url);
      if (!result.changed) {
        return originalFetch(input, init);
      }

      const nextInit = { ...(init || {}) };
      nextInit.body = JSON.stringify(result.body);
      LOG(`${adapter.name}: substituted masked body`);
      return originalFetch(input, nextInit);
    } catch (err) {
      if (err && err.message && err.message.includes("mask-mcp: user cancelled")) {
        LOG(err.message);
        // Surface as a rejected Promise so the page's send logic
        // treats it as a normal network failure (no masked payload
        // ever leaves the browser). Chat UIs typically present this
        // as "send failed — try again" which is the correct UX.
        return Promise.reject(err);
      }
      WARN("fetch hook error; falling back to original:", err?.message || err);
      return originalFetch(input, init);
    }
  };

  // --- XHR hook ----------------------------------------------------------

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this._maskMcpMethod = method;
    this._maskMcpUrl = url;
    return originalXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    try {
      const method = (this._maskMcpMethod || "GET").toUpperCase();
      const url = this._maskMcpUrl || "";
      if (method !== "POST" || typeof body !== "string") {
        return originalXhrSend.apply(this, arguments);
      }
      const adapter = pickAdapter(url);
      if (!adapter) {
        return originalXhrSend.apply(this, arguments);
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (_) {
        return originalXhrSend.apply(this, arguments);
      }

      const xhr = this;
      const args = arguments;
      (async () => {
        if (!(await isEnabled())) {
          originalXhrSend.apply(xhr, args);
          return;
        }
        try {
          const result = await processBody(adapter, parsed, url);
          if (!result.changed) {
            originalXhrSend.apply(xhr, args);
            return;
          }
          LOG(`${adapter.name}: substituted masked XHR body`);
          originalXhrSend.call(xhr, JSON.stringify(result.body));
        } catch (err) {
          if (err && err.message && err.message.includes("mask-mcp: user cancelled")) {
            LOG(err.message);
            try { xhr.abort(); } catch (_) { /* noop */ }
            return;
          }
          WARN("XHR hook error; falling back to original:", err?.message || err);
          originalXhrSend.apply(xhr, args);
        }
      })();
    } catch (err) {
      WARN("XHR send hook setup failed:", err?.message || err);
      return originalXhrSend.apply(this, arguments);
    }
  };

  LOG("injected hooks installed on", window.location.hostname);
})();
