// engine/severity.js — pure-JS port of src/app/services/severity.py.
"use strict";

(function attach(root) {
  const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

  const LABEL_TO_SEVERITY = {
    // ---- critical -------------------------------------------------------
    MY_NUMBER: "critical",
    PASSPORT: "critical",
    DRIVERS_LICENSE: "critical",
    CREDIT_CARD: "critical",
    BANK_ACCOUNT: "critical",
    API_KEY: "critical",
    SECRET: "critical",
    DB_CONNECTION: "critical",
    // ---- high -----------------------------------------------------------
    PERSON: "high",
    PROPER_NOUN_PERSON: "high",
    EMAIL_ADDRESS: "high",
    PHONE_NUMBER: "high",
    ADDRESS: "high",
    PATIENT_ID: "high",
    // ---- medium ---------------------------------------------------------
    LOCATION: "medium",
    PROPER_NOUN_LOCATION: "medium",
    PROPER_NOUN_ORG: "medium",
    ORGANIZATION: "medium",
    COMPANY: "medium",
    EMPLOYEE_ID: "medium",
    MEMBER_ID: "medium",
    CUSTOMER_ID: "medium",
    CONTRACT_NUMBER: "medium",
    PURCHASE_ORDER: "medium",
    INVOICE_NUMBER: "medium",
    INTERNAL_ID: "medium",
    DEPARTMENT: "medium",
    ASSET_NUMBER: "medium",
    LICENSE_NUMBER: "medium",
    PATENT_NUMBER: "medium",
    MONETARY_AMOUNT: "medium",
    ANNUAL_INCOME: "medium",
    URL: "medium",
    IP_ADDRESS: "medium",
    // ---- low ------------------------------------------------------------
    AGE: "low",
    GENDER: "low",
    DATE: "low",
    BLOOD_TYPE: "low",
    POSTAL_CODE: "low",
    SKU: "low",
    KATAKANA_NAME: "low",
  };

  function severityFor(label) {
    return Object.prototype.hasOwnProperty.call(LABEL_TO_SEVERITY, label)
      ? LABEL_TO_SEVERITY[label]
      : "low";
  }
  function maxSeverity(severities) {
    const order = Object.fromEntries(SEVERITY_ORDER.map((s, i) => [s, i]));
    let best = "low", bestRank = order.low;
    for (const sev of severities || []) {
      const r = Object.prototype.hasOwnProperty.call(order, sev) ? order[sev] : order.low;
      if (r < bestRank) { best = sev; bestRank = r; }
    }
    return best;
  }

  const api = { SEVERITY_ORDER, LABEL_TO_SEVERITY, severityFor, maxSeverity };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { severity: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
