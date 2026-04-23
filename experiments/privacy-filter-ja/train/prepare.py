#!/usr/bin/env python3
"""prepare.py — JSONL → tokenized HF Dataset with BIOES-aligned labels.

Input:
    - seed.jsonl + generated.jsonl (char-level {start,end,label} spans)

Output:
    - HF Dataset saved to disk (dataset/ by default)
    - id2label / label2id JSON (../labels.json) for train.py

Usage:
    python train/prepare.py \\
        --config train/train-config.yaml

Key step — char-span → token-BIOES alignment:
    HF tokenizer returns (offsets_mapping) for each token: (char_start,
    char_end). For each training example we loop tokens and check
    overlap with every span. First token of a span → B-<cat>,
    last token → E-<cat>, middle → I-<cat>, single-token → S-<cat>,
    no overlap → O.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import yaml
from datasets import Dataset, DatasetDict
from transformers import AutoTokenizer


def load_labels(root: Path) -> tuple[list[str], dict[str, int], dict[int, str]]:
    """Build the full BIOES label list from categories.yaml."""
    cats = yaml.safe_load((root / "categories.yaml").read_text(encoding="utf-8"))
    category_names: list[str] = []
    for group in ("existing_categories", "japanese_categories"):
        for cat in cats.get(group, []) or []:
            category_names.append(cat["name"])
    # BIOES × categories + O
    labels = ["O"]
    for c in category_names:
        for tag in ("B", "I", "E", "S"):
            labels.append(f"{tag}-{c}")
    label2id = {lbl: i for i, lbl in enumerate(labels)}
    id2label = {i: lbl for lbl, i in label2id.items()}
    return labels, label2id, id2label


def load_jsonl(path: Path) -> list[dict]:
    out: list[dict] = []
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            out.append(json.loads(line))
    return out


def spans_to_bioes(
    offsets: list[tuple[int, int]],
    spans: list[dict],
    label2id: dict[str, int],
    word_ids: list[int | None],
) -> list[int]:
    """Project char-level spans onto token-level BIOES labels."""
    tok_labels: list[int] = [label2id["O"]] * len(offsets)
    # Special tokens get -100 so loss ignores them.
    for i, wid in enumerate(word_ids):
        if wid is None:
            tok_labels[i] = -100
    # For each span, find the list of token indices whose char range
    # falls inside [start, end).
    for sp in spans:
        s_start, s_end, s_label = sp["start"], sp["end"], sp["label"]
        covered: list[int] = []
        for i, (cs, ce) in enumerate(offsets):
            if word_ids[i] is None:
                continue
            if ce <= s_start or cs >= s_end:
                continue
            # overlap
            covered.append(i)
        if not covered:
            continue
        if len(covered) == 1:
            tok_labels[covered[0]] = label2id[f"S-{s_label}"]
        else:
            tok_labels[covered[0]] = label2id[f"B-{s_label}"]
            tok_labels[covered[-1]] = label2id[f"E-{s_label}"]
            for i in covered[1:-1]:
                tok_labels[i] = label2id[f"I-{s_label}"]
    return tok_labels


def tokenize_and_align(
    records: list[dict],
    tokenizer,
    label2id: dict[str, int],
    max_length: int,
) -> dict[str, list[Any]]:
    input_ids: list[list[int]] = []
    attention_masks: list[list[int]] = []
    all_labels: list[list[int]] = []
    for rec in records:
        enc = tokenizer(
            rec["text"],
            truncation=True,
            max_length=max_length,
            return_offsets_mapping=True,
        )
        offsets = enc["offset_mapping"]
        # word_ids is tokenizer-specific; fast tokenizers support it,
        # and we use offsets to detect special tokens (0,0) for padding/CLS.
        word_ids = [
            None if (o[0] == 0 and o[1] == 0) else i
            for i, o in enumerate(offsets)
        ]
        labels = spans_to_bioes(offsets, rec.get("annotations", []), label2id, word_ids)
        input_ids.append(enc["input_ids"])
        attention_masks.append(enc["attention_mask"])
        all_labels.append(labels)
    return {
        "input_ids": input_ids,
        "attention_mask": attention_masks,
        "labels": all_labels,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True, type=str, help="train-config.yaml")
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[1]
    cfg = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))

    # Labels
    labels, label2id, id2label = load_labels(root)
    print(f"built {len(labels)} labels (18 categories × 4 BIOES + O)")

    # Data
    seed_path = root / cfg["data"]["seed_path"].lstrip("../")
    gen_path = root / cfg["data"]["generated_path"].lstrip("../")
    records = load_jsonl(seed_path) + load_jsonl(gen_path)
    print(f"loaded {len(records)} records (seed={len(load_jsonl(seed_path))}, "
          f"generated={len(load_jsonl(gen_path))})")
    if not records:
        sys.stderr.write("no records — run data/generator.py first.\n")
        return 2

    # Shuffle + split
    import random
    rng = random.Random(cfg["training"]["seed"])
    rng.shuffle(records)
    val_n = max(1, int(len(records) * cfg["data"]["val_fraction"]))
    val_records = records[:val_n]
    train_records = records[val_n:]
    print(f"split: train={len(train_records)}, val={len(val_records)}")

    # Tokenize
    tokenizer = AutoTokenizer.from_pretrained(cfg["model"]["tokenizer_id"])
    max_length = cfg["data"]["max_length"]
    print(f"tokenizing (max_length={max_length})...")
    train_col = tokenize_and_align(train_records, tokenizer, label2id, max_length)
    val_col = tokenize_and_align(val_records, tokenizer, label2id, max_length)

    # Save
    out_dir = root / cfg["data"]["dataset_dir"].lstrip("../")
    out_dir.mkdir(parents=True, exist_ok=True)

    ds = DatasetDict({
        "train": Dataset.from_dict(train_col),
        "validation": Dataset.from_dict(val_col),
    })
    ds.save_to_disk(str(out_dir))
    print(f"dataset saved → {out_dir}")

    (root / "labels.json").write_text(
        json.dumps({"labels": labels, "label2id": label2id, "id2label": {str(k): v for k, v in id2label.items()}},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"labels saved → labels.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
