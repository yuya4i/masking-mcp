// engine/blocklist.js — common-noun blocklist (RuntimeConfig default).
"use strict";

(function attach(root) {
  const DEFAULT_COMMON_NOUN_BLOCKLIST = new Set([
    "プロジェクト",
    "メンバー",
    "チーム",
    "マネージャー",
    "リーダー",
    "ユーザー",
    "クライアント",
    "サーバー",
    "システム",
    "データ",
    "ファイル",
    "フォルダ",
    "フォルダー",
    "レポート",
    "ミーティング",
    "タスク",
    "チケット",
    "スケジュール",
    "ドキュメント",
    "アカウント",
    "パスワード",
    "メッセージ",
    "スタッフ",
    "カスタマー",
    "オフィス",
    "ミーティングルーム",
  ]);

  function shouldDropCommonNoun(surface, blocklist) {
    if (!surface) return false;
    const bl = blocklist instanceof Set ? blocklist
      : blocklist ? new Set(blocklist) : DEFAULT_COMMON_NOUN_BLOCKLIST;
    return bl.has(surface);
  }

  const api = { DEFAULT_COMMON_NOUN_BLOCKLIST, shouldDropCommonNoun };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { blocklist: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
