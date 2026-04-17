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
// ``size`` is approximate on-disk / download size for the default
// Ollama quantization (Q4_K_M). ``vram`` is peak runtime VRAM with
// the default 4k-8k context. Both values come from Ollama's public
// model cards and in-house measurements.
const RECOMMENDED_MODELS = [
  {
    name: "qwen3:1.7b",
    size: "1.1 GB",
    vram: "~1.5 GB",
    desc: "軽量 · 日本語対応 · 最初の選択肢",
    badge: { label: "軽量", cls: "b-light" },
  },
  {
    name: "qwen3:4b",
    size: "2.5 GB",
    vram: "~3 GB",
    desc: "推奨 · バランス型 · 精度/速度のバランス◎",
    badge: { label: "推奨", cls: "b-recommend" },
  },
  {
    name: "qwen3:8b",
    size: "4.7 GB",
    vram: "~5 GB",
    desc: "高精度 · 文脈検出が正確",
    badge: { label: "高精度", cls: "b-high" },
  },
  {
    name: "qwen3:14b",
    size: "8.2 GB",
    vram: "~9 GB",
    desc: "最高精度 · 複雑な日本語ビジネス文書向け",
    badge: { label: "最高精度", cls: "b-top" },
  },
  {
    name: "gemma3:4b",
    size: "2.5 GB",
    vram: "~3 GB",
    desc: "代替 · Google · Qwen3 系の代替候補",
    badge: { label: "代替", cls: "b-alt" },
  },
  {
    name: "llama3.2:3b",
    size: "2.0 GB",
    vram: "~2 GB",
    desc: "代替 · 英語寄り",
    badge: { label: "代替", cls: "b-alt" },
  },
  {
    name: "phi3.5:3.8b",
    size: "2.2 GB",
    vram: "~2.5 GB",
    desc: "代替 · Microsoft",
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

    const size = document.createElement("span");
    size.className = "llm-recommend-size";
    size.title = "ダウンロードサイズ · VRAM 使用量 (推定)";
    size.textContent = `${rec.size} / VRAM ${rec.vram}`;

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
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn-delete";
      delBtn.textContent = "削除";
      delBtn.title = `${rec.name} を Ollama から削除`;
      delBtn.addEventListener("click", () => deleteModel(rec.name, row));
      action.appendChild(delBtn);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-pull";
      btn.textContent = "ダウンロード";
      btn.addEventListener("click", () => pullModel(rec.name, row));
      action.appendChild(btn);
    }

    row.appendChild(name);
    row.appendChild(size);
    row.appendChild(desc);
    row.appendChild(badge);
    row.appendChild(action);
    container.appendChild(row);
  }
}

// Delete an installed model from Ollama via DELETE /api/delete.
// Fires after an explicit confirm() — there's no undo (the model
// files are removed from disk) so the guard is deliberate.
async function deleteModel(modelName, rowEl) {
  const baseUrl = normalizeUrl($("llm-url").value);
  if (!baseUrl) {
    alert("先に URL を設定してください");
    return;
  }
  if (!confirm(`${modelName} を Ollama から削除します。\n\nこの操作は元に戻せません (モデルファイルが実際に削除されます)。続行しますか?`)) {
    return;
  }
  const actionEl = rowEl.querySelector(".llm-recommend-action");
  while (actionEl.firstChild) actionEl.removeChild(actionEl.firstChild);
  const progress = document.createElement("span");
  progress.className = "llm-recommend-progress";
  progress.textContent = "削除中…";
  actionEl.appendChild(progress);

  try {
    const resp = await fetch(baseUrl + "/api/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
    });
    if (!resp.ok) {
      throw new Error(`${resp.status} ${resp.statusText}`);
    }
    progress.textContent = "✓ 削除しました";
    progress.style.color = "var(--ok)";
    // If the user was using this model, clear the stored selection.
    try {
      const stored = await chrome.storage.local.get("localLlmModel");
      if (stored.localLlmModel === modelName) {
        await chrome.storage.local.set({ localLlmModel: "" });
      }
    } catch (_) {}
    setTimeout(() => testLlm(), 600);
  } catch (err) {
    progress.textContent = "失敗: " + (err?.message || err);
    progress.style.color = "var(--err)";
    setTimeout(() => {
      const currentModels = [...($("llm-model").options || [])].map((o) => o.value);
      renderRecommendList(currentModels);
    }, 3000);
  }
}

// Pull a model from Ollama via streaming NDJSON, so the UI can
// display real-time progress (percentage + size). The options page
// runs in a chrome-extension:// context — unlike content scripts
// on HTTPS sites, it's NOT subject to Private Network Access, so
// we can fetch http://localhost:11434 directly without going
// through the service worker proxy.
async function pullModel(modelName, rowEl) {
  const baseUrl = normalizeUrl($("llm-url").value);
  if (!baseUrl) {
    alert("先に URL を設定してください");
    return;
  }
  const actionEl = rowEl.querySelector(".llm-recommend-action");
  while (actionEl.firstChild) actionEl.removeChild(actionEl.firstChild);

  const progressWrap = document.createElement("div");
  progressWrap.className = "llm-recommend-progress-wrap";
  const progressBar = document.createElement("div");
  progressBar.className = "llm-recommend-progress-bar";
  const progressFill = document.createElement("div");
  progressFill.className = "llm-recommend-progress-fill";
  progressBar.appendChild(progressFill);
  const progressText = document.createElement("span");
  progressText.className = "llm-recommend-progress";
  progressText.textContent = "開始中…";
  progressWrap.appendChild(progressBar);
  progressWrap.appendChild(progressText);
  actionEl.appendChild(progressWrap);

  const humanBytes = (n) => {
    if (!Number.isFinite(n)) return "";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB";
    return n + " B";
  };

  try {
    const resp = await fetch(baseUrl + "/api/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName, stream: true }),
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`${resp.status} ${resp.statusText}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let success = false;
    // Track overall progress by keeping the largest total/completed
    // we've seen — Ollama emits progress per-layer, so the latest
    // event is the most informative.
    let lastTotal = 0;
    let lastCompleted = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch (_) {
          continue;
        }
        if (ev.error) {
          throw new Error(ev.error);
        }
        const status = String(ev.status || "");
        const total = Number(ev.total) || 0;
        const completed = Number(ev.completed) || 0;
        if (total > lastTotal) lastTotal = total;
        if (completed > lastCompleted) lastCompleted = completed;
        if (status === "success") {
          success = true;
          progressFill.style.width = "100%";
          progressText.textContent = "✓ ダウンロード完了";
          progressText.style.color = "var(--ok)";
          break;
        }
        if (total > 0 && completed > 0) {
          const pct = Math.min(100, Math.round((completed / total) * 100));
          progressFill.style.width = pct + "%";
          progressText.textContent = `${pct}% (${humanBytes(completed)} / ${humanBytes(total)})`;
        } else {
          // Meta phases: "pulling manifest" / "verifying" / "writing
          // manifest" / "removing any unused layers".
          progressText.textContent = status || "ダウンロード中…";
        }
      }
      if (success) break;
    }
    if (!success) {
      throw new Error("unexpected end of stream");
    }
    // Refresh tags → updates dropdown + flips this row to
    // "✓ インストール済".
    setTimeout(() => testLlm(), 600);
  } catch (err) {
    progressFill.style.background = "var(--err)";
    progressText.textContent = "失敗: " + (err?.message || err);
    progressText.style.color = "var(--err)";
    // Re-render the row after 4s so the ダウンロード button comes back.
    setTimeout(() => {
      const currentModels = [...($("llm-model").options || [])].map((o) => o.value);
      renderRecommendList(currentModels);
    }, 4000);
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
