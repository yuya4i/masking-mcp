# pii-masking (旧 local-mask-mcp / mask-mcp)

`pii-masking` は、生成AIへ送信する前にローカルPC上で個人情報を検出・マスクするための軽量ゲートウェイ + Chrome 拡張機能です。MCP対応クライアント向けのツール提供と、OpenAI、Claude、Manus、その他プロバイダ向けのローカルHTTPプロキシ、ブラウザ UI 上の対話的レビュー機能を統合しています。

> **リポジトリ名の変遷**: `local-mask-mcp` → `mask-mcp` → `pii-masking`。Git remote の旧 URL (`masking-mcp.git`) は新しい URL (`pii-masking.git`) に redirect されます。

> **ロードマップ**: 実装中 / 予定している機能一覧は [TODO.md](./TODO.md) を参照してください。直近のフォーカスは **(1) WebSocket チャット (Socket.IO) のマスキング**、**(2) 個人運用向けマスキング除外データベース**、**(3) サイドバー UX のモダン化**、**(4) v0.5.0 ローカル LLM (Ollama / LM Studio / llama.cpp) 連携** です。

> **v0.5.0 dev**: `feat/local-llm-proxy-v0.5.0` ブランチで進行中の「拡張機能内で完結する Ollama 連携」。サイドバー裏で LLM が文脈考慮検出を並行実行し、サイドバー冒頭の *LLM 分析中…* バナーで進捗を可視化します。LLM が検出した surface は regex/Sudachi 結果を上書き、regex は構造化 PII の安全網として残ります。詳細は [browser-extension/README.md#local-llm-proxy-v050-experimental](./browser-extension/README.md#local-llm-proxy-v050-experimental) を参照。

## アーキテクチャ概要

本プロジェクトは、`FastAPI` によるローカル常駐サービスを中核にし、**複数のアナライザを合成できるマスキングパイプライン** + `pytesseract` による OCR + `FastMCP` による MCP ツール提供を行う雛形です。

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

アナライザの現状と予定:

- **Presidio** (実装済み): 英語中心の NER + 正規表現。`PERSON` / `EMAIL_ADDRESS` / `CREDIT_CARD` など固定カテゴリで検出する `entity_types` 指定に対応。
- **SudachiPy 固有名詞抽出** ([feat/sudachi-analyzer](./TODO.md#milestone-1--japanese-proper-noun-masking-mvp) で追加予定): 日本語形態素解析により **POS = 名詞,固有名詞** のトークンのみを検出対象にする。カテゴリに縛られず、人名・地名・組織名・商品名を一括でマスクできる。一般名詞 (名詞,一般) は意図的に除外。
- **カスタム正規表現レコグナイザー** (Milestone 2): 社内 ID・プロジェクトコードなど業務固有パターン。
- **アナライザ抽象化** (Milestone 2): `Analyzer` プロトコルで 3 つを統一し、`MaskingService` は合成チェーンのみを持つ。

設定は JSON、監査ログは JSON Lines で保持します。外部 AI への転送は **pure MITM パススルー** で、プロバイダごとの認証ヘッダはクライアントがそのまま送る方式です (`PASSTHROUGH_HEADER_MAPPING`)。

## 検出チェックリスト

デフォルトで以下のカテゴリが有効です (`enable_preset_patterns: true`)。
カテゴリ単位で無効化する場合は `disabled_pattern_categories` に追加してください。

| カテゴリ | entity_type | 検出対象 | 検出元 |
|---|---|---|---|
| 人名 | PERSON / PROPER_NOUN_PERSON | 田中太郎、山田 | Presidio NER / Sudachi 固有名詞 |
| メールアドレス | EMAIL_ADDRESS | user@example.com | Presidio |
| 電話番号 | PHONE_NUMBER | 090-1234-5678, 03-1234-5678 | Presidio / プリセット正規表現 |
| 住所 | ADDRESS | 兵庫県明石市大久保町 | プリセット正規表現 |
| 年齢 | AGE | 35歳 | プリセット正規表現 |
| 性別 | GENDER | 男性 / 女性 | プリセット正規表現 |
| 会社名 | COMPANY | 株式会社マスクテスト | プリセット正規表現 |
| 金額 | MONETARY_AMOUNT | ¥15,000 / 100万円 | プリセット正規表現 |
| 日付 | DATE | 2024/01/15, 令和6年1月 | プリセット正規表現 |
| IPアドレス | IP_ADDRESS | 192.168.1.1 | プリセット正規表現 |
| URL | URL | https://example.com | プリセット正規表現 |
| マイナンバー | MY_NUMBER | 1234 5678 9012 | プリセット正規表現 |
| 口座番号 | BANK_ACCOUNT | 普通 1234567 | プリセット正規表現 |
| 免許証番号 | DRIVERS_LICENSE | 12-34-567890-12 | プリセット正規表現 |
| パスポート | PASSPORT | AB1234567 | プリセット正規表現 |
| DB接続情報 | DB_CONNECTION | postgresql://... / DB_NAME=mydb | プリセット正規表現 |
| APIキー | API_KEY / SECRET | sk-xxx, password=xxx | プリセット正規表現 |
| 内部ID | INTERNAL_ID | PRJ-001, EMP-12345 | プリセット正規表現 |
| クレジットカード | CREDIT_CARD | 4111-1111-1111-1111 | Presidio |
| 地名 | LOCATION / PROPER_NOUN_LOCATION | 東京、大阪 | Presidio / Sudachi 固有名詞 |
| 組織名 | PROPER_NOUN_ORG | グーグル | Sudachi 固有名詞 |

プリセットは `src/app/services/analyzers/presets.py` で定義されています。`enable_preset_patterns: false` に設定すると全てのプリセットパターンが無効化されます。特定カテゴリだけを無効化するには `disabled_pattern_categories` に対象のキーを追加してください (例: `["URL", "DATE"]`)。

## ビジネスドキュメント向けプリセット

Milestone 8 Wave A で追加した、日常の業務書類で漏れやすい識別子カテゴリ 15 種 (`src/app/services/analyzers/presets.py` — `BUILTIN_PATTERNS` に追記)。

| カテゴリ | entity_type | 検出対象 |
|---|---|---|
| 郵便番号 | POSTAL_CODE | `〒651-0087`, `123-4567` |
| 部署コード | DEPARTMENT | `DIV-101`, `部署コード: D-001` |
| 契約番号 | CONTRACT_NUMBER | `CONTRACT-ABC-001`, `契約番号: CT-2024-01` |
| 発注番号 / PO | PURCHASE_ORDER | `PO-1234567`, `発注番号: PO-9999` |
| 顧客ID | CUSTOMER_ID | `CUST-0001`, `顧客ID: C-999` |
| 請求書番号 | INVOICE_NUMBER | `INV-20240415`, `請求番号: INV-12` |
| 社員ID | EMPLOYEE_ID | `STAFF-00123`, `社員番号: E-0042` |
| 会員ID | MEMBER_ID | `MEMBER-123456`, `会員ID: M-555` |
| 患者ID | PATIENT_ID | `PATIENT-12345`, `患者ID: P-77` |
| 製品コード / SKU | SKU | `SKU-ABC-123`, `商品コード: X-77` |
| 血液型 | BLOOD_TYPE | `AB型`, `A型` |
| 年収 / 月収 | ANNUAL_INCOME | `年収1200万円`, `月収 40 万円` |
| 特許番号 | PATENT_NUMBER | `特許2024-123456`, `JP 1234567` |
| 資産番号 | ASSET_NUMBER | `ASSET-12345`, `資産番号: FA-999` |
| ライセンス番号 | LICENSE_NUMBER | `LIC-ABC-2024` |

これらも `enable_preset_patterns=false` で一括無効化、または `disabled_pattern_categories` で個別に無効化できます。プリセットは 漏洩傾向のある新カテゴリが判明するたびに **順次拡張** していく前提で作られています — 正規表現の誤検知は `disabled_pattern_categories` もしくはブラウザ拡張のレビューモーダルで個別に解除してください。

## 重要度 (severity) 分類

各検出には `category` (表示バケット) / `classification` (言語分類) に加えて、**`severity`** (漏洩時の危険度) が付与されます。`src/app/services/severity.py` の `LABEL_TO_SEVERITY` がベース、`severity_for_surface(label, surface)` が **検出された実テキストを見て** 動的に tier を上げます。UI はこの値を元に左ボーダー色・カテゴリヘッダー色・長押しゲートを切り替えます。

| Severity | 対象ラベル (抜粋) | UI 色 | UI 挙動 |
|---|---|---|---|
| `critical` | `MY_NUMBER`, `PASSPORT`, `DRIVERS_LICENSE`, `CREDIT_CARD`, `BANK_ACCOUNT`, `API_KEY`, `SECRET`, `DB_CONNECTION`, **+ 動的昇格 (下表参照)** | rose `#e11d48` | 通常はクリックで切替。`force_masked_categories` 由来のロック行のみ長押し (スライダー 0–1.5s) 必要 |
| `high` | `PHONE_NUMBER`, `ADDRESS`, `PATIENT_ID` | orange `#ea580c` | クリックで切替 |
| `medium` | `LOCATION`, `EMPLOYEE_ID`, `MEMBER_ID`, `CUSTOMER_ID`, `CONTRACT_NUMBER`, `INVOICE_NUMBER`, `MONETARY_AMOUNT`, `URL`, `IP_ADDRESS` 他 | yellow `#ca8a04` | クリックで切替 |
| `low` | `AGE`, `GENDER`, `DATE`, `BLOOD_TYPE`, `POSTAL_CODE`, `SKU`, `KATAKANA_NAME`, 未マップラベル | slate `#64748b` | クリックで切替 |

### Surface-aware 昇格ルール

`severity_for_surface(label, value)` は base severity を以下の規則で **critical に昇格** します (Python と JS Engine で同じ正規表現):

| ラベル | 昇格条件 | 例 |
|---|---|---|
| `PERSON` / `PROPER_NOUN_PERSON` | 常に critical | 「田中太郎」 |
| `ORGANIZATION` / `COMPANY` / `PROPER_NOUN_ORG` | surface に `株式会社` `㈱` `有限会社` `㈲` `合同会社` `合資会社` を含む | 「株式会社アクメ」「アクメ㈱」 |
| `EMAIL_ADDRESS` | surface が `user@host.tld` 形式 (ドメイン付き) | `tanaka@acme.com` |

### PERSON 偽陽性フィルタ

Sudachi/Presidio は時折、敬語や業務表現 (例: 「ご注意くださいますようお願いいたします」) を `PROPER_NOUN_PERSON` と誤判定します。これを防ぐため `is_false_positive_person(surface)` が以下の条件で **検出を完全に drop** します:

- surface 長 > 6 文字 (実際の名前は 2–6 文字)
- かつ次のいずれかを含む: `ます` `ません` `ください` `いたします` `願い` `注意` `確認` `ご了承` `申し訳` `よろしく` `とおり` `ように` `については` `ところ` `ため` `こと` 等

カテゴリヘッダーは配下の子行の **最悪 severity** で塗られます (例: `PERSON` カテゴリに `API_KEY` が混ざっていれば critical 色)。`RuntimeConfig.default_uncheck_below` で「この重要度未満の行は初期状態で未チェックにする」閾値を設定できます (デフォルト `"low"` = 全行初期マスク)。

## 一般名詞ブロックリスト

Sudachi の `sudachidict_core` はカタカナの汎用ビジネス用語 (`プロジェクト` / `メンバー` / `チーム` など) を稀に **固有名詞** とタグ付けします。`RuntimeConfig.common_noun_blocklist` に表面文字列を登録しておくと、**マスク処理の前段** で完全一致でドロップされます (大文字小文字区別・前方一致なし)。

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
- **安全装置** — 「東京」を追加して、位置情報の誤送を強制的にブロック (検出ラベルが PROPER_NOUN_LOCATION でもドロップされる)

### 集約 (aggregated) エンドポイント

`POST /v1/extension/sanitize/aggregated` — 同じテキストが複数回出現する場合、サイドバー UI 側で `田中太郎 (2件)` のように 1 行で表示できるように集約されたレスポンスを返します。オリジナルの `POST /v1/extension/sanitize` は後方互換のため従来通り per-detection 形式で返します。

レスポンス例:

```json
{
  "original_text": "リーク情報: 田中太郎の年収1200万円。",
  "aggregated": [
    {
      "value": "田中太郎",
      "label": "PROPER_NOUN_PERSON",
      "category": "PERSON",
      "count": 1,
      "positions": [[6, 10]],
      "masked": true
    }
  ],
  "audit_id": "...",
  "force_masked_categories": ["PERSON", "ORGANIZATION", "FINANCIAL"]
}
```

`force_masked_categories` は `RuntimeConfig.force_mask_keywords` (既定: `["リーク","未公開","機密","confidential","leak"]`) が原文内に名詞として現れた (Sudachi POS 判定) 場合にロックされる大分類名の配列です。

## ディレクトリ構成

```text
local-mask-mcp/
├── docs/
│   └── requirements_and_design.md
├── src/
│   ├── app/
│   │   ├── config.py
│   │   ├── main.py
│   │   ├── models/
│   │   │   └── schemas.py
│   │   ├── routes/
│   │   │   ├── admin.py
│   │   │   ├── proxy.py
│   │   │   └── sanitize.py
│   │   └── services/
│   │       ├── document_service.py
│   │       ├── masking_service.py
│   │       ├── ocr_service.py
│   │       ├── proxy_service.py
│   │       └── repositories.py
│   └── mcp_server/
│       └── server.py
├── tests/
│   └── test_masking_service.py
├── .env.example
├── pyproject.toml
└── README.md
```

<a id="autostart"></a>
## 自動起動セットアップ (ブラウザ拡張向け)

拡張を使うときは gateway が常時立ち上がっている必要があります。Chrome 拡張はサンドボックスの制約で自身から Docker を起動できないため、**OS ログイン時に gateway を自動で立ち上げる仕組み** を用意しています。1 度実行すれば以降は自動。

### Linux / WSL2

```bash
cd /path/to/masking-mcp
bash scripts/install-autostart.sh
```

- **systemd user service** (`~/.config/systemd/user/mask-mcp-gateway.service`) を登録
- systemd が使えない環境 (WSL で `/etc/wsl.conf` の `systemd=true` 未設定など) では `~/.bashrc` フックに自動フォールバック
- 次回ログインから `docker compose up -d` が自動実行される
- container 自体は `restart: unless-stopped` なので Docker daemon 再起動にも追従
- 確認: `systemctl --user status mask-mcp-gateway`
- 削除: `bash scripts/install-autostart.sh --uninstall`

### Windows (WSL + Docker Desktop 前提)

PowerShell (管理者権限不要) から:

```powershell
cd C:\Users\<you>\workspace\mask-mcp
powershell -File scripts\install-autostart.ps1
```

- Windows タスクスケジューラに `MaskMcpGatewayAutostart` を登録
- ログイン時に `wsl -d <distro> -- bash -c "cd <repo> && docker compose up -d"` を実行
- 削除: `powershell -File scripts\install-autostart.ps1 -Uninstall`

### 拡張の popup が疎通状態を教える

拡張インストール後、gateway に届かない状態で popup を開くと **「Gateway が見つかりません」** が表示され、あなたの OS 向けの install コマンドがコピー可能な形で出ます。1 回実行すれば以降は不要です。

---

<a id="standalone-mode"></a>
## Standalone モード (Docker gateway なしで動く)

`feat/serverless-engine-phase1` 以降、拡張機能に **pure-JavaScript の PII 検出エンジン** が同梱されています。Docker gateway を立ち上げなくても、regex ベースのプリセット (EMAIL / PHONE_NUMBER / POSTAL_CODE / MY_NUMBER / API_KEY / BLOOD_TYPE / ANNUAL_INCOME など 30+ カテゴリ) はブラウザ内でそのまま動きます。

精度目安 (vs Docker gateway full stack):

| カテゴリ | Standalone (Phase 1) | Gateway (Phase 2 + Presidio) |
|---|---|---|
| 構造化 PII (email / phone / 郵便番号 / マイナンバー / API key / …) | ≒同等 | 同等 |
| 日本語固有名詞 (田中太郎、株式会社〇〇) | 部分 (COMPANY + KATAKANA_NAME のみ) | 高 (Sudachi 形態素) |
| 英語 PERSON / LOCATION / ORGANIZATION | 未対応 | 高 (Presidio NER) |

標準では **Hybrid モード** で動作し、gateway が `127.0.0.1:8081` で応答すれば gateway を使い、応答しなければ自動的に standalone エンジンへフォールバックします。

### 切り替え方

拡張の popup から (Phase 4 で UI 追加予定) — または `chrome.storage.local` を直接編集:

```js
// Chrome DevTools (拡張 background page):
chrome.storage.local.set({ mask_mcp_pref_hybrid: "standalone" }); // 常に local エンジン
chrome.storage.local.set({ mask_mcp_pref_hybrid: "gateway" });    // 常に gateway (不達は失敗)
chrome.storage.local.set({ mask_mcp_pref_hybrid: "auto" });       // 既定: 疎通確認で自動切替
```

現在どちらで動いているかは `window.__localMaskMCP.settings.activeBackend` を DevTools で参照してください (`"gateway"` / `"standalone"`)。

### Chrome Web Store 公開版との違い

Web Store 公開版は `mask_mcp_pref_hybrid = "standalone"` をデフォルトにした配布ビルドになります (ユーザーが Docker を入れずに動くことが前提)。dev unpacked 版は `"auto"` で引き続き Hybrid 動作します。

---

## セットアップ

本プロジェクトは **Docker 前提** で管理しています。ホストに Python や uv をインストールする必要はありません。必要なのは `docker` と `docker compose` だけです。

`Makefile` 経由で全部済ませるのが一番短い道です。host に必要なのは `docker` / `docker compose` / `make` だけ。

```bash
cd /path/to/local-mask-mcp
make up                        # build + 起動 + /health 待ち + admin_token 表示
make config                    # 認証済みで /admin/config を pretty-print
make logs                      # コンテナログを tail
make down                      # 停止 (data/ は保持)
make help                      # 全ターゲット一覧
```

`make up` は内部で `mkdir -p data && docker compose up -d --build` を行い、`/health` が 200 を返すまで最大 60 秒待機します。`.env` は **任意** で、`ADMIN_TOKEN` は初回リクエスト時に自動生成されて `data/admin_token` (mode 0600) に保存されるため、`.env` を用意しなくてもそのまま動きます。

コードを書き換えた後は `make up` がそのまま `--build` を含むので毎回拾ってくれますが、レイヤキャッシュが壊れた気配があるときは `make rebuild` (`docker compose build --no-cache` のエイリアス) を使ってください。

以後 `curl` を直接叩くときは:

```bash
TOKEN=$(cat data/admin_token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8081/admin/config
```

明示的な固定値にしたい / チームで共有したい場合だけ `.env` に `ADMIN_TOKEN=...` を書いてください (env var があればそちらが優先)。

初回ビルドは spaCy `en_core_web_lg` (~400 MB) の取得があるため数分かかります。2 回目以降はレイヤキャッシュが効きます。

OCRで日本語を扱う場合は、Dockerfile の `tesseract-ocr-eng` の横に `tesseract-ocr-jpn` を追加してから再ビルドしてください。

### パッケージ管理について

依存は `uv.lock` で完全にロックされており、**このファイルは repo にコミットします**。`docker compose build` は `uv.lock` を基に `uv sync --frozen` で再現性のあるインストールを実行します。依存を変更するときのみ、使い捨てコンテナで uv を走らせてロックファイルを更新します:

```bash
# lockfile を更新する使い捨てコンテナを起動
docker run --rm -it -v "$PWD:/app" -w /app \
    ghcr.io/astral-sh/uv:0.11-python3.11-bookworm-slim \
    sh -c 'uv add <package> && cat uv.lock > /dev/null'
```

`uv add` / `uv lock --upgrade` のような依存操作は上記パターン、それ以外 (実行・テスト・lint) は全部コンテナ内です。

## 使い方

ゲートウェイは `docker compose up -d` で起動済みの前提です。以下の `curl` はすべてホストから動作中のコンテナ (`127.0.0.1:8081`) に対して叩きます。

### 1. ON/OFF切替

```bash
curl -X POST http://127.0.0.1:8081/admin/toggle \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true}'
```

### 2. テキスト単体のマスキング

```bash
curl -X POST http://127.0.0.1:8081/sanitize/text \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d '{"text": "John Doe lives at 1 Main St. Email john@example.com"}'
```

### 3. 既定プロバイダの切替

```bash
cat <<'JSON' | curl -X PUT http://127.0.0.1:8081/admin/config \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d @-
{
  "filter_enabled": true,
  "fail_closed": true,
  "entity_types": ["PERSON", "PHONE_NUMBER", "EMAIL_ADDRESS", "LOCATION"],
  "mask_strategy": "tag",
  "default_provider_id": "anthropic",
  "providers": {
    "openai": {
      "provider_id": "openai",
      "provider_type": "openai",
      "base_url": "https://api.openai.com",
      "api_key_env": "OPENAI_API_KEY",
      "enabled": true,
      "route_mode": "native",
      "default_headers": {},
      "model_mapping": {}
    },
    "anthropic": {
      "provider_id": "anthropic",
      "provider_type": "anthropic",
      "base_url": "https://api.anthropic.com",
      "api_key_env": "ANTHROPIC_API_KEY",
      "enabled": true,
      "route_mode": "native",
      "default_headers": {"anthropic-version": "2023-06-01"},
      "model_mapping": {}
    }
  }
}
JSON
```

### 4. OpenAIへ転送

ゲートウェイは **純粋なMITM** として動作するため、クライアントは自分でプロバイダ宛の認証ヘッダ（OpenAIなら `Authorization: Bearer ...`、Anthropicなら `x-api-key: ...`）を付与してください。ゲートウェイ側にはAPIキーを置きません。

```bash
curl -X POST http://127.0.0.1:8081/proxy/openai/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-4.1-mini",
    "messages": [
      {"role": "user", "content": "My email is john@example.com"}
    ]
  }'
```

### 5. Claudeへ転送

```bash
curl -X POST http://127.0.0.1:8081/proxy/anthropic/v1/messages \
  -H 'Content-Type: application/json' \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "claude-3-5-sonnet-latest",
    "messages": [
      {"role": "user", "content": "My phone number is 090-1234-5678"}
    ],
    "max_tokens": 512
  }'
```

### 6. Generic Providerへ転送

```bash
curl -X POST http://127.0.0.1:8081/proxy/generic/custom-local-llm \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $CUSTOM_API_KEY" \
  -d '{
    "operation": "v1/chat/completions",
    "model": "my-model",
    "messages": [
      {"role": "user", "content": "My address is 1 Main St."}
    ]
  }'
```

### 補足: 許可リスト (検出するが置換しない)

特定のエンティティ種別を「検出はするが置換しない」pass-through 扱いにできます。監査ログ上は `action: "allowed"` として記録されるため、何を素通ししたかはトレース可能です。

```bash
curl -X POST http://127.0.0.1:8081/sanitize/text \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "John Doe lives in Tokyo. Contact john@example.com",
    "allow_entity_types": ["LOCATION"]
  }'
```

恒常的に適用したい場合は `PUT /admin/config` で `allow_entity_types` を指定してください。

### 補足: 日本語 (Sudachi) 固有名詞マスキング

Presidio は既定で英語向けに構成されているため、日本語の固有名詞 (人名・地名・組織名) は拾いきれません。`RuntimeConfig.morphological_analyzer` を `"sudachi"` に切り替えると、SudachiPy による形態素解析が Presidio の検出結果にアドオンされ、`("名詞","固有名詞",...)` のみが `PROPER_NOUN_PERSON` / `PROPER_NOUN_LOCATION` / `PROPER_NOUN_ORG` / `PROPER_NOUN` としてマスキング対象に加わります。`("名詞","一般",...)` はマスクされません — 「会社」「車」のような一般名詞は素通しします。

既定値は `"none"` で、英語のみを扱ってきた既存のデプロイには影響しません。Sudachi 辞書のロードは初回リクエスト時まで遅延されるので、フラグを立てていないユーザは起動コストも払いません。

```bash
# 1) 恒常的に有効化 (RuntimeConfig を更新)
cat <<'JSON' | curl -X PUT http://127.0.0.1:8081/admin/config \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d @-
{
  "filter_enabled": true,
  "fail_closed": true,
  "entity_types": ["PERSON", "PHONE_NUMBER", "EMAIL_ADDRESS", "LOCATION"],
  "mask_strategy": "tag",
  "morphological_analyzer": "sudachi",
  "sudachi_split_mode": "A",
  "proper_noun_pos_patterns": [
    ["名詞", "固有名詞"],
    ["名詞", "一般", "人名"]
  ]
}
JSON

# 2) 日本語テキストをマスク
curl -X POST http://127.0.0.1:8081/sanitize/text \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d '{"text": "田中太郎は東京本社にいる"}'
```

`sudachi_split_mode` と `proper_noun_pos_patterns` は両方とも省略可能で、既定値はそれぞれ `"C"` (複合固有名詞を 1 トークンに融合) と `[["名詞", "固有名詞"]]` (Sudachi の固有名詞タグすべてを対象) です。既定値は `feat/sudachi-analyzer` 時点の挙動と完全に一致するため、既存デプロイは何もしなくても従来どおりに動作します。

- `sudachi_split_mode`: `"A"` は最小単位まで分割 (例: `東京スカイツリー` → `東京` + `スカイツリー`)、`"B"` は中間、`"C"` は最長単位で融合。固有名詞の *一部* だけをマスクしたい (`東京` だけ出す) ようなケースでは `"A"` を指定します。
- `proper_noun_pos_patterns`: POS 6 要素タプルの *接頭辞* をリストで渡します。`["名詞", "固有名詞", "人名"]` のように 3 要素目まで指定すれば人名だけに絞り込めますし、IPAdic 系辞書に移行した場合などは `["名詞", "一般", "人名"]` を追加することでカテゴリを補完できます。逆に地名をマスクしたくない運用では `[["名詞", "固有名詞", "人名"], ["名詞", "固有名詞", "組織"], ["名詞", "固有名詞", "一般"]]` のように `地名` を省いたリストを渡します。

期待されるレスポンス (抜粋):

```jsonc
{
  "filter_enabled": true,
  "sanitized_text": "<PROPER_NOUN_PERSON>は<PROPER_NOUN_LOCATION>本社にいる",
  "detections": [
    {
      "entity_type": "PROPER_NOUN_PERSON",
      "start": 0, "end": 4,
      "text": "田中太郎",
      "action": "masked"
    },
    {
      "entity_type": "PROPER_NOUN_LOCATION",
      "start": 5, "end": 7,
      "text": "東京",
      "action": "masked"
    }
  ]
}
```

検出ラベルは `allow_entity_types` とも組み合わせられます。例えば `"allow_entity_types": ["PROPER_NOUN_LOCATION"]` を指定すれば、人名はマスクしつつ地名だけ pass-through にできます (監査ログには `action: "allowed"` として残ります)。

### 補足: 言語別のアナライザ振り分け + 正規表現カスタム検出

長文の英語と日本語が混在するワークロードでは、Presidio を日本語に当てても拾えず、Sudachi を英語に当てても空振りするだけなので、**入力テキストの CJK 比率で振り分け**できます。加えて、社内 ID や案件コードのように Presidio の定型カテゴリでも Sudachi の固有名詞抽出でも拾えない業務固有パターンには、**`RegexAnalyzer` によるカスタム正規表現** を 1 本の分析器として追加できます。

`RuntimeConfig.analyzers_by_language` を設定すると、各リクエストのテキストに対して以下の流れが動きます:

1. `app.services.language_detection.detect_language(text)` が `"ja"` / `"en"` / `"mixed"` を返す (CJK 比率 ≥ `language_detection_ja_threshold` で `"ja"`、0 で `"en"`、その間を `"mixed"`)
2. 設定されたマップから、その言語に対応するアナライザの順序付きリストを取り出す (なければ `mixed` → `en` の順でフォールバック)
3. そのリストに含まれるアナライザだけが走る

`analyzers_by_language` が未設定 (`null`) の場合は従来どおり **Presidio 常時 + Sudachi 任意** の挙動になるため、既存デプロイはまったく影響を受けません。

```bash
# 1) 言語別ディスパッチ + 社内 ID 正規表現を有効化
cat <<'JSON' | curl -X PUT http://127.0.0.1:8081/admin/config \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d @-
{
  "filter_enabled": true,
  "fail_closed": true,
  "entity_types": ["PERSON", "PHONE_NUMBER", "EMAIL_ADDRESS", "LOCATION"],
  "mask_strategy": "tag",
  "morphological_analyzer": "sudachi",
  "analyzers_by_language": {
    "en":    ["presidio", "regex"],
    "ja":    ["sudachi",  "regex"],
    "mixed": ["presidio", "sudachi", "regex"]
  },
  "regex_patterns": [
    ["EMPLOYEE_ID",   "EMP-\\d{5}"],
    ["PROJECT_CODE",  "PRJ-[A-Z]{3}-\\d{4}"]
  ],
  "language_detection_ja_threshold": 0.2
}
JSON

# 2) 英語テキストに社員 ID を混ぜる
curl -X POST http://127.0.0.1:8081/sanitize/text \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d '{"text": "employee EMP-12345 filed project PRJ-ABC-0099 yesterday"}'
```

期待されるレスポンス (抜粋):

```jsonc
{
  "sanitized_text": "employee <EMPLOYEE_ID> filed project <PROJECT_CODE> yesterday",
  "detections": [
    { "entity_type": "EMPLOYEE_ID",  "text": "EMP-12345",    "action": "masked" },
    { "entity_type": "PROJECT_CODE", "text": "PRJ-ABC-0099", "action": "masked" }
  ]
}
```

`regex_patterns` の各要素は `[entity_type, regex]` の 2 要素リストで、JSON エスケープの都合上 `\\d` のようにバックスラッシュを二重化して書きます。正規表現はコンパイル時にエラーになると `MaskingService` の次回リクエスト時に `re.error` を透過させるので、テスト環境で構文エラーを検出できます。`analyzers_by_language` に `"regex"` を並べておき `regex_patterns` を空にしておくと、チェーン構成は維持したままパターンだけを切り離せます。

`language_detection_ja_threshold` は 0.0–1.0 の実数です。デフォルトの 0.2 は「英語長文の中に 1 つだけ漢字が混ざる」程度では `"ja"` に傾かず `"mixed"` に落とすバランスで、オペレータが全体を漢字寄りに寄せたければ下げる (例: 0.1) ことができます。

### 補足: 検出結果のテーブル表示

`sanitize/text` / `sanitize/file` のレスポンス `detections` は以下のカラムを持つので、どのクライアントでもそのままテーブル描画できます。

| カラム | 意味 |
|---|---|
| `entity_type` | Presidioが付けたラベル (例: `EMAIL_ADDRESS`) |
| `start` / `end` | 元テキスト中の文字オフセット |
| `line` / `column` | 1始まりの行・列 (PDFやログ参照時の目印) |
| `text` | 元テキストの該当部分 |
| `context_before` / `context_after` | 前後 ~20 文字のスニペット |
| `score` | Presidioの確信度 (0.0–1.0) |
| `action` | `masked` (置換済) または `allowed` (pass-through) |

### 7. MCPから既定プロバイダを切替

MCPツールとして `set_provider(provider_id)` を追加しているため、MCPクライアントから `openai` `anthropic` `manus` などへ既定送信先を変更できます。

## Claude 連携 (自動 PII マスク)

ゲートウェイを Claude Code / Claude Desktop と組み合わせて、**Enter を押すだけで自動的に PII をマスクしてから Anthropic に送信する** 構成を作れます。

### 方法 1: Claude Code — `ANTHROPIC_BASE_URL` (ストリーミング対応)

Claude Code 内部の Anthropic SDK は `ANTHROPIC_BASE_URL` 環境変数でエンドポイントを上書きできます。ゲートウェイの `/proxy/anthropic` を指定すると、全 API コールがゲートウェイ経由になり、ユーザの入力テキスト内の PII がマスクされてから Anthropic に転送されます。

```bash
# ゲートウェイを起動
make up

# Claude Code をゲートウェイ経由で起動
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

`stream: true` リクエスト (Claude Code のデフォルト) はゲートウェイが SSE チャンクをそのまま中継するため、通常と同じ打鍵感でトークンが表示されます。`x-api-key` はクライアントが付けたものをそのまま転送 (ゲートウェイにはキー不要)。

### 方法 2: Claude Desktop — MCP サーバ登録

Claude Desktop は MCP (Model Context Protocol) でツールを提供するサーバを登録できます。このプロジェクトの MCP サーバは以下のツールを公開しています:

| ツール | 説明 |
|---|---|
| `sanitize_text(text, mask_strategy)` | テキストの PII を検出してマスク |
| `detect_language(text)` | ja / en / mixed 判定 |
| `set_analyzer_config(...)` | アナライザ設定を変更 |
| `set_provider(provider_id)` | 転送先プロバイダを切替 |
| `toggle_filter(enabled)` | フィルタ ON/OFF |
| `get_runtime_config()` | 現在の設定を取得 |

#### 設定手順

**1. ラッパースクリプトに実行権限があることを確認** (初回のみ):

```bash
chmod +x scripts/mcp-stdio.sh
```

**2. `claude_desktop_config.json` に追加**

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`

**WSL の場合** (Claude Desktop は Windows 側で動作するため `wsl` 経由で呼ぶ):

```json
{
  "mcpServers": {
    "mask-mcp": {
      "command": "wsl",
      "args": [
        "bash", "/home/<user>/workspace/mask-mcp/scripts/mcp-stdio.sh"
      ]
    }
  }
}
```

**Mac / ネイティブ Linux の場合** (直接実行):

```json
{
  "mcpServers": {
    "mask-mcp": {
      "command": "/absolute/path/to/mask-mcp/scripts/mcp-stdio.sh"
    }
  }
}
```

`<user>` やパスは実際の環境に合わせてください。

**3. Claude Desktop を再起動** すると、ツール一覧に `sanitize_text` 等が現れます。

`scripts/mcp-stdio.sh` が内部で以下を行うため、権限エラー (`PermissionError: /app/data/runtime_config.json`) は発生しません:

- `mkdir -p data/` — bind mount 先を Docker daemon ではなくホストユーザが作成
- `--user $(id -u):$(id -g)` — コンテナ内プロセスをホスト側と同じ UID/GID で実行

> **Note**: `docker run` を直接 `claude_desktop_config.json` に書く方法もありますが、`data/` が存在しない場合に Docker daemon が root 所有でディレクトリを自動生成し、コンテナ内の UID 1000 (`maskmcp`) が書き込めなくなる既知の問題があります。スクリプト経由にすることでこの問題を回避しています。

ターミナルから動作確認したい場合:

```bash
make mcp    # MCP stdio サーバが起動 (Ctrl-C で停止)
```

#### 補足: MCP は「ツール呼び出し」方式

方法 1 (Base URL) が **全リクエストを自動的にマスク** するのに対し、MCP は **Claude がツールを呼ぶタイミングでだけマスク** される違いがあります。「必ずマスクしたい」なら方法 1、「必要なときだけマスクしたい」なら方法 2 が向いています。

## ブラウザ拡張 (全生成AIサービス対応)

Claude Code の `ANTHROPIC_BASE_URL` 経由のマスクは **Anthropic API を叩く Claude Code / SDK** に閉じています。Web 版 Claude.ai / ChatGPT / Gemini / Manus のチャット UI は SDK を介さず直接ブラウザから fetch を投げるため、`BASE_URL` ではカバーできません。そこで用意したのが `browser-extension/` の Chrome MV3 拡張です。

| | `ANTHROPIC_BASE_URL` 方式 | ブラウザ拡張 方式 |
|---|---|---|
| 対象 | Claude Code / Anthropic SDK を使うプロセス | Web ブラウザの AI チャット UI |
| カバー範囲 | Anthropic 1 プロバイダ | Claude.ai / ChatGPT / Gemini / Manus |
| 動作原理 | HTTP プロキシ (MITM) | `window.fetch` / `XHR.send` の monkey-patch |
| 認証 | 不要 (クライアントの API キーをパススルー) | なし (ループバック信頼モデル) |
| 追加エンドポイント | 既存 `/proxy/*` | 新規 `POST /v1/extension/sanitize` |

**インストール**: `make up` でゲートウェイを起動した後、`chrome://extensions` → Developer mode → Load unpacked → `browser-extension/` を選択するだけです。詳細手順・対応状況・既知の制約は [browser-extension/README.md](./browser-extension/README.md) を参照してください。

拡張側からゲートウェイを叩く専用エンドポイントは `POST /v1/extension/sanitize` で、`admin_token` 不要の読み取り専用 (入力テキスト → マスク済みテキスト) として公開しています。監査ログには `request_type="extension"` として記録されるため、`data/audit.jsonl` をフィルタすれば拡張経由のトラフィックだけを抽出できます。

**インタラクティブ・レビュー** (デフォルトON): ゲートウェイの検出結果を送信直前に Shadow DOM パネルで表示し、誤検知 (「プロジェクト」や「会社」がカタカナ名ヒューリスティックに巻き込まれた等) はチェックを外して元テキストのまま送信できます。Enter で確定、Esc でキャンセル (送信自体を中止)。ポップアップの「送信前に確認する」チェックを外すと従来どおりの自動マスクモードに戻ります。パネルは `z-index: 2147483647` の固定要素を `document.body` に差し込む Shadow DOM 設計で、ホストページの DOM/CSS には干渉しません。

**UI モード** (Milestone 8 Wave B で追加): ポップアップに `UI モード` ラジオを追加しました。

| モード | 動作 | エンドポイント |
|---|---|---|
| サイドバー (デフォルト) | 画面右側に固定パネルを表示。同じ文字列の重複は `田中太郎 (2件)` のように 1 行へ集約し、カテゴリごとに折り畳み + 一括 ON/OFF + すべて選択/解除 + リアルタイムプレビューが使えます。`機密` / `未公開` / `リーク` / `confidential` / `leak` などのキーワードが含まれる場合、`force_mask_categories` (デフォルト `PERSON` / `ORGANIZATION` / `FINANCIAL`) に属するカテゴリは 🔒 アイコン付きでロックされ、長押しゲートでのみ解除できます。 | `POST /v1/extension/sanitize/aggregated` |
| モーダル (従来) | Phase 2 と同じ中央モーダル。1 検出 = 1 行の per-occurrence 表示。 | `POST /v1/extension/sanitize` |

### サイドバー UX

| 機能 | 説明 |
|---|---|
| Push レイアウト | sidebar はチャット領域に被らず、`<body>` 直下の flex sibling として並ぶ。`min(400px, 45vw)` でビューポートに追従 |
| テーマ自動同期 | `getComputedStyle` でホストページの背景色を検出し、輝度 < 0.5 で dark palette を適用。サイドバー背景はサイトと同じ色 |
| Severity フィルタタブ | `All` `Critical` `High` `Medium` `Low` のセグメントコントロールで行を絞り込み |
| ロック解除スライダー | 0–1.5s (0.1s 刻み) で `force_masked_categories` 由来のロック行の長押し時間を設定。0s でクリック即解除 |
| Before/After 視覚化 | 行は `元の値 → <PLACEHOLDER>` で表示。マスク ON 時は元の値が薄く inactive、placeholder が active。マスク OFF 時は逆転して矢印も反転 |
| 緑バー (右側) | マスク OFF 行の右端に 4px 緑バー = 「この値はそのまま送信される」の視覚マーカー |
| 除外ボタン | 各行に `✖ 除外` ボタン → `chrome.storage.local.maskAllowlist` に永続登録。次回以降の検出で自動 unmask |
| **LLM 分析中バナー** (v0.5.0+) | ローカル LLM が有効かつ regex が 1 件以上検出した場合、サイドバーは **LLM 完了を待たず即時オープン**。本体上部に紫グラデーションのスピナーバナーを表示し、LLM 解決時点で行を差分再描画する。ユーザーが先に触った mask/unmask 状態は preserve される |
| **ローディングピル** (v0.5.0+) | サイドバー外・画面右上に固定される `✨ LLM 分析中…` のピル型インジケータ。regex が 0 件で「LLM が何か見つけるか待機中」の時間帯でも可視化される |

### マスキング除外データベース (allowlist)

`chrome://extensions` → 拡張アイコン右クリック → 「オプション」、もしくはポップアップの「⚙ 詳細設定」ボタンで開く `options.html` で管理:

- 値の追加・削除・全削除
- JSON エクスポート (タイムスタンプ付き) / JSON インポート (重複自動マージ)
- マスキング有効/無効、interactive、UI mode、Gateway 疎通ステータス
- ダークモード自動追従

**クロスタブ即時反映**: 一方のタブで除外リストに追加すると、`chrome.storage.onChanged` → `content.js` → `injected.js` → `mask-mcp:settings-updated` CustomEvent → 開いている全タブのサイドバーが該当行を即座に unmask + 緑バー表示。リロード不要。

### ローカル LLM 連携 (v0.5.0, 実験的)

ゲートウェイ不要で、**ブラウザ拡張 + 手元の Ollama (または LM Studio / llama.cpp)** だけで文脈考慮型の PII 検出を追加できます。LLM 出力は regex/Sudachi の検出結果を上書きし (LLM 優先)、regex 側は構造化 PII (メール・クレカ・電話) の安全網として残ります。

#### 最小構成

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

#### アーキテクチャ要点

- **Service Worker がプロキシ**: Chrome の Private Network Access (PNA) ポリシーは HTTPS ページから `http://localhost` への fetch をブロックするため、LLM コールは全て特権コンテキストである service worker に `LLM_FETCH` メッセージで委譲します。
- **Host-lock**: service worker は `chrome.storage.local.localLlmUrl` とホスト/プロトコルが一致する URL 以外を拒否します。任意の HTTP プロキシとしては使えません。
- **Sender-ID 検証**: foreign extension から SW への中継は `sender.id !== chrome.runtime.id` で弾かれます。
- **Qwen3 `<think>` 除去**: システムプロンプト冒頭に `/no_think` を付与し、応答からも `<think>…</think>` ブロックをストリップ。JSON 先頭から末尾までを再抽出してから `JSON.parse` します。
- **Fail-closed on replace**: `AI 置換` モードは LLM がどれか 1 件でも失敗すると outbound リクエスト全体を abort します (部分漏洩より送信中止を優先)。
- **Fail-open on detect**: `検出補助` モードは LLM がタイムアウトしても regex/Sudachi 結果のみでサイドバーに残留。サイドバー冒頭のバナーがエラー表示に切り替わり、4 秒で自動非表示。

#### 既知の制約

| 症状 | 原因 | 対処 |
|---|---|---|
| 403 (CORS) が返る | Ollama の `OLLAMA_ORIGINS` 未設定 | 上記 docker コマンドで `OLLAMA_ORIGINS='*'` を付与。オプション画面の「接続確認」が自動検知して remediation を表示 |
| コールドスタートでタイムアウト | 4B+ モデルは初回 20–40s | タイムアウトを 120000ms 以上に (最大 180000) |
| LLM が `エンジニア` `アクセスキー` など一般語を検出 | モデル側の過検出 | `HARD NEGATIVE LIST` (システムプロンプト) と `LLM_DENYLIST` + `LLM_DENY_REGEX` (クライアント側フィルタ) で落とす仕様。追加したい語は `browser-extension/injected.js` の denylist に足す |
| LLM 優先マージが効いていない | 設定が `AI 置換` のまま | v0.5.0 以降、`検出補助` と `AI 置換` の両方で `mergeLlmDetect` が走るよう修正済み。もし検出ログに `SKIPPED` が出ていたら開発者ツールのコンソールで `[mask-mcp] llm detect: ...` の行を参照 |

詳細な設定・ログ例・セキュリティ設計は [browser-extension/README.md#local-llm-proxy-v050-experimental](./browser-extension/README.md#local-llm-proxy-v050-experimental) を参照してください。

### Socket.IO (WebSocket) 対応

manus.im など Socket.IO over WebSocket を使うサービスは `fetch` / `XHR` を経由しないため、専用フックで対応:

1. `injected.js` の `WebSocket.prototype.send` を wrap
2. Engine.IO v4 EVENT フレーム (`42[...]` / `4213[...]`) をパース
3. `["message", {type:"user_message", contents:[{type:"text", value:"..."}]}]` の `value` フィールドのみマスキング適用
4. ping / pong / CONNECT / DISCONNECT / ACK は素通し
5. ユーザーキャンセル時はそのフレームのみ silent drop (WebSocket は閉じない = chat session 維持)

**セキュリティ**: WebSocket URL に含まれる JWT (manus は `?token=...` で認証) は LOG 出力時に `token` `auth` `key` `sentry_key` 等を `REDACTED` に置換します。診断ログから session 認証情報が漏れないよう設計。

## テスト

テストは Docker のビルドステージで走らせます。host に何もインストールする必要はありません。

```bash
make test
# 内部で: docker build --target test --progress=plain -t local-mask-mcp:test .
```

`Dockerfile` の `test` ステージは `builder` を引き継ぎ、dev 依存 (pytest / pytest-asyncio / ruff) と spaCy モデル、tesseract を追加してから `uv run pytest tests/ -v` を実行します。**どれか 1 本でもテストが落ちるとビルドが失敗する** ので、CI ゲートとしてそのまま使えます。通常の `make up` / `docker compose build` はこのステージをスキップします。

## 次の実装タスク

初期雛形からPoCへ進める際は、`document_service.py` にPDF画像化とページ単位OCRを追加し、`sanitize/file` エンドポイントを実装します。次に、`masking_service.py` へ日本語Recognizer、社内識別子用のカスタムRecognizer、プレビュー用差分表示を追加します。最後に、`proxy_service.py` でストリーミング応答、マルチモーダル入力、添付ファイル、fail-closed制御、Manus APIのファイルアップロード連携を実装してください。
