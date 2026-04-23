#!/usr/bin/env python3
"""push_to_hub.py — upload trained model + dataset to Hugging Face Hub.

Prerequisites:
    huggingface-cli login    # or: HF_TOKEN=... in env

Usage:
    python publish/push_to_hub.py \\
        --model ../checkpoints/best \\
        --repo yuya4i/privacy-filter-ja \\
        [--dataset-repo yuya4i/privacy-filter-ja-dataset] \\
        [--dataset-dir ../dataset] \\
        [--private]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from huggingface_hub import HfApi, create_repo


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="local checkpoint dir")
    ap.add_argument("--repo", required=True, help="HF model repo id (user/name)")
    ap.add_argument("--dataset-repo", default=None, help="HF dataset repo id (optional)")
    ap.add_argument("--dataset-dir", default=None, help="local HF Dataset dir")
    ap.add_argument("--private", action="store_true", help="create as private repo")
    ap.add_argument("--commit-message", default="upload privacy-filter-ja")
    args = ap.parse_args()

    api = HfApi()
    root = Path(__file__).resolve().parents[1]

    # Push model
    print(f"push model: {args.model} → {args.repo}")
    create_repo(args.repo, private=args.private, exist_ok=True)
    api.upload_folder(
        folder_path=args.model,
        repo_id=args.repo,
        commit_message=args.commit_message,
    )
    # Add model card
    card_path = root / "publish" / "MODEL_CARD.md"
    if card_path.exists():
        api.upload_file(
            path_or_fileobj=str(card_path),
            path_in_repo="README.md",
            repo_id=args.repo,
            commit_message="add model card",
        )
        print("  model card uploaded")

    # Push dataset (optional)
    if args.dataset_repo and args.dataset_dir:
        dd = Path(args.dataset_dir)
        if not dd.exists():
            sys.stderr.write(f"dataset dir not found: {dd}\n")
        else:
            print(f"push dataset: {dd} → {args.dataset_repo}")
            create_repo(args.dataset_repo, repo_type="dataset",
                        private=args.private, exist_ok=True)
            api.upload_folder(
                folder_path=str(dd),
                repo_id=args.dataset_repo,
                repo_type="dataset",
                commit_message=args.commit_message,
            )

    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
