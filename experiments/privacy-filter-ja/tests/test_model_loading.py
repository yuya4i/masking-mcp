"""Regression test for task #64: openai/privacy-filter architecture error.

The model at ``openai/privacy-filter`` declares
``model_type = "openai_privacy_filter"`` in its config.json, which is not
registered by transformers < 5.x. Loading via AutoConfig / AutoModel
fails with::

    ValueError: The checkpoint you are trying to load has model type
    `openai_privacy_filter` but Transformers does not recognize this
    architecture.

The fine-tune pipeline (prepare / train / eval) cannot start until this
resolves. The fix bumps ``transformers`` to 5.x where this model type is
natively supported.

This test exercises ``AutoModelForTokenClassification.from_pretrained``
against the cached model snapshot (offline). It is intentionally a
single, minimal integration test — we only need to prove the architecture
error is gone, not audit every property.
"""
from __future__ import annotations

import pytest
from transformers import AutoModelForTokenClassification, AutoTokenizer


# 33 labels = O + 8 entity types × 4 BIOES tags (matches labels.json +
# the base model's config.id2label). Explicit to future-proof against
# the label set expanding in a later PR.
NUM_LABELS = 33


def test_openai_privacy_filter_loads_for_token_classification() -> None:
    """Model loads without ValueError and exposes the expected config."""
    model = AutoModelForTokenClassification.from_pretrained(
        "openai/privacy-filter",
        num_labels=NUM_LABELS,
        ignore_mismatched_sizes=False,
    )
    assert model is not None
    assert model.config.model_type == "openai_privacy_filter"
    assert model.config.num_labels == NUM_LABELS


def test_openai_privacy_filter_tokenizer_loads_via_auto() -> None:
    """AutoTokenizer loads natively in transformers 5.x.

    The 4.x path required a PreTrainedTokenizerFast fallback shim because
    ``TokenizersBackend`` (declared in this checkpoint's
    ``tokenizer_config.json``) was not registered. If this test passes
    after the 5.x bump, the fine-tune pipeline scripts can use
    AutoTokenizer directly without a compat shim.
    """
    tok = AutoTokenizer.from_pretrained("openai/privacy-filter")
    assert tok is not None
    assert tok.vocab_size > 0
    # Offset mapping is required by tokenize_and_align() in prepare.py —
    # assert the fast tokenizer path survives (slow tokenizers don't
    # expose offsets for this model family).
    enc = tok("田中太郎", return_offsets_mapping=True)
    assert "offset_mapping" in enc
    assert len(enc["offset_mapping"]) > 0
