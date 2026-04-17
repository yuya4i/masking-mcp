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

  // Query params that commonly carry session credentials. Our diagnostic
  // LOGs echo URLs verbatim, which means JWT/API-key leaks into console
  // and any screenshot / paste. Redaction keeps the host + path visible
  // (useful for endpoint discovery) while masking secrets.
  const SENSITIVE_QS = [
    "token",
    "auth",
    "key",
    "api_key",
    "access_token",
    "sentry_key",
    "session",
  ];

  function redactUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      let dirty = false;
      for (const k of SENSITIVE_QS) {
        if (u.searchParams.has(k)) {
          u.searchParams.set(k, "REDACTED");
          dirty = true;
        }
      }
      return dirty ? u.toString() : raw;
    } catch (_) {
      return raw;
    }
  }

  // Bounded-length snippet for logging WS frames. Socket.IO EVENT frames
  // start with ``42[...]`` and are usually under a few hundred chars —
  // 160 chars is enough to see the event name + first field without
  // drowning the console in long JSON payloads.
  function previewPayload(data, max = 160) {
    if (typeof data !== "string") return "(" + typeof data + ")";
    return data.length <= max
      ? data
      : data.slice(0, max) + "…(+" + (data.length - max) + " chars)";
  }

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
      // Notify open UI surfaces (e.g. sidebar) so they can apply
      // live-updated settings (allowlist additions etc.) without
      // requiring a re-render trigger.
      try {
        window.dispatchEvent(
          new CustomEvent("mask-mcp:settings-updated", {
            detail: NS.settings,
          })
        );
      } catch (_) {}
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

  // Engine readiness resolves when bundle.js dispatches
  // "mask-mcp:engine-ready" or when polling detects engine.ready.
  // Safety timeout prevents callers from hanging if the engine scripts
  // silently fail to load (e.g., page CSP blocks chrome-extension://).
  const ENGINE_WAIT_MS = 3000;
  function isEngineReady(e) {
    return !!(e && e.ready && typeof e.maskAggregated === "function");
  }
  const enginePromise = new Promise((resolve) => {
    if (isEngineReady(NS.engine)) {
      resolve(NS.engine);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("mask-mcp:engine-ready", onReady);
      resolve(value);
    };
    const onReady = () => finish(NS.engine);
    window.addEventListener("mask-mcp:engine-ready", onReady);
    const iv = setInterval(() => {
      if (isEngineReady(NS.engine)) {
        clearInterval(iv);
        finish(NS.engine);
      }
    }, 50);
    setTimeout(() => {
      clearInterval(iv);
      finish(isEngineReady(NS.engine) ? NS.engine : null);
    }, ENGINE_WAIT_MS);
  });

  async function getEngine() {
    const e = await enginePromise;
    return isEngineReady(e) ? e : null;
  }

  async function sanitizeOnce(text, service, sourceUrl) {
    const backend = await resolveBackend();
    if (backend === "standalone") {
      const engine = await getEngine();
      if (!engine) {
        // Engine missing AND gateway not preferred: degrade by returning
        // the raw text so the fetch hook's unmasked-confirm prompt fires.
        WARN(
          "standalone mode requested but engine unavailable after",
          ENGINE_WAIT_MS + "ms.",
          "Check DevTools Console for [mask-mcp] engine bundle errors",
          "or CSP violations blocking chrome-extension:// scripts."
        );
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
      const engine = await getEngine();
      if (!engine) {
        WARN(
          "standalone mode requested but engine unavailable after",
          ENGINE_WAIT_MS + "ms.",
          "Check DevTools Console for [mask-mcp] engine bundle errors",
          "or CSP violations blocking chrome-extension:// scripts."
        );
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

  // v0.5.0 — Local LLM wrapper. Returns null when LLM is disabled /
  // unreachable / times out, so callers can treat "no augmentation"
  // as the normal case.
  async function llmAugment(text, mode) {
    try {
      const cfgResp = await request("llm-config", {});
      const cfg = cfgResp && cfgResp.config;
      if (!cfg) return null;
      const prompts = NS.engine && NS.engine.llmPrompts;
      if (!prompts) return null;
      const build =
        mode === "replace" ? prompts.buildReplacePrompt : prompts.buildDetectPrompt;
      const { system, user } = build(text);
      const callResp = await request("llm-call", { system, user, config: cfg });
      const raw = callResp && callResp.result;
      if (!raw || typeof raw !== "string") return null;
      // The LLM sometimes wraps JSON in ```json fences despite instructions.
      // Qwen3 / Deepseek-R1 / other "thinking" models wrap reasoning
      // in <think>...</think> before the actual answer. Strip those
      // blocks (including multi-line, including unclosed in case the
      // model truncated). Also strip ```json fences.
      let cleaned = raw
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<think>[\s\S]*$/i, "")
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      // Some models leave a leading narrative before JSON. Find the
      // first `{` and last `}` and parse that substring.
      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      if (firstBrace > 0 && lastBrace > firstBrace) {
        cleaned = cleaned.slice(firstBrace, lastBrace + 1);
      }
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (_) {
        LOG("llm response not JSON; ignoring");
        return null;
      }
      // [MEDIUM] Strict schema validation — a prompt-injected response
      // that returns free-form text or unexpected fields must be
      // rejected so the regex pipeline stays authoritative.
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        LOG("llm response not object; ignoring");
        return null;
      }
      if (mode === "detect") {
        if (!Array.isArray(parsed.entities)) {
          LOG("llm detect response missing entities[]; ignoring");
          return null;
        }
        parsed.entities = parsed.entities.filter(
          (e) =>
            e &&
            typeof e === "object" &&
            typeof e.text === "string" &&
            e.text.trim().length > 0 &&
            e.text.length < 500 &&
            typeof e.entity_type === "string"
        );
        return parsed;
      }
      if (mode === "replace") {
        if (
          typeof parsed.rewritten_text !== "string" ||
          parsed.rewritten_text.length === 0
        ) {
          LOG("llm replace response missing rewritten_text; ignoring");
          return null;
        }
        return parsed;
      }
      return parsed;
    } catch (err) {
      WARN("llmAugment failed:", err?.message || err);
      return null;
    }
  }

  // Merge LLM-detected contextual entities into the regex aggregated
  // response. Skips LLM entirely when config is missing or mode is
  // not "detect". Deduplicates by surface text so regex wins on
  // overlap. Returns the (possibly augmented) aggResp.
  async function mergeLlmDetect(aggResp, text) {
    try {
      const cfgResp = await request("llm-config", {});
      const cfg = cfgResp && cfgResp.config;
      if (!cfg || cfg.mode !== "detect") return aggResp;
      NS.sidebar && NS.sidebar.showLoading && NS.sidebar.showLoading("LLM 分析中…");
      let out;
      try {
        out = await llmAugment(text, "detect");
      } finally {
        NS.sidebar && NS.sidebar.hideLoading && NS.sidebar.hideLoading();
      }
      const llmEnts = (out && Array.isArray(out.entities)) ? out.entities : [];
      if (!llmEnts.length) return aggResp;
      const existing = new Set(
        (aggResp.aggregated || []).map((a) => String(a.value))
      );
      const LABEL_TO_CATEGORY = {
        PERSON: "PERSON",
        COMPANY: "ORGANIZATION",
        LOCATION: "LOCATION",
        DEPARTMENT: "OTHER",
        PROJECT_CODE: "OTHER",
        CREDENTIAL: "CREDENTIAL",
        SENSITIVE_FACT: "OTHER",
      };
      const LABEL_TO_SEVERITY = {
        PERSON: "critical",
        COMPANY: "critical",
        LOCATION: "high",
        DEPARTMENT: "medium",
        PROJECT_CODE: "medium",
        CREDENTIAL: "critical",
        SENSITIVE_FACT: "high",
      };
      let added = 0;
      const counters = {};
      for (const ent of llmEnts) {
        const value = typeof ent.text === "string" ? ent.text.trim() : "";
        if (!value || existing.has(value)) continue;
        const start = text.indexOf(value);
        if (start < 0) continue;
        const label = String(ent.entity_type || "SENSITIVE_FACT").toUpperCase();
        const category = LABEL_TO_CATEGORY[label] || "OTHER";
        const severity = LABEL_TO_SEVERITY[label] || "medium";
        counters[label] = (counters[label] || 0) + 1;
        aggResp.aggregated.push({
          value,
          label,
          category,
          count: 1,
          positions: [[start, start + value.length]],
          masked: true,
          placeholder: `<${label}_${counters[label]}>`,
          classification: "contextual",
          severity,
          source: "llm",
        });
        existing.add(value);
        added++;
      }
      if (added > 0) LOG(`mergeLlmDetect: +${added} entities from LLM`);
      return aggResp;
    } catch (err) {
      WARN("mergeLlmDetect failed:", err?.message || err);
      return aggResp;
    }
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

  // Manus is operated by Butterfly Effect Inc.; its backend APIs are
  // served from *.butterfly-effect.dev, not only from manus.im. The
  // user-facing page at manus.im fetches chat/session endpoints from
  // butterfly-effect.dev, so a ``manus.im``-only matcher never fires.
  // Match either host, then gate on a common API path keyword to keep
  // out static assets and telemetry.
  const manusAdapter = {
    name: "manus",
    match: (url) =>
      /(manus\.im|butterfly-effect\.dev)/i.test(url) &&
      !/(sentry|amplitude|analytics|telemetry|segment\.io|datadog|newrelic)/i.test(
        url
      ) &&
      /(\/api\/|\/v1\/|\/chat\/|\/message|\/task|\/session|\/rpc|\/submit|\/send|\/completion|\/agent|\/conversation)/i.test(
        url
      ),
    extractInputs(body) {
      const out = [];
      const pushIfString = (v) => {
        if (typeof v === "string" && v.trim()) out.push(v);
      };
      pushIfString(body?.input);
      pushIfString(body?.prompt);
      pushIfString(body?.query);
      pushIfString(body?.text);
      pushIfString(body?.message);
      pushIfString(body?.content);
      if (Array.isArray(body?.contents)) {
        for (const c of body.contents) {
          if (c?.type === "text" && typeof c.value === "string" && c.value.trim()) {
            out.push(c.value);
          }
        }
      }
      if (Array.isArray(body?.messages)) {
        for (const m of body.messages) {
          if (m?.role === "user" && typeof m.content === "string") {
            out.push(m.content);
          } else if (Array.isArray(m?.content)) {
            for (const p of m.content) {
              if (typeof p?.text === "string" && p.text.trim()) out.push(p.text);
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
      const swap = (key) => {
        if (typeof clone?.[key] === "string" && clone[key].trim()) {
          clone[key] = next(clone[key]);
        }
      };
      swap("input");
      swap("prompt");
      swap("query");
      swap("text");
      swap("message");
      swap("content");
      if (Array.isArray(clone?.contents)) {
        for (const c of clone.contents) {
          if (c?.type === "text" && typeof c.value === "string" && c.value.trim()) {
            c.value = next(c.value);
          }
        }
      }
      if (Array.isArray(clone?.messages)) {
        for (const m of clone.messages) {
          if (m?.role === "user" && typeof m.content === "string") {
            m.content = next(m.content);
          } else if (Array.isArray(m?.content)) {
            for (const p of m.content) {
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
        `[PII Guard] Could not mask your input to ${serviceName}.\n\n` +
          `Send the original text anyway?`
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

    // v0.5.0 — AI replace mode. When enabled the LLM rewrites the
    // message body end-to-end; we skip the regex/review pipeline for
    // those inputs and substitute the LLM output directly. Falls back
    // to the regex path when LLM returns nothing usable.
    try {
      const cfgResp = await request("llm-config", {});
      const cfg = cfgResp && cfgResp.config;
      if (cfg && cfg.mode === "replace") {
        const rewritten = [];
        let allLlmSucceeded = true;
        NS.sidebar && NS.sidebar.showLoading && NS.sidebar.showLoading("AI 置換中…");
        try {
          for (const text of inputs) {
            const out = await llmAugment(text, "replace");
            if (
              out &&
              typeof out.rewritten_text === "string" &&
              out.rewritten_text.length > 0 &&
              out.rewritten_text !== text
            ) {
              rewritten.push(out.rewritten_text);
            } else {
              allLlmSucceeded = false;
              break;
            }
          }
        } finally {
          NS.sidebar && NS.sidebar.hideLoading && NS.sidebar.hideLoading();
        }
        if (allLlmSucceeded && rewritten.length === inputs.length) {
          LOG(`${adapter.name}: LLM replace mode substituted ${inputs.length} input(s)`);
          return { changed: true, body: adapter.replaceInputs(bodyJson, rewritten) };
        }
        LOG(`${adapter.name}: LLM replace partial/failed; falling back to regex path`);
      }
    } catch (err) {
      WARN("llm replace path failed; falling back to regex:", err?.message || err);
    }

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
        let aggResp = await sanitizeAggregated(text, adapter.name, url);
        if (!aggResp) {
          if (!confirmSendUnmasked(adapter.name)) {
            throw new Error("mask-mcp: user cancelled unmasked send");
          }
          masked.push(text);
          continue;
        }
        // v0.5.0 — detect mode: augment regex aggregated with LLM
        // contextual entities. We call llmAugment(text, "detect")
        // and merge the returned entities into aggResp.aggregated
        // so the sidebar renders them with an 'llm' source badge.
        aggResp = await mergeLlmDetect(aggResp, text);
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

      // Provider-host diagnostic: for the 4 AI provider hostnames we
      // claim in manifest.json, log every request regardless of method.
      // This is how we find streaming/WS/SSE endpoints that don't go
      // through our POST+JSON path. Third-party hosts (amplitude etc.)
      // are excluded so the console isn't drowned in telemetry.
      const PROVIDER_RE =
        /(claude\.(ai|com)|\.claude\.com|chatgpt\.com|\.openai\.com|gemini\.google\.com|manus\.im|butterfly-effect\.dev)/i;
      try {
        const host = new URL(url, location.href).host;
        if (PROVIDER_RE.test(host)) {
          LOG(
            "provider request:",
            method.toUpperCase(),
            redactUrl(url),
            "bodyType=" + typeof (init && init.body)
          );
        }
      } catch (_) {}

      if (method.toUpperCase() !== "POST") {
        return originalFetch(input, init);
      }
      const adapter = pickAdapter(url);
      if (!adapter) {
        try {
          const target = new URL(url, location.href).host;
          if (PROVIDER_RE.test(target)) {
            LOG("intercepted POST with no adapter match:", redactUrl(url));
          }
        } catch (_) {}
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
      // [SECURITY] Fail-closed: if masking pipeline threw an unexpected
      // error we refuse the send rather than silently passing the
      // original (PII-bearing) body through. The AI service sees a
      // network error and the user sees the retry-prompt — the correct
      // UX for a privacy-critical tool.
      WARN("fetch hook error; ABORTING request (fail-closed):", err?.message || err);
      return Promise.reject(
        new TypeError("PII Guard: masking pipeline error; request aborted")
      );
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
      // Same provider-host diagnostic as the fetch hook, so XHR-based
      // submissions show up in the console too.
      try {
        const host = new URL(url, location.href).host;
        if (
          /(claude\.(ai|com)|\.claude\.com|chatgpt\.com|\.openai\.com|gemini\.google\.com|manus\.im|butterfly-effect\.dev)/i.test(
            host
          )
        ) {
          LOG("provider xhr:", method, redactUrl(url), "bodyType=" + typeof body);
        }
      } catch (_) {}
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
          // [SECURITY] Fail-closed: abort the XHR so the original
          // body never reaches the network. Chat UIs surface this as
          // a send error.
          WARN("XHR hook error; ABORTING (fail-closed):", err?.message || err);
          try { xhr.abort(); } catch (_) { /* noop */ }
        }
      })();
    } catch (err) {
      // [SECURITY] Outer setup error — also fail closed.
      WARN("XHR send hook setup failed; ABORTING:", err?.message || err);
      try { this.abort(); } catch (_) { /* noop */ }
      return;
    }
  };

  // --- sendBeacon hook (log only) ----------------------------------------
  //
  // Sentry / Amplitude SDKs routinely deliver envelopes via
  // ``navigator.sendBeacon`` which bypasses fetch+XHR entirely. We
  // pass the call through unchanged and only LOG provider hits so the
  // console reveals whether manus chat submission uses this path.

  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    const originalSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function patchedSendBeacon(url, data) {
      try {
        const host = new URL(url, location.href).host;
        if (
          /(claude\.(ai|com)|\.claude\.com|chatgpt\.com|\.openai\.com|gemini\.google\.com|manus\.im|butterfly-effect\.dev)/i.test(
            host
          )
        ) {
          // [SECURITY] Fail-closed sendBeacon: provider-host beacons
          // bypass fetch/XHR hooks entirely. Analytics payloads from
          // chat UIs can embed user text (draft buffers, error
          // reports). Refuse the beacon unconditionally — the return
          // value of false signals the page that delivery failed,
          // which chat apps gracefully ignore.
          LOG("provider beacon BLOCKED:", redactUrl(url), "bodyType=" + typeof data);
          return false;
        }
      } catch (_) {}
      return originalSendBeacon(url, data);
    };
  }

  // --- WebSocket hook ----------------------------------------------------
  //
  // manus.im uses Socket.IO v4 (Engine.IO v4) over WebSocket for chat
  // submission. Outgoing user text arrives as an EVENT frame:
  //
  //   42["message", {id, timestamp, type: "user_message", content, ...}]
  //
  // We parse each send() frame, mask the ``content`` field via the
  // shared ``manusAdapter`` (which already knows how to extract /
  // replace ``content``), and re-serialize. Non-EVENT frames
  // (ping/pong, CONNECT, ACK) and EVENT frames of other shapes pass
  // through untouched. WebSocket is not closed on user-cancel —
  // dropping the single frame is enough and keeps the session alive.

  function parseSocketIoEvent(raw) {
    if (typeof raw !== "string") return null;
    const m = raw.match(/^(42\d*)(\[[\s\S]*\])$/);
    if (!m) return null;
    let args;
    try {
      args = JSON.parse(m[2]);
    } catch (_) {
      return null;
    }
    if (!Array.isArray(args) || typeof args[0] !== "string") return null;
    return { prefix: m[1], args };
  }

  function serializeSocketIoEvent(prefix, args) {
    return prefix + JSON.stringify(args);
  }

  const manusWsAdapter = {
    name: "manus-ws",
    matchUrl(url) {
      return /^wss?:\/\/(?:[^/]*\.)?manus\.im\/socket\.io\//i.test(url || "");
    },
    // Returns ``{ bodyJson, restore }`` only for the chat-submit frame
    // the fetch-oriented ``manusAdapter`` can actually mask; null for
    // any other event so they pass through unchanged.
    handleEvent(args) {
      if (args[0] !== "message") return null;
      const payload = args[1];
      if (!payload || typeof payload !== "object") return null;
      if (payload.type !== "user_message") return null;
      const hasContent =
        typeof payload.content === "string" && payload.content.trim();
      const hasContents =
        Array.isArray(payload.contents) &&
        payload.contents.some(
          (c) =>
            c?.type === "text" &&
            typeof c.value === "string" &&
            c.value.trim()
        );
      if (!hasContent && !hasContents) return null;
      return {
        bodyJson: payload,
        restore: (maskedBody) => ["message", maskedBody, ...args.slice(2)],
      };
    },
  };

  if (typeof WebSocket !== "undefined") {
    const originalWsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedWsSend(data) {
      let asyncHandled = false;
      try {
        const url = this.url || "";
        const host = new URL(url, location.href).host;
        if (
          /(claude\.(ai|com)|\.claude\.com|chatgpt\.com|\.openai\.com|gemini\.google\.com|manus\.im|butterfly-effect\.dev)/i.test(
            host
          )
        ) {
          const size = (data && typeof data.length === "number") ? data.length : 0;
          LOG(
            "provider ws send:",
            redactUrl(url),
            "bodyType=" + typeof data,
            "size=" + size,
            "preview=" + previewPayload(data)
          );
        }

        if (manusWsAdapter.matchUrl(url) && typeof data === "string") {
          const parsed = parseSocketIoEvent(data);
          if (!parsed) {
            // ping/pong/CONNECT/ACK — pass through silently.
          } else {
            const wrapped = manusWsAdapter.handleEvent(parsed.args);
            if (!wrapped) {
              // Non-chat EVENT (typing, ack, etc.) — pass through.
            } else {
              asyncHandled = true;
              const ws = this;
              const args = arguments;
              const redacted = redactUrl(url);
              LOG("manus-ws: intercepting user_message frame");
              (async () => {
                if (!(await isEnabled())) {
                  originalWsSend.apply(ws, args);
                  return;
                }
                try {
                  const result = await processBody(
                    manusAdapter,
                    wrapped.bodyJson,
                    redacted
                  );
                  if (!result.changed) {
                    originalWsSend.apply(ws, args);
                    return;
                  }
                const newFrame = serializeSocketIoEvent(
                  parsed.prefix,
                  wrapped.restore(result.body)
                );
                LOG(
                  `${manusWsAdapter.name}: substituted masked WS frame (${data.length} → ${newFrame.length} bytes)`
                );
                originalWsSend.call(ws, newFrame);
              } catch (err) {
                if (
                  err &&
                  err.message &&
                  err.message.includes("mask-mcp: user cancelled")
                ) {
                  LOG(err.message, "— WS frame dropped");
                  return;
                }
                // [SECURITY] Fail-closed: drop the frame instead of
                // forwarding the original. The WS stays open so the
                // session survives; the chat UI treats this as a
                // missing ack and typically re-prompts.
                WARN(
                  "WS hook error; DROPPING frame (fail-closed):",
                  err?.message || err
                );
              }
            })();
            }
          }
        }
      } catch (err) {
        WARN("WS send hook setup failed:", err?.message || err);
      }
      if (!asyncHandled) {
        return originalWsSend.apply(this, arguments);
      }
    };
  }

  LOG(
    "injected hooks installed on",
    window.location.hostname,
    "(fetch, xhr, sendBeacon, ws)"
  );
})();
