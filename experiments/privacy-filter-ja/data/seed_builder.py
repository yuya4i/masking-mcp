#!/usr/bin/env python3
"""Produce seed.jsonl from readable examples.

Handwritten examples declared here in a span-search form so we never
have to count character offsets by hand. Run:

    python data/seed_builder.py > data/seed.jsonl

Each entry passes through ``rec(text, *entities)`` which locates each
``(value, label)`` pair by ``str.find()``. Building errors (typo in a
value) are caught at generation time, not silently baked into the
JSONL.

The examples intentionally cover:
- all 18 categories (existing 8 + JP 10) with 4-8 solo examples each
- multi-category realistic scenarios (emails, forms, meeting notes)
- negative (no-PII) sentences to teach background class

Total ~180 examples. Expand via generator.py + template pools.
"""
from __future__ import annotations

import json
import sys
from typing import Iterable


def rec(text: str, *entities: tuple[str, str]) -> dict:
    """Locate each (value, label) in ``text`` by find() and return a
    {text, annotations[]} record. Raises on missing value."""
    ann: list[dict] = []
    cursor = 0
    # Track cursor so repeated occurrences in the same text each get a
    # distinct span. Callers pass entities in left-to-right order.
    for val, lbl in entities:
        idx = text.find(val, cursor)
        if idx < 0:
            # Fall back to global search; lets callers use non-strict order
            idx = text.find(val)
        if idx < 0:
            raise ValueError(f"value {val!r} not found in text {text!r}")
        ann.append({"start": idx, "end": idx + len(val), "label": lbl})
        cursor = idx + len(val)
    return {"text": text, "annotations": ann}


def neg(text: str) -> dict:
    """Negative example — no PII annotations, teaches the O class."""
    return {"text": text, "annotations": []}


EXAMPLES: list[dict] = []


# ==================== private_person ====================
EXAMPLES += [
    rec("田中太郎さんが今日の会議に出席します。", ("田中太郎", "private_person")),
    rec("私の上司は佐藤です。", ("佐藤", "private_person")),
    rec("鈴木花子からメッセージを受け取りました。", ("鈴木花子", "private_person")),
    rec("報告者: 山田健司", ("山田健司", "private_person")),
    rec("高橋先生に確認をお願いしました。", ("高橋", "private_person")),
    rec("取引先の渡辺様にご連絡ください。", ("渡辺", "private_person")),
    rec("Please contact John Smith for details.",
        ("John Smith", "private_person")),
    rec("Mary Jonesが今週の担当です。", ("Mary Jones", "private_person")),
]

# ==================== private_email ====================
EXAMPLES += [
    rec("メールはtanaka@example.comまでお願いします。",
        ("tanaka@example.com", "private_email")),
    rec("Contact: john.smith+work@company.co.jp",
        ("john.smith+work@company.co.jp", "private_email")),
    rec("返信先: support@acme-corp.com (土日を除く)",
        ("support@acme-corp.com", "private_email")),
    rec("info@pii-masking.dev へ質問を送ってください",
        ("info@pii-masking.dev", "private_email")),
    rec("差出人: yamada.hanako_dev@startup.io",
        ("yamada.hanako_dev@startup.io", "private_email")),
    rec("CC: team-lead@company.jp, admin@company.jp",
        ("team-lead@company.jp", "private_email"),
        ("admin@company.jp", "private_email")),
]

# ==================== private_phone ====================
EXAMPLES += [
    rec("お問い合わせは 090-1234-5678 まで。",
        ("090-1234-5678", "private_phone")),
    rec("会社代表: 03-1234-5678 (平日 9-17 時)",
        ("03-1234-5678", "private_phone")),
    rec("緊急連絡先 080-8765-4321 を登録してください。",
        ("080-8765-4321", "private_phone")),
    rec("FAX: 06-1111-2222",
        ("06-1111-2222", "private_phone")),
    rec("Call +81-3-1234-5678 from abroad",
        ("+81-3-1234-5678", "private_phone")),
    rec("携帯 070-9999-8888 にかけてください",
        ("070-9999-8888", "private_phone")),
]

# ==================== private_address ====================
EXAMPLES += [
    rec("住所: 東京都港区赤坂1-2-3",
        ("東京都港区赤坂1-2-3", "private_address")),
    rec("配送先は兵庫県明石市大久保町5-6-7で間違いないですか。",
        ("兵庫県明石市大久保町5-6-7", "private_address")),
    rec("実家は北海道札幌市中央区北1条西2丁目にあります。",
        ("北海道札幌市中央区北1条西2丁目", "private_address")),
    rec("Shipping: 1 Main St, San Francisco, CA 94105",
        ("1 Main St, San Francisco, CA 94105", "private_address")),
    rec("大阪府大阪市北区梅田3-4-5 グランフロント大阪",
        ("大阪府大阪市北区梅田3-4-5", "private_address")),
]

# ==================== private_url ====================
EXAMPLES += [
    rec("詳細は https://example.com/docs/intro を参照。",
        ("https://example.com/docs/intro", "private_url")),
    rec("ダウンロード: http://downloads.company.jp/v1.0.zip",
        ("http://downloads.company.jp/v1.0.zip", "private_url")),
    rec("個人ブログ https://blog.tanaka.dev/post/42 を更新しました。",
        ("https://blog.tanaka.dev/post/42", "private_url")),
    rec("資料は https://internal.acme.co.jp/wiki/onboarding です。",
        ("https://internal.acme.co.jp/wiki/onboarding", "private_url")),
]

# ==================== private_date ====================
EXAMPLES += [
    rec("生年月日: 1985/04/12",
        ("1985/04/12", "private_date")),
    rec("DOB 1990-07-28 を記録してください。",
        ("1990-07-28", "private_date")),
    rec("入社日は2020年4月1日です。",
        ("2020年4月1日", "private_date")),
    rec("誕生日 3/14 (お祝いメッセージ送付予定)",
        ("3/14", "private_date")),
    rec("契約日: 令和6年5月15日",
        ("令和6年5月15日", "private_date")),
]

# ==================== secret (API keys / passwords) ====================
EXAMPLES += [
    rec("API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd",
        ("sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd", "secret")),
    rec("Anthropic: sk-ant-api03-xYzAbCdEfGhIjKlMnOpQrStUvWxYz01234567891234567890abcdEfGhIjKlMnOpQrStUvWxYz0123456789aB を使用",
        ("sk-ant-api03-xYzAbCdEfGhIjKlMnOpQrStUvWxYz01234567891234567890abcdEfGhIjKlMnOpQrStUvWxYz0123456789aB", "secret")),
    rec("password=Str0ngP@ssw0rd!2026",
        ("Str0ngP@ssw0rd!2026", "secret")),
    rec("GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 を revoke 済み",
        ("ghp_abcdefghijklmnopqrstuvwxyz0123456789", "secret")),
    rec("DATABASE_URL=postgres://user:hunter2@db.internal:5432/prod",
        ("postgres://user:hunter2@db.internal:5432/prod", "secret")),
    rec("Bearer xoxb-EXAMPLE-0000-EXAMPLE-0000-EXAMPLE-0000-XXXX",
        ("xoxb-EXAMPLE-0000-EXAMPLE-0000-EXAMPLE-0000-XXXX", "secret")),
    rec("OpenAI のキー sk-proj-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX は共有禁止",
        ("sk-proj-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", "secret")),
]

# ==================== account_number ====================
EXAMPLES += [
    rec("クレジット番号: 4111-1111-1111-1111",
        ("4111-1111-1111-1111", "account_number")),
    rec("Visa 4532 0151 1283 0366 を利用",
        ("4532 0151 1283 0366", "account_number")),
    rec("Invoice #INV-20260423-001 を発行",
        ("INV-20260423-001", "account_number")),
    rec("注文番号 PO-987654321 をご確認ください",
        ("PO-987654321", "account_number")),
]

# ==================== private_my_number ====================
EXAMPLES += [
    rec("マイナンバー: 1234 5678 9012",
        ("1234 5678 9012", "private_my_number")),
    rec("個人番号 987654321098 を控えてください。",
        ("987654321098", "private_my_number")),
    rec("マイナンバーカード: 1111 2222 3333",
        ("1111 2222 3333", "private_my_number")),
    rec("私のマイナンバーは 2468 1357 9012 です。",
        ("2468 1357 9012", "private_my_number")),
]

# ==================== private_postal_code_jp ====================
EXAMPLES += [
    rec("郵便番号 〒107-0061",
        ("〒107-0061", "private_postal_code_jp")),
    rec("配送先 〒100-0001 東京都",
        ("〒100-0001", "private_postal_code_jp")),
    rec("POSTAL 651-0087 を記入",
        ("651-0087", "private_postal_code_jp")),
    rec("〒530-0001 大阪府大阪市北区",
        ("〒530-0001", "private_postal_code_jp"),
        ("大阪府大阪市北区", "private_address")),
]

# ==================== private_prefecture ====================
EXAMPLES += [
    rec("出身は兵庫県です。",
        ("兵庫県", "private_prefecture")),
    rec("来週東京都に出張します。",
        ("東京都", "private_prefecture")),
    rec("観光で北海道に行きたい。",
        ("北海道", "private_prefecture")),
    rec("神奈川県と千葉県の支社を回ります。",
        ("神奈川県", "private_prefecture"),
        ("千葉県", "private_prefecture")),
    rec("大阪府の支部長に報告",
        ("大阪府", "private_prefecture")),
    rec("京都府からの案件を対応",
        ("京都府", "private_prefecture")),
]

# ==================== private_company_jp ====================
EXAMPLES += [
    rec("株式会社アクメと契約しました。",
        ("株式会社アクメ", "private_company_jp")),
    rec("有限会社テストソリューションズからの提案",
        ("有限会社テストソリューションズ", "private_company_jp")),
    rec("ACME株式会社の田中様",
        ("ACME株式会社", "private_company_jp"),
        ("田中", "private_person")),
    rec("合同会社ZZZに発注しました。",
        ("合同会社ZZZ", "private_company_jp")),
    rec("㈱サンプル商事の営業担当",
        ("㈱サンプル商事", "private_company_jp")),
]

# ==================== private_driver_license_jp ====================
EXAMPLES += [
    rec("免許証番号 12-34-567890-12 を控えました",
        ("12-34-567890-12", "private_driver_license_jp")),
    rec("運転免許 45-67-123456-78",
        ("45-67-123456-78", "private_driver_license_jp")),
    rec("免許 99-88-776655-44 (更新済み)",
        ("99-88-776655-44", "private_driver_license_jp")),
]

# ==================== private_passport_jp ====================
EXAMPLES += [
    rec("パスポート: AB1234567",
        ("AB1234567", "private_passport_jp")),
    rec("旅券番号 TK9876543 で発券",
        ("TK9876543", "private_passport_jp")),
    rec("Passport MJ5555000 はまだ有効期限内です",
        ("MJ5555000", "private_passport_jp")),
]

# ==================== private_annual_income ====================
EXAMPLES += [
    rec("年収1200万円を目指します。",
        ("年収1200万円", "private_annual_income")),
    rec("希望年収 1500万円 を提示",
        ("1500万円", "private_annual_income")),
    rec("月収 40万円 から 60万円 に昇給",
        ("40万円", "private_annual_income"),
        ("60万円", "private_annual_income")),
    rec("年俸制で年収800万円です。",
        ("年収800万円", "private_annual_income")),
    rec("年収 1,200 万円ラインを超える候補者",
        ("1,200 万円", "private_annual_income")),
]

# ==================== private_bank_account_jp ====================
EXAMPLES += [
    rec("振込先: みずほ銀行 普通 1234567",
        ("普通 1234567", "private_bank_account_jp")),
    rec("当座 7654321 (りそな銀行)",
        ("当座 7654321", "private_bank_account_jp")),
    rec("口座番号 普通 9999001 を登録しました",
        ("普通 9999001", "private_bank_account_jp")),
    rec("貯蓄 5555333 に振り込みをお願いします",
        ("貯蓄 5555333", "private_bank_account_jp")),
]

# ==================== private_patient_id_jp ====================
EXAMPLES += [
    rec("患者ID: P-12345",
        ("P-12345", "private_patient_id_jp")),
    rec("MRN PATIENT-77889 を診療録に記載",
        ("PATIENT-77889", "private_patient_id_jp")),
    rec("患者 ID: P-00042 は来週再診予定",
        ("P-00042", "private_patient_id_jp")),
    rec("医療記録番号 MRN-998877",
        ("MRN-998877", "private_patient_id_jp")),
]

# ==================== private_employee_id_jp ====================
EXAMPLES += [
    rec("社員番号 EMP-12345 でログイン",
        ("EMP-12345", "private_employee_id_jp")),
    rec("スタッフID STAFF-00123",
        ("STAFF-00123", "private_employee_id_jp")),
    rec("従業員番号 E-0042 の研修記録",
        ("E-0042", "private_employee_id_jp")),
    rec("EMP-99001 と EMP-99002 は異動",
        ("EMP-99001", "private_employee_id_jp"),
        ("EMP-99002", "private_employee_id_jp")),
]

# ==================== multi-category realistic ====================
EXAMPLES += [
    rec(
        "株式会社アクメの田中太郎 (tanaka@acme.co.jp / 090-1234-5678) が 2026/05/01 に訪問予定",
        ("株式会社アクメ", "private_company_jp"),
        ("田中太郎", "private_person"),
        ("tanaka@acme.co.jp", "private_email"),
        ("090-1234-5678", "private_phone"),
        ("2026/05/01", "private_date"),
    ),
    rec(
        "件名: 採用内定のお知らせ\n佐藤花子様 (社員番号 EMP-20260401) - 年収 1200 万円でのオファーとなります。マイナンバー 1234 5678 9012 を登録してください。",
        ("佐藤花子", "private_person"),
        ("EMP-20260401", "private_employee_id_jp"),
        ("1200 万円", "private_annual_income"),
        ("1234 5678 9012", "private_my_number"),
    ),
    rec(
        "〒107-0061 東京都港区北青山3-6-7 (ACME株式会社) の田中まで。電話 03-5555-6666",
        ("〒107-0061", "private_postal_code_jp"),
        ("東京都港区北青山3-6-7", "private_address"),
        ("ACME株式会社", "private_company_jp"),
        ("田中", "private_person"),
        ("03-5555-6666", "private_phone"),
    ),
    rec(
        "運転免許 12-34-567890-12、パスポート AB1234567 を提出済み。年収 800万円。",
        ("12-34-567890-12", "private_driver_license_jp"),
        ("AB1234567", "private_passport_jp"),
        ("年収 800万円", "private_annual_income"),
    ),
    rec(
        "カルテ情報: 患者ID P-00123 (山田花子、1985-03-22 生、〒530-0001)",
        ("P-00123", "private_patient_id_jp"),
        ("山田花子", "private_person"),
        ("1985-03-22", "private_date"),
        ("〒530-0001", "private_postal_code_jp"),
    ),
    rec(
        "振込先: みずほ銀行 普通 1234567 (株式会社テスト工業)",
        ("普通 1234567", "private_bank_account_jp"),
        ("株式会社テスト工業", "private_company_jp"),
    ),
    rec(
        "詳細は https://internal.acme.co.jp/wiki/onboarding で確認、連絡は admin@acme.co.jp まで。Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz01234567890123456789012345678901234567890123456789abcd がログインキー。",
        ("https://internal.acme.co.jp/wiki/onboarding", "private_url"),
        ("admin@acme.co.jp", "private_email"),
        ("sk-ant-api03-abcdefghijklmnopqrstuvwxyz01234567890123456789012345678901234567890123456789abcd", "secret"),
    ),
    rec(
        "兵庫県明石市の支社長 渡辺 (watanabe@branch.jp / 078-9999-0000)",
        ("兵庫県", "private_prefecture"),
        ("渡辺", "private_person"),
        ("watanabe@branch.jp", "private_email"),
        ("078-9999-0000", "private_phone"),
    ),
]

# ==================== negative (no PII) ====================
EXAMPLES += [
    neg("今日の会議は延期になりました。"),
    neg("プロジェクトの進捗を共有してください。"),
    neg("明日のミーティングでは議題 3 点を扱います。"),
    neg("レポートのレビューをお願いします。"),
    neg("新しい機能の仕様書を読みました。"),
    neg("オフィスのコーヒーマシンが壊れました。"),
    neg("来週のリリースに向けてテストを進めます。"),
    neg("会社のWi-Fiパスワードを教えてください。"),
    neg("The deployment pipeline is stable this week."),
    neg("システムのパフォーマンスが改善されました。"),
    neg("チームのボードゲーム大会を企画中です。"),
    neg("お疲れさまです、本日の議事録を共有します。"),
    neg("週末の天気予報を確認してください。"),
    neg("ドキュメントの更新が必要です。"),
    neg("API の設計方針について議論しました。"),
    neg("バグ修正のレビューお願いします。"),
    neg("この機能は来月リリース予定です。"),
    neg("会議室を 30 分予約しました。"),
    neg("ランチは12時からです。"),
    neg("テスト環境で検証を実施します。"),
]


def main() -> int:
    out = sys.stdout
    for ex in EXAMPLES:
        out.write(json.dumps(ex, ensure_ascii=False) + "\n")
    sys.stderr.write(f"emitted {len(EXAMPLES)} records\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
