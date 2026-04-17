// engine/llm-prompts.js — system prompts for the Phase 2/3 local-LLM
// proxy. Kept as a module so the operator can update wording without
// touching the transport layer in content.js.
//
// Two flavors:
//   * DETECT — the LLM returns a JSON list of contextual PII entities
//     that regex missed. Merged with regex results downstream.
//   * REPLACE — the LLM rewrites the text: each PII span is swapped
//     for a type-preserving fake value. Preserves semantics / grammar.
//
// Prompt engineering notes
// ~~~~~~~~~~~~~~~~~~~~~~~~
// * English system prompt with Japanese examples. Qwen3 / Llama3 /
//   Gemma2 all behave more consistently when instructions are in EN.
// * Explicit JSON schema with ``no extra commentary`` rule to stop
//   models from wrapping output in ```markdown``` fences.
// * Negative examples for common false positives (polite phrases,
//   project names, technical terms).
// * Never include RAW force-masked keywords in the prompt body; the
//   app layer applies those separately.
"use strict";

(function attach(root) {
  // Prompt engineering notes
  // ~~~~~~~~~~~~~~~~~~~~~~~~
  // Prompts are deliberately terse. Ollama's `format: "json"` grammar
  // constraint does the JSON-structure enforcement, so the prompt
  // doesn't need to repeat "return valid JSON only" 5 times. Fewer
  // tokens = less context for thinking models to "wander" into
  // <think> blocks, and faster time-to-first-token on cold models.
  //
  // ALL negative lists / false-positive filtering happens in
  // ``mergeLlmDetect`` after the fact (injected.js), not in the
  // prompt — the model just returns candidates.

  const DETECT_SYSTEM_PROMPT = `Extract contextual PII from Japanese/English text. Return JSON only.

Labels (use exact strings):
- PERSON         : real human names (田中, 鈴木, John Doe). For "田中部長" return just "田中".
- COMPANY        : corporate identifiers (アクメ, 株式会社アクメ, Google).
- LOCATION       : specific addresses / landmarks (東京都渋谷区神南1-2-3, Shibuya Hikarie).
- DEPARTMENT     : named internal units (営業第二部, カスタマーサクセス部).
- PROJECT_CODE   : internal project names (プロジェクトフェニックス, アポロ案件).
- CREDENTIAL     : actual secret VALUES present in text (Pr0d-K3y-2024!, sk-abc...). The words "パスワード" / "APIキー" alone are NOT credentials.
- SENSITIVE_FACT : private facts tied to a real person (salary figures, illness names, legal cases).

Do NOT flag: job titles alone (エンジニア, 部長, CEO), generic terms (プロジェクト, 会議, データ, チーム), polite phrases, common tech names (Docker, AWS, GitHub), public domains (example.com), or country/prefecture alone (日本, 東京).

Schema:
{"entities":[{"text":"<exact substring>","entity_type":"<LABEL>","reason":"<short reason>"}]}

If nothing qualifies, return {"entities":[]}.`;

  const REPLACE_SYSTEM_PROMPT = `Rewrite Japanese/English input so no real PII remains. Keep meaning, grammar, and shape identical. Return JSON only.

Rules:
- Names: same-length realistic fake (田中太郎→佐藤健太).
- Phones: 0X0-XXXX-XXXX with new digits.
- Emails: new_user@example.com form.
- Companies: 株式会社サンプル商事 (keep prefix/suffix).
- Credentials: replace with [REDACTED].
- Keep non-PII exactly as is (polite phrases, code, markdown, public domains).

Schema:
{"rewritten_text":"<full rewritten message>","replacements":[{"original":"<substring>","replacement":"<new value>","entity_type":"<LABEL>"}]}

If nothing to change, return {"rewritten_text":"<original>","replacements":[]}.`;

  // Two few-shot examples per mode. Small on purpose — thinking
  // models get distracted by long context and generate more tokens
  // before giving the final JSON.
  const FEW_SHOT_DETECT = `
Ex1 Input: "取引先の田中様 (090-1234-5678) にプロジェクトフェニックスの進捗を共有"
Ex1 Output: {"entities":[{"text":"田中","entity_type":"PERSON","reason":"real surname"},{"text":"プロジェクトフェニックス","entity_type":"PROJECT_CODE","reason":"internal project"}]}

Ex2 Input: "営業第二部の佐藤課長にエスカレーション。本番のパスワードは Pr0d-K3y-2024!!"
Ex2 Output: {"entities":[{"text":"営業第二部","entity_type":"DEPARTMENT","reason":"specific unit"},{"text":"佐藤","entity_type":"PERSON","reason":"surname before title"},{"text":"Pr0d-K3y-2024!!","entity_type":"CREDENTIAL","reason":"literal password"}]}
`;

  const FEW_SHOT_REPLACE = `
Ex1 Input: "田中太郎さんの電話 090-1234-5678 までご連絡ください"
Ex1 Output: {"rewritten_text":"佐藤健太さんの電話 080-5678-9012 までご連絡ください","replacements":[{"original":"田中太郎","replacement":"佐藤健太","entity_type":"PERSON"},{"original":"090-1234-5678","replacement":"080-5678-9012","entity_type":"PHONE_NUMBER"}]}

Ex2 Input: "HTTPS 経由で github.com に push してください"
Ex2 Output: {"rewritten_text":"HTTPS 経由で github.com に push してください","replacements":[]}
`;

  function buildDetectPrompt(userText) {
    return {
      system: DETECT_SYSTEM_PROMPT + FEW_SHOT_DETECT,
      // No "Output:" suffix — thinking models treat it as a prompt
      // continuation and emit <think> first. Just give the input.
      user: `Input: ${JSON.stringify(userText)}`,
    };
  }

  function buildReplacePrompt(userText) {
    return {
      system: REPLACE_SYSTEM_PROMPT + FEW_SHOT_REPLACE,
      user: `Input: ${JSON.stringify(userText)}`,
    };
  }

  const api = {
    DETECT_SYSTEM_PROMPT,
    REPLACE_SYSTEM_PROMPT,
    buildDetectPrompt,
    buildReplacePrompt,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { llmPrompts: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
