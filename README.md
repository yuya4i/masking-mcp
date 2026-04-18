<div align="center">

# 🛡️ PII Guard / `pii-masking`

**🇯🇵 日本語 (このページ)** ・ [**🇺🇸 English**](./README.en.md)

---

**生成 AI へ送信する前に、ローカル PC 上で個人情報を検出・マスクする軽量ゲートウェイ + Chrome 拡張機能**

Runs 100% locally. Zero network egress for detection. LAN-only for LLM augmentation.

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

## 🎯 3 行で言うと

1. **ブラウザ拡張 (Chrome MV3)** が Claude.ai / ChatGPT / Gemini / Manus の送信を横取りし、PII を検出。
2. **FastAPI ゲートウェイ (Docker)** が Presidio + SudachiPy + プリセット正規表現で判定 (オプション)。
3. **ローカル LLM (Ollama / LM Studio / llama.cpp)** が文脈考慮型の追加検出 + AI 置換モードを提供 (v0.5.0+)。

検出結果は送信直前にサイドバーでユーザー確認 → 確定したものだけマスク済みペイロードとして送信されます。**第三者サーバーには一切送信されません。**

> **📌 現在のリリース**: Chrome Web Store 公開版 `v1.0.1` (standalone-only) / dev ビルド `v0.5.1-dev` (local-LLM 対応)。
> 実装履歴は [CHANGELOG](./browser-extension/CHANGELOG.md)、ロードマップは [TODO.md](./TODO.md) を参照。

---

## 📖 目次

- [✨ 概要](#-概要)
- [🏗 アーキテクチャ](#-アーキテクチャ)
- [🎯 検出対象カタログ](#-検出対象カタログ)
- [🔐 ベンダー別 API キー検出](#-ベンダー別-api-キー検出-v050)
- [🛡 重要度 (severity) 分類](#-重要度-severity-分類)
- [🧹 一般名詞ブロックリスト](#-一般名詞ブロックリスト)
- [⚙️ セットアップ](#-セットアップ)
- [🚀 使い方 (Gateway API)](#-使い方-gateway-api)
- [🌐 ブラウザ拡張](#-ブラウザ拡張)
- [🧠 ローカル LLM 連携 (v0.5.0)](#-ローカル-llm-連携-v050)
- [🤖 Claude Code / Claude Desktop 連携](#-claude-code--claude-desktop-連携)
- [📦 Chrome Web Store 公開ビルド](#-chrome-web-store-公開ビルド)
- [🧪 テスト](#-テスト)
- [🗂 ディレクトリ構成](#-ディレクトリ構成)

---

## ✨ 概要

| レイヤ | 技術 | 責務 |
|---|---|---|
| **ブラウザ拡張** | Chrome MV3 / Shadow DOM / Service Worker | 送信インターセプト、サイドバー UI、LLM プロキシ |
| **ゲートウェイ (任意)** | FastAPI + Pydantic v2 + uv on Docker | Presidio / Sudachi / 正規表現の合成パイプライン |
| **MCP サーバ (任意)** | FastMCP (stdio) | Claude Desktop へ `sanitize_text` 等のツール提供 |
| **ローカル LLM (任意)** | Ollama / LM Studio / llama.cpp | 文脈考慮型 PII 検出 + AI 置換モード |

拡張はゲートウェイ不要でも動きます (**Standalone モード**)。ゲートウェイが `127.0.0.1:8081` で応答すれば自動的に併用 (**Hybrid**)。LLM を有効にすると拡張が Service Worker 経由で直接 Ollama を叩きます — **ゲートウェイも LLM もあなたのマシン/LAN から出ない**。

---

## 🏗 アーキテクチャ

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

**アナライザ構成** (全て実装済):

| アナライザ | 言語 | 役割 |
|---|---|---|
| **Presidio** | 英語中心 | `PERSON` / `EMAIL_ADDRESS` / `CREDIT_CARD` など固定カテゴリ |
| **SudachiPy** | 日本語 | 形態素解析で `名詞,固有名詞` のみ抽出 (一般名詞は素通し) |
| **RegexAnalyzer** | 両対応 | 社内 ID・API キー・住所・40+ カテゴリのプリセット |
| **ローカル LLM** | 両対応 | 文脈考慮型 PII 検出 (regex の安全網は残す) |

**アナライザ抽象化**: `Analyzer` Protocol (`src/app/services/analyzers/base.py`) で 3 種を統一。新規アナライザ (例: GiNZA) の追加は 1 ファイルで完結。

---

## 🎯 検出対象カタログ

デフォルトで以下のカテゴリが有効です (`enable_preset_patterns: true`)。カテゴリ単位で無効化する場合は `disabled_pattern_categories` に追加してください。

### 基本カテゴリ

| カテゴリ | entity_type | 検出例 | 検出元 |
|---|---|---|---|
| 人名 | `PERSON` / `PROPER_NOUN_PERSON` | 田中太郎、山田 | Presidio NER / Sudachi |
| メールアドレス | `EMAIL_ADDRESS` | user@example.com | Presidio |
| 電話番号 | `PHONE_NUMBER` | 090-1234-5678, 03-1234-5678 | Presidio / プリセット |
| **都道府県+市区町村** | **`PREFECTURE_CITY`** 🆕 | **兵庫県明石市 / 東京都渋谷区** | **プリセット正規表現** |
| 住所 (番地まで) | `ADDRESS` | 兵庫県明石市大久保町1丁目2番3号 | プリセット正規表現 |
| 年齢 | `AGE` | 35歳 | プリセット正規表現 |
| 性別 | `GENDER` | 男性 / 女性 | プリセット正規表現 |
| 会社名 | `COMPANY` | 株式会社マスクテスト | プリセット正規表現 |
| 金額 | `MONETARY_AMOUNT` | ¥15,000 / 100万円 | プリセット正規表現 |
| 日付 | `DATE` | 2024/01/15, 令和6年1月 | プリセット正規表現 |
| IP アドレス | `IP_ADDRESS` | 192.168.1.1 | プリセット正規表現 |
| URL | `URL` | https://example.com | プリセット正規表現 |
| マイナンバー | `MY_NUMBER` | 1234 5678 9012 | プリセット正規表現 |
| 口座番号 | `BANK_ACCOUNT` | 普通 1234567 | プリセット正規表現 |
| 免許証番号 | `DRIVERS_LICENSE` | 12-34-567890-12 | プリセット正規表現 |
| パスポート | `PASSPORT` | AB1234567 | プリセット正規表現 |
| DB 接続情報 | `DB_CONNECTION` | `postgresql://...` | プリセット正規表現 |
| API キー | `API_KEY` / `SECRET` | `sk-xxx`, `password=xxx` | [ベンダー別テーブル](#-ベンダー別-api-キー検出-v050) |
| 内部 ID | `INTERNAL_ID` | PRJ-001, EMP-12345 | プリセット正規表現 |
| クレジットカード | `CREDIT_CARD` | 4111-1111-1111-1111 | Presidio |
| 地名 | `LOCATION` / `PROPER_NOUN_LOCATION` | 東京、大阪 | Presidio / Sudachi |
| 組織名 | `PROPER_NOUN_ORG` | グーグル | Sudachi |

> 💡 **`PREFECTURE_CITY` と `ADDRESS` の使い分け**: 「兵庫県明石市」のような都道府県+市区町村単体は `PREFECTURE_CITY` として別カテゴリで検出されます。「兵庫県明石市大久保町1丁目2番3号」のように番地まで続く場合は `ADDRESS` 側が longer span を取って勝ちます (overlap resolver が自動で解決)。

<details>
<summary>📎 <b>ビジネス文書向け 15 カテゴリ (Milestone 8 Wave A)</b></summary>

| カテゴリ | entity_type | 検出対象 |
|---|---|---|
| 郵便番号 | `POSTAL_CODE` | `〒651-0087`, `123-4567` |
| 部署コード | `DEPARTMENT` | `DIV-101`, `部署コード: D-001` |
| 契約番号 | `CONTRACT_NUMBER` | `CONTRACT-ABC-001`, `契約番号: CT-2024-01` |
| 発注番号 / PO | `PURCHASE_ORDER` | `PO-1234567`, `発注番号: PO-9999` |
| 顧客 ID | `CUSTOMER_ID` | `CUST-0001`, `顧客ID: C-999` |
| 請求書番号 | `INVOICE_NUMBER` | `INV-20240415`, `請求番号: INV-12` |
| 社員 ID | `EMPLOYEE_ID` | `STAFF-00123`, `社員番号: E-0042` |
| 会員 ID | `MEMBER_ID` | `MEMBER-123456`, `会員ID: M-555` |
| 患者 ID | `PATIENT_ID` | `PATIENT-12345`, `患者ID: P-77` |
| 製品コード / SKU | `SKU` | `SKU-ABC-123`, `商品コード: X-77` |
| 血液型 | `BLOOD_TYPE` | `AB型`, `A型` |
| 年収 / 月収 | `ANNUAL_INCOME` | `年収1200万円`, `月収 40 万円` |
| 特許番号 | `PATENT_NUMBER` | `特許2024-123456`, `JP 1234567` |
| 資産番号 | `ASSET_NUMBER` | `ASSET-12345`, `資産番号: FA-999` |
| ライセンス番号 | `LICENSE_NUMBER` | `LIC-ABC-2024` |

プリセットは `src/app/services/analyzers/presets.py` で定義。漏洩傾向のある新カテゴリが判明するたびに順次拡張していく前提です。誤検知は `disabled_pattern_categories` もしくはブラウザ拡張のレビューモーダルで個別に解除してください。

</details>

---

## 🔐 ベンダー別 API キー検出 (v0.5.0+)

`API_KEY` カテゴリは汎用 `sk-*` / `pk_*` / `access_key_*` に加えて、**主要 SaaS の固定プレフィックストークンを直接認識**します。`browser-extension/engine/patterns.js` と `src/app/services/analyzers/presets.py` で同じ内容を保持 (両方を必ず同時に更新)。

<details>
<summary>📋 <b>対応ベンダー一覧 (30+ 種)</b></summary>

| Vendor | プレフィックス / フォーマット | 用途 |
|---|---|---|
| OpenAI | `sk-<32+>` / `sk-proj-...` / `sk-svcacct-...` / `sk-None-...` | プロジェクト/サービス/レガシー各種キー |
| Anthropic | `sk-ant-api03-<80+>` / `sk-ant-admin01-<80+>` | Claude API / Admin |
| Notion | `ntn_<40+>` / `secret_<43>` | Integration token (新/旧) |
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
| GitLab | `glpat-<20+>` / `glrt-<20+>` | Personal / Runner token |
| Mailgun | `key-<32 hex>` | Private API key |
| npm | `npm_<36>` | Automation / publishing |
| Fireworks AI | `fw_<24+>` | API key |
| Airtable | `pat<14>.<64 hex>` | Personal access token |
| Linear | `lin_api_<32+>` / `lin_oauth_<32+>` | API / OAuth |
| Figma | `figd_<40+>` | Personal access |
| Discord | `[MN][A-Za-z\d]{23}.<6>.<27+>` | Bot token |
| Cloudflare | `cf-<40+>` | API token |
| JWT | `eyJ...·eyJ...·...` | 三分割 base64url (Supabase 等) |
| HTTP header | `Bearer <16+>` / `X-Api-Key: ...` | リクエストヘッダ書式 |
| 証明書 | `-----BEGIN … PRIVATE KEY-----` | RSA / EC / OpenSSH / PGP / DSA |

</details>

これらは全て `entity_type` を `API_KEY` (PEM 鍵のみ `SECRET`) として出力し、[severity 分類](#-重要度-severity-分類) で **critical** 扱いです。サイドバーでは赤枠 + ロック、送信前に必ずユーザー確認が入ります。

ローカル LLM を有効にしている場合でも、これらの構造化トークンは **regex の安全網** として常に検出されます。

---

## 🛡 重要度 (severity) 分類

各検出には `category` (表示バケット) / `classification` (言語分類) に加えて **`severity`** (漏洩時の危険度) が付与されます。`src/app/services/severity.py` の `LABEL_TO_SEVERITY` がベース、`severity_for_surface(label, surface)` が **検出された実テキストを見て** 動的に tier を上げます。

| Severity | 対象ラベル (抜粋) | UI 色 | UI 挙動 |
|---|---|---|---|
| 🔴 `critical` | `MY_NUMBER`, `PASSPORT`, `DRIVERS_LICENSE`, `CREDIT_CARD`, `BANK_ACCOUNT`, `API_KEY`, `SECRET`, `DB_CONNECTION`, **+ 動的昇格** | rose `#e11d48` | `force_masked_categories` 由来のロック行のみ長押し (0–1.5s) 必要 |
| 🟠 `high` | `PHONE_NUMBER`, `ADDRESS`, `PATIENT_ID` | orange `#ea580c` | クリックで切替 |
| 🟡 `medium` | `LOCATION`, `PREFECTURE_CITY`, `EMPLOYEE_ID`, `MEMBER_ID`, `CUSTOMER_ID`, `CONTRACT_NUMBER`, `MONETARY_AMOUNT`, `URL`, `IP_ADDRESS` 他 | yellow `#ca8a04` | クリックで切替 |
| ⚪ `low` | `AGE`, `GENDER`, `DATE`, `BLOOD_TYPE`, `POSTAL_CODE`, `SKU`, `KATAKANA_NAME` | slate `#64748b` | クリックで切替 |

### Surface-aware 昇格ルール

`severity_for_surface(label, value)` は base severity を以下の規則で **critical に昇格** します (Python と JS Engine で同じ正規表現):

| ラベル | 昇格条件 | 例 |
|---|---|---|
| `PERSON` / `PROPER_NOUN_PERSON` | 常に critical | 「田中太郎」 |
| `ORGANIZATION` / `COMPANY` / `PROPER_NOUN_ORG` | surface に `株式会社` `㈱` `有限会社` `㈲` `合同会社` `合資会社` を含む | 「株式会社アクメ」「アクメ㈱」 |
| `EMAIL_ADDRESS` | surface が `user@host.tld` 形式 | `tanaka@acme.com` |

### PERSON 偽陽性フィルタ

Sudachi/Presidio は時折、敬語や業務表現 (例: 「ご注意くださいますようお願いいたします」) を `PROPER_NOUN_PERSON` と誤判定します。`is_false_positive_person(surface)` が以下の条件で **検出を完全に drop**:

- surface 長 > 6 文字 (実際の名前は 2–6 文字)
- かつ次のいずれかを含む: `ます` `ません` `ください` `いたします` `願い` `注意` `確認` `ご了承` `申し訳` `よろしく` `とおり` `ように` `については` `ところ` `ため` `こと` 等

カテゴリヘッダーは配下の子行の **最悪 severity** で塗られます (例: `PERSON` カテゴリに `API_KEY` が混ざっていれば critical 色)。`RuntimeConfig.default_uncheck_below` で「この重要度未満の行は初期状態で未チェックにする」閾値を設定できます (デフォルト `"low"` = 全行初期マスク)。

---

## 🧹 一般名詞ブロックリスト

Sudachi の `sudachidict_core` はカタカナの汎用ビジネス用語 (`プロジェクト` / `メンバー` / `チーム`) を稀に **固有名詞** とタグ付けします。`RuntimeConfig.common_noun_blocklist` に表面文字列を登録すると、**マスク処理の前段**で完全一致でドロップされます (大文字小文字区別・前方一致なし)。

デフォルトでは次の 26 語が登録されています:

```
プロジェクト, メンバー, チーム, マネージャー, リーダー, ユーザー,
クライアント, サーバー, システム, データ, ファイル, フォルダ,
フォルダー, レポート, ミーティング, タスク, チケット, スケジュール,
ドキュメント, アカウント, パスワード, メッセージ, スタッフ,
カスタマー, オフィス, ミーティングルーム
```

ブロックリストは `min_score` / `enabled_pii_classes` / `allow_entity_types` より **先** に適用されるため、たとえ別のアナライザが信頼度 1.0 で検出していてもドロップされます。用途例:

- **偽陽性の抑制** — 「プロジェクトαの進捗」のような一般語を恒常的に除外
- **安全装置** — 「東京」を追加して、位置情報の誤送を強制的にブロック

---

## ⚙️ セットアップ

> **🚨 前提**: `docker` と `docker compose` があれば host に Python / uv のインストールは不要です。

### ゲートウェイ起動 (全部まとめて)

```bash
cd /path/to/pii-masking
make up                        # build + 起動 + /health 待ち + admin_token 表示
make config                    # 認証済みで /admin/config を pretty-print
make logs                      # コンテナログを tail
make down                      # 停止 (data/ は保持)
make help                      # 全ターゲット一覧
```

`make up` は内部で `mkdir -p data && docker compose up -d --build` を行い、`/health` が 200 を返すまで最大 60 秒待機します。`.env` は **任意** で、`ADMIN_TOKEN` は初回リクエスト時に自動生成されて `data/admin_token` (mode 0600) に保存されます。

コード変更後は `make up` がそのまま `--build` を含むので毎回拾ってくれますが、レイヤキャッシュが壊れた気配があるときは `make rebuild` (`docker compose build --no-cache` のエイリアス) を使ってください。

```bash
TOKEN=$(cat data/admin_token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8081/admin/config
```

> 💡 初回ビルドは spaCy `en_core_web_lg` (~400 MB) の取得があるため数分かかります。2 回目以降はレイヤキャッシュが効きます。

### 自動起動 (OS ログイン時に gateway を起動)

Chrome 拡張はサンドボックスの制約で自身から Docker を起動できないため、**OS ログイン時に gateway を自動で立ち上げる仕組み** を用意しています。1 度実行すれば以降は自動。

<details>
<summary><b>Linux / WSL2</b></summary>

```bash
cd /path/to/pii-masking
bash scripts/install-autostart.sh
```

- **systemd user service** (`~/.config/systemd/user/mask-mcp-gateway.service`) を登録
- systemd が使えない環境 (WSL で `/etc/wsl.conf` の `systemd=true` 未設定など) では `~/.bashrc` フックに自動フォールバック
- 次回ログインから `docker compose up -d` が自動実行される
- container 自体は `restart: unless-stopped` なので Docker daemon 再起動にも追従
- 確認: `systemctl --user status mask-mcp-gateway`
- 削除: `bash scripts/install-autostart.sh --uninstall`

</details>

<details>
<summary><b>Windows (WSL + Docker Desktop 前提)</b></summary>

PowerShell (管理者権限不要) から:

```powershell
cd C:\Users\<you>\workspace\pii-masking
powershell -File scripts\install-autostart.ps1
```

- Windows タスクスケジューラに `MaskMcpGatewayAutostart` を登録
- ログイン時に `wsl -d <distro> -- bash -c "cd <repo> && docker compose up -d"` を実行
- 削除: `powershell -File scripts\install-autostart.ps1 -Uninstall`

</details>

拡張インストール後、gateway に届かない状態で popup を開くと **「Gateway が見つかりません」** が表示され、あなたの OS 向けの install コマンドがコピー可能な形で出ます。

### Standalone モード (Docker 不要)

`feat/serverless-engine-phase1` 以降、拡張機能に **pure-JavaScript の PII 検出エンジン** が同梱されています。Docker gateway を立ち上げなくても、regex ベースのプリセット (EMAIL / PHONE_NUMBER / POSTAL_CODE / MY_NUMBER / API_KEY / BLOOD_TYPE / ANNUAL_INCOME など 40+ カテゴリ) はブラウザ内でそのまま動きます。

| カテゴリ | Standalone (Phase 1) | Gateway (Phase 2 + Presidio) |
|---|---|---|
| 構造化 PII (email / phone / 郵便番号 / マイナンバー / API key / …) | ≒ 同等 | 同等 |
| 日本語固有名詞 (田中太郎、株式会社〇〇) | 部分 (COMPANY + KATAKANA_NAME のみ) | 高 (Sudachi 形態素) |
| 英語 PERSON / LOCATION / ORGANIZATION | 未対応 | 高 (Presidio NER) |

標準では **Hybrid モード** で動作し、gateway が `127.0.0.1:8081` で応答すれば gateway を使い、応答しなければ自動的に standalone エンジンへフォールバックします。

---

## 🚀 使い方 (Gateway API)

ゲートウェイは `docker compose up -d` で起動済みの前提です。

### 1. テキスト単体のマスキング

```bash
curl -X POST http://127.0.0.1:8081/sanitize/text \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d '{"text": "John Doe lives at 1 Main St. Email john@example.com"}'
```

### 2. 検出結果のテーブル表示

`sanitize/text` / `sanitize/file` のレスポンス `detections` は以下のカラムを持つので、どのクライアントでもそのままテーブル描画できます。

| カラム | 意味 |
|---|---|
| `entity_type` | Presidio / Sudachi / プリセットが付けたラベル |
| `start` / `end` | 元テキスト中の文字オフセット |
| `line` / `column` | 1 始まりの行・列 (PDF やログ参照時の目印) |
| `text` | 元テキストの該当部分 |
| `context_before` / `context_after` | 前後 ~20 文字のスニペット |
| `score` | Presidio の確信度 (0.0–1.0) |
| `action` | `masked` (置換済) または `allowed` (pass-through) |

### 3. OpenAI / Claude / Manus へ転送 (MITM パススルー)

ゲートウェイは **純粋な MITM** として動作するため、クライアントは自分でプロバイダ宛の認証ヘッダ (OpenAI なら `Authorization: Bearer ...`、Anthropic なら `x-api-key: ...`) を付与します。ゲートウェイ側には API キーを置きません。

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
<summary><b>4. 日本語 (Sudachi) 固有名詞マスキング</b></summary>

`RuntimeConfig.morphological_analyzer` を `"sudachi"` に切り替えると、SudachiPy による形態素解析が Presidio にアドオンされ、`("名詞","固有名詞",...)` のみが `PROPER_NOUN_PERSON` / `PROPER_NOUN_LOCATION` / `PROPER_NOUN_ORG` としてマスキング対象に加わります。

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

期待レスポンス (抜粋):

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
<summary><b>5. 言語別アナライザ振り分け + 正規表現カスタム検出</b></summary>

長文の英語と日本語が混在するワークロードでは、`RuntimeConfig.analyzers_by_language` で **入力テキストの CJK 比率で振り分け** できます。加えて、社内 ID や案件コードのように定型カテゴリで拾えない業務固有パターンには、**`RegexAnalyzer` によるカスタム正規表現** を 1 本の分析器として追加できます。

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

### 6. 集約 (aggregated) エンドポイント

`POST /v1/extension/sanitize/aggregated` — 同じテキストが複数回出現する場合、サイドバー UI 側で `田中太郎 (2件)` のように 1 行で表示できるように集約されたレスポンスを返します。

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

`force_masked_categories` は `RuntimeConfig.force_mask_keywords` (既定: `["リーク","未公開","機密","confidential","leak"]`) が原文内に名詞として現れた場合にロックされる大分類名の配列です。

---

## 🌐 ブラウザ拡張

Claude Code の `ANTHROPIC_BASE_URL` 経由のマスクは **Anthropic API を叩く Claude Code / SDK** に閉じています。Web 版 Claude.ai / ChatGPT / Gemini / Manus のチャット UI は SDK を介さず直接ブラウザから fetch を投げるため、`BASE_URL` ではカバーできません。そこで用意したのが `browser-extension/` の **Chrome MV3 拡張** です。

| | `ANTHROPIC_BASE_URL` 方式 | ブラウザ拡張方式 |
|---|---|---|
| 対象 | Claude Code / Anthropic SDK を使うプロセス | Web ブラウザの AI チャット UI |
| カバー範囲 | Anthropic 1 プロバイダ | Claude.ai / ChatGPT / Gemini / Manus |
| 動作原理 | HTTP プロキシ (MITM) | `window.fetch` / `XHR.send` の monkey-patch |
| 認証 | 不要 (クライアントの API キーをパススルー) | なし (ループバック信頼モデル) |
| 追加エンドポイント | 既存 `/proxy/*` | 新規 `POST /v1/extension/sanitize` |

**インストール**: `make up` でゲートウェイを起動した後、`chrome://extensions` → Developer mode → Load unpacked → `browser-extension/` を選択するだけ。詳細手順は [browser-extension/README.md](./browser-extension/README.md)。

### インタラクティブ・レビュー (デフォルト ON)

ゲートウェイの検出結果を送信直前に **Shadow DOM** パネルで表示し、誤検知 (「プロジェクト」や「会社」がカタカナ名ヒューリスティックに巻き込まれた等) はチェックを外して元テキストのまま送信できます。Enter で確定、Esc でキャンセル (送信自体を中止)。

### UI モード

| モード | 動作 | エンドポイント |
|---|---|---|
| **サイドバー (デフォルト)** | 画面右側に固定パネル。同じ文字列の重複は `田中太郎 (2件)` のように 1 行へ集約 + カテゴリ折り畳み + 一括 ON/OFF + リアルタイムプレビュー。`機密` / `リーク` などのキーワードを含む場合は `force_mask_categories` に属するカテゴリが 🔒 ロックされる | `POST /v1/extension/sanitize/aggregated` |
| **モーダル (従来)** | Phase 2 と同じ中央モーダル。1 検出 = 1 行の per-occurrence 表示 | `POST /v1/extension/sanitize` |

### サイドバー UX ハイライト

| 機能 | 説明 |
|---|---|
| **Push + Shrink レイアウト** | sidebar はチャットに被らず `<body>` 直下の flex sibling として並ぶ。`min(400px, 50vw)` でビューポートに追従 |
| **独立スタッキング** | `position: relative` + `z-index: 2147483647` + `isolation: isolate`。ホストの sticky/fixed 要素がサイドバー上に漏れない |
| **モードピル** (ヘッダー右) | `AI 置換 (実験的)` / `検出補助 (Regex + AI)` / `Regex のみ` を色分け表示 |
| **テーマ自動同期** | `getComputedStyle` でホスト背景色を検出、輝度 < 0.5 で dark palette 適用 |
| **Severity フィルタタブ** | `All` `Critical` `High` `Medium` `Low` のセグメントコントロール |
| **操作ルール** (v0.5.0 確定) | **長押しは critical 行がマスク中のときだけ**。他はワンタップでマスク/解除 |
| **Before/After 縦列揃え** | 4 列グリッド `[icon] [変更前] [→] [変更後]`。長値は `text-overflow: ellipsis` で切詰 |
| **緑バー** (右側) | マスク OFF 行の右端に 4px 緑バー = 「この値はそのまま送信される」の視覚マーカー |
| **除外ボタン** | 各行に `✖ 除外` → `chrome.storage.local.maskAllowlist` に永続登録 |
| **出現回数表示** | 行 2 行目に `出現回数 N回` と明示 |
| **AI 分析中オーバーレイ** | LLM 有効時、サイドバー中央に二重リング大型スピナー + 「✨ AI 分析中…」。完了後に行が stagger-in (80ms × index) |
| **AI 検出バッジ** | LLM 検出行は `✨` アイコン (紫パルス) + 2 行目に `● AI 検出` 紫グラデピル |
| **ユニーク番号タグ** (replace モード) | 同じ値は同じタグ、異なる値は異なる番号 (`<name_1>`, `<company_2>`…) — 1:1 復元可能マッピング |

### マスキング除外データベース (allowlist)

`chrome://extensions` → 拡張アイコン右クリック → 「オプション」、もしくはポップアップの「⚙ 詳細設定」ボタンで開く `options.html` で管理:

- 値の追加・削除・全削除
- JSON エクスポート (タイムスタンプ付き) / JSON インポート (重複自動マージ)
- マスキング有効/無効、interactive、UI mode、Gateway 疎通ステータス
- ダークモード自動追従

**クロスタブ即時反映**: 一方のタブで除外リストに追加すると、`chrome.storage.onChanged` → `content.js` → `injected.js` → `mask-mcp:settings-updated` CustomEvent → 開いている全タブのサイドバーが該当行を即座に unmask。リロード不要。

### Socket.IO (WebSocket) 対応

manus.im など Socket.IO over WebSocket を使うサービスは `fetch` / `XHR` を経由しないため、専用フックで対応:

1. `injected.js` の `WebSocket.prototype.send` を wrap
2. Engine.IO v4 EVENT フレーム (`42[...]` / `4213[...]`) をパース
3. `["message", {type:"user_message", contents:[{type:"text", value:"..."}]}]` の `value` フィールドのみマスキング適用
4. ping / pong / CONNECT / DISCONNECT / ACK は素通し
5. ユーザーキャンセル時はそのフレームのみ silent drop (WebSocket は閉じない = chat session 維持)

> **🔐 Security**: WebSocket URL に含まれる JWT (manus は `?token=...` で認証) は LOG 出力時に `token` `auth` `key` `sentry_key` 等を `REDACTED` に置換します。診断ログから session 認証情報が漏れない設計。

---

## 🧠 ローカル LLM 連携 (v0.5.0)

ゲートウェイ不要で、**ブラウザ拡張 + 手元の Ollama (または LM Studio / llama.cpp)** だけで文脈考慮型の PII 検出を追加できます。

| モード | 動作 |
|---|---|
| `Regex のみ` | LLM 無しの従来挙動 |
| `検出補助 (Regex + AI)` | LLM が contextual PII を追加、同じ surface は LLM ラベルで上書き。regex は構造化 PII の安全網として残る |
| `AI 置換 (実験的)` | LLM が本文全体を `<tag_N>` プレースホルダーに書き換え、送信先 AI サービスに原文が届かない |

### 最小構成

```bash
# 1) Ollama を CORS 許可付きで起動 (拡張は chrome-extension:// origin を使うため必須)
docker run -d --name ollama --gpus all \
  -e OLLAMA_HOST='0.0.0.0:11434' \
  -e OLLAMA_ORIGINS='*' \
  -p 11434:11434 \
  -v ollama:/root/.ollama \
  --restart unless-stopped \
  ollama/ollama:latest

# 2) モデルを pull (日本語軽量なら qwen3:1.7b、精度重視なら qwen3:4b)
docker exec -it ollama ollama pull qwen3:4b

# 3) 拡張の「⚙ 詳細設定」から
#    - ローカル LLM 連携を有効化
#    - URL に http://localhost:11434
#    - 接続確認 → モデルを選択
```

### アーキテクチャ要点

- **Service Worker がプロキシ**: Chrome の Private Network Access (PNA) ポリシーは HTTPS ページから `http://localhost` への fetch をブロックするため、LLM コールは全て特権コンテキストである service worker に `LLM_FETCH` メッセージで委譲
- **Host-lock**: service worker は `chrome.storage.local.localLlmUrl` とホスト/プロトコルが一致する URL 以外を拒否。任意の HTTP プロキシとしては使えない
- **Sender-ID 検証**: foreign extension から SW への中継は `sender.id !== chrome.runtime.id` で弾かれる
- **`think: false` + `format: "json"`**: Ollama API リクエストに 3 つの必須パラメータ — `think: false` (Qwen3 系の思考トークン抑止)、`format: "json"` (JSON grammar 制約)、`num_predict: 2048` (生成上限)
- **多段リトライ**: `500/503 "loading model"` → 最大 6 回 × 3s、`AbortError` → 最大 2 回 × 2s。inner bridge budget = `timeoutMs × 3 + 30s` で全リトライをカバー
- **ユニーク番号タグ**: replace モードの出力を `<name_1>`, `<company_2>`, `<hospital_1>` のような 1:1 マッピングで正規化
- **Fail-closed on replace / Fail-open on detect**: `AI 置換` は 1 件でも失敗で outbound 全体 abort、`検出補助` は LLM がタイムアウトしても regex/Sudachi のみで継続

### 推奨モデル (v0.5.0+)

| Model | Size | VRAM | Badge |
|---|---|---|---|
| `qwen3:1.7b` | 1.1 GB | ~1.5 GB | 軽量 |
| `qwen3:4b` | 2.5 GB | ~3 GB | **推奨** |
| `qwen3:8b` | 4.7 GB | ~5 GB | 高精度 |
| `qwen3:14b` | 8.2 GB | ~9 GB | 最高精度 |
| `gemma3:4b` | 2.5 GB | ~3 GB | 代替 |
| `llama3.2:3b` | 2.0 GB | ~2 GB | 代替 |
| `phi3.5:3.8b` | 2.2 GB | ~2.5 GB | 代替 |

オプション画面から **ワンクリック ダウンロード** (`POST /api/pull` ストリーミング NDJSON で進捗バー付き) / **ワンクリック 削除** (`DELETE /api/delete`) が可能。

### 既知の制約

| 症状 | 原因 | 対処 |
|---|---|---|
| 403 (CORS) が返る | Ollama の `OLLAMA_ORIGINS` 未設定 | docker-compose に `OLLAMA_ORIGINS: "*"` を追加。オプション画面の「接続確認」が自動検知して remediation alert を表示 |
| コールドスタートで遅い | 4B+ モデルは初回 20–40s、9B+ thinking は 60–90s | タイムアウトを 120000ms (デフォルト) ~ 240000ms で調整 |
| LLM が `エンジニア` 等を検出 | モデル側の過検出 | プロンプト `HARD NEGATIVE LIST` + クライアント `LLM_DENYLIST` / `LLM_DENY_REGEX` |
| 検出結果が出ない (Qwen3) | 旧実装で `think: true` デフォルトがトークン budget を消費 | 現行は `think: false` 明示。リロードで解消 |

詳細は [browser-extension/README.md#local-llm-proxy-v050-experimental](./browser-extension/README.md#local-llm-proxy-v050-experimental) を参照。

---

## 🤖 Claude Code / Claude Desktop 連携

### 方法 1: Claude Code — `ANTHROPIC_BASE_URL` (ストリーミング対応)

```bash
make up
ANTHROPIC_BASE_URL=http://127.0.0.1:8081/proxy/anthropic claude

# 恒常化するなら .bashrc / .zshrc に alias
alias claude-safe='ANTHROPIC_BASE_URL=http://127.0.0.1:8081/proxy/anthropic claude'
```

**データフロー**:

```
あなたの入力 (Enter)
  → Claude Code SDK → http://127.0.0.1:8081/proxy/anthropic/v1/messages
  → ゲートウェイが messages[] 内の PII をマスク
  → マスク済みペイロードを https://api.anthropic.com/v1/messages に転送
  → ストリーミング応答がそのままパススルーで返る
```

### 方法 2: Claude Desktop — MCP サーバ登録

| ツール | 説明 |
|---|---|
| `sanitize_text(text, mask_strategy)` | テキストの PII を検出してマスク |
| `detect_language(text)` | ja / en / mixed 判定 |
| `set_analyzer_config(...)` | アナライザ設定を変更 |
| `set_provider(provider_id)` | 転送先プロバイダを切替 |
| `toggle_filter(enabled)` | フィルタ ON/OFF |
| `get_runtime_config()` | 現在の設定を取得 |

<details>
<summary><b>設定手順</b></summary>

1. **ラッパースクリプトに実行権限を付与** (初回のみ):
   ```bash
   chmod +x scripts/mcp-stdio.sh
   ```

2. **`claude_desktop_config.json` に追加**
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`

   **WSL の場合** (Claude Desktop は Windows 側で動作するため `wsl` 経由):
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

   **Mac / ネイティブ Linux** (直接実行):
   ```json
   {
     "mcpServers": {
       "pii-masking": {
         "command": "/absolute/path/to/pii-masking/scripts/mcp-stdio.sh"
       }
     }
   }
   ```

3. **Claude Desktop を再起動** すると、ツール一覧に `sanitize_text` 等が現れます。

</details>

> 💡 方法 1 (Base URL) は **全リクエストを自動マスク**、MCP は **Claude がツールを呼ぶタイミングでだけマスク**。「必ずマスクしたい」なら方法 1、「必要なときだけ」なら方法 2。

---

## 📦 Chrome Web Store 公開ビルド

`browser-extension/` は **dev ビルド** — ローカル LLM プロキシ、`http://*/*` host permission、options ページの LLM 設定カードが含まれます。Store には一切出ない設計です。

Store 向けの配布物は `scripts/build-store.sh` で生成:

```bash
./scripts/build-store.sh
# → dist/browser-extension-store/         (unpacked, Load unpacked 可能)
# → dist/browser-extension-store.zip      (Developer Dashboard アップロード用)
```

ビルドスクリプトの処理:

1. `browser-extension/` → `dist/browser-extension-store/` にコピー
2. `manifest.json` を `manifest.store.json` に置換 (`http://*/*` なし、6 chat-provider ホストのみ)
3. `engine/surrogates.js` + `engine/llm-prompts.js` を削除
4. `STORE-STRIP:START … STORE-STRIP:END` ブロックを `sed` で除去
5. 検証: `http://*/*` が manifest に残っていない、marker が残っていない、削除ファイルへの参照なし、manifest が JSON valid、全 `.js` が `node --check` を通る
6. Store Dashboard 用に zip 化

詳細は [browser-extension/README.md#building-the-chrome-web-store-variant](./browser-extension/README.md#building-the-chrome-web-store-variant)。

---

## 🧪 テスト

テストは Docker のビルドステージで走らせます。host に何もインストールする必要はありません。

```bash
make test
# 内部で: docker build --target test --progress=plain -t pii-masking:test .
```

`Dockerfile` の `test` ステージは `builder` を引き継ぎ、dev 依存 (pytest / pytest-asyncio / ruff) と spaCy モデル、tesseract を追加してから `uv run pytest tests/ -v` を実行します。**どれか 1 本でもテストが落ちるとビルドが失敗する** ので、CI ゲートとしてそのまま使えます。

---

## 🗂 ディレクトリ構成

```text
pii-masking/
├── browser-extension/          Chrome MV3 拡張 (dev ビルド)
│   ├── manifest.json           dev manifest (http://*/*, LLM engine files 全部入り)
│   ├── manifest.store.json     Web Store 配布用 manifest (LLM 関連なし)
│   ├── content.js              isolated-world bridge + LLM_FETCH ルーティング
│   ├── injected.js             main-world fetch/XHR/WebSocket フック
│   ├── sidebar.js              Shadow DOM サイドバー UI
│   ├── review-modal.js         Shadow DOM レビューモーダル UI
│   ├── background.js           service worker (badge + per-tab count + LLM proxy)
│   ├── options.html/css/js     設定ページ (allowlist, LLM 設定, UI モード)
│   ├── popup.html/css/js       ツールバー popup
│   └── engine/                 standalone JS engine
│       ├── engine.js             sweep-line overlap resolver + pipeline
│       ├── patterns.js           BUILTIN_PATTERNS (regex プリセット)
│       ├── classification.js     label → classification (contact / identifier / ...)
│       ├── categories.js         label → big category (PERSON / LOCATION / ...)
│       ├── severity.js           label → severity tier + surface-aware 昇格
│       ├── ts-sudachi.js         mini Sudachi-like 日本語形態素解析
│       ├── force-mask.js         force_mask_keywords ロック判定
│       ├── blocklist.js          DEFAULT_COMMON_NOUN_BLOCKLIST
│       ├── surrogates.js         (dev only) 型保存 fake values
│       ├── llm-prompts.js        (dev only) /no_think system prompt + few-shot
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
│   ├── build-store.sh          Web Store ビルドパイプライン
│   ├── install-autostart.sh    Linux/WSL2 gateway autostart
│   ├── install-autostart.ps1   Windows gateway autostart
│   ├── mcp-stdio.sh            MCP stdio ラッパー (Docker 経由起動)
│   └── generate-icons.py       拡張アイコン生成
├── tests/                      pytest スイート
├── docs/                       要件定義・設計ドキュメント
├── docker-compose.yml
├── Dockerfile
├── pyproject.toml
├── uv.lock                     依存ロック (repo にコミット)
├── CHANGELOG.md                ルート CHANGELOG (ゲートウェイ側)
├── TODO.md                     ロードマップ
└── README.md                   このファイル
```

---

<div align="center">

**作者**: [@Sna_FX](https://twitter.com/Sna_FX) — 詳細は [browser-extension/README.md](./browser-extension/README.md) と [CHANGELOG](./browser-extension/CHANGELOG.md) を参照

[⬆ 目次に戻る](#-目次)

</div>
