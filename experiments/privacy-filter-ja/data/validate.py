#!/usr/bin/env python3
"""Span integrity validator for seed.jsonl / generated.jsonl.

Usage:
    python validate.py seed.jsonl [generated.jsonl ...]

Verifies each record has:
- text: str
- annotations: list of {start, end, label}
- 0 <= start < end <= len(text)
- text[start:end] is non-empty
- no zero-width spans
- no span overlaps (warning only — overlaps can be intentional)
- label appears in categories.yaml

Reports error count and exits 1 on any error.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - dev convenience
    sys.stderr.write(
        "PyYAML required. Install: pip install pyyaml\n"
    )
    sys.exit(2)


def load_allowed_labels(yaml_path: Path) -> set[str]:
    data = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    labels: set[str] = set()
    for cat in data.get("existing_categories", []) or []:
        labels.add(cat["name"])
    for cat in data.get("japanese_categories", []) or []:
        labels.add(cat["name"])
    return labels


def validate_record(rec: dict, line_no: int, allowed: set[str]) -> list[str]:
    errs: list[str] = []
    text = rec.get("text")
    ann = rec.get("annotations")
    if not isinstance(text, str):
        errs.append(f"line {line_no}: text missing or non-string")
        return errs
    if ann is None:
        ann = []
    if not isinstance(ann, list):
        errs.append(f"line {line_no}: annotations must be list")
        return errs
    for i, a in enumerate(ann):
        if not isinstance(a, dict):
            errs.append(f"line {line_no}.{i}: annotation not object")
            continue
        s = a.get("start")
        e = a.get("end")
        lbl = a.get("label")
        if not isinstance(s, int) or not isinstance(e, int):
            errs.append(f"line {line_no}.{i}: start/end must be int")
            continue
        if s < 0 or e > len(text) or s >= e:
            errs.append(
                f"line {line_no}.{i}: bad span [{s}:{e}] for text length {len(text)}"
            )
            continue
        span_text = text[s:e]
        if not span_text:
            errs.append(f"line {line_no}.{i}: empty span")
        if not isinstance(lbl, str) or lbl not in allowed:
            errs.append(
                f"line {line_no}.{i}: unknown label {lbl!r} "
                f"(allowed: {sorted(allowed)})"
            )
    # Overlap warning (not an error).
    if len(ann) >= 2:
        sorted_ann = sorted(ann, key=lambda a: (a["start"], a["end"]))
        for a, b in zip(sorted_ann, sorted_ann[1:]):
            if a["end"] > b["start"]:
                # Allowed but unusual — emit as info only.
                sys.stderr.write(
                    f"line {line_no}: span overlap [{a['start']}:{a['end']}]"
                    f" vs [{b['start']}:{b['end']}]\n"
                )
    return errs


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write(f"usage: {sys.argv[0]} FILE.jsonl [...]\n")
        return 2
    root = Path(__file__).resolve().parents[1]
    cats_path = root / "categories.yaml"
    if not cats_path.exists():
        sys.stderr.write(f"categories.yaml not found at {cats_path}\n")
        return 2
    allowed = load_allowed_labels(cats_path)

    total_errs = 0
    total_records = 0
    for arg in sys.argv[1:]:
        path = Path(arg)
        if not path.exists():
            sys.stderr.write(f"{arg}: not found\n")
            total_errs += 1
            continue
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            total_records += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as exc:
                sys.stderr.write(f"{arg}:{line_no}: bad JSON — {exc}\n")
                total_errs += 1
                continue
            for err in validate_record(rec, line_no, allowed):
                sys.stderr.write(f"{arg}:{err}\n")
                total_errs += 1

    print(f"validated {total_records} records, {total_errs} errors")
    return 0 if total_errs == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
