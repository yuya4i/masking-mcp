# Experiments — moved out

このディレクトリは機械学習系のサブプロジェクトを置くための場所ですが、現状すべて独立リポジトリに移管済みです。

## 移管先

| 旧 path | 新リポジトリ | 説明 |
|---|---|---|
| `experiments/privacy-filter-ja/` | [yuya4i/pii-filter-ja](https://github.com/yuya4i/pii-filter-ja) (private) | `openai/privacy-filter` の日本語 fine-tune レシピとデータジェネレータ |

## 移管の理由

- ML 実験は Chrome 拡張 / FastAPI ゲートウェイとライフサイクルが異なる (学習ジョブ・データセット・モデル成果物の管理が独立)
- 依存スタックが独立 (transformers 5.x, torch, datasets など)
- 本リポのサイズ肥大を避ける

移管は `git filter-repo --subdirectory-filter experiments/privacy-filter-ja` で履歴を保持したまま行いました。旧 path 配下のコミット履歴 (#32, #33, #34, #35) は新リポに全て残っています。
