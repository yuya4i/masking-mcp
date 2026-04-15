// Service worker — MV3 background entry point.
//
// Responsibilities:
// 1. Keep a per-tab count of masked detections and surface it on the
//    action badge.
// 2. Respond to popup queries for "how many masks on tab X".
// 3. Seed ``chrome.storage.local.enabled`` to ``true`` on install so
//    the content script can assume the key exists.
// 4. Reset per-tab counters on navigation / tab close so the badge
//    doesn't carry stale numbers across page boundaries.
//
// MV3 service workers are ephemeral — any in-memory state is wiped
// when the worker sleeps. The badge itself is persisted by Chrome, so
// that's fine, but ``tabCounts`` below lives in memory and will reset
// after ~30s of inactivity. That's acceptable for a detection counter
// (the user is either actively interacting or the data is stale).

const BADGE_BG_OK = "#2166cc";
const BADGE_BG_WARN = "#b84a00";

/** Per-tab detection counts. Keyed by tab id. */
const tabCounts = new Map();

function updateBadge(tabId, count) {
  const text = count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: count > 0 ? BADGE_BG_OK : BADGE_BG_WARN,
  }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  // Ensure both keys exist so every subsequent read is a plain
  // ``storage.get(key)`` without a fallback branch. ``interactive``
  // defaults to ``true`` — interactive review is the headline UX
  // introduced in ``feat/interactive-review-ui``.
  const stored = await chrome.storage.local.get(["enabled", "interactive"]);
  const patch = {};
  if (typeof stored.enabled !== "boolean") patch.enabled = true;
  if (typeof stored.interactive !== "boolean") patch.interactive = true;
  if (Object.keys(patch).length > 0) {
    await chrome.storage.local.set(patch);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "DETECTION_COUNT") {
    // Content script reports "N detections on this page fetch" after
    // each intercepted request.
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId === "number") {
      const prev = tabCounts.get(tabId) || 0;
      const next = prev + (message.count || 0);
      tabCounts.set(tabId, next);
      updateBadge(tabId, next);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "GET_TAB_COUNT") {
    // Popup asking for a single tab's counter.
    const tabId = typeof message.tabId === "number" ? message.tabId : null;
    sendResponse({ count: (tabId !== null && tabCounts.get(tabId)) || 0 });
    return true;
  }

  return false;
});

// Reset a tab's counter when the user navigates to a new top-level
// URL. ``tabs.onUpdated`` works with the ``activeTab`` permission we
// already request, so no extra host/perm grants are needed. We key
// on the ``loading`` status of a URL change to capture both full
// reloads and client-side navigations that rewrite ``tab.url``.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // ``changeInfo.url`` fires on every URL mutation, including SPA
  // pushState navigations. Resetting there keeps the badge meaningful
  // as the user moves between chats in Claude.ai / ChatGPT.
  if (typeof changeInfo.url === "string") {
    tabCounts.delete(tabId);
    updateBadge(tabId, 0);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabCounts.delete(tabId);
});
