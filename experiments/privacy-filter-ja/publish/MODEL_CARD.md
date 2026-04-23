---
license: apache-2.0
base_model: openai/privacy-filter
tags:
  - token-classification
  - pii-detection
  - japanese
  - privacy
language:
  - ja
  - en
library_name: transformers
pipeline_tag: token-classification
---

# privacy-filter-ja

`openai/privacy-filter` (Apache 2.0) を日本語 PII 検出に拡張ファインチューンしたモデル。

英語中心の既存 8 カテゴリに、日本語特有の **10 カテゴリ** を追加しました。

## 対応カテゴリ (18 種)

### 既存 (英語中心、親モデルから継承)

- `account_number` — 口座 / クレジットカード / 請求番号
- `private_address` — 郵便住所 (番地付き)
- `private_email` — メールアドレス
- `private_person` — 人名
- `private_phone` — 電話番号
- `private_url` — URL
- `private_date` — 日付
- `secret` — API キー / パスワード

### 日本語拡張

- `private_my_number` — マイナンバー (12 桁)
- `private_postal_code_jp` — 郵便番号 (〒NNN-NNNN)
- `private_prefecture` — 都道府県 (47)
- `private_company_jp` — 日本法人名 (株式会社...)
- `private_driver_license_jp` — 運転免許証番号
- `private_passport_jp` — パスポート番号
- `private_annual_income` — 年収 / 月収
- `private_bank_account_jp` — 銀行口座
- `private_patient_id_jp` — 患者 ID / MRN
- `private_employee_id_jp` — 社員番号

## 使い方

```python
from transformers import pipeline

pipe = pipeline("token-classification", model="yuya4i/privacy-filter-ja")
text = "株式会社アクメの田中太郎 (tanaka@acme.co.jp / 090-1234-5678)"
print(pipe(text))
```

### Transformers.js (ブラウザ内)

```javascript
import { pipeline } from "@xenova/transformers";
const pipe = await pipeline(
  "token-classification", "yuya4i/privacy-filter-ja",
  { device: "webgpu", dtype: "q4" },
);
const out = await pipe("田中太郎さんが明日来ます");
```

## 学習詳細

- **ベースモデル**: `openai/privacy-filter` (1.5B 総パラメータ / 50M active, MoE)
- **追加学習データ**: 合成データ ~20k-30k 例 (char-level span アノテーション)
- **ハードウェア**: RTX 4090 24 GB, bf16
- **エポック**: 3
- **バッチサイズ**: 16 (実効 32 via gradient_accumulation=2)
- **学習率**: 3e-5, cosine scheduler, warmup 5%
- **損失**: token-level cross-entropy (ignore_index=-100 for special tokens)
- **評価**: seqeval F1 (BIOES span-exact)

## 性能 (社内ベンチ)

| カテゴリ | F1 | Precision | Recall |
|---|---|---|---|
| (学習後のメトリクスをここに記入) | — | — | — |

## 制限

- 英語非 PII はベース model を継承 (日本語学習で若干のドリフトあり)
- カタカナのみの人名・企業名は誤検知の余地
- 極端に長い文脈 (>512 token) は head tail truncation
- 医療/金融の業界用語は限定カバー

## ライセンス

**Apache 2.0**。親モデル `openai/privacy-filter` のライセンスを継承しています。

## 学習レシピ

データ生成・学習・評価のスクリプト一式は以下で公開:

https://github.com/yuya4i/pii-masking/tree/main/experiments/privacy-filter-ja

同じレシピで再現可能、カテゴリ追加もパッケージ化されています。
