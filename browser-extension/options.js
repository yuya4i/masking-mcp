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

// --- Local LLM section -------------------------------------------------

function setLlmStatus(state, text) {
  const el = $("llm-status");
  el.textContent = text;
  el.className = "status-pill status-" + state;
}

function normalizeUrl(raw) {
  if (!raw) return "";
  let url = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;
  return url;
}

async function swFetch(url, timeoutMs) {
  // Route through the service worker so Chrome's Private Network Access
  // policy does not block HTTPS-page → http://localhost calls.
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "LLM_FETCH",
      url,
      method: "GET",
      timeoutMs: timeoutMs || 4000,
    });
    return resp || null;
  } catch (_) {
    return null;
  }
}

async function probeLlm(url) {
  if (!url) return { ok: false, reason: "no-url" };
  const tagsResp = await swFetch(url + "/api/tags", 4000);
  if (tagsResp && tagsResp.ok && tagsResp.body) {
    try {
      const tags = JSON.parse(tagsResp.body);
      if (Array.isArray(tags.models)) {
        return { ok: true, kind: "ollama", models: tags.models.map((m) => m.name) };
      }
    } catch (_) {}
  }
  if (tagsResp && tagsResp.status === 403) {
    return { ok: false, reason: "cors", status: 403 };
  }
  const oaiResp = await swFetch(url + "/v1/models", 4000);
  if (oaiResp && oaiResp.ok && oaiResp.body) {
    try {
      const oai = JSON.parse(oaiResp.body);
      if (Array.isArray(oai.data)) {
        return { ok: true, kind: "openai-compat", models: oai.data.map((m) => m.id) };
      }
    } catch (_) {}
  }
  return { ok: false, reason: "unreachable", status: tagsResp && tagsResp.status };
}

async function testLlm() {
  const rawUrl = $("llm-url").value;
  const url = normalizeUrl(rawUrl);
  if (!url) {
    setLlmStatus("unknown", "URL 未設定");
    return;
  }
  setLlmStatus("checking", "接続確認中...");
  const result = await probeLlm(url);
  if (result && result.ok) {
    setLlmStatus("ok", `接続 OK (${result.kind}, ${result.models.length} モデル)`);
    populateModels(result.models);
    await chrome.storage.local.set({ localLlmUrl: url, localLlmKind: result.kind });
  } else if (result && result.reason === "cors") {
    setLlmStatus("err", "CORS 拒否 — OLLAMA_ORIGINS 設定が必要");
    alert(
      "Ollama サーバーが 403 を返しました。CORS 設定が原因です。\n\n" +
        "解決方法 (いずれか):\n\n" +
        "  1. ollama バイナリで起動:\n" +
        "     OLLAMA_ORIGINS='*' ollama serve\n\n" +
        "  2. Docker で起動中:\n" +
        "     docker stop ollama && \\\n" +
        "     docker run -d --name ollama -e OLLAMA_ORIGINS='*' \\\n" +
        "       -p 11434:11434 -v ollama:/root/.ollama ollama/ollama\n\n" +
        "  3. systemd で起動中:\n" +
        "     sudo systemctl edit ollama\n" +
        "     → [Service] Environment=\"OLLAMA_ORIGINS=*\"\n" +
        "     sudo systemctl restart ollama\n\n" +
        "設定後にこの画面をリロードして再度「接続確認」を押してください。"
    );
  } else {
    setLlmStatus(
      "err",
      `接続失敗 (${(result && result.status) || "no-response"})`
    );
  }
}

function populateModels(models) {
  const sel = $("llm-model");
  const prev = sel.value;
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "(未選択)";
  sel.appendChild(blank);
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    if (m === prev) opt.selected = true;
    sel.appendChild(opt);
  }
  renderRecommendList(models);
}

// Curated list of models that handle Japanese + JSON-constrained
// detection reasonably well. The "accuracy" column is a qualitative
// label from in-house PII benchmarks, NOT an academic score — it
// reflects relative behaviour on 100 mixed JA/EN test prompts.
const RECOMMENDED_MODELS = [
  {
    name: "qwen3:1.7b",
    desc: "軽量 · 日本語対応 · VRAM 約 1.5 GB · 最初の選択肢",
    badge: { label: "軽量", cls: "b-light" },
  },
  {
    name: "qwen3:4b",
    desc: "推奨 · バランス型 · VRAM 約 3 GB · 精度/速度のバランス◎",
    badge: { label: "推奨", cls: "b-recommend" },
  },
  {
    name: "qwen3:8b",
    desc: "高精度 · VRAM 約 5 GB · 文脈検出が正確",
    badge: { label: "高精度", cls: "b-high" },
  },
  {
    name: "qwen3:14b",
    desc: "最高精度 · VRAM 約 9 GB · 複雑な日本語ビジネス文書向け",
    badge: { label: "最高精度", cls: "b-top" },
  },
  {
    name: "gemma3:4b",
    desc: "代替 · Google · VRAM 約 3 GB · Qwen3 系の代替候補",
    badge: { label: "代替", cls: "b-alt" },
  },
  {
    name: "llama3.2:3b",
    desc: "代替 · 英語寄り · VRAM 約 2 GB",
    badge: { label: "代替", cls: "b-alt" },
  },
  {
    name: "phi3.5:3.8b",
    desc: "代替 · Microsoft · VRAM 約 2.5 GB",
    badge: { label: "代替", cls: "b-alt" },
  },
];

function renderRecommendList(installedModels) {
  const container = $("llm-recommend-list");
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);
  const installedSet = new Set(installedModels || []);
  // Tags in Ollama include ":latest" suffix for default tags; normalise
  // "qwen3:1.7b" vs "qwen3:1.7b-instruct" etc.
  const isInstalled = (name) =>
    installedSet.has(name) ||
    [...installedSet].some((m) => m === name || m.startsWith(name + ":"));

  for (const rec of RECOMMENDED_MODELS) {
    const row = document.createElement("div");
    row.className = "llm-recommend-item";
    row.dataset.model = rec.name;

    const name = document.createElement("div");
    name.className = "llm-recommend-name";
    name.textContent = rec.name;

    const desc = document.createElement("div");
    desc.className = "llm-recommend-desc";
    desc.textContent = rec.desc;

    const badge = document.createElement("span");
    badge.className = "llm-recommend-badge " + rec.badge.cls;
    badge.textContent = rec.badge.label;

    const action = document.createElement("div");
    action.className = "llm-recommend-action";
    if (isInstalled(rec.name)) {
      const tag = document.createElement("span");
      tag.className = "llm-recommend-installed";
      tag.textContent = "✓ インストール済";
      action.appendChild(tag);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-pull";
      btn.textContent = "ダウンロード";
      btn.addEventListener("click", () => pullModel(rec.name, row));
      action.appendChild(btn);
    }

    row.appendChild(name);
    row.appendChild(desc);
    row.appendChild(badge);
    row.appendChild(action);
    container.appendChild(row);
  }
}

// Fire POST /api/pull to Ollama to download a model. The response is
// a streaming NDJSON; since we're going through the SW fetch proxy
// (which reads .text() at end), we effectively block until the pull
// completes. That's fine for the options UI — the user just sees a
// "ダウンロード中" state until Ollama finishes.
async function pullModel(modelName, rowEl) {
  const url = normalizeUrl($("llm-url").value);
  if (!url) {
    alert("先に URL を設定してください");
    return;
  }
  const actionEl = rowEl.querySelector(".llm-recommend-action");
  while (actionEl.firstChild) actionEl.removeChild(actionEl.firstChild);
  const progress = document.createElement("span");
  progress.className = "llm-recommend-progress";
  progress.textContent = "ダウンロード中…";
  actionEl.appendChild(progress);

  try {
    const resp = await chrome.runtime.sendMessage({
      type: "LLM_FETCH",
      url: url + "/api/pull",
      method: "POST",
      body: JSON.stringify({ name: modelName, stream: false }),
      // Pulling a 4B model over a slow connection can take 5–15 min.
      // 30 minutes upper bound ought to cover anything reasonable.
      timeoutMs: 1800000,
    });
    if (resp && resp.ok) {
      progress.textContent = "✓ 完了";
      progress.style.color = "var(--ok)";
      // Refresh tags so the select + recommend list reflect the
      // newly-available model.
      setTimeout(() => testLlm(), 400);
    } else {
      const reason = (resp && (resp.status || resp.error)) || "unknown";
      progress.textContent = "失敗 (" + reason + ")";
      progress.style.color = "var(--err)";
      setTimeout(() => {
        renderRecommendList([...new Set([...($("llm-model").options || [])].map(o => o.value))]);
      }, 3000);
    }
  } catch (err) {
    progress.textContent = "失敗: " + (err?.message || err);
    progress.style.color = "var(--err)";
  }
}

async function loadLlmSettings() {
  const stored = await chrome.storage.local.get([
    "localLlmEnabled",
    "localLlmUrl",
    "localLlmModel",
    "localLlmMode",
    "localLlmTimeoutMs",
  ]);
  $("llm-enabled").checked = stored.localLlmEnabled === true;
  $("llm-url").value = stored.localLlmUrl || "";
  $("llm-mode").value = stored.localLlmMode === "replace" ? "replace" : "detect";
  $("llm-timeout").value = stored.localLlmTimeoutMs || 120000;
  if (stored.localLlmModel) {
    const opt = document.createElement("option");
    opt.value = stored.localLlmModel;
    opt.textContent = stored.localLlmModel + " (保存済み)";
    opt.selected = true;
    $("llm-model").appendChild(opt);
  }
  if (stored.localLlmUrl && stored.localLlmEnabled) {
    testLlm();
  } else if (!stored.localLlmUrl) {
    setLlmStatus("unknown", "未設定");
  } else {
    setLlmStatus("unknown", "無効化中");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadAllowlist();
  loadEnabled();
  loadInteractive();
  loadUiMode();
  loadLlmSettings();

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

  // LLM event wiring.
  $("llm-enabled").addEventListener("change", (e) => {
    chrome.storage.local.set({ localLlmEnabled: e.target.checked });
    if (!e.target.checked) setLlmStatus("unknown", "無効化中");
    else if ($("llm-url").value) testLlm();
  });
  $("llm-test-btn").addEventListener("click", testLlm);
  $("llm-url").addEventListener("change", (e) => {
    const url = normalizeUrl(e.target.value);
    chrome.storage.local.set({ localLlmUrl: url });
    e.target.value = url;
  });
  $("llm-model").addEventListener("change", (e) => {
    chrome.storage.local.set({ localLlmModel: e.target.value });
  });
  $("llm-mode").addEventListener("change", (e) => {
    const v = e.target.value === "replace" ? "replace" : "detect";
    chrome.storage.local.set({ localLlmMode: v });
  });
  $("llm-timeout").addEventListener("change", (e) => {
    const n = Math.max(2000, Math.min(240000, parseInt(e.target.value, 10) || 120000));
    chrome.storage.local.set({ localLlmTimeoutMs: n });
    e.target.value = n;
  });
});
