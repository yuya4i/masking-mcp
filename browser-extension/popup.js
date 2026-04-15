// Popup script — reads/writes chrome.storage.local, probes the gateway,
// and queries the service worker for the per-tab detection count. No
// build step; this file is the full popup logic.
//
// Design notes:
// - ``chrome.storage.local`` is the source of truth for the enabled
//   flag. The content script reads the same key on every intercept so
//   toggling from the popup takes effect on the very next fetch.
// - The gateway reachability probe is a 1.5s fetch to ``/health``.
//   Anything longer looks like the popup froze; anything shorter
//   will false-flag a gateway that is just slow to wake up.
// - The detection count comes from ``background.js`` which aggregates
//   per-tab counters. We query it by tab id rather than reading
//   storage directly so the counter resets cleanly when the user
//   navigates away.

const GATEWAY_HEALTH_URL = "http://127.0.0.1:8081/health";
const GATEWAY_PROBE_TIMEOUT_MS = 1500;

const $ = (id) => document.getElementById(id);

function setGatewayStatus(state, text) {
  const el = $("gateway-status");
  el.textContent = text;
  el.className = "value status-" + state;
}

async function probeGateway() {
  setGatewayStatus("unknown", "checking…");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(GATEWAY_HEALTH_URL, {
      signal: controller.signal,
      // ``no-cors`` would tolerate the check even without CORS, but
      // /health replies with permissive CORS so this keeps the error
      // surface meaningful instead of a perpetual opaque success.
      cache: "no-store",
    });
    if (response.ok) {
      setGatewayStatus("ok", "reachable ✓");
    } else {
      setGatewayStatus("warn", "HTTP " + response.status);
    }
  } catch (err) {
    setGatewayStatus("err", "unreachable");
  } finally {
    clearTimeout(timer);
  }
}

async function loadEnabled() {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  $("enabled-toggle").checked = enabled;
}

async function saveEnabled(value) {
  await chrome.storage.local.set({ enabled: value });
}

async function loadInteractive() {
  // Default is ON — the user explicitly requested interactive mode
  // as the headline UX, and the content script falls back to the
  // same default if the key is missing.
  const { interactive = true } = await chrome.storage.local.get("interactive");
  $("interactive-toggle").checked = interactive;
}

async function saveInteractive(value) {
  await chrome.storage.local.set({ interactive: value });
}

async function loadDetectionCount() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    $("detections-count").textContent = "0";
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_TAB_COUNT",
      tabId: tab.id,
    });
    const count = response && typeof response.count === "number" ? response.count : 0;
    $("detections-count").textContent = String(count);
  } catch (err) {
    // Service worker may be asleep on first popup open; default to 0.
    $("detections-count").textContent = "0";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadEnabled();
  loadInteractive();
  probeGateway();
  loadDetectionCount();

  $("enabled-toggle").addEventListener("change", (e) => {
    saveEnabled(e.target.checked);
  });
  $("interactive-toggle").addEventListener("change", (e) => {
    saveInteractive(e.target.checked);
  });
});
