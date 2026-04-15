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

  // Pre-warm: hit /health in the background on content script load.
  // This makes the browser complete the PNA preflight + open the
  // keep-alive TCP connection before the user's first message, so
  // the first real sanitize call is already on a warm pipeline.
  // Failures are silent - we rely on the actual sanitize attempt to
  // surface errors meaningfully.
  (async () => {
    try {
      const t0 = Date.now();
      const resp = await fetch(GATEWAY_HEALTH_URL, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
      });
      const elapsed = Date.now() - t0;
      if (resp.ok) {
        console.debug("[mask-mcp] gateway warmup ok in", elapsed + "ms");
      } else {
        console.warn("[mask-mcp] gateway warmup http", resp.status);
      }
    } catch (e) {
      console.warn("[mask-mcp] gateway warmup failed:", e?.message || e);
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
  injectScript("review-modal.js");
  injectScript("sidebar.js");
  injectScript("injected.js");

  // Push the current ``interactive`` + ``uiMode`` preferences into
  // MAIN world as soon as we can. The injected script reads them off
  // ``window.__localMaskMCP.settings`` before every fetch, so a
  // toggle in the popup takes effect on the very next intercept.
  // ``uiMode`` defaults to ``"sidebar"`` (Milestone 8 Wave B); the
  // legacy modal experience is opt-in via the popup radio.
  async function broadcastSettings() {
    let interactive = true;
    let uiMode = "sidebar";
    try {
      const stored = await chrome.storage.local.get(["interactive", "uiMode"]);
      interactive = stored.interactive !== false;
      if (stored.uiMode === "modal" || stored.uiMode === "sidebar") {
        uiMode = stored.uiMode;
      }
    } catch (_) {
      interactive = true;
      uiMode = "sidebar";
    }
    window.postMessage(
      {
        source: TAG_OUT,
        type: "settings",
        settings: { interactive, uiMode },
      },
      "*"
    );
  }
  broadcastSettings();
  // Re-broadcast whenever the popup flips either toggle so open tabs
  // pick up the new setting without a reload.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if ("interactive" in changes || "uiMode" in changes) broadcastSettings();
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
    if (!data || data.source !== TAG_IN || typeof data.id !== "string") return;

    if (data.type === "sanitize") {
      handleSanitize(data);
    } else if (data.type === "sanitize-aggregated") {
      handleSanitizeAggregated(data);
    } else if (data.type === "is-enabled") {
      handleIsEnabled(data);
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
          GATEWAY_TIMEOUT_MS + "ms).",
          "Check: (1) gateway running? curl http://127.0.0.1:8081/health",
          "(2) if on WSL, docker-compose.yml bind should be 0.0.0.0:8081."
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
