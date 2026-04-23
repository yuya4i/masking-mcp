#!/usr/bin/env bash
# run_pipeline.sh — one-shot pipeline for privacy-filter-ja.
#
# Phases (all can be skipped individually):
#   0. preflight   — python / torch / GPU / HF CLI sanity checks
#   1. venv        — create .venv/, pip install requirements.txt
#   2. generate    — data/generator.py → data/generated.jsonl + validate
#   3. prepare     — train/prepare.py → dataset/ + labels.json
#   4. train       — train/train.py → checkpoints/best
#   5. eval        — eval/eval.py → eval/eval-results.txt
#   6. publish     — publish/push_to_hub.py (requires HF login)
#
# Usage:
#   ./run_pipeline.sh                          # full pipeline w/ defaults
#   ./run_pipeline.sh --count 10000            # smaller dataset
#   ./run_pipeline.sh --skip-train --skip-publish   # data-only
#   ./run_pipeline.sh --from eval              # resume from phase N onwards
#   ./run_pipeline.sh --no-venv                # use current Python env as-is
#
# All paths are resolved relative to this script's own directory so
# you can invoke it from anywhere in the repo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ==================== defaults ====================
COUNT=30000
SEED=42
VENV_DIR=".venv"
USE_VENV=true
REPO="yuya4i/privacy-filter-ja"
DATASET_REPO="yuya4i/privacy-filter-ja-dataset"
FROM_PHASE=0                           # resume from this phase (0 = all)
DO_GENERATE=true
DO_PREPARE=true
DO_TRAIN=true
DO_EVAL=true
DO_PUBLISH=true
PRIVATE_REPO=false

# ==================== color helpers ====================
if [[ -t 1 ]]; then
  C_BOLD=$'\e[1m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'
  C_RED=$'\e[31m'; C_BLUE=$'\e[34m'; C_RESET=$'\e[0m'
else
  C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""; C_RESET=""
fi
say()  { printf "%s==>%s %s\n"  "$C_BLUE"   "$C_RESET" "$*"; }
ok()   { printf "%sOK:%s %s\n"   "$C_GREEN"  "$C_RESET" "$*"; }
warn() { printf "%sWARN:%s %s\n" "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf "%sERR:%s %s\n"  "$C_RED"    "$C_RESET" "$*" >&2; exit 1; }
phase() {
  printf "\n%s━━━ phase %s: %s ━━━%s\n" "$C_BOLD" "$1" "$2" "$C_RESET"
}

# ==================== option parsing ====================
print_help() {
  cat <<EOF
privacy-filter-ja pipeline runner

Options:
  --count <N>              records to generate          (default: ${COUNT})
  --seed <N>               RNG seed                      (default: ${SEED})
  --repo <user/name>       HF model repo id              (default: ${REPO})
  --dataset-repo <id>      HF dataset repo id            (default: ${DATASET_REPO})
  --private                create HF repos as private    (default: public)
  --from <phase>           resume from phase (1-6)       (default: all)
  --venv <path>            venv location                 (default: ${VENV_DIR})
  --no-venv                use current Python as-is (skip venv creation)
  --skip-generate          skip data generation
  --skip-prepare           skip tokenize + dataset prep
  --skip-train             skip GPU training
  --skip-eval              skip evaluation
  --skip-publish           skip HF Hub upload

Phases are numbered 1-6. --from 4 runs train→eval→publish only.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --count)         COUNT="$2";           shift 2 ;;
    --seed)          SEED="$2";            shift 2 ;;
    --repo)          REPO="$2";            shift 2 ;;
    --dataset-repo)  DATASET_REPO="$2";    shift 2 ;;
    --private)       PRIVATE_REPO=true;    shift   ;;
    --from)          FROM_PHASE="$2";      shift 2 ;;
    --venv)          VENV_DIR="$2";        shift 2 ;;
    --no-venv)       USE_VENV=false;       shift   ;;
    --skip-generate) DO_GENERATE=false;    shift   ;;
    --skip-prepare)  DO_PREPARE=false;     shift   ;;
    --skip-train)    DO_TRAIN=false;       shift   ;;
    --skip-eval)     DO_EVAL=false;        shift   ;;
    --skip-publish)  DO_PUBLISH=false;     shift   ;;
    -h|--help)       print_help; exit 0 ;;
    *)               die "unknown option: $1  (see --help)" ;;
  esac
done

# Apply --from N: any phase below N is auto-skipped
if [[ "$FROM_PHASE" -gt 2 ]]; then DO_GENERATE=false; fi
if [[ "$FROM_PHASE" -gt 3 ]]; then DO_PREPARE=false;  fi
if [[ "$FROM_PHASE" -gt 4 ]]; then DO_TRAIN=false;    fi
if [[ "$FROM_PHASE" -gt 5 ]]; then DO_EVAL=false;     fi

# ==================== phase 0: preflight ====================
phase "0/6" "preflight checks"

command -v python3 >/dev/null || die "python3 not found"
PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
say "python: $PY_VER"
[[ "$(printf '%s\n' "3.10" "$PY_VER" | sort -V | head -1)" == "3.10" ]] \
  || warn "python < 3.10 detected — transformers may require 3.10+"

command -v nvidia-smi >/dev/null && GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1) \
  || GPU_NAME="none"
say "gpu: $GPU_NAME"
[[ "$GPU_NAME" == "none" ]] && [[ "$DO_TRAIN" == true ]] \
  && warn "no GPU detected — training will fall back to CPU (extremely slow)"

# ==================== phase 1: venv ====================
PY=python3
if [[ "$USE_VENV" == true ]]; then
  phase "1/6" "virtualenv + deps"
  if [[ ! -d "$VENV_DIR" ]]; then
    say "creating venv at $VENV_DIR"
    python3 -m venv "$VENV_DIR"
  else
    say "reusing existing venv at $VENV_DIR"
  fi
  # shellcheck disable=SC1090,SC1091
  source "$VENV_DIR/bin/activate"
  PY="python"
  say "pip install (quiet)..."
  "$PY" -m pip install --upgrade pip >/dev/null
  "$PY" -m pip install -r train/requirements.txt >/dev/null
  "$PY" -m pip install huggingface_hub pyyaml >/dev/null
  ok "deps installed"
else
  warn "skipping venv — using system python"
fi

# ==================== phase 2: generate ====================
if [[ "$DO_GENERATE" == true ]]; then
  phase "2/6" "data generation"
  "$PY" data/generator.py --count "$COUNT" --seed "$SEED" --out data/generated.jsonl
  "$PY" data/validate.py data/seed.jsonl data/generated.jsonl
  GEN_COUNT=$(wc -l < data/generated.jsonl)
  ok "generated $GEN_COUNT records → data/generated.jsonl"
else
  warn "skipping data generation"
fi

# ==================== phase 3: prepare ====================
if [[ "$DO_PREPARE" == true ]]; then
  phase "3/6" "tokenize + dataset prep"
  (cd train && "$PY" prepare.py --config train-config.yaml)
  ok "dataset ready at dataset/"
else
  warn "skipping prepare"
fi

# ==================== phase 4: train ====================
if [[ "$DO_TRAIN" == true ]]; then
  phase "4/6" "fine-tune on GPU"
  START_T=$(date +%s)
  (cd train && "$PY" train.py --config train-config.yaml)
  ELAPSED=$(( $(date +%s) - START_T ))
  ok "training finished in ${ELAPSED}s → checkpoints/best"
else
  warn "skipping train"
fi

# ==================== phase 5: eval ====================
if [[ "$DO_EVAL" == true ]]; then
  phase "5/6" "evaluation"
  mkdir -p eval
  "$PY" eval/eval.py \
    --model checkpoints/best \
    --test eval/test.jsonl \
    | tee eval/eval-results.txt
  ok "results written to eval/eval-results.txt"
else
  warn "skipping eval"
fi

# ==================== phase 6: publish ====================
if [[ "$DO_PUBLISH" == true ]]; then
  phase "6/6" "publish to Hugging Face Hub"
  # Verify HF credentials before attempting upload
  if ! "$PY" -c 'import huggingface_hub; huggingface_hub.whoami()' >/dev/null 2>&1; then
    warn "HF not logged in — run: huggingface-cli login"
    warn "(or set HF_TOKEN=... in env)"
    die  "aborting publish phase"
  fi
  PRIV_FLAG=""
  if [[ "$PRIVATE_REPO" == true ]]; then PRIV_FLAG="--private"; fi
  "$PY" publish/push_to_hub.py \
    --model checkpoints/best \
    --repo "$REPO" \
    --dataset-repo "$DATASET_REPO" \
    --dataset-dir dataset \
    $PRIV_FLAG
  ok "published: https://huggingface.co/$REPO"
else
  warn "skipping publish"
fi

# ==================== summary ====================
printf "\n%s━━━ pipeline complete ━━━%s\n" "$C_BOLD" "$C_RESET"
[[ "$DO_GENERATE" == true ]] && ok "generated: data/generated.jsonl"
[[ "$DO_PREPARE"  == true ]] && ok "dataset:   dataset/"
[[ "$DO_TRAIN"    == true ]] && ok "model:     checkpoints/best"
[[ "$DO_EVAL"     == true ]] && ok "eval:      eval/eval-results.txt"
[[ "$DO_PUBLISH"  == true ]] && ok "hub:       https://huggingface.co/$REPO"
