# TODO / Roadmap

This file tracks the roadmap for `local-mask-mcp` — a local PII-masking
gateway with MCP adapter and pass-through LLM proxy.

## Vision

Turn the gateway from a **Presidio-only (English-oriented, fixed-category)
masker** into an extensible, **language-aware**, **multi-analyzer** system.

The flagship addition is **Japanese proper-noun masking via morphological
analysis** (SudachiPy / GiNZA / Fugashi). Every 固有名詞 (proper noun)
detected by the analyzer becomes a mask target, regardless of whether it
matches one of Presidio's predefined entity categories. 一般名詞 (common
nouns) are intentionally excluded, matching the user's stated requirement:

> テキスト、ドキュメント、中に含まれる一般名詞を除く固有名詞などを形態素解析
> によって抽出されたデータをマスクする手法

In other words: run `text` → morphological analyzer → filter tokens where
POS starts with `名詞,固有名詞` → mask those spans.

## Status legend

- `[ ]` open — not yet started
- `[~]` in progress — feature branch exists, work in flight
- `[x]` done — merged to `main`

## Working agreement

- Each feature lives on its own branch, named after the bullet below
  (`feat/...`, `refactor/...`, `docs/...`, `chore/...`).
- Every feature branch is implemented by a dedicated **Agent Team**,
  spawned with `Agent(... isolation: "worktree")` so parallel work does
  not step on each other.
- A feature branch is merged back into `main` only after the Docker
  `test` target (`make test`) is green inside the worktree.
- `uv.lock` is the single source of truth for the dependency set. New
  dependencies are added via a throwaway uv container so the host does
  not need uv installed:
  ```bash
  docker run --rm -it -v "$PWD:/app" -w /app \
      ghcr.io/astral-sh/uv:0.11-python3.11-bookworm-slim \
      uv add <package>
  ```
- Every PR / merge must keep `make test` passing and the documented
  `entity_types` / `allow_entity_types` / `mask_strategy` contract
  backward compatible.

---

## Milestone 1 — Japanese proper-noun masking (MVP)

Goal: a user can POST Japanese text containing person/place/organization
names through `/sanitize/text` and see them masked, without touching the
existing Presidio English path.

- [x] **feat/sudachi-analyzer** — merged in `7614b83`, 5 commits, 15/15 tests green.
  Follow-ups discovered during implementation are tracked in Milestone 4 below
  (split-mode config, overlap resolver optimization, surname/placename
  ambiguity, conftest extraction).
  - Add `sudachipy` + `sudachidict_core` as runtime dependencies via
    `uv add`; commit both `pyproject.toml` and the regenerated
    `uv.lock`.
  - New module `src/app/services/sudachi_analyzer.py` with a
    `SudachiProperNounAnalyzer` class that:
    - Instantiates a `sudachipy.Dictionary().create()` tokenizer once
      at `__init__` time (analogous to `AnalyzerEngine()` for Presidio).
    - Exposes `analyze(text: str) -> list[PresidioLikeDetection]` where
      each detection has `entity_type="PROPER_NOUN"` (or the finer
      subcategory — 人名 / 地名 / 組織名), `start` / `end` byte offsets,
      and `score=1.0`.
    - Filters tokens whose POS tuple's first two fields are
      `("名詞", "固有名詞")`; 一般名詞 and non-nouns are discarded.
  - Integrate into `MaskingService.sanitize_text` as a secondary
    analyzer that runs in addition to Presidio. Detections are merged
    before the masking strategy is applied, with overlapping spans
    resolved by taking the higher-confidence entry.
  - New runtime config field `morphological_analyzer: Literal["sudachi", "none"] = "none"`
    so existing deployments do not change behaviour until they opt in.
  - Japanese unit tests in `tests/test_sudachi_analyzer.py` covering:
    - 人名 detection (`田中太郎`, `山田`, `SATO`)
    - 地名 detection (`東京`, `大阪府`, `渋谷区`)
    - 組織名 detection (`グーグル`, `株式会社マスクテスト`)
    - 一般名詞 non-detection (`会社`, `今日`, `りんご`)
    - Overlap handling when Presidio and Sudachi both fire on the
      same span.
  - Dockerfile: bake the Sudachi dictionary into the builder stage's
    `/opt/venv` exactly the way spaCy `en_core_web_lg` is baked today.
    Must NOT re-download the dict at container start.
  - Update `README.md` and `docker-compose.yml` comments with a
    Japanese example.
  - Acceptance: `make test` green with the new tests, `make up` +
    curl round-trip shows `田中太郎` masked in `sanitized_text`.
  - Depends on: nothing.

- [ ] **feat/pos-filter-config**
  - Expose the set of POS prefixes that count as "proper noun" as
    `RuntimeConfig.proper_noun_pos_patterns: list[list[str]]`.
  - Default value: `[["名詞", "固有名詞"]]`.
  - Allow users to broaden (e.g. add `["名詞", "一般", "人名"]` for
    IPAdic variants) or tighten (e.g. exclude 地名).
  - Depends on: `feat/sudachi-analyzer`.

---

## Milestone 2 — Analyzer abstraction

Goal: `MaskingService` stops talking to Presidio/Sudachi directly and
instead composes a list of `Analyzer` implementations, so adding a new
backend (GiNZA, Fugashi, custom regex) is a one-file change.

- [ ] **refactor/analyzer-protocol**
  - Introduce `Analyzer` `Protocol` in `src/app/services/analyzers/base.py`
    with `analyze(text: str, config: RuntimeConfig) -> list[Detection]`.
  - Extract the existing Presidio calls into
    `src/app/services/analyzers/presidio.py` (`PresidioAnalyzer`).
  - Move `SudachiProperNounAnalyzer` under the same package.
  - `MaskingService` holds `analyzers: list[Analyzer]` and concatenates
    their results before running the masking strategy.
  - No behaviour change for existing clients.
  - Depends on: `feat/sudachi-analyzer`.

- [ ] **feat/custom-regex-recognizer**
  - `RegexAnalyzer` — pattern list in config, first-class analyzer.
  - Useful for employee IDs, internal project codes, free-text
    passwords that slip past both Presidio and Sudachi.
  - Depends on: `refactor/analyzer-protocol`.

---

## Milestone 3 — Language-aware routing

Goal: detect the text's language with a cheap heuristic and run only
the analyzers relevant to it, avoiding Presidio's English NER running
against Japanese (or vice versa).

- [ ] **feat/language-detection**
  - Simple CJK-ratio detector returning `"ja"` / `"en"` / `"mixed"`.
  - Pure-Python, no new dependency.

- [ ] **feat/language-aware-dispatch**
  - `MaskingService` selects analyzer subset by detected language.
  - Config: `analyzers_by_language: dict[str, list[str]]`.
  - Depends on: `refactor/analyzer-protocol` + `feat/language-detection`.

---

## Milestone 4 — Observability & polish

- [ ] **feat/score-threshold** — per-entity minimum score filter; drops
  low-confidence detections before they hit `sanitized_text`. Closes
  the current `Reach → PERSON` false-positive noted in the e2e test.

- [ ] **feat/audit-query-endpoint** — `/admin/audits` accepts `since`
  / `entity_type` / `action` query params instead of just returning
  the last N records.

- [ ] **docs/architecture-diagram** — ASCII / Mermaid diagram of
  analyzer chain, language routing, MITM proxy flow.

- [ ] **feat/sudachi-split-mode-config** — `SudachiProperNounAnalyzer`
  is currently hard-coded to `SplitMode.C` (longest). Expose
  `sudachi_split_mode: Literal["A", "B", "C"] = "C"` in `RuntimeConfig`
  so operators who prefer finer-grained tokenization (e.g. to mask
  morpheme-level components of compound names) can opt in. Depends on:
  nothing.

- [ ] **chore/sudachi-overlap-sweep-line** — the overlap resolver
  introduced with `feat/sudachi-analyzer` is an O(n²) nested scan.
  Fine for PoC payloads but scales poorly on long PDF extracts with
  hundreds of detections. Rewrite as an interval-sweep in
  `masking_service.py` once input sizes justify it. Depends on: nothing.

- [ ] **feat/sudachi-surname-placename-disambiguation** — surfaces like
  `千葉` / `神戸` are both `人名` (surname) and `地名` (city) in the Sudachi
  default dictionary. A per-request confidence threshold, a custom
  user dictionary, or a contextual heuristic would reduce misfires.
  Depends on: nothing, but benefits from `feat/score-threshold`.

- [ ] **chore/tests-conftest** — `DummyConfigRepository` /
  `DummyAuditRepository` helpers are duplicated between
  `test_masking_service.py` and `test_sudachi_analyzer.py`. Lift them
  into `tests/conftest.py` as pytest fixtures before adding the next
  test file. Depends on: nothing; should be done before Milestone 2.

---

## Milestone 5 — MCP surface

- [ ] **feat/mcp-language-tool** — expose `detect_language(text)` as
  an MCP tool.
- [ ] **feat/mcp-analyzer-tool** — MCP tool to enable/disable individual
  analyzers at runtime (mirroring `toggle_filter` but per-analyzer).

---

## Out of scope (explicitly)

- Training a custom NER model. We compose off-the-shelf analyzers and
  rule-based filters; model training belongs in a separate project.
- Centralized secret management for upstream LLM API keys. The gateway
  is a pure MITM; clients send their own auth headers.
- Multi-tenant / remote deployment. This is a local, loopback-bound
  tool. Non-loopback binds are unsupported and deliberately undocumented.
