#!/usr/bin/env python3
"""train.py — fine-tune openai/privacy-filter for Japanese + JP categories.

Strategy:
1. Load openai/privacy-filter with its original 33-label head.
2. Replace the classification head with a new Linear(hidden, 73).
3. WARM-START the new head: for each existing label (O + 8 categories
   × 4 BIOES = 33), copy the original weights to the matching index
   in the new head. Japanese-specific labels get standard Xavier init.
4. Fine-tune everything on the merged (seed + generated) dataset.

Why not freeze the base model?
    The original model is English-first. Japanese tokenization produces
    different subword patterns; the backbone needs to adapt or recall
    drops heavily on Japanese named entities.

Why warm-start the head instead of random-init?
    The existing 8 categories should retain their English detection
    ability. Warm-starting preserves those weights on day 1.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch
import yaml
from datasets import load_from_disk
from transformers import (
    AutoModelForTokenClassification,
    AutoTokenizer,
    DataCollatorForTokenClassification,
    Trainer,
    TrainingArguments,
)


def load_config(path: str) -> dict:
    return yaml.safe_load(Path(path).read_text(encoding="utf-8"))


def build_id_mapping(
    new_labels: list[str],
    old_id2label: dict[int, str],
) -> dict[int, int]:
    """Map each old label id → new label id (for warm-starting the head).
    Skips any old label that doesn't appear in the new set."""
    new_label2id = {lbl: i for i, lbl in enumerate(new_labels)}
    m: dict[int, int] = {}
    for old_id, lbl in old_id2label.items():
        if isinstance(old_id, str):
            old_id = int(old_id)
        if lbl in new_label2id:
            m[old_id] = new_label2id[lbl]
    return m


def warm_start_head(
    new_model: torch.nn.Module,
    base_model: torch.nn.Module,
    id_map: dict[int, int],
) -> None:
    """Copy rows of the base classifier weight/bias into the new one
    for every (old_id → new_id) pair in id_map."""
    # Typical HuggingFace token-classification heads expose ``classifier``
    # or ``score`` as the final Linear. We probe both.
    def find_head(m):
        for name in ("classifier", "score", "cls"):
            if hasattr(m, name):
                sub = getattr(m, name)
                if isinstance(sub, torch.nn.Linear):
                    return sub, name
        return None, None

    old_head, _ = find_head(base_model)
    new_head, _ = find_head(new_model)
    if old_head is None or new_head is None:
        print("WARN: could not locate classification head; skipping warm-start")
        return
    with torch.no_grad():
        for old_id, new_id in id_map.items():
            if old_id < old_head.weight.shape[0] and new_id < new_head.weight.shape[0]:
                new_head.weight[new_id].copy_(old_head.weight[old_id])
                if old_head.bias is not None and new_head.bias is not None:
                    new_head.bias[new_id].copy_(old_head.bias[old_id])
    print(f"warm-started {len(id_map)} label rows from base head")


def compute_metrics_factory(id2label: dict[int, str]):
    from seqeval.metrics import f1_score, precision_score, recall_score

    def compute_metrics(eval_pred):
        preds, labels = eval_pred
        preds = np.argmax(preds, axis=-1)
        true_labels = []
        pred_labels = []
        for p, l in zip(preds, labels):
            true_row = []
            pred_row = []
            for pi, li in zip(p, l):
                if li == -100:
                    continue
                true_row.append(id2label[int(li)])
                pred_row.append(id2label[int(pi)])
            true_labels.append(true_row)
            pred_labels.append(pred_row)
        return {
            "precision": precision_score(true_labels, pred_labels),
            "recall":    recall_score(true_labels, pred_labels),
            "f1":        f1_score(true_labels, pred_labels),
        }

    return compute_metrics


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="train-config.yaml")
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[1]
    cfg = load_config(args.config)
    m_cfg = cfg["model"]
    d_cfg = cfg["data"]
    t_cfg = cfg["training"]

    # Load labels from prepare.py output
    labels_path = root / "labels.json"
    if not labels_path.exists():
        sys.stderr.write("run prepare.py first (labels.json missing)\n")
        return 2
    label_data = json.loads(labels_path.read_text(encoding="utf-8"))
    new_labels: list[str] = label_data["labels"]
    label2id = {lbl: i for i, lbl in enumerate(new_labels)}
    id2label = {i: lbl for lbl, i in label2id.items()}

    # Dataset
    ds_dir = (root / d_cfg["dataset_dir"].lstrip("../")).resolve()
    ds = load_from_disk(str(ds_dir))
    print(f"dataset: train={len(ds['train'])} val={len(ds['validation'])}")

    # Tokenizer
    tokenizer = AutoTokenizer.from_pretrained(m_cfg["tokenizer_id"])

    # Base model (for warm-start source)
    from transformers import AutoConfig
    print("loading base model...")
    base_model = AutoModelForTokenClassification.from_pretrained(m_cfg["base_model_id"])
    old_id2label = base_model.config.id2label

    # New model with extended head
    new_config = AutoConfig.from_pretrained(
        m_cfg["base_model_id"],
        num_labels=len(new_labels),
        id2label=id2label,
        label2id=label2id,
    )
    new_model = AutoModelForTokenClassification.from_pretrained(
        m_cfg["base_model_id"],
        config=new_config,
        ignore_mismatched_sizes=True,   # head shape differs from base
    )
    id_map = build_id_mapping(new_labels, old_id2label)
    warm_start_head(new_model, base_model, id_map)
    del base_model   # free RAM before training

    # Trainer
    data_collator = DataCollatorForTokenClassification(tokenizer)
    args_hf = TrainingArguments(
        output_dir=str((root / t_cfg["output_dir"].lstrip("../")).resolve()),
        num_train_epochs=t_cfg["num_train_epochs"],
        per_device_train_batch_size=t_cfg["per_device_train_batch_size"],
        per_device_eval_batch_size=t_cfg["per_device_eval_batch_size"],
        learning_rate=t_cfg["learning_rate"],
        warmup_ratio=t_cfg["warmup_ratio"],
        weight_decay=t_cfg["weight_decay"],
        lr_scheduler_type=t_cfg["lr_scheduler_type"],
        gradient_accumulation_steps=t_cfg["gradient_accumulation_steps"],
        eval_strategy=t_cfg["eval_strategy"],
        eval_steps=t_cfg["eval_steps"],
        save_strategy=t_cfg["save_strategy"],
        save_steps=t_cfg["save_steps"],
        save_total_limit=t_cfg["save_total_limit"],
        logging_steps=t_cfg["logging_steps"],
        bf16=t_cfg["bf16"],
        fp16=t_cfg["fp16"],
        dataloader_num_workers=t_cfg["dataloader_num_workers"],
        seed=t_cfg["seed"],
        metric_for_best_model=t_cfg["metric_for_best_model"],
        greater_is_better=t_cfg["greater_is_better"],
        load_best_model_at_end=t_cfg["load_best_model_at_end"],
        report_to=t_cfg["report_to"],
    )
    trainer = Trainer(
        model=new_model,
        args=args_hf,
        train_dataset=ds["train"],
        eval_dataset=ds["validation"],
        tokenizer=tokenizer,
        data_collator=data_collator,
        compute_metrics=compute_metrics_factory(id2label),
    )

    trainer.train()
    # Save best model (load_best_model_at_end=True ensures this is best ckpt)
    best_dir = (root / "checkpoints/best").resolve()
    best_dir.mkdir(parents=True, exist_ok=True)
    trainer.save_model(str(best_dir))
    tokenizer.save_pretrained(str(best_dir))
    print(f"best model saved → {best_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
