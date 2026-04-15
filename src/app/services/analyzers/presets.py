"""Built-in pattern set for Japanese PII detection.

This module defines a comprehensive, categorized set of regex patterns
for detecting sensitive information in Japanese text (and some universal
patterns like IP addresses, URLs, API keys, etc.).  The patterns load
automatically into :class:`RegexAnalyzer` when
``RuntimeConfig.enable_preset_patterns`` is ``True`` (the default), so
operators get broad PII coverage out of the box without configuring
``regex_patterns`` by hand.

Each pattern is a ``(entity_type, regex_string)`` pair — the same shape
the :class:`RegexAnalyzer` constructor expects.  Categories can be
disabled individually via ``RuntimeConfig.disabled_pattern_categories``.

Design decisions
~~~~~~~~~~~~~~~~

* **No new dependencies.** Every pattern is a pure Python ``re`` regex.
* **No catastrophic backtracking.** Character-class ranges are bounded
  (e.g. ``{0,20}`` instead of ``*``), and alternations use fixed
  literals or short character classes — no nested quantifiers.
* **Preset patterns merge *before* user patterns.** If a user supplies
  ``regex_patterns`` in ``RuntimeConfig``, those are appended after the
  presets so they can shadow or extend built-in entity types.
"""

from __future__ import annotations


BUILTIN_PATTERNS: dict[str, list[tuple[str, str]]] = {
    # --- 住所 (Japanese addresses) ---
    "ADDRESS": [
        (
            "ADDRESS",
            r"(?:北海道|(?:東京|京都|大阪)(?:都|府)|.{2,3}県)"
            r"(?:[^\s、。,]{1,6}[市区町村郡])[^\s、。,]{0,20}",
        ),
    ],
    # --- 年齢 ---
    "AGE": [
        ("AGE", r"\d{1,3}\s*(?:歳|才)"),
    ],
    # --- 性別 ---
    "GENDER": [
        ("GENDER", r"(?:男性|女性|その他)"),
    ],
    # --- 金額 (Monetary amounts) ---
    "MONETARY_AMOUNT": [
        ("MONETARY_AMOUNT", r"[¥￥]\s*[\d,]+(?:\.\d+)?(?:\s*円)?"),
        ("MONETARY_AMOUNT", r"\d[\d,]*\s*(?:円|ドル|万円|億円)"),
        ("MONETARY_AMOUNT", r"\$\s*[\d,]+(?:\.\d+)?"),
    ],
    # --- 日付 (Dates — potential DOB) ---
    "DATE": [
        ("DATE", r"\d{4}[/\-年]\d{1,2}[/\-月]\d{1,2}日?"),
        (
            "DATE",
            r"(?:令和|平成|昭和|大正)\s*\d{1,2}\s*年"
            r"(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)?",
        ),
    ],
    # --- 会社名 (Company names) ---
    "COMPANY": [
        (
            "COMPANY",
            r"(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人"
            r"|NPO法人|学校法人|医療法人)\s*[^\s、。,]{1,20}",
        ),
        (
            "COMPANY",
            r"[^\s、。,]{1,20}"
            r"(?:株式会社|有限会社|合同会社|Inc\.|Corp\.|Ltd\.|LLC|Co\.,?\s*Ltd\.)",
        ),
    ],
    # --- IP アドレス ---
    "IP_ADDRESS": [
        ("IP_ADDRESS", r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"),
    ],
    # --- URL ---
    "URL": [
        ("URL", r"https?://[^\s<>\"'、。）]+"),
    ],
    # --- マイナンバー (My Number) ---
    "MY_NUMBER": [
        ("MY_NUMBER", r"\b\d{4}\s*\d{4}\s*\d{4}\b"),
    ],
    # --- 口座番号 (Bank account) ---
    "BANK_ACCOUNT": [
        (
            "BANK_ACCOUNT",
            r"(?:普通|当座|貯蓄)\s*(?:口座)?\s*(?:番号)?\s*[:：]?\s*\d{6,8}",
        ),
    ],
    # --- 免許証番号 ---
    "DRIVERS_LICENSE": [
        ("DRIVERS_LICENSE", r"\b\d{2}\s*-?\s*\d{2}\s*-?\s*\d{6}\s*-?\s*\d{2}\b"),
    ],
    # --- パスポート番号 ---
    "PASSPORT": [
        ("PASSPORT", r"\b[A-Z]{2}\d{7}\b"),
    ],
    # --- データベース接続情報 ---
    "DB_CONNECTION": [
        (
            "DB_CONNECTION",
            r"(?:mysql|postgresql|postgres|mongodb|redis|sqlite)://[^\s]+",
        ),
        (
            "DB_CONNECTION",
            r"(?:database|db_name|dbname|DB_HOST|DB_NAME)\s*[=:]\s*[^\s,;]+",
        ),
    ],
    # --- API キー / シークレット ---
    "API_KEY": [
        ("API_KEY", r"(?:sk|pk|api[_\-]?key|access[_\-]?key)[_\-][\w\-]{20,}"),
        (
            "SECRET",
            r"(?:password|secret|token|api_key|apikey|access_token)\s*[=:]\s*\S{8,}",
        ),
    ],
    # --- プロジェクト名 / 内部識別子 ---
    "INTERNAL_ID": [
        ("INTERNAL_ID", r"\b(?:PRJ|PJ|PROJ|PROJECT)[_\-][\w\-]{3,20}\b"),
        ("INTERNAL_ID", r"\b(?:EMP|STAFF)[_\-]\d{4,10}\b"),
        ("INTERNAL_ID", r"\b(?:TICKET|ISSUE|TASK)[_\-]\d{3,10}\b"),
    ],
    # --- 電話番号 (Japanese phone — supplement Presidio) ---
    "PHONE_NUMBER_JP": [
        ("PHONE_NUMBER", r"0\d{1,4}[-(]\d{1,4}[-)]\d{3,4}"),
        ("PHONE_NUMBER", r"\b0[789]0\d{8}\b"),
    ],
    # --- EMAIL_ADDRESS (permissive — catches uncommon TLDs) ---
    # Permissive RFC-5322-ish pattern: anything with an @, dot, and
    # letters for TLD. Intentionally broader than Presidio's built-in
    # EMAIL_ADDRESS recognizer so uncommon TLDs like ``.fizz`` / ``.xyz``
    # / ``.dev`` / ``.lgbt`` are caught. Presidio's recognizer relies on
    # a hardcoded TLD whitelist and misses newer gTLDs; this preset
    # deliberately falls back to the structural ``user@domain.tld``
    # shape so anything syntactically an email is flagged.
    "EMAIL_ADDRESS": [
        ("EMAIL_ADDRESS", r"\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,63}\b"),
    ],
}


def get_preset_patterns(
    disabled_categories: list[str] | None = None,
) -> list[tuple[str, str]]:
    """Return a flat list of ``(entity_type, pattern)`` for all enabled categories.

    Parameters
    ----------
    disabled_categories:
        Category keys (must match keys of :data:`BUILTIN_PATTERNS`) to
        exclude.  ``None`` or empty list means "everything enabled".
    """
    disabled = set(disabled_categories or [])
    result: list[tuple[str, str]] = []
    for category, patterns in BUILTIN_PATTERNS.items():
        if category not in disabled:
            result.extend(patterns)
    return result


#: Human-readable checklist for documentation / introspection.
CATEGORY_DESCRIPTIONS: dict[str, str] = {
    "ADDRESS": "日本語住所 (都道府県+市区町村)",
    "AGE": "年齢 (〇〇歳/才)",
    "GENDER": "性別 (男性/女性)",
    "MONETARY_AMOUNT": "金額 (円/ドル/$¥)",
    "DATE": "日付 (YYYY/MM/DD, 令和〇年〇月〇日)",
    "COMPANY": "会社名 (株式会社〇〇 等)",
    "IP_ADDRESS": "IPアドレス",
    "URL": "URL (http/https)",
    "MY_NUMBER": "マイナンバー (12桁)",
    "BANK_ACCOUNT": "口座番号",
    "DRIVERS_LICENSE": "免許証番号",
    "PASSPORT": "パスポート番号",
    "DB_CONNECTION": "データベース接続文字列 / DB名",
    "API_KEY": "APIキー / シークレット / トークン",
    "INTERNAL_ID": "プロジェクトID / 従業員ID / チケット番号",
    "PHONE_NUMBER_JP": "日本語電話番号 (090-, 03-, etc.)",
    "EMAIL_ADDRESS": "メールアドレス (Presidio 非依存 / 新規 gTLD 対応)",
}
