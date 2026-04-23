#!/usr/bin/env python3
"""Template-driven data generator for privacy-filter-ja.

Usage:
    python data/generator.py --count 30000 --seed 42 --out data/generated.jsonl

Each template is a Python f-string-like pattern with typed placeholders
that map to category labels. Example:

    "{PERSON}さんが{DATE}に{COMPANY}を訪問します"

At emit time the generator:
1. Picks a random template.
2. Replaces each {PLACEHOLDER} with a sampled value from the matching
   pool.
3. Records the exact character span of each substitution and tags it
   with the appropriate label from ``categories.yaml``.
4. Writes ``{text, annotations: [...]}`` JSONL.

The generator is deterministic for a given --seed so reruns produce
identical outputs (useful for reproducible training).

Diversity knobs:
- Templates span 10 scenario families (business email, chat, form,
  medical record, HR memo, financial, travel, support ticket, casual,
  multi-entity).
- Each placeholder's sampler varies format (hyphen / space / none),
  so e.g. phone numbers show as "090-1234-5678" / "(090) 1234-5678" /
  "+81-90-1234-5678" / "09012345678" randomly.
- ~15% of emitted records are negatives (no PII) to teach the
  background class. A curated negative pool lives inline below.
"""
from __future__ import annotations

import argparse
import json
import random
import string
import sys
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent
POOL_DIR = ROOT / "pools"


def load_pool(name: str) -> list[str]:
    path = POOL_DIR / f"{name}.txt"
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


# ==================== Pool loaders (cached at import) ====================
SURNAMES = load_pool("surnames_ja")
GIVEN_NAMES = load_pool("given_names_ja")
COMPANY_PREFIXES = load_pool("company_prefixes")
COMPANY_SUFFIXES = load_pool("company_suffixes")
COMPANY_STEMS = load_pool("company_stems")
PREFECTURES = load_pool("prefectures_jp")
CITIES = load_pool("cities_jp")
EMAIL_DOMAINS = load_pool("email_domains")
URL_PATHS = load_pool("url_paths")

# ==================== Sampler functions ====================
# Each returns (value: str, label: str)


def s_person(r: random.Random) -> tuple[str, str]:
    style = r.random()
    if style < 0.5:
        v = r.choice(SURNAMES) + r.choice(GIVEN_NAMES)  # full name
    elif style < 0.85:
        v = r.choice(SURNAMES)                          # last name only
    else:
        # katakana / romaji western-style
        v = r.choice([
            "John Smith", "Mary Jones", "David Kim", "Emma Brown",
            "ジョン", "メアリー", "David", "Emma",
        ])
    return v, "private_person"


def s_email(r: random.Random) -> tuple[str, str]:
    user = r.choice([
        r.choice(SURNAMES),
        (r.choice(SURNAMES) + "." + r.choice(GIVEN_NAMES)).lower() if False else r.choice(["tanaka", "yamada", "suzuki", "kato", "info", "admin", "contact", "support", "sales"]),
        r.choice(["taro", "hanako", "dev", "team", "user", "test"]),
    ])
    # optional tag (+work)
    if r.random() < 0.2:
        user = user + "+" + r.choice(["work", "dev", "priv", "news"])
    domain = r.choice(EMAIL_DOMAINS)
    return f"{user}@{domain}", "private_email"


def s_phone(r: random.Random) -> tuple[str, str]:
    style = r.random()
    if style < 0.4:
        # Japan mobile 0X0-NNNN-NNNN
        prefix = r.choice(["090", "080", "070"])
        a = f"{r.randint(1000, 9999)}"
        b = f"{r.randint(1000, 9999)}"
        v = f"{prefix}-{a}-{b}"
    elif style < 0.7:
        # Japan landline 0X-NNNN-NNNN
        prefix = r.choice(["03", "06", "045", "052", "075", "092"])
        a = f"{r.randint(1000, 9999)}"
        b = f"{r.randint(1000, 9999)}"
        v = f"{prefix}-{a}-{b}"
    elif style < 0.85:
        # International +81
        a = f"{r.randint(10, 99)}"
        b = f"{r.randint(1000, 9999)}"
        c = f"{r.randint(1000, 9999)}"
        v = f"+81-{a}-{b}-{c}"
    else:
        # No separator
        v = f"0{r.randint(10, 99)}{r.randint(10000000, 99999999)}"
    return v, "private_phone"


def s_address(r: random.Random) -> tuple[str, str]:
    pref = r.choice(PREFECTURES)
    city = r.choice([c for c in CITIES if not c.endswith("区")])  # avoid orphan 区
    # simple 丁目-番地-号
    a = r.randint(1, 10)
    b = r.randint(1, 30)
    c = r.randint(1, 30)
    v = f"{pref}{city}{a}-{b}-{c}"
    return v, "private_address"


def s_url(r: random.Random) -> tuple[str, str]:
    scheme = r.choice(["https://", "http://"])
    domain = r.choice(EMAIL_DOMAINS)  # reuse as domain pool
    path = r.choice(URL_PATHS)
    return f"{scheme}{domain}/{path}", "private_url"


def s_date(r: random.Random) -> tuple[str, str]:
    y = r.randint(1980, 2028)
    m = r.randint(1, 12)
    d = r.randint(1, 28)
    style = r.random()
    if style < 0.3:
        v = f"{y}/{m:02d}/{d:02d}"
    elif style < 0.6:
        v = f"{y}-{m:02d}-{d:02d}"
    elif style < 0.85:
        v = f"{y}年{m}月{d}日"
    else:
        # Reiwa / Heisei
        era_year = y - 2018 if y >= 2019 else y - 1988
        era = "令和" if y >= 2019 else "平成"
        v = f"{era}{era_year}年{m}月{d}日"
    return v, "private_date"


def s_secret(r: random.Random) -> tuple[str, str]:
    style = r.random()
    if style < 0.3:
        # OpenAI-style
        body = "".join(r.choices(string.ascii_letters + string.digits, k=r.randint(32, 50)))
        v = f"sk-proj-{body}"
    elif style < 0.55:
        # GitHub PAT
        body = "".join(r.choices(string.ascii_letters + string.digits, k=36))
        v = f"ghp_{body}"
    elif style < 0.75:
        # Anthropic
        body = "".join(r.choices(string.ascii_letters + string.digits, k=r.randint(80, 95)))
        v = f"sk-ant-api03-{body}"
    elif style < 0.9:
        # password-looking
        body = "".join(r.choices(string.ascii_letters + string.digits + "!@#$%", k=r.randint(10, 18)))
        v = body
    else:
        # Bearer JWT-ish
        body = "".join(r.choices(string.ascii_letters + string.digits + "_-", k=40))
        v = f"xoxb-{body}"
    return v, "secret"


def s_account(r: random.Random) -> tuple[str, str]:
    style = r.random()
    if style < 0.4:
        # Credit card hyphen
        v = f"{r.randint(4000, 4999)}-{r.randint(1000, 9999)}-{r.randint(1000, 9999)}-{r.randint(1000, 9999)}"
    elif style < 0.7:
        # Credit card space
        v = f"{r.randint(4000, 4999)} {r.randint(1000, 9999)} {r.randint(1000, 9999)} {r.randint(1000, 9999)}"
    else:
        # Invoice / PO
        v = r.choice(["INV", "PO", "ORD"]) + "-" + str(r.randint(1000000, 99999999))
    return v, "account_number"


def s_my_number(r: random.Random) -> tuple[str, str]:
    # 12 digits, optional space separator every 4
    digits = "".join(r.choices(string.digits, k=12))
    if r.random() < 0.6:
        v = f"{digits[:4]} {digits[4:8]} {digits[8:]}"
    else:
        v = digits
    return v, "private_my_number"


def s_postal(r: random.Random) -> tuple[str, str]:
    a = r.randint(100, 999)
    b = r.randint(0, 9999)
    prefix = "〒" if r.random() < 0.6 else ""
    v = f"{prefix}{a}-{b:04d}"
    return v, "private_postal_code_jp"


def s_prefecture(r: random.Random) -> tuple[str, str]:
    return r.choice(PREFECTURES), "private_prefecture"


def s_company(r: random.Random) -> tuple[str, str]:
    stem = r.choice(COMPANY_STEMS)
    if r.random() < 0.7:
        pfx = r.choice(COMPANY_PREFIXES)
        v = f"{pfx}{stem}"
    else:
        sfx = r.choice(COMPANY_SUFFIXES)
        v = f"{stem}{sfx}"
    return v, "private_company_jp"


def s_driver(r: random.Random) -> tuple[str, str]:
    a = r.randint(10, 99)
    b = r.randint(10, 99)
    c = r.randint(100000, 999999)
    d = r.randint(10, 99)
    return f"{a}-{b}-{c}-{d}", "private_driver_license_jp"


def s_passport(r: random.Random) -> tuple[str, str]:
    letters = "".join(r.choices(string.ascii_uppercase, k=2))
    digits = r.randint(1000000, 9999999)
    return f"{letters}{digits}", "private_passport_jp"


def s_income(r: random.Random) -> tuple[str, str]:
    amount = r.randint(3, 30) * 100  # 300-3000 万円
    style = r.random()
    if style < 0.4:
        v = f"年収{amount}万円"
    elif style < 0.7:
        v = f"{amount}万円"
    elif style < 0.85:
        v = f"年収 {amount:,} 万円"
    else:
        monthly = amount // 12
        v = f"月収{monthly}万円"
    return v, "private_annual_income"


def s_bank(r: random.Random) -> tuple[str, str]:
    kind = r.choice(["普通", "当座", "貯蓄"])
    num = r.randint(1000000, 9999999)
    style = r.random()
    if style < 0.5:
        v = f"{kind} {num}"
    else:
        v = f"{kind}{num}"
    return v, "private_bank_account_jp"


def s_patient(r: random.Random) -> tuple[str, str]:
    style = r.random()
    if style < 0.4:
        v = f"P-{r.randint(100, 99999)}"
    elif style < 0.7:
        v = f"PATIENT-{r.randint(10000, 999999)}"
    else:
        v = f"MRN-{r.randint(10000, 999999)}"
    return v, "private_patient_id_jp"


def s_employee(r: random.Random) -> tuple[str, str]:
    style = r.random()
    if style < 0.4:
        v = f"EMP-{r.randint(1000, 99999)}"
    elif style < 0.7:
        v = f"E-{r.randint(100, 9999):04d}"
    else:
        v = f"STAFF-{r.randint(10000, 99999)}"
    return v, "private_employee_id_jp"


SAMPLERS: dict[str, Callable[[random.Random], tuple[str, str]]] = {
    "PERSON":     s_person,
    "EMAIL":      s_email,
    "PHONE":      s_phone,
    "ADDRESS":    s_address,
    "URL":        s_url,
    "DATE":       s_date,
    "SECRET":     s_secret,
    "ACCOUNT":    s_account,
    "MY_NUMBER":  s_my_number,
    "POSTAL":     s_postal,
    "PREFECTURE": s_prefecture,
    "COMPANY":    s_company,
    "DRIVER":     s_driver,
    "PASSPORT":   s_passport,
    "INCOME":     s_income,
    "BANK":       s_bank,
    "PATIENT":    s_patient,
    "EMP":        s_employee,
}


# ==================== Templates ====================
# Each template is a string with {PLACEHOLDER} markers. Multiple
# occurrences of the same placeholder get independent samples.

TEMPLATES: list[str] = [
    # Business email
    "{PERSON}さんが今日の会議に出席します。",
    "{PERSON}からメッセージを受け取りました。",
    "件名: 打合せのご案内\n{PERSON}様、ご連絡ありがとうございます。",
    "本日の議事録を {PERSON} 宛に送付しました。",
    "CC: {EMAIL}, {EMAIL}",
    "返信先: {EMAIL}",
    "連絡先は {EMAIL} と {PHONE} です。",
    "{COMPANY}の{PERSON}様 ({EMAIL}) より問合せ。",
    "お問い合わせは {PHONE} まで。",
    "緊急連絡先 {PHONE} を登録してください。",
    # HR / 社員
    "社員番号 {EMP} ({PERSON}) の研修記録",
    "{EMP} は {DATE} 入社予定",
    "{PERSON} の希望年収は {INCOME} です",
    "採用内定: {PERSON}様、{INCOME} でのオファーとなります。",
    # マイナンバー・身分証
    "マイナンバー: {MY_NUMBER}",
    "個人番号 {MY_NUMBER} を控えてください。",
    "運転免許 {DRIVER}",
    "パスポート: {PASSPORT}",
    "{PERSON} の身分証情報 (運転免許 {DRIVER}, パスポート {PASSPORT}) を保管",
    # 住所
    "住所: {ADDRESS}",
    "配送先 {POSTAL} {ADDRESS}",
    "{PREFECTURE}出身の{PERSON}さん",
    "{COMPANY}本社 ({POSTAL} {ADDRESS})",
    # 金融
    "振込先: {BANK}",
    "クレジット番号 {ACCOUNT}",
    "注文番号 {ACCOUNT} をご確認ください",
    "{PERSON} の振込口座: {BANK}",
    # 医療
    "患者ID: {PATIENT}",
    "{PATIENT} ({PERSON}, {DATE} 生)",
    # URL / ドキュメント
    "詳細は {URL} を参照。",
    "ダウンロード: {URL}",
    # API キー / シークレット
    "API_KEY={SECRET}",
    "GITHUB_TOKEN={SECRET}",
    "認証情報 {SECRET} は共有禁止",
    "Bearer {SECRET}",
    # Date only
    "生年月日: {DATE}",
    "入社日 {DATE}",
    "契約日は {DATE} です。",
    # Multi
    "{COMPANY} の {PERSON} ({EMAIL} / {PHONE}) が {DATE} に訪問予定",
    "{PERSON} さん ({EMAIL}) は {COMPANY} のご担当者です",
    "{PERSON} さんのマイナンバー {MY_NUMBER} を登録",
    "住所変更: {ADDRESS} ({POSTAL}) — {PERSON}",
    "経費精算: 社員番号 {EMP}、金額 {INCOME}、振込先 {BANK}",
    "{PERSON} 患者ID {PATIENT}、{PREFECTURE}在住",
    # Chat / casual
    "今度 {PERSON} と {PREFECTURE} 行こう",
    "{PERSON} に {PHONE} で連絡して",
    "{PERSON} がちょっと遅れるって。{EMAIL} にも CC で。",
]

# Negative templates — no PII at all.
NEGATIVE_TEMPLATES: list[str] = [
    "今日の会議は延期になりました。",
    "プロジェクトの進捗を共有してください。",
    "明日のミーティングでは議題3点を扱います。",
    "レポートのレビューをお願いします。",
    "新しい機能の仕様書を読みました。",
    "オフィスのコーヒーマシンが壊れました。",
    "来週のリリースに向けてテストを進めます。",
    "システムのパフォーマンスが改善されました。",
    "バグ修正のレビューお願いします。",
    "この機能は来月リリース予定です。",
    "会議室を30分予約しました。",
    "ランチは12時からです。",
    "お疲れさまです、本日の議事録を共有します。",
    "The deployment pipeline is stable this week.",
    "API の設計方針について議論しました。",
    "ドキュメントの更新が必要です。",
    "週末の天気予報を確認してください。",
    "テスト環境で検証を実施します。",
    "品質チェックを通過しました。",
    "新しい資料をアップロードしました。",
]


def emit_from_template(template: str, r: random.Random) -> dict:
    """Expand a template into {text, annotations}, tracking every
    substitution's character span."""
    out_parts: list[str] = []
    annotations: list[dict] = []
    i = 0
    pos = 0  # current position in the expanded text
    while i < len(template):
        ch = template[i]
        if ch == "{":
            # parse placeholder
            end = template.find("}", i + 1)
            if end < 0:
                raise ValueError(f"unterminated placeholder in {template!r}")
            placeholder = template[i + 1:end]
            sampler = SAMPLERS.get(placeholder)
            if sampler is None:
                raise ValueError(f"unknown placeholder {placeholder!r}")
            value, label = sampler(r)
            annotations.append({
                "start": pos,
                "end": pos + len(value),
                "label": label,
            })
            out_parts.append(value)
            pos += len(value)
            i = end + 1
        else:
            out_parts.append(ch)
            pos += 1
            i += 1
    return {"text": "".join(out_parts), "annotations": annotations}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=20000, help="records to emit")
    ap.add_argument("--seed", type=int, default=42, help="RNG seed")
    ap.add_argument("--out", type=str, required=True, help="output JSONL path")
    ap.add_argument("--negative-ratio", type=float, default=0.15,
                    help="fraction of records that are negative (no PII)")
    args = ap.parse_args()

    r = random.Random(args.seed)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    with out.open("w", encoding="utf-8") as f:
        for _ in range(args.count):
            if r.random() < args.negative_ratio:
                text = r.choice(NEGATIVE_TEMPLATES)
                f.write(json.dumps({"text": text, "annotations": []}, ensure_ascii=False) + "\n")
            else:
                tmpl = r.choice(TEMPLATES)
                rec = emit_from_template(tmpl, r)
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"wrote {args.count} records to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
