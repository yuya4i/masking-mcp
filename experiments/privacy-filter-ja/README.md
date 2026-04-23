# privacy-filter-ja — 日本語 PII 検出モデル

`openai/privacy-filter` (Apache 2.0 ライセンスの 1.5B MoE 型トークン分類器) を日本語 PII に拡張ファインチューンするプロジェクト。既存の 8 カテゴリ (account_number / private_address / private_email / private_person / private_phone / private_url / private_date / secret) に、日本語特有の 10 カテゴリを追加します。

## 追加カテゴリ (10 種)

| label | 例 |
|---|---|
| `private_my_number` | `1234 5678 9012` (マイナンバー) |
| `private_postal_code_jp` | `〒107-0061`, `100-0001` |
| `private_prefecture` | 東京都, 兵庫県, 北海道 |
| `private_company_jp` | 株式会社アクメ, 有限会社○○ |
| `private_driver_license_jp` | `12-34-567890-12` |
| `private_passport_jp` | `AB1234567` |
| `private_annual_income` | `年収1200万円`, `月収40万円` |
| `private_bank_account_jp` | `普通 1234567`, `当座 7654321` |
| `private_patient_id_jp` | `PATIENT-12345`, `患者ID: P-77` |
| `private_employee_id_jp` | `EMP-12345`, `社員番号: E-0042` |

合計 **18 カテゴリ × 4 BIOES タグ + 1 背景 = 73 labels**。

## パイプライン

```text
(phase 1: このディレクトリで用意するもの)

  categories.yaml          ── ラベル定義
        │
        ▼
  data/seed.jsonl          ── 手動キュレーション例 (500+)
        │
        ▼ template merge
  data/pools/*.txt         ── 変数プール (名前/会社/住所/...)
        │
        ▼
  data/generator.py        ── seed + pools → 大量 JSONL
        │
        ▼
  dataset.jsonl            ── 20k-50k 例 (user がローカル生成)

(phase 2: ユーザーがローカル RTX 4090 で実行)

  train/prepare.py         ── jsonl → HF Dataset + tokenize + BIOES 整列
        │
        ▼
  train/train.py           ── openai/privacy-filter から fine-tune
        │
        ▼
  checkpoints/best/        ── 学習済みモデル
        │
        ▼
  eval/eval.py             ── char-span F1 per category
        │
        ▼
  publish/push_to_hub.py   ── HF Hub へアップロード
        │
        ▼
  HF Hub: yuya4i/privacy-filter-ja
```

## 実行手順

### 1. データ生成 (数秒)

```bash
cd experiments/privacy-filter-ja
python data/generator.py --count 30000 --seed 42 --out data/generated.jsonl
python data/validate.py data/seed.jsonl data/generated.jsonl
```

### 2. 学習 (2-6 時間 on RTX 4090)

```bash
cd train
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python prepare.py --in ../data/generated.jsonl --out ../dataset/
python train.py --config train-config.yaml
```

### 3. 評価

```bash
python ../eval/eval.py --model ../checkpoints/best --test ../eval/test.jsonl
```

### 4. HF Hub へ公開

```bash
huggingface-cli login
python ../publish/push_to_hub.py \
  --model ../checkpoints/best \
  --repo yuya4i/privacy-filter-ja \
  --dataset-repo yuya4i/privacy-filter-ja-dataset
```

## ライセンス

- 元モデル: `openai/privacy-filter` Apache 2.0
- 本プロジェクトのコード: Apache 2.0 (継承)
- 生成データ: CC-BY-4.0 (派生自由、帰属必要)
- 学習済み派生モデル: Apache 2.0 (親モデルに継承)

## 注意点

- **個人情報**: プール内の名前・会社名・住所等はすべて **合成** (実在人物/企業と偶然一致する場合があるが意図的な参照ではない)
- **タスクの限定**: 本モデルは PII 検出のみ。汎用 LLM ではない
- **日本語特化**: 多言語テキストは既存 `openai/privacy-filter` が英語中心のカバー範囲、JP 拡張は重ね合わせ

## ディレクトリ

```text
experiments/privacy-filter-ja/
├── README.md                  このファイル
├── categories.yaml            ラベル定義
├── .gitignore                 generated.jsonl / checkpoints/ を除外
├── data/
│   ├── seed.jsonl             手動キュレーション例
│   ├── generator.py           template × pools → 大量生成
│   ├── validate.py            span 整合性チェック
│   └── pools/                 変数プール
├── train/
│   ├── prepare.py             jsonl → tokenized dataset
│   ├── train.py               fine-tune loop
│   ├── train-config.yaml
│   └── requirements.txt
├── eval/
│   ├── eval.py                char-span F1
│   └── test.jsonl             held-out 検証セット
└── publish/
    ├── push_to_hub.py
    └── MODEL_CARD.md
```
