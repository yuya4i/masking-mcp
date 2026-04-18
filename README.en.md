<div align="center">

# 🛡️ PII Guard / `pii-masking`

[**🇯🇵 日本語**](./README.md) ・ **🇺🇸 English (this page)**

---

**A lightweight gateway + Chrome extension that detects and masks PII locally — before it ever reaches a generative AI service.**

100% local. Zero network egress for detection. LAN-only for LLM augmentation.

---

![Python 3.11](https://img.shields.io/badge/python-3.11-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white)
![Pydantic v2](https://img.shields.io/badge/Pydantic-v2-E92063?logo=pydantic&logoColor=white)
![uv](https://img.shields.io/badge/uv-0.11-DE5FE9?logo=python&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![Presidio](https://img.shields.io/badge/Presidio-MS-5E5CE6)
![SudachiPy](https://img.shields.io/badge/SudachiPy-core-E60012)
![pytesseract](https://img.shields.io/badge/pytesseract-OCR-4B5563)
![FastMCP](https://img.shields.io/badge/FastMCP-stdio-7C3AED)
![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)
![Ollama](https://img.shields.io/badge/Ollama-local--LLM-000000?logo=ollama&logoColor=white)
![Qwen3](https://img.shields.io/badge/Qwen3-1.7b%20%2F%204b-615CED)
![pytest](https://img.shields.io/badge/tests-pytest-0A9EDC?logo=pytest&logoColor=white)
![Ruff](https://img.shields.io/badge/lint-Ruff-D7FF64?logo=ruff&logoColor=black)

</div>

---

## 🎯 In 3 lines

1. A **Chrome MV3 extension** intercepts outbound traffic to Claude.ai / ChatGPT / Gemini / Manus and detects PII before send.
2. An optional **FastAPI gateway (Docker)** adds Presidio + SudachiPy + preset regex analyzers.
3. An optional **local LLM (Ollama / LM Studio / llama.cpp)** provides context-aware detection plus an AI-replace mode (v0.5.0+).

Detections are surfaced in a Shadow DOM sidebar for user confirmation right before the send fires. **Nothing is ever transmitted to a third-party server.**

> **📌 Current release**: Chrome Web Store public build `v1.0.1` (standalone only) / dev build `v0.5.1-dev` (local-LLM). See [CHANGELOG](./browser-extension/CHANGELOG.md) and [TODO.md](./TODO.md).

---

## 📖 Table of contents

- [✨ Overview](#-overview)
- [🏗 Architecture](#-architecture)
- [🎯 Detection catalog](#-detection-catalog)
- [🔐 Vendor-specific API key detection](#-vendor-specific-api-key-detection-v050)
- [🛡 Severity tiers](#-severity-tiers)
- [🧹 Common-noun blocklist](#-common-noun-blocklist)
- [⚙️ Setup](#-setup)
- [🚀 Usage (Gateway API)](#-usage-gateway-api)
- [🌐 Browser extension](#-browser-extension)
- [🧠 Local LLM proxy (v0.5.0)](#-local-llm-proxy-v050)
- [🤖 Claude Code / Claude Desktop integration](#-claude-code--claude-desktop-integration)
- [📦 Chrome Web Store build](#-chrome-web-store-build)
- [🧪 Tests](#-tests)
- [🗂 Directory layout](#-directory-layout)

---

## ✨ Overview

| Layer | Stack | Responsibility |
|---|---|---|
| **Browser extension** | Chrome MV3 / Shadow DOM / Service Worker | Send interception, sidebar UI, LLM proxy |
| **Gateway (optional)** | FastAPI + Pydantic v2 + uv on Docker | Presidio / Sudachi / regex analyzer chain |
| **MCP server (optional)** | FastMCP (stdio) | Exposes `sanitize_text` etc. to Claude Desktop |
| **Local LLM (optional)** | Ollama / LM Studio / llama.cpp | Context-aware PII detection + AI-replace mode |

The extension runs **without the gateway** (Standalone mode). If the gateway is up at `127.0.0.1:8081`, it's used automatically (**Hybrid**). Enabling a local LLM routes every call through the extension's service worker directly to Ollama — **neither the gateway nor the LLM ever leaves your machine / LAN**.

---

## 🏗 Architecture

```text
      HTTP request (/sanitize/text, /proxy/*)        MCP stdio (sanitize_text, ...)
              │                                                │
              ▼                                                ▼
        FastAPI router  ───────────────────────────────▶  FastMCP server
              │             (shared MaskingService)
              ▼
     ┌──────────────────────────────────────────────┐
     │             MaskingService                   │
     │  detect_language(text)  →  "ja"/"en"/"mixed" │
     │          │                                   │
     │          ▼                                   │
     │  analyzers_by_language[lang]  (or legacy)    │
     │          │                                   │
     │   ┌──────┼──────────┬───────────┐            │
     │   ▼      ▼          ▼           ▼            │
     │ Presidio Sudachi  Regex  (future analyzer)   │
     │   │      │          │                        │
     │   └──────┴──────────┘                        │
     │        merged RecognizerResult[]             │
     │        │                                     │
     │        ▼                                     │
     │  _resolve_overlaps (sweep-line)              │
     │        │                                     │
     │        ▼                                     │
     │  allow-list filter + mask strategy           │
     │  (tag | partial | hash)                      │
     └────────────────────┬─────────────────────────┘
                          ▼
           sanitized text + DetectionResult[]
                          │
                          ▼
          MITM proxy → upstream LLM  (optional)
                          │
                          ▼
           audit log (JSONL) + admin_token bootstrap
```

**Analyzer mix** (all implemented):

| Analyzer | Language | Role |
|---|---|---|
| **Presidio** | English-first | `PERSON` / `EMAIL_ADDRESS` / `CREDIT_CARD` and fixed entity types |
| **SudachiPy** | Japanese | Morphological analysis — only `名詞,固有名詞` (proper nouns) are kept, general nouns are skipped |
| **RegexAnalyzer** | Both | Org-internal IDs, API keys, addresses — 40+ preset categories |
| **Local LLM** | Both | Context-aware PII detection (regex safety net is always kept) |

**Analyzer abstraction**: the three concrete analyzers implement an `Analyzer` Protocol (`src/app/services/analyzers/base.py`). Adding a new one (e.g. GiNZA) is a single-file change.

---

## 🎯 Detection catalog

Presets are enabled by default (`enable_preset_patterns: true`). Disable a category by adding its key to `disabled_pattern_categories`.

### Core categories

| Category | entity_type | Example | Source |
|---|---|---|---|
| Person | `PERSON` / `PROPER_NOUN_PERSON` | 田中太郎, Tanaka | Presidio NER / Sudachi |
| Email | `EMAIL_ADDRESS` | user@example.com | Presidio |
| Phone | `PHONE_NUMBER` | 090-1234-5678, 03-1234-5678 | Presidio / preset |
| **Prefecture + city** | **`PREFECTURE_CITY`** 🆕 | **兵庫県明石市 / 東京都渋谷区** | **preset regex** |
| Full address | `ADDRESS` | 兵庫県明石市大久保町1丁目2番3号 | preset regex |
| Age | `AGE` | 35歳 | preset regex |
| Gender | `GENDER` | 男性 / 女性 | preset regex |
| Company | `COMPANY` | 株式会社マスクテスト | preset regex |
| Money | `MONETARY_AMOUNT` | ¥15,000 / 100万円 | preset regex |
| Date | `DATE` | 2024/01/15, 令和6年1月 | preset regex |
| IP | `IP_ADDRESS` | 192.168.1.1 | preset regex |
| URL | `URL` | https://example.com | preset regex |
| My Number (JP) | `MY_NUMBER` | 1234 5678 9012 | preset regex |
| Bank account | `BANK_ACCOUNT` | 普通 1234567 | preset regex |
| Driver's license | `DRIVERS_LICENSE` | 12-34-567890-12 | preset regex |
| Passport | `PASSPORT` | AB1234567 | preset regex |
| DB connection | `DB_CONNECTION` | `postgresql://...` | preset regex |
| API key | `API_KEY` / `SECRET` | `sk-xxx`, `password=xxx` | [vendor table](#-vendor-specific-api-key-detection-v050) |
| Internal ID | `INTERNAL_ID` | PRJ-001, EMP-12345 | preset regex |
| Credit card | `CREDIT_CARD` | 4111-1111-1111-1111 | Presidio |
| Location | `LOCATION` / `PROPER_NOUN_LOCATION` | 東京, 大阪 | Presidio / Sudachi |
| Organization | `PROPER_NOUN_ORG` | グーグル | Sudachi |

> 💡 **When to use `PREFECTURE_CITY` vs `ADDRESS`**: The "prefecture + city" form alone (e.g. `兵庫県明石市`) is detected as `PREFECTURE_CITY`. When a street suffix follows (e.g. `兵庫県明石市大久保町1丁目2番3号`), `ADDRESS` wins via longer-span resolution in the sweep-line overlap resolver.

<details>
<summary>📎 <b>Business-doc presets (Milestone 8 Wave A — 15 extra categories)</b></summary>

| Category | entity_type | Matches |
|---|---|---|
| Postal code | `POSTAL_CODE` | `〒651-0087`, `123-4567` |
| Department code | `DEPARTMENT` | `DIV-101`, `部署コード: D-001` |
| Contract number | `CONTRACT_NUMBER` | `CONTRACT-ABC-001`, `契約番号: CT-2024-01` |
| PO / purchase order | `PURCHASE_ORDER` | `PO-1234567`, `発注番号: PO-9999` |
| Customer ID | `CUSTOMER_ID` | `CUST-0001`, `顧客ID: C-999` |
| Invoice number | `INVOICE_NUMBER` | `INV-20240415`, `請求番号: INV-12` |
| Employee ID | `EMPLOYEE_ID` | `STAFF-00123`, `社員番号: E-0042` |
| Member ID | `MEMBER_ID` | `MEMBER-123456`, `会員ID: M-555` |
| Patient ID | `PATIENT_ID` | `PATIENT-12345`, `患者ID: P-77` |
| SKU | `SKU` | `SKU-ABC-123`, `商品コード: X-77` |
| Blood type | `BLOOD_TYPE` | `AB型`, `A型` |
| Annual / monthly income | `ANNUAL_INCOME` | `年収1200万円`, `月収 40 万円` |
| Patent number | `PATENT_NUMBER` | `特許2024-123456`, `JP 1234567` |
| Asset number | `ASSET_NUMBER` | `ASSET-12345`, `資産番号: FA-999` |
| License number | `LICENSE_NUMBER` | `LIC-ABC-2024` |

Defined in `src/app/services/analyzers/presets.py`. We keep extending this list as new leak-prone categories surface; disable false positives via `disabled_pattern_categories` or per-row in the review sidebar.

</details>

---

## 🔐 Vendor-specific API key detection (v0.5.0+)

The `API_KEY` category goes beyond generic `sk-*` / `pk_*` / `access_key_*` rules and directly recognises **fixed-prefix tokens from major SaaS vendors**. The same table lives in both `browser-extension/engine/patterns.js` and `src/app/services/analyzers/presets.py` (always update both together).

<details>
<summary>📋 <b>Supported vendors (30+)</b></summary>

| Vendor | Prefix / format | Purpose |
|---|---|---|
| OpenAI | `sk-<32+>` / `sk-proj-...` / `sk-svcacct-...` / `sk-None-...` | project / service / legacy |
| Anthropic | `sk-ant-api03-<80+>` / `sk-ant-admin01-<80+>` | Claude API / Admin |
| Notion | `ntn_<40+>` / `secret_<43>` | Integration token (new/old) |
| GitHub | `ghp_<36>` / `gho_<36>` / `ghu_<36>` / `ghs_<36>` / `ghr_<36>` / `github_pat_<80+>` | PAT / OAuth / fine-grained |
| Slack | `xoxb-*` / `xoxp-*` / `xoxa-*` / `xoxr-*` / `xoxs-*` | Bot / User / App / Refresh |
| Google | `AIza[A-Za-z0-9_\-]{35}` / `ya29.<40+>` | GCP / Firebase / OAuth |
| AWS | `AKIA` / `ASIA` / `AROA` / `AIDA` / `ANPA` / `ANVA` / `APKA` / `ABIA` / `ACCA` + `[A-Z0-9]{16}` | IAM / STS / Federated |
| Hugging Face | `hf_<34+>` | Access token |
| Stripe | `sk_live_*` / `sk_test_*` / `pk_live_*` / `pk_test_*` / `rk_*` / `whsec_*` | Secret / Publishable / Webhook |
| Twilio | `AC<32 hex>` / `SK<32 hex>` | Account SID / API Key SID |
| SendGrid | `SG.<22>.<43>` | API key (2 segments) |
| Groq | `gsk_<40+>` | API key |
| Replicate | `r8_<37+>` | API key |
| Tavily | `tvly-<16+>` | Search API key |
| GitLab | `glpat-<20+>` / `glrt-<20+>` | Personal / Runner |
| Mailgun | `key-<32 hex>` | Private API key |
| npm | `npm_<36>` | Automation / publishing |
| Fireworks AI | `fw_<24+>` | API key |
| Airtable | `pat<14>.<64 hex>` | Personal access |
| Linear | `lin_api_<32+>` / `lin_oauth_<32+>` | API / OAuth |
| Figma | `figd_<40+>` | Personal access |
| Discord | `[MN][A-Za-z\d]{23}.<6>.<27+>` | Bot token |
| Cloudflare | `cf-<40+>` | API token |
| JWT | `eyJ...·eyJ...·...` | 3-segment base64url (Supabase etc.) |
| HTTP header | `Bearer <16+>` / `X-Api-Key: ...` | request headers |
| Certificate | `-----BEGIN … PRIVATE KEY-----` | RSA / EC / OpenSSH / PGP / DSA |

</details>

All of these emit `entity_type = API_KEY` (PEM keys → `SECRET`) and are treated as **critical** in the [severity table](#-severity-tiers). The sidebar locks them with a red border and requires explicit user confirmation before send.

With local LLM enabled, structured tokens are still caught by **regex as a safety net** — even if the LLM misses or misclassifies them.

---

## 🛡 Severity tiers

Every detection carries a `category` (display bucket), `classification` (linguistic class), and **`severity`** (leak-time risk). `src/app/services/severity.py` is the base map; `severity_for_surface(label, surface)` escalates tiers based on **the actual matched text**.

| Severity | Labels (excerpt) | UI colour | UI behaviour |
|---|---|---|---|
| 🔴 `critical` | `MY_NUMBER`, `PASSPORT`, `DRIVERS_LICENSE`, `CREDIT_CARD`, `BANK_ACCOUNT`, `API_KEY`, `SECRET`, `DB_CONNECTION`, **+ dynamic escalation** | rose `#e11d48` | Long-press (0–1.5 s) required only on locked rows from `force_masked_categories` |
| 🟠 `high` | `PHONE_NUMBER`, `ADDRESS`, `PATIENT_ID` | orange `#ea580c` | Click to toggle |
| 🟡 `medium` | `LOCATION`, `PREFECTURE_CITY`, `EMPLOYEE_ID`, `MEMBER_ID`, `CUSTOMER_ID`, `CONTRACT_NUMBER`, `MONETARY_AMOUNT`, `URL`, `IP_ADDRESS`, … | yellow `#ca8a04` | Click to toggle |
| ⚪ `low` | `AGE`, `GENDER`, `DATE`, `BLOOD_TYPE`, `POSTAL_CODE`, `SKU`, `KATAKANA_NAME` | slate `#64748b` | Click to toggle |

### Surface-aware escalation

`severity_for_surface(label, value)` promotes the base severity to **critical** in these cases (shared regex across Python and JS engines):

| Label | Trigger | Example |
|---|---|---|
| `PERSON` / `PROPER_NOUN_PERSON` | Always critical | "田中太郎" |
| `ORGANIZATION` / `COMPANY` / `PROPER_NOUN_ORG` | surface contains `株式会社`, `㈱`, `有限会社`, `㈲`, `合同会社`, `合資会社` | "株式会社アクメ", "アクメ㈱" |
| `EMAIL_ADDRESS` | surface in `user@host.tld` shape | `tanaka@acme.com` |

### PERSON false-positive filter

Sudachi/Presidio sometimes mis-tag polite phrases like "ご注意くださいますようお願いいたします" as `PROPER_NOUN_PERSON`. `is_false_positive_person(surface)` **drops** the detection when:

- Surface length > 6 chars (real names are 2–6)
- Surface contains one of: `ます` `ません` `ください` `いたします` `願い` `注意` `確認` `ご了承` `申し訳` `よろしく` `とおり` `ように` `については` `ところ` `ため` `こと` etc.

Category headers render the **worst severity** among their children (e.g. a `PERSON` category bucket containing an `API_KEY` shows the critical colour). `RuntimeConfig.default_uncheck_below` sets the threshold below which rows start unchecked (default `"low"` = every row masked).

---

## 🧹 Common-noun blocklist

Sudachi's `sudachidict_core` occasionally tags generic business katakana (`プロジェクト` / `メンバー` / `チーム`) as proper nouns. `RuntimeConfig.common_noun_blocklist` is a list of surface strings that are **dropped before any other filter** — exact match, case-sensitive.

Default 26 entries:

```
プロジェクト, メンバー, チーム, マネージャー, リーダー, ユーザー,
クライアント, サーバー, システム, データ, ファイル, フォルダ,
フォルダー, レポート, ミーティング, タスク, チケット, スケジュール,
ドキュメント, アカウント, パスワード, メッセージ, スタッフ,
カスタマー, オフィス, ミーティングルーム
```

The blocklist runs **before** `min_score` / `enabled_pii_classes` / `allow_entity_types`, so even a high-confidence detection from another analyzer is dropped. Useful for:

- **Suppressing false positives** — "プロジェクトαの進捗" stays un-tagged.
- **Safety net** — add "東京" to force-block location leaks regardless of the detection label.

---

## ⚙️ Setup

> **🚨 Prerequisite**: `docker` + `docker compose`. No host-side Python / uv install needed.

### Start the gateway

```bash
cd /path/to/pii-masking
make up                        # build + start + /health wait + admin_token print
make config                    # authed pretty-print of /admin/config
make logs                      # tail container logs
make down                      # stop (keeps data/)
make help                      # full target list
```

`make up` runs `mkdir -p data && docker compose up -d --build` and polls `/health` up to 60 s. `.env` is **optional** — `ADMIN_TOKEN` is auto-generated on first request and saved to `data/admin_token` (mode 0600).

```bash
TOKEN=$(cat data/admin_token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8081/admin/config
```

> 💡 First build downloads spaCy `en_core_web_lg` (~400 MB). Subsequent builds are layer-cached.

### Autostart (launch gateway on OS login)

Chrome extensions can't start Docker themselves due to sandbox restrictions, so we ship scripts that wire up **OS-login autostart**. One-time setup.

<details>
<summary><b>Linux / WSL2</b></summary>

```bash
cd /path/to/pii-masking
bash scripts/install-autostart.sh
```

- Installs a **systemd user service** (`~/.config/systemd/user/mask-mcp-gateway.service`).
- Falls back to a `~/.bashrc` hook when systemd isn't available (WSL without `systemd=true` in `/etc/wsl.conf`).
- Subsequent logins auto-run `docker compose up -d`.
- Container itself is `restart: unless-stopped`, so it survives Docker daemon restarts.
- Verify: `systemctl --user status mask-mcp-gateway`.
- Uninstall: `bash scripts/install-autostart.sh --uninstall`.

</details>

<details>
<summary><b>Windows (requires WSL + Docker Desktop)</b></summary>

From PowerShell (no admin needed):

```powershell
cd C:\Users\<you>\workspace\pii-masking
powershell -File scripts\install-autostart.ps1
```

- Registers `MaskMcpGatewayAutostart` in Windows Task Scheduler.
- On login, runs `wsl -d <distro> -- bash -c "cd <repo> && docker compose up -d"`.
- Uninstall: `powershell -File scripts\install-autostart.ps1 -Uninstall`.

</details>

If the popup opens while the gateway is unreachable, it shows a **"Gateway not found"** card with a copy-pasteable install command for your OS.

### Standalone mode (no Docker)

Since `feat/serverless-engine-phase1`, the extension ships with a **pure-JavaScript PII detector** inline. No gateway needed for the regex presets (EMAIL / PHONE_NUMBER / POSTAL_CODE / MY_NUMBER / API_KEY / BLOOD_TYPE / ANNUAL_INCOME / 40+ categories) — everything runs in-browser.

| Category | Standalone (Phase 1) | Gateway (Phase 2 + Presidio) |
|---|---|---|
| Structured PII (email / phone / postal / My Number / API key / …) | ≒ parity | parity |
| Japanese proper nouns (田中太郎, 株式会社…) | partial (COMPANY + KATAKANA_NAME only) | high (Sudachi morphological) |
| English PERSON / LOCATION / ORGANIZATION | not supported | high (Presidio NER) |

By default the extension runs in **Hybrid mode** — use the gateway when it responds at `127.0.0.1:8081`, fall back to standalone when it doesn't.

---

## 🚀 Usage (Gateway API)

Assuming the gateway is running.

### 1. Mask a single text

```bash
curl -X POST http://127.0.0.1:8081/sanitize/text \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d '{"text": "John Doe lives at 1 Main St. Email john@example.com"}'
```

### 2. Detection result shape

The `detections[]` field in `sanitize/text` / `sanitize/file` responses carries columns ready for any UI:

| Column | Meaning |
|---|---|
| `entity_type` | Label from Presidio / Sudachi / preset |
| `start` / `end` | Char offsets in the original text |
| `line` / `column` | 1-based line / col (useful for PDF / log referencing) |
| `text` | Matched substring |
| `context_before` / `context_after` | ~20 chars of surrounding context |
| `score` | Presidio confidence (0.0–1.0) |
| `action` | `masked` (replaced) or `allowed` (pass-through) |

### 3. Forward to OpenAI / Claude / Manus (MITM pass-through)

The gateway is a **pure MITM** — the client attaches its own provider auth header (`Authorization: Bearer ...` for OpenAI, `x-api-key: ...` for Anthropic). The gateway holds no API keys.

```bash
# OpenAI
curl -X POST http://127.0.0.1:8081/proxy/openai/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{"model": "gpt-4.1-mini", "messages": [{"role":"user","content":"My email is john@example.com"}]}'

# Anthropic
curl -X POST http://127.0.0.1:8081/proxy/anthropic/v1/messages \
  -H 'Content-Type: application/json' \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-3-5-sonnet-latest","messages":[{"role":"user","content":"My phone is 090-1234-5678"}],"max_tokens":512}'
```

<details>
<summary><b>4. Japanese proper-noun masking (Sudachi)</b></summary>

Set `RuntimeConfig.morphological_analyzer` to `"sudachi"` to add SudachiPy's morphological analyzer on top of Presidio. Only `("名詞","固有名詞",...)` tokens become mask targets (general nouns are skipped).

```bash
cat <<'JSON' | curl -X PUT http://127.0.0.1:8081/admin/config \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' -d @-
{
  "filter_enabled": true,
  "morphological_analyzer": "sudachi",
  "sudachi_split_mode": "A",
  "proper_noun_pos_patterns": [["名詞", "固有名詞"]]
}
JSON

curl -X POST http://127.0.0.1:8081/sanitize/text \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d '{"text": "田中太郎は東京本社にいる"}'
```

Expected response (excerpt):

```jsonc
{
  "sanitized_text": "<PROPER_NOUN_PERSON>は<PROPER_NOUN_LOCATION>本社にいる",
  "detections": [
    { "entity_type": "PROPER_NOUN_PERSON", "text": "田中太郎", "action": "masked" },
    { "entity_type": "PROPER_NOUN_LOCATION", "text": "東京", "action": "masked" }
  ]
}
```

</details>

<details>
<summary><b>5. Language-aware dispatch + custom regex</b></summary>

For mixed-language workloads, `RuntimeConfig.analyzers_by_language` dispatches analyzers **by CJK ratio**. `RegexAnalyzer` adds org-internal regex patterns that neither Presidio's fixed categories nor Sudachi's proper-noun extractor would catch.

```bash
cat <<'JSON' | curl -X PUT http://127.0.0.1:8081/admin/config \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' -d @-
{
  "analyzers_by_language": {
    "en":    ["presidio", "regex"],
    "ja":    ["sudachi",  "regex"],
    "mixed": ["presidio", "sudachi", "regex"]
  },
  "regex_patterns": [
    ["EMPLOYEE_ID",   "EMP-\\d{5}"],
    ["PROJECT_CODE",  "PRJ-[A-Z]{3}-\\d{4}"]
  ]
}
JSON
```

</details>

### 6. Aggregated endpoint

`POST /v1/extension/sanitize/aggregated` — collapses repeated occurrences of the same surface into one row so the sidebar can render `田中太郎 (2件)` instead of two rows.

```json
{
  "original_text": "リーク情報: 田中太郎の年収1200万円。",
  "aggregated": [
    { "value": "田中太郎", "label": "PROPER_NOUN_PERSON", "category": "PERSON", "count": 1, "positions": [[6, 10]], "masked": true }
  ],
  "audit_id": "...",
  "force_masked_categories": ["PERSON", "ORGANIZATION", "FINANCIAL"]
}
```

`force_masked_categories` is populated when `RuntimeConfig.force_mask_keywords` (default `["リーク","未公開","機密","confidential","leak"]`) is matched as a noun in the source text by Sudachi.

---

## 🌐 Browser extension

`ANTHROPIC_BASE_URL` routing only covers **Claude Code / SDK callers**. The browser-based UIs (Claude.ai, ChatGPT, Gemini, Manus) talk `fetch` directly from the page, so they need a different entry point. That's what `browser-extension/` is.

| | `ANTHROPIC_BASE_URL` approach | Browser-extension approach |
|---|---|---|
| Scope | Claude Code / Anthropic SDK processes | Browser AI chat UIs |
| Coverage | Anthropic (1 provider) | Claude.ai / ChatGPT / Gemini / Manus |
| Mechanism | HTTP proxy (MITM) | `window.fetch` / `XHR.send` monkey-patch |
| Auth | None (passthrough) | None (loopback trust model) |
| New endpoint | existing `/proxy/*` | new `POST /v1/extension/sanitize` |

**Install**: `make up`, then `chrome://extensions` → Developer mode → **Load unpacked** → pick `browser-extension/`. See [browser-extension/README.md](./browser-extension/README.md) for the full walkthrough.

### Interactive review (default ON)

Detections appear in a **Shadow DOM** panel right before the send fires. Un-tick false positives (e.g. "プロジェクト" or "会社" swept up by the katakana heuristic) to send the original instead. `Enter` confirms; `Esc` cancels the whole send.

### UI modes

| Mode | Behaviour | Endpoint |
|---|---|---|
| **Sidebar** (default) | Right-side fixed panel. Repeated surfaces collapse into a single `田中太郎 (2件)` row. Category folding + bulk ON/OFF + live preview. Lock icons for categories force-masked by keywords like `機密` / `リーク`. | `POST /v1/extension/sanitize/aggregated` |
| **Modal** (legacy) | Same Phase 2 centre modal. 1 detection = 1 row. | `POST /v1/extension/sanitize` |

### Sidebar UX highlights

| Feature | Description |
|---|---|
| **Push + shrink layout** | Sidebar sits as a flex sibling of the chat under `<body>` — never overlaps. `min(400px, 50vw)` responsive width. |
| **Independent stacking** | `position: relative` + `z-index: 2147483647` + `isolation: isolate`. Host-page sticky/fixed elements never leak onto the panel. |
| **Mode pill** (header right) | Colour-coded pill shows `AI 置換 (実験的)` / `検出補助 (Regex + AI)` / `Regex のみ`. |
| **Theme sync** | Reads host background via `getComputedStyle`; luminance < 0.5 → dark palette. |
| **Severity filter tabs** | `All` / `Critical` / `High` / `Medium` / `Low` segment control. |
| **Interaction rules** (v0.5.0 final) | **Long-press required only for masked critical rows**. Everything else is a single tap. |
| **Before/after grid** | 4-column grid `[icon] [original] [→] [masked]`. Long values get `text-overflow: ellipsis` with full text in `title`. |
| **Green bar** (right edge) | On unmasked rows — visual cue that "this value will be sent raw". |
| **Exclude button** | Per-row `✖ 除外` writes to `chrome.storage.local.maskAllowlist`. |
| **Occurrence count** | Second line shows `出現回数 N回` (N occurrences in the input). |
| **AI analysis overlay** | While the LLM thinks, a centred double-ring spinner + `✨ AI 分析中…` overlay. Rows stagger-in (80 ms × index) when the LLM resolves. |
| **AI detection badge** | LLM rows show a `✨` icon (purple pulse) + a purple gradient `● AI 検出` pill on the second line. |
| **Unique numbered tags** (replace mode) | Same surface → same tag; different surface → different number (`<name_1>`, `<company_2>`, …). 1:1 restorable mapping. |

### Allowlist DB

Manage via `chrome://extensions` → right-click icon → Options, or the `⚙ 詳細設定` button in the popup:

- Add / remove / clear entries
- JSON export (timestamped) / JSON import (deduped merge)
- Master enable/disable, interactive toggle, UI mode radio, gateway health badge
- Dark-mode aware

**Cross-tab live sync**: adding an entry in one tab fires `chrome.storage.onChanged` → `content.js` → `injected.js` → `mask-mcp:settings-updated` CustomEvent. All open tabs unmask the row without reload.

### Socket.IO (WebSocket) support

manus.im uses Socket.IO over WebSocket, which doesn't pass through `fetch` / `XHR`. A dedicated hook handles it:

1. `injected.js` wraps `WebSocket.prototype.send`.
2. Parses Engine.IO v4 EVENT frames (`42[...]` / `4213[...]`).
3. Masks only the `value` field inside `["message", {type:"user_message", contents:[{type:"text", value:"..."}]}]`.
4. ping / pong / CONNECT / DISCONNECT / ACK pass through unchanged.
5. On user cancel, only that frame is silently dropped (the WebSocket stays open — chat session preserved).

> **🔐 Security**: manus's WebSocket URL carries a JWT via `?token=...`. Diagnostic logs redact `token` / `auth` / `key` / `sentry_key` query params to `REDACTED`.

---

## 🧠 Local LLM proxy (v0.5.0)

No gateway required — **browser extension + local Ollama (or LM Studio / llama.cpp)** gives you context-aware PII detection.

| Mode | Behaviour |
|---|---|
| `Regex only` | Legacy behaviour, no LLM. |
| `Augmented detect (Regex + AI)` | LLM adds contextual PII; its labels override regex for shared surfaces; regex remains the safety net for structured PII. |
| `AI replace (experimental)` | LLM rewrites the whole input into `<tag_N>` placeholders before send — nothing that looks like the original ever leaves the browser. |

### Minimal setup

```bash
# 1) Ollama with CORS allowed (chrome-extension:// needs OLLAMA_ORIGINS)
docker run -d --name ollama --gpus all \
  -e OLLAMA_HOST='0.0.0.0:11434' \
  -e OLLAMA_ORIGINS='*' \
  -p 11434:11434 \
  -v ollama:/root/.ollama \
  --restart unless-stopped \
  ollama/ollama:latest

# 2) Pull a model (light: qwen3:1.7b; balanced: qwen3:4b)
docker exec -it ollama ollama pull qwen3:4b

# 3) Options page → enable local LLM → URL http://localhost:11434
#    → 接続確認 → pick model.
```

### Architecture notes

- **Service worker proxy**: Chrome's Private Network Access blocks HTTPS pages from fetching `http://localhost`. All LLM calls are relayed through the privileged service worker via an `LLM_FETCH` message.
- **Host lock**: The SW rejects any URL whose host/protocol doesn't match `chrome.storage.local.localLlmUrl`. Cannot be repurposed as a general HTTP proxy.
- **Sender-ID check**: Foreign extensions can't relay through the SW — `sender.id !== chrome.runtime.id` is rejected.
- **`think: false` + `format: "json"`**: Three required params in every Ollama request — `think: false` (suppresses Qwen3 thinking tokens), `format: "json"` (grammar constraint), `num_predict: 2048` (generation cap).
- **Multi-stage retry**: `500/503 "loading model"` → up to 6× with 3 s spacing; `AbortError` → up to 2× with 2 s spacing. Inner bridge budget = `timeoutMs × 3 + 30 s` covers all retries.
- **Unique numbered tags**: Replace mode output is normalised to a 1:1 map — `<name_1>`, `<company_2>`, `<hospital_1>` — same surface → same tag; different values → different numbers.
- **Fail-closed on replace / fail-open on detect**: Any replace failure aborts the whole outbound request; detect failures leave regex/Sudachi results intact.

### Recommended models (v0.5.0+)

| Model | Size | VRAM | Badge |
|---|---|---|---|
| `qwen3:1.7b` | 1.1 GB | ~1.5 GB | light |
| `qwen3:4b` | 2.5 GB | ~3 GB | **recommended** |
| `qwen3:8b` | 4.7 GB | ~5 GB | high-accuracy |
| `qwen3:14b` | 8.2 GB | ~9 GB | top-accuracy |
| `gemma3:4b` | 2.5 GB | ~3 GB | alternative |
| `llama3.2:3b` | 2.0 GB | ~2 GB | alternative |
| `phi3.5:3.8b` | 2.2 GB | ~2.5 GB | alternative |

One-click **Download** (`POST /api/pull` with streaming NDJSON progress) and **Delete** (`DELETE /api/delete`) are available from the options page.

### Known limits

| Symptom | Cause | Fix |
|---|---|---|
| 403 (CORS) | `OLLAMA_ORIGINS` not set | Add `OLLAMA_ORIGINS: "*"` to the compose env; the options page's 接続確認 detects this and shows the remediation command. |
| Slow first call | 4B+ models take 20–40 s cold; 9B+ thinking models 60–90 s | Bump timeout to 120 000 ms (default) ~ 240 000 ms. |
| LLM flags generic words (`エンジニア`, `アクセスキー`) | Model over-detection | Prompt `HARD NEGATIVE LIST` + client-side `LLM_DENYLIST` / `LLM_DENY_REGEX`. |
| No result on Qwen3 | Old `think: true` default consumed the token budget | Current code forces `think: false`. Reload the extension. |

See [browser-extension/README.md#local-llm-proxy-v050-experimental](./browser-extension/README.md#local-llm-proxy-v050-experimental) for the full story.

---

## 🤖 Claude Code / Claude Desktop integration

### Option 1: Claude Code — `ANTHROPIC_BASE_URL` (streaming OK)

```bash
make up
ANTHROPIC_BASE_URL=http://127.0.0.1:8081/proxy/anthropic claude

# Persist via alias
alias claude-safe='ANTHROPIC_BASE_URL=http://127.0.0.1:8081/proxy/anthropic claude'
```

**Data flow**:

```
your input (Enter)
  → Claude Code SDK → http://127.0.0.1:8081/proxy/anthropic/v1/messages
  → gateway masks PII inside messages[]
  → masked payload → https://api.anthropic.com/v1/messages
  → streaming response flows back as-is
```

### Option 2: Claude Desktop — MCP server

| Tool | Description |
|---|---|
| `sanitize_text(text, mask_strategy)` | Detect + mask PII in a text. |
| `detect_language(text)` | Return ja / en / mixed. |
| `set_analyzer_config(...)` | Update analyzer chain. |
| `set_provider(provider_id)` | Switch default upstream provider. |
| `toggle_filter(enabled)` | Master on/off. |
| `get_runtime_config()` | Dump current config. |

<details>
<summary><b>Setup steps</b></summary>

1. Make the wrapper executable (first time only):
   ```bash
   chmod +x scripts/mcp-stdio.sh
   ```

2. Edit `claude_desktop_config.json`:
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`

   **WSL** (Claude Desktop runs on Windows, reaches into WSL via `wsl`):
   ```json
   {
     "mcpServers": {
       "pii-masking": {
         "command": "wsl",
         "args": ["bash", "/home/<user>/workspace/pii-masking/scripts/mcp-stdio.sh"]
       }
     }
   }
   ```

   **Mac / native Linux** (direct):
   ```json
   {
     "mcpServers": {
       "pii-masking": {
         "command": "/absolute/path/to/pii-masking/scripts/mcp-stdio.sh"
       }
     }
   }
   ```

3. Restart Claude Desktop → `sanitize_text` etc. appear in the tool list.

</details>

> 💡 Option 1 **always masks every request**; MCP masks **only when Claude calls the tool**. Pick 1 for "always safe", pick 2 for "on demand".

---

## 📦 Chrome Web Store build

`browser-extension/` is the **dev build** — it includes the local-LLM proxy, `http://*/*` host permission, and the options-page LLM config card. None of that is shipped to the Store.

Produce the Store distributable with:

```bash
./scripts/build-store.sh
# → dist/browser-extension-store/         (unpacked, Load unpacked OK)
# → dist/browser-extension-store.zip      (upload to Developer Dashboard)
```

The script:

1. Copies `browser-extension/` → `dist/browser-extension-store/`
2. Replaces `manifest.json` with `manifest.store.json` (no `http://*/*`, 6 chat-provider hosts only)
3. Deletes `engine/surrogates.js` + `engine/llm-prompts.js`
4. Strips every `STORE-STRIP:START … STORE-STRIP:END` block with `sed`
5. Validates: no `http://*/*` in manifest, no stray markers, no references to deleted files, valid JSON, every `.js` passes `node --check`
6. Zips for Developer Dashboard upload

See [browser-extension/README.md#building-the-chrome-web-store-variant](./browser-extension/README.md#building-the-chrome-web-store-variant) for details.

---

## 🧪 Tests

Tests run inside a Docker build stage — host installs nothing.

```bash
make test
# → docker build --target test --progress=plain -t pii-masking:test .
```

The `test` stage extends `builder`, adds dev deps (pytest / pytest-asyncio / ruff) + spaCy model + tesseract, then runs `uv run pytest tests/ -v`. **Any failing test fails the build**, so it works as-is for a CI gate.

---

## 🗂 Directory layout

```text
pii-masking/
├── browser-extension/          Chrome MV3 extension (dev build)
│   ├── manifest.json           dev manifest (http://*/*, full LLM engine)
│   ├── manifest.store.json     Web-Store manifest (LLM stripped)
│   ├── content.js              isolated-world bridge + LLM_FETCH routing
│   ├── injected.js             main-world fetch/XHR/WebSocket hooks
│   ├── sidebar.js              Shadow DOM sidebar UI
│   ├── review-modal.js         Shadow DOM review modal UI
│   ├── background.js           service worker (badge + per-tab count + LLM proxy)
│   ├── options.html/css/js     options page (allowlist, LLM config, UI mode)
│   ├── popup.html/css/js       toolbar popup
│   └── engine/                 standalone JS engine
│       ├── engine.js             sweep-line overlap resolver + pipeline
│       ├── patterns.js           BUILTIN_PATTERNS (regex presets)
│       ├── classification.js     label → classification
│       ├── categories.js         label → big category
│       ├── severity.js           label → severity tier + surface escalation
│       ├── ts-sudachi.js         mini Sudachi-like JP morphological analyzer
│       ├── force-mask.js         force_mask_keywords lock decider
│       ├── blocklist.js          DEFAULT_COMMON_NOUN_BLOCKLIST
│       ├── surrogates.js         (dev only) type-preserving fake values
│       ├── llm-prompts.js        (dev only) /no_think prompt + few-shot
│       └── bundle.js             UMD bundle
├── src/
│   ├── app/
│   │   ├── config.py
│   │   ├── main.py
│   │   ├── models/schemas.py
│   │   ├── routes/               admin.py / proxy.py / sanitize.py
│   │   └── services/
│   │       ├── masking_service.py
│   │       ├── analyzers/        base.py / presidio.py / sudachi.py / regex.py / presets.py
│   │       ├── category_map.py
│   │       ├── classification.py
│   │       ├── severity.py
│   │       ├── aggregation.py
│   │       ├── force_mask.py
│   │       ├── language_detection.py
│   │       ├── document_service.py
│   │       ├── ocr_service.py
│   │       ├── proxy_service.py
│   │       └── repositories.py
│   └── mcp_server/server.py
├── scripts/
│   ├── build-store.sh          Web-Store build pipeline
│   ├── install-autostart.sh    Linux/WSL2 gateway autostart
│   ├── install-autostart.ps1   Windows gateway autostart
│   ├── mcp-stdio.sh            MCP stdio wrapper (Docker-backed)
│   └── generate-icons.py       extension icon generator
├── tests/                      pytest suite
├── docs/                       requirements + design docs
├── docker-compose.yml
├── Dockerfile
├── pyproject.toml
├── uv.lock                     dependency lockfile (committed)
├── CHANGELOG.md                root CHANGELOG (gateway side)
├── TODO.md                     roadmap
└── README.md                   this file (Japanese)
```

---

<div align="center">

**Author**: [@Sna_FX](https://twitter.com/Sna_FX) — see [browser-extension/README.md](./browser-extension/README.md) and the [CHANGELOG](./browser-extension/CHANGELOG.md) for full history.

[⬆ back to TOC](#-table-of-contents)

</div>
