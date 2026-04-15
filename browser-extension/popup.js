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
  // Surface the one-time setup hint whenever the gateway is NOT
  // reachable, so a first-time user sees exactly what to run to
  // make it come up automatically from now on.
  const hint = $("autostart-hint");
  if (hint) {
    hint.hidden = state === "ok";
    if (state !== "ok") {
      // Detect Windows vs. *nix by user-agent so we can suggest the
      // right installer. Chrome exposes navigator.userAgentData on
      // modern versions; fall back to the legacy UA string.
      const platform =
        (navigator.userAgentData &&
          navigator.userAgentData.platform) ||
        navigator.platform ||
        "";
      const isWindows = /win/i.test(platform);
      const cmdEl = $("autostart-cmd");
      if (cmdEl) {
        cmdEl.textContent = isWindows
          ? "powershell -File scripts\\install-autostart.ps1"
          : "bash scripts/install-autostart.sh";
      }
    }
  }
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

async function loadUiMode() {
  // Default is "sidebar" — Milestone 8 Wave B headline UX. Anything
  // other than "modal" is normalised back to "sidebar" so a stale or
  // garbled value can't leave the radio group unchecked.
  const { uiMode } = await chrome.storage.local.get("uiMode");
  const value = uiMode === "modal" ? "modal" : "sidebar";
  const target = document.querySelector(
    `input[name="ui-mode"][value="${value}"]`
  );
  if (target) target.checked = true;
}

async function saveUiMode(value) {
  const normalized = value === "modal" ? "modal" : "sidebar";
  await chrome.storage.local.set({ uiMode: normalized });
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
  loadUiMode();
  probeGateway();
  loadDetectionCount();

  $("enabled-toggle").addEventListener("change", (e) => {
    saveEnabled(e.target.checked);
  });
  $("interactive-toggle").addEventListener("change", (e) => {
    saveInteractive(e.target.checked);
  });
  // Radio change events bubble up from individual inputs; bind on
  // the fieldset so we get a single listener regardless of how many
  // radios live inside it.
  const fieldset = $("ui-mode-fieldset");
  if (fieldset) {
    fieldset.addEventListener("change", (e) => {
      const value =
        e.target && e.target.name === "ui-mode" ? e.target.value : null;
      if (value) saveUiMode(value);
    });
  }
});
