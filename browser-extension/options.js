// Options page — full settings UI with mask allowlist database.
// Mirrors popup.js for shared toggles and adds CRUD + import/export
// for the maskAllowlist key in chrome.storage.local.

const $ = (id) => document.getElementById(id);

// --- Allowlist CRUD -----------------------------------------------------

async function loadAllowlist() {
  const { maskAllowlist = [] } = await chrome.storage.local.get("maskAllowlist");
  renderAllowlist(maskAllowlist);
}

function renderAllowlist(items) {
  const container = $("allowlist-entries");
  $("allowlist-count").textContent = items.length + "件";
  while (container.firstChild) container.removeChild(container.firstChild);
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "登録なし — 上の入力欄から追加してください";
    container.appendChild(empty);
    return;
  }
  for (const val of items) {
    const row = document.createElement("div");
    row.className = "entry";
    const text = document.createElement("span");
    text.className = "entry-value";
    text.textContent = val;
    const btn = document.createElement("button");
    btn.className = "entry-remove";
    btn.textContent = "\u00d7";
    btn.title = "削除";
    btn.addEventListener("click", () => removeFromAllowlist(val));
    row.appendChild(text);
    row.appendChild(btn);
    container.appendChild(row);
  }
}

async function addToAllowlist(value) {
  const trimmed = (value || "").trim();
  if (!trimmed) return;
  const { maskAllowlist = [] } = await chrome.storage.local.get("maskAllowlist");
  if (maskAllowlist.includes(trimmed)) return;
  maskAllowlist.push(trimmed);
  await chrome.storage.local.set({ maskAllowlist });
  renderAllowlist(maskAllowlist);
}

async function removeFromAllowlist(value) {
  const { maskAllowlist = [] } = await chrome.storage.local.get("maskAllowlist");
  const filtered = maskAllowlist.filter((v) => v !== value);
  await chrome.storage.local.set({ maskAllowlist: filtered });
  renderAllowlist(filtered);
}

async function clearAllowlist() {
  if (!confirm("すべての除外エントリを削除します。よろしいですか?")) return;
  await chrome.storage.local.set({ maskAllowlist: [] });
  renderAllowlist([]);
}

async function exportAllowlist() {
  const { maskAllowlist = [] } = await chrome.storage.local.get("maskAllowlist");
  const blob = new Blob(
    [JSON.stringify({ maskAllowlist, exported_at: new Date().toISOString() }, null, 2)],
    { type: "application/json" }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mask-allowlist-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importAllowlist(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const incoming = Array.isArray(data?.maskAllowlist)
      ? data.maskAllowlist.filter((v) => typeof v === "string")
      : [];
    if (incoming.length === 0) {
      alert("インポートできるエントリがありません");
      return;
    }
    const { maskAllowlist = [] } = await chrome.storage.local.get("maskAllowlist");
    const merged = Array.from(new Set([...maskAllowlist, ...incoming]));
    await chrome.storage.local.set({ maskAllowlist: merged });
    renderAllowlist(merged);
    alert(`${incoming.length}件をインポートしました (重複除外後 ${merged.length}件)`);
  } catch (err) {
    alert("インポート失敗: " + (err && err.message ? err.message : err));
  }
}

// --- Settings (mirrors popup) ------------------------------------------

async function loadEnabled() {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  $("opt-enabled").checked = enabled;
}

async function loadInteractive() {
  const { interactive = true } = await chrome.storage.local.get("interactive");
  $("opt-interactive").checked = interactive;
}

async function loadUiMode() {
  const { uiMode } = await chrome.storage.local.get("uiMode");
  const value = uiMode === "modal" ? "modal" : "sidebar";
  const target = document.querySelector(`input[name="ui-mode"][value="${value}"]`);
  if (target) target.checked = true;
}

async function probeGateway() {
  const el = $("gateway-status");
  el.textContent = "checking…";
  el.className = "status-pill status-unknown";
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 1500);
  try {
    const resp = await fetch("http://127.0.0.1:8081/health", {
      signal: controller.signal,
      cache: "no-store",
    });
    if (resp.ok) {
      el.textContent = "reachable ✓";
      el.className = "status-pill status-ok";
    } else {
      el.textContent = "HTTP " + resp.status;
      el.className = "status-pill status-warn";
    }
  } catch (_) {
    el.textContent = "unreachable";
    el.className = "status-pill status-err";
  } finally {
    clearTimeout(t);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadAllowlist();
  loadEnabled();
  loadInteractive();
  loadUiMode();
  probeGateway();

  $("allowlist-add-btn").addEventListener("click", () => {
    const input = $("allowlist-input");
    addToAllowlist(input.value);
    input.value = "";
    input.focus();
  });
  $("allowlist-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      addToAllowlist(e.target.value);
      e.target.value = "";
    }
  });

  $("clear-btn").addEventListener("click", clearAllowlist);
  $("export-btn").addEventListener("click", exportAllowlist);
  $("import-btn").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importAllowlist(file);
    e.target.value = "";
  });

  $("opt-enabled").addEventListener("change", (e) => {
    chrome.storage.local.set({ enabled: e.target.checked });
  });
  $("opt-interactive").addEventListener("change", (e) => {
    chrome.storage.local.set({ interactive: e.target.checked });
  });
  document.querySelectorAll('input[name="ui-mode"]').forEach((r) => {
    r.addEventListener("change", (e) => {
      const value = e.target.value === "modal" ? "modal" : "sidebar";
      chrome.storage.local.set({ uiMode: value });
    });
  });
});
