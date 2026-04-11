"""Japanese proper-noun analyzer backed by SudachiPy.

This module is deliberately self-contained: it exposes a small analyzer
class that returns plain dataclass instances and has no dependency on
Presidio. The ``MaskingService`` integration lifts those records into
``RecognizerResult`` objects at call time so the rest of the pipeline
(allow-list filtering, strategy application, detection reporting) keeps
working unchanged.

The analyzer only reports morphemes whose part-of-speech tuple starts
with ``("名詞", "固有名詞", ...)``. Everything else — including the
otherwise plentiful ``("名詞", "一般", ...)`` common nouns — is dropped.
This matches the explicit product requirement:

    形態素解析で固有名詞を抽出してマスクし、一般名詞はマスクしない

``SudachiPy 0.6+`` returns codepoint-based offsets from
``Morpheme.begin()`` / ``Morpheme.end()``, which means the reported
``start`` / ``end`` spans can be used directly to slice the original
Python ``str`` — no byte-to-char translation is needed. The
``tests/test_sudachi_analyzer.py`` suite pins that invariant so a
future SudachiPy regression would fail loudly instead of silently
producing garbled spans.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from sudachipy import Dictionary, SplitMode, Tokenizer


#: Sudachi offers three split granularities.  ``C`` keeps multi-morpheme
#: proper nouns fused together (e.g. ``東京タワー`` as a single token)
#: and is the correct default for masking-oriented use cases where we
#: would rather over-span than split a name in half. ``A`` splits the
#: same string into its constituent morphemes, ``B`` sits in the middle.
SudachiSplitMode = Literal["A", "B", "C"]


@dataclass(frozen=True)
class SudachiDetection:
    """A single proper-noun span detected by Sudachi.

    Offsets are codepoint-based, matching what ``MaskingService`` stores
    for Presidio detections so the two sources can be merged without
    any translation step. ``score`` is always ``1.0`` for now — Sudachi
    does not return a per-morpheme confidence, and a fixed score keeps
    the overlap resolver in ``masking_service.py`` simple.
    """

    entity_type: str
    start: int
    end: int
    score: float
    surface: str


#: Map of Sudachi's third POS slot (``pos[2]``) to the detection's
#: ``entity_type``. Everything not in this table falls back to the
#: generic ``PROPER_NOUN`` tag.
_FINE_POS_TO_ENTITY: dict[str, str] = {
    "人名": "PROPER_NOUN_PERSON",
    "地名": "PROPER_NOUN_LOCATION",
    "組織": "PROPER_NOUN_ORG",
}


def _split_mode_from_str(mode: SudachiSplitMode) -> SplitMode:
    """Translate the string flag from ``RuntimeConfig`` to a ``SplitMode``."""
    if mode == "A":
        return SplitMode.A
    if mode == "B":
        return SplitMode.B
    if mode == "C":
        return SplitMode.C
    raise ValueError(f"unknown Sudachi split mode: {mode!r} (expected 'A', 'B', or 'C')")


class SudachiProperNounAnalyzer:
    """Extract Japanese proper-noun spans using SudachiPy.

    Instantiating this class loads the Sudachi dictionary (~50 MB of
    memory), so ``MaskingService`` lazily creates a single instance the
    first time a request opts in to morphological analysis. Subsequent
    calls reuse the same tokenizer.
    """

    def __init__(self, split_mode: SudachiSplitMode = "C") -> None:
        self._mode: SplitMode = _split_mode_from_str(split_mode)
        self._tokenizer: Tokenizer = Dictionary().create()

    def analyze(self, text: str) -> list[SudachiDetection]:
        """Return every proper-noun morpheme detected in ``text``.

        Empty input returns an empty list without touching the
        tokenizer, which avoids a surprise allocation on the hot path
        when a caller sends a zero-length body.
        """
        if not text:
            return []

        detections: list[SudachiDetection] = []
        for morpheme in self._tokenizer.tokenize(text, self._mode):
            pos = morpheme.part_of_speech()
            # The POS tuple is always length 6 for modern Sudachi
            # dictionaries; the first two slots hold the coarse-grained
            # category we care about. Keep only 固有名詞 ("proper noun")
            # and explicitly drop 一般 ("common noun") plus everything
            # else (particles, verbs, symbols, ...).
            if len(pos) < 2 or pos[0] != "名詞" or pos[1] != "固有名詞":
                continue

            fine = pos[2] if len(pos) > 2 else ""
            entity_type = _FINE_POS_TO_ENTITY.get(fine, "PROPER_NOUN")

            detections.append(
                SudachiDetection(
                    entity_type=entity_type,
                    start=morpheme.begin(),
                    end=morpheme.end(),
                    score=1.0,
                    surface=morpheme.surface(),
                )
            )
        return detections
