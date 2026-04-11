# local-mask-mcp

`local-mask-mcp` は、生成AIへ送信する前にローカルPC上で個人情報を検出・マスクするための軽量ゲートウェイです。MCP対応クライアント向けのツール提供と、OpenAI、Claude、Manus、その他プロバイダ向けのローカルHTTPプロキシを同居させる構成を想定しています。

## アーキテクチャ概要

本プロジェクトは、`FastAPI` によるローカル常駐サービスを中核にし、`Presidio` を用いたPII検出・匿名化、`pytesseract` を用いたOCR、`FastMCP` を用いたMCPツール提供を行う雛形です。初期実装では、設定はJSON、監査ログはJSON Linesで保持します。外部AIへの転送は `ProviderResolver + ProviderAdapter` パターンで実装し、プロバイダ追加時は既存のマスキング処理を変更せずにアダプタを差し込める構成としています。

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
  "morphological_analyzer": "sudachi"
}
JSON

# 2) 日本語テキストをマスク
curl -X POST http://127.0.0.1:8081/sanitize/text \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d '{"text": "田中太郎は東京本社にいる"}'
```

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

## テスト

テストは Docker のビルドステージで走らせます。host に何もインストールする必要はありません。

```bash
make test
# 内部で: docker build --target test --progress=plain -t local-mask-mcp:test .
```

`Dockerfile` の `test` ステージは `builder` を引き継ぎ、dev 依存 (pytest / pytest-asyncio / ruff) と spaCy モデル、tesseract を追加してから `uv run pytest tests/ -v` を実行します。**どれか 1 本でもテストが落ちるとビルドが失敗する** ので、CI ゲートとしてそのまま使えます。通常の `make up` / `docker compose build` はこのステージをスキップします。

## 次の実装タスク

初期雛形からPoCへ進める際は、`document_service.py` にPDF画像化とページ単位OCRを追加し、`sanitize/file` エンドポイントを実装します。次に、`masking_service.py` へ日本語Recognizer、社内識別子用のカスタムRecognizer、プレビュー用差分表示を追加します。最後に、`proxy_service.py` でストリーミング応答、マルチモーダル入力、添付ファイル、fail-closed制御、Manus APIのファイルアップロード連携を実装してください。
