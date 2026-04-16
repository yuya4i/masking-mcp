// Content script — isolated-world bridge.
//
// MV3 content scripts run in an isolated JS world by default, which
// means monkey-patching ``window.fetch`` here only patches the
// extension's own wrapper, not the page's real fetch. We therefore:
//
// 1. Inject ``injected.js`` into the page's MAIN world via a script
//    tag. That script patches the real ``window.fetch`` and
//    ``XMLHttpRequest.prototype.send``.
// 2. Provide a ``window.postMessage`` bridge so the injected script
//    (which has no ``chrome.*`` access) can:
//      a) ask the isolated world to POST to the gateway on its behalf,
//         and
//      b) read the ``enabled`` flag from ``chrome.storage.local``.
//    The isolated world then relays detection counts back to the
//    service worker.
//
// All injected-script → content-script messages are tagged with
// ``source: "mask-mcp-inpage"`` so the page's own ``message`` handlers
// don't see them (and vice-versa for ``mask-mcp-content``).

(() => {
  "use strict";

  const TAG_IN = "mask-mcp-inpage";   // injected → content
  const TAG_OUT = "mask-mcp-content"; // content → injected

  const GATEWAY_URL = "http://127.0.0.1:8081/v1/extension/sanitize";
  const GATEWAY_AGGREGATED_URL =
    "http://127.0.0.1:8081/v1/extension/sanitize/aggregated";
  const GATEWAY_HEALTH_URL = "http://127.0.0.1:8081/health";
  // Bumped from 3000 -> 15000 because the FIRST call from Chrome on
  // Windows to a WSL2-hosted gateway routinely takes several seconds:
  // Chrome's CORS-RFC1918 preflight on public-to-private fetches gets
  // re-negotiated on every fresh tab, and Windows's ephemeral port
  // mapping into the WSL2 VM has cold-start overhead that does NOT
  // show up when curling from inside WSL. Once warm the call is
  // milliseconds, but the first click in a fresh tab needs head-room.
  const GATEWAY_TIMEOUT_MS = 15000;

  // Cached gateway reachability. Hybrid dispatch in injected.js
  // consults this (via a postMessage round-trip) to decide whether to
  // call the gateway or fall back to the standalone engine. The
  // pre-warm below flips ``gatewayReachable`` true on a successful
  // /health response; injected.js can also ask for a refresh.
  let gatewayReachable = null; // null = unknown yet, true/false once probed
  const GATEWAY_PROBE_TIMEOUT_MS = 500;

  async function probeGateway() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        GATEWAY_PROBE_TIMEOUT_MS
      );
      try {
        const resp = await fetch(GATEWAY_HEALTH_URL, {
          method: "GET",
          mode: "cors",
          credentials: "omit",
          signal: controller.signal,
        });
        gatewayReachable = resp.ok;
        return resp.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch (_) {
      gatewayReachable = false;
      return false;
    }
  }

  // Pre-warm: hit /health in the background on content script load.
  // Also completes the PNA preflight + TCP warmup for the common
  // gateway-mode path. Sets gatewayReachable for Hybrid dispatch.
  (async () => {
    const t0 = Date.now();
    const ok = await probeGateway();
    const elapsed = Date.now() - t0;
    if (ok) {
      console.debug("[mask-mcp] gateway warmup ok in", elapsed + "ms");
    } else {
      console.debug(
        "[mask-mcp] gateway unreachable at warmup — standalone engine will handle masking"
      );
    }
  })();

  // 1) Inject the page-world scripts in order:
  //    ``review-modal.js`` and ``sidebar.js`` must run before
  //    ``injected.js`` so the helper namespaces are already attached
  //    to ``window.__localMaskMCP.{reviewModal,sidebar}`` by the time
  //    the fetch hook tries to call them. ``document_start`` runs
  //    before any page script, so all three hooks are installed before
  //    the first fetch leaves the page. The ``async = false`` flag
  //    preserves source order despite the dynamic insertion.
  function injectScript(file) {
    const el = document.createElement("script");
    el.src = chrome.runtime.getURL(file);
    el.async = false;
    (document.head || document.documentElement).appendChild(el);
    el.addEventListener("load", () => el.remove());
  }
  // Engine modules are loaded BEFORE review-modal / sidebar / injected.js
  // so window.__localMaskMCP.engine is ready by the time injected.js's
  // first fetch intercept fires. Order matters: the leaf modules (no
  // cross-engine deps) must load before engine.js and the final
  // bundle.js launcher that flips engine.ready = true.
  // Each file is a MV3-safe script (no ES6 import / eval).
  const ENGINE_FILES = [
    "engine/patterns.js",
    "engine/classification.js",
    "engine/severity.js",
    "engine/categories.js",
    "engine/aggregate.js",
    "engine/force-mask.js",
    "engine/blocklist.js",
    "engine/engine.js",
    "engine/bundle.js",
  ];
  for (const f of ENGINE_FILES) injectScript(f);
  injectScript("review-modal.js");
  injectScript("sidebar.js");
  injectScript("injected.js");
  console.debug(
    "[mask-mcp] injected",
    ENGINE_FILES.length + 3,
    "scripts (engine + ui + hook)"
  );

  // Push the current ``interactive`` + ``uiMode`` preferences into
  // MAIN world as soon as we can. The injected script reads them off
  // ``window.__localMaskMCP.settings`` before every fetch, so a
  // toggle in the popup takes effect on the very next intercept.
  // ``uiMode`` defaults to ``"sidebar"`` (Milestone 8 Wave B); the
  // legacy modal experience is opt-in via the popup radio.
  async function broadcastSettings() {
    let interactive = true;
    let uiMode = "sidebar";
    let maskAllowlist = [];
    try {
      const stored = await chrome.storage.local.get(["interactive", "uiMode", "maskAllowlist"]);
      interactive = stored.interactive !== false;
      if (stored.uiMode === "modal" || stored.uiMode === "sidebar") {
        uiMode = stored.uiMode;
      }
      if (Array.isArray(stored.maskAllowlist)) {
        maskAllowlist = stored.maskAllowlist.filter((v) => typeof v === "string");
      }
    } catch (_) {
      interactive = true;
      uiMode = "sidebar";
    }
    window.postMessage(
      {
        source: TAG_OUT,
        type: "settings",
        settings: { interactive, uiMode, maskAllowlist },
      },
      "*"
    );
  }
  broadcastSettings();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if ("interactive" in changes || "uiMode" in changes || "maskAllowlist" in changes) {
        broadcastSettings();
      }
    });
  } catch (_) {
    // ``chrome.storage`` is always available in an MV3 content
    // script; the guard exists only to avoid bricking the page if
    // the API ever throws at boot.
  }

  // 2) Handle page-world requests.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== TAG_IN) return;

    // Allowlist add (no id — fire-and-forget write to chrome.storage).
    if (data.type === "add-allowlist" && typeof data.value === "string") {
      (async () => {
        try {
          const { maskAllowlist = [] } = await chrome.storage.local.get("maskAllowlist");
          const v = data.value.trim();
          if (v && !maskAllowlist.includes(v)) {
            maskAllowlist.push(v);
            await chrome.storage.local.set({ maskAllowlist });
          }
        } catch (_) {}
      })();
      return;
    }

    if (typeof data.id !== "string") return;

    if (data.type === "sanitize") {
      handleSanitize(data);
    } else if (data.type === "sanitize-aggregated") {
      handleSanitizeAggregated(data);
    } else if (data.type === "is-enabled") {
      handleIsEnabled(data);
    } else if (data.type === "backend-probe") {
      handleBackendProbe(data);
    } else if (data.type === "hybrid-pref") {
      handleHybridPref(data);
    } else if (data.type === "detection-count") {
      // Fire-and-forget badge update.
      try {
        chrome.runtime.sendMessage({
          type: "DETECTION_COUNT",
          count: Number(data.count) || 0,
        });
      } catch (_) {
        // Service worker might be asleep; not fatal.
      }
    }
  });

  async function handleSanitize(data) {
    const { id, payload } = data;
    const responseBody = await callGateway(GATEWAY_URL, payload);
    window.postMessage(
      { source: TAG_OUT, id, type: "sanitize-result", result: responseBody },
      "*"
    );
  }

  async function handleSanitizeAggregated(data) {
    const { id, payload } = data;
    const responseBody = await callGateway(GATEWAY_AGGREGATED_URL, payload);
    window.postMessage(
      {
        source: TAG_OUT,
        id,
        type: "sanitize-aggregated-result",
        result: responseBody,
      },
      "*"
    );
  }

  // Shared transport for the two sanitize endpoints. Identical
  // request semantics; only the URL changes. Returns null on any
  // failure so the caller can fall back to ``confirmSendUnmasked``.
  async function callGateway(url, payload) {
    let responseBody = null;
    const t0 = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
          mode: "cors",
          credentials: "omit",
        });
        if (resp.ok) {
          responseBody = await resp.json();
          const elapsed = Date.now() - t0;
          if (elapsed > 1500) {
            console.info(
              "[mask-mcp] gateway slow:",
              elapsed + "ms",
              "url:",
              url
            );
          }
        } else {
          console.warn("[mask-mcp] gateway returned", resp.status, "for", url);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const elapsed = Date.now() - t0;
      if (err && err.name === "AbortError") {
        console.warn(
          "[mask-mcp] gateway timed out after",
          elapsed + "ms (limit",
          GATEWAY_TIMEOUT_MS + "ms)."
        );
      } else {
        console.warn(
          "[mask-mcp] gateway call failed after",
          elapsed + "ms:",
          err?.message || err,
          "url:",
          url
        );
      }
    }
    return responseBody;
  }

  // Hybrid mode: report current gateway reachability to the injected
  // script. Refresh on demand if ``data.refresh === true``, otherwise
  // return the cached value (populated by the warmup probe or the last
  // refresh call). Result is also used to display a badge update when
  // we fall back to standalone mode.
  async function handleBackendProbe(data) {
    const { id } = data;
    if (data.refresh === true || gatewayReachable === null) {
      await probeGateway();
    }
    const reachable = gatewayReachable === true;
    try {
      chrome.runtime.sendMessage({
        type: "BACKEND_MODE",
        mode: reachable ? "gateway" : "standalone",
      });
    } catch (_) {
      // service worker asleep — not fatal.
    }
    window.postMessage(
      {
        source: TAG_OUT,
        id,
        type: "backend-probe-result",
        reachable,
      },
      "*"
    );
  }

  // Returns the user's Hybrid-mode preference from chrome.storage.local.
  // Recognised values:
  //   "auto"       — probe gateway, fall back to standalone (default)
  //   "standalone" — never call gateway, always use local engine
  //   "gateway"    — always use gateway (legacy behaviour); fail loudly
  //                  if unreachable. Expert-mode only.
  async function handleHybridPref(data) {
    const { id } = data;
    // Web Store build: default to standalone (no Docker required).
    // Power users can opt into "gateway" / "auto" via DevTools but
    // the shipped UX assumes a self-contained browser-only engine.
    let pref = "standalone";
    try {
      const stored = await chrome.storage.local.get(["mask_mcp_pref_hybrid"]);
      const v = stored.mask_mcp_pref_hybrid;
      if (v === "standalone" || v === "gateway" || v === "auto") {
        pref = v;
      }
    } catch (_) {
      pref = "standalone";
    }
    window.postMessage(
      {
        source: TAG_OUT,
        id,
        type: "hybrid-pref-result",
        pref,
      },
      "*"
    );
  }

  async function handleIsEnabled(data) {
    const { id } = data;
    let enabled = true;
    try {
      const stored = await chrome.storage.local.get("enabled");
      enabled = stored.enabled !== false;
    } catch (_) {
      enabled = true;
    }
    window.postMessage(
      { source: TAG_OUT, id, type: "is-enabled-result", enabled },
      "*"
    );
  }
})();
