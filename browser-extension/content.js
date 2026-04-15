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
  const GATEWAY_TIMEOUT_MS = 3000;

  // 1) Inject the page-world scripts in order:
  //    ``review-modal.js`` must run before ``injected.js`` so the
  //    modal helper is already attached to
  //    ``window.__localMaskMCP.reviewModal`` by the time the fetch
  //    hook tries to call it. ``document_start`` runs before any
  //    page script, so both hooks are installed before the first
  //    fetch leaves the page.
  function injectScript(file) {
    const el = document.createElement("script");
    el.src = chrome.runtime.getURL(file);
    el.async = false;
    (document.head || document.documentElement).appendChild(el);
    el.addEventListener("load", () => el.remove());
  }
  injectScript("review-modal.js");
  injectScript("injected.js");

  // Push the current ``interactive`` preference into MAIN world as
  // soon as we can. The injected script reads it off
  // ``window.__localMaskMCP.settings`` before every fetch, so a
  // toggle in the popup takes effect on the very next intercept.
  async function broadcastSettings() {
    let interactive = true;
    try {
      const stored = await chrome.storage.local.get("interactive");
      interactive = stored.interactive !== false;
    } catch (_) {
      interactive = true;
    }
    window.postMessage(
      { source: TAG_OUT, type: "settings", settings: { interactive } },
      "*"
    );
  }
  broadcastSettings();
  // Re-broadcast whenever the popup flips the toggle so open tabs
  // pick up the new setting without a reload.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if ("interactive" in changes) broadcastSettings();
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
    let responseBody = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
      try {
        const resp = await fetch(GATEWAY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
          mode: "cors",
          credentials: "omit",
        });
        if (resp.ok) {
          responseBody = await resp.json();
        } else {
          console.warn("[mask-mcp] gateway returned", resp.status);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      console.warn("[mask-mcp] gateway call failed:", err?.message || err);
    }
    window.postMessage(
      { source: TAG_OUT, id, type: "sanitize-result", result: responseBody },
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
