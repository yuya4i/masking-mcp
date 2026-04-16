// Popup script — reads/writes chrome.storage.local for masking
// preferences and queries the service worker for the per-tab
// detection count. Standalone-only build: no gateway probe.

const $ = (id) => document.getElementById(id);

async function loadEnabled() {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  $("enabled-toggle").checked = enabled;
}

async function saveEnabled(value) {
  await chrome.storage.local.set({ enabled: value });
}

async function loadInteractive() {
  const { interactive = true } = await chrome.storage.local.get("interactive");
  $("interactive-toggle").checked = interactive;
}

async function saveInteractive(value) {
  await chrome.storage.local.set({ interactive: value });
}

async function loadUiMode() {
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
    $("detections-count").textContent = "0";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadEnabled();
  loadInteractive();
  loadUiMode();
  loadDetectionCount();

  $("enabled-toggle").addEventListener("change", (e) => {
    saveEnabled(e.target.checked);
  });
  $("interactive-toggle").addEventListener("change", (e) => {
    saveInteractive(e.target.checked);
  });
  const fieldset = $("ui-mode-fieldset");
  if (fieldset) {
    fieldset.addEventListener("change", (e) => {
      const value =
        e.target && e.target.name === "ui-mode" ? e.target.value : null;
      if (value) saveUiMode(value);
    });
  }
  $("open-options-btn").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
});
