// engine/engine.js — standalone masking pipeline entry point.
// Replicates /v1/extension/sanitize{,/aggregated} shapes using preset
// regex + classification + severity + categories + aggregation +
// force-mask + blocklist. No Presidio (Phase 3), no Sudachi (Phase 2).
// Target accuracy vs Python gateway: 75-80%.
"use strict";

(function attach(root) {
  function resolveDeps() {
    const d = {};
    if (typeof require === "function") {
      const load = (k, p) => { try { d[k] = require(p); } catch (_) {} };
      load("patterns", "./patterns");
      load("classification", "./classification");
      load("severity", "./severity");
      load("categories", "./categories");
      load("aggregate", "./aggregate");
      load("forceMask", "./force-mask");
      load("blocklist", "./blocklist");
      load("userForceMask", "./user-force-mask");
      load("onnxDetector", "./onnx-detector");
    }
    const ns = (root && root.__localMaskMCP && root.__localMaskMCP.engine) || {};
    for (const k of ["patterns","classification","severity","categories","aggregate","forceMask","blocklist","userForceMask","onnxDetector"]) {
      d[k] = d[k] || ns[k];
    }
    return d;
  }

  function generateAuditId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      try { return crypto.randomUUID(); } catch (_) {}
    }
    const hex = "0123456789abcdef";
    let out = "";
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
      else if (i === 14) out += "4";
      else if (i === 19) out += hex[Math.floor(Math.random() * 4) + 8];
      else out += hex[Math.floor(Math.random() * 16)];
    }
    return out;
  }

  function collectDetections(text, options) {
    const deps = resolveDeps();
    if (!deps.patterns) throw new Error("mask-mcp engine: patterns missing");
    const disabled = new Set((options && options.disabledCategories) || []);
    const out = [];
    for (const { entity_type, pattern } of deps.patterns.getPresetPatterns(disabled)) {
      // Clone so module-level regex lastIndex is never mutated.
      const re = new RegExp(pattern.source, pattern.flags);
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m.index === re.lastIndex) { re.lastIndex += 1; continue; }
        out.push({
          entity_type, start: m.index, end: m.index + m[0].length,
          text: m[0], score: 1.0, action: "masked",
        });
      }
    }
    return out;
  }

  // Sweep-line overlap resolver — mirror of _resolve_overlaps.
  function resolveOverlaps(results) {
    if (results.length < 2) return results.slice();
    const ordered = results.slice().sort((a, b) => a.start - b.start || b.end - a.end);
    const keep = [];
    let eS = -1, eE = -1, eSc = -1;
    for (const c of ordered) {
      if (eE >= c.end && eSc >= c.score && (eS < c.start || eE > c.end)) continue;
      keep.push(c);
      if (c.end > eE || (c.end === eE && c.score > eSc)) {
        eS = c.start; eE = c.end; eSc = c.score;
      }
    }
    return keep;
  }

  // Collect every raw detection (regex/dict/force-mask) without any
  // filtering or overlap resolution. Shared between the sync pipeline
  // (used by tests, gateway-style callers) and the async pipeline that
  // additionally awaits ML/NER detections from the service worker.
  function collectRawDetections(text, opts, deps) {
    let dets = collectDetections(text, { disabledCategories: opts.disabledCategories });
    // ユーザーがサイドバー drop で登録した force-mask list を regex 検出と merge。
    // blocklist より前に積んでおくことで、ブロックリストに入った語を
    // 誤ってユーザーが追加してしまっても blocklist 側が最終的に勝つ
    // (= blocklist が常に最上位の安全装置、という既存不変を維持)。
    if (deps.userForceMask && Array.isArray(opts.userForceMaskEntries) && opts.userForceMaskEntries.length > 0) {
      dets = dets.concat(deps.userForceMask.detectUserForceMask(text, opts.userForceMaskEntries));
    }
    return dets;
  }

  // Apply the post-collection filters in a fixed order: blocklist →
  // minScore → enabledPiiClasses → overlap resolver. Idempotent enough
  // that calling it after merging in async ML detections still yields
  // the right answer.
  function finishPipeline(dets, opts, deps) {
    const minScore = typeof opts.minScore === "number" ? opts.minScore : 0.0;
    const bl = opts.commonNounBlocklist instanceof Set ? opts.commonNounBlocklist
      : new Set(opts.commonNounBlocklist || deps.blocklist.DEFAULT_COMMON_NOUN_BLOCKLIST);
    if (bl.size > 0) dets = dets.filter((d) => !bl.has(d.text));
    if (minScore > 0.0) dets = dets.filter((d) => d.score >= minScore);
    if (opts.enabledPiiClasses) {
      const en = new Set(opts.enabledPiiClasses);
      dets = dets.filter((d) => en.has(deps.classification.classificationFor(d.entity_type)));
    }
    return resolveOverlaps(dets);
  }

  function runPipeline(text, opts, deps) {
    return finishPipeline(collectRawDetections(text, opts, deps), opts, deps);
  }

  // Async variant: same as runPipeline but also invokes the ML detector
  // (transformers.js NER via the service worker) when opts.mlEnabled is
  // truthy. ML failures degrade silently — regex/dict detections always
  // survive even if the SW is asleep / WASM hasn't loaded yet.
  async function runPipelineAsync(text, opts, deps) {
    let dets = collectRawDetections(text, opts, deps);
    if (opts.mlEnabled && deps.onnxDetector) {
      try {
        const mlDets = await deps.onnxDetector.detectViaMl(text);
        if (mlDets.length > 0) dets = dets.concat(mlDets);
      } catch (_) { /* fall through with regex-only */ }
    }
    return finishPipeline(dets, opts, deps);
  }

  // /v1/extension/sanitize/aggregated.
  // Returns a Promise when opts.mlEnabled is true (ML inference is
  // async via the SW), otherwise returns the result synchronously
  // wrapped in Promise.resolve. Callers should always ``await`` —
  // the API is uniformly Promise-shaped so the call site doesn't
  // branch on mlEnabled.
  async function maskAggregated(text, options) {
    const opts = options || {};
    const deps = resolveDeps();
    if (!deps.aggregate || !deps.forceMask || !deps.blocklist) {
      throw new Error("mask-mcp engine: deps missing");
    }
    const kws = opts.forceMaskKeywords || deps.forceMask.DEFAULT_KEYWORDS;
    const cats = opts.forceMaskCategories || deps.forceMask.DEFAULT_CATEGORIES;
    const dets = opts.mlEnabled
      ? await runPipelineAsync(text, opts, deps)
      : runPipeline(text, opts, deps);
    let agg = deps.aggregate.aggregateDetections(dets);
    const fired = deps.forceMask.detectForceMaskTrigger(text, kws);
    const forced = deps.forceMask.resolveForcedCategories(fired, cats);
    agg = deps.forceMask.applyForceMask(agg, forced);
    return { original_text: text, aggregated: agg, audit_id: generateAuditId(), force_masked_categories: forced };
  }

  // /v1/extension/sanitize. Same Promise-uniform shape as maskAggregated.
  async function maskSanitize(text, options) {
    const opts = options || {};
    const deps = resolveDeps();
    const dets = opts.mlEnabled
      ? await runPipelineAsync(text, opts, deps)
      : runPipeline(text, opts, deps);
    const sanitized = deps.aggregate.applyTagMask(text, dets);
    const enriched = dets.map((d) => ({
      entity_type: d.entity_type, start: d.start, end: d.end, score: d.score,
      text: d.text, action: d.action || "masked",
      severity: deps.severity.severityFor(d.entity_type),
    }));
    return {
      audit_id: generateAuditId(), filter_enabled: true,
      original_length: text.length, sanitized_text: sanitized,
      detections: enriched, forwarded: false,
    };
  }

  const api = { maskAggregated, maskSanitize, collectDetections, resolveOverlaps, runPipeline, runPipelineAsync };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, api);
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
