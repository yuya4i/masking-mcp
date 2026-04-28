// offscreen.js — ML inference host for transformers.js.
//
// Why this file exists
// --------------------
// The MV3 service worker cannot run transformers.js because the WASM
// backend in onnxruntime-web uses dynamic `import()`, which the HTML
// spec forbids on `ServiceWorkerGlobalScope`. The fix is to host the
// pipeline in an offscreen document, which is a hidden DOM-bearing
// extension context where dynamic imports are allowed.
//
// Message protocol
// ----------------
// All messages from the service worker to this offscreen document are
// tagged with `target: "offscreen"` so the SW's own onMessage listener
// can ignore them and we don't accidentally answer messages from the
// page world. Two types are handled:
//   * ML_DETECT  — run NER over `message.text`, respond with aggregated
//                  entity spans.
//   * ML_PREWARM — build the pipeline (forces model download / load)
//                  without running inference.
//
// Both responses use the same shape as the original SW handler so the
// content-script-side onnx-detector.js doesn't need to change.

import {
  pipeline as transformersPipeline,
  env as transformersEnv,
} from "./vendor/transformers/transformers.min.js";

transformersEnv.backends.onnx.wasm.wasmPaths =
  chrome.runtime.getURL("vendor/transformers/");
transformersEnv.allowRemoteModels = true;
transformersEnv.allowLocalModels = false;

const ML_MODEL_ID = "Xenova/distilbert-base-multilingual-cased-ner-hrl";
let mlPipelinePromise = null;

function getMlPipeline() {
  if (!mlPipelinePromise) {
    mlPipelinePromise = transformersPipeline(
      "token-classification",
      ML_MODEL_ID,
      { dtype: "q8" }
    ).catch((err) => {
      // Drop the cached promise so the next call retries (e.g., the
      // user grants HF Hub permission after an initial denial).
      mlPipelinePromise = null;
      throw err;
    });
  }
  return mlPipelinePromise;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "offscreen" || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "ML_DETECT") {
    (async () => {
      const text = typeof message.text === "string" ? message.text : "";
      if (!text) {
        sendResponse({ ok: true, entities: [] });
        return;
      }
      try {
        const ner = await getMlPipeline();
        const raw = await ner(text, { aggregation_strategy: "simple" });
        const entities = Array.isArray(raw) ? raw : [];
        sendResponse({ ok: true, entities, modelId: ML_MODEL_ID });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "ML_PREWARM") {
    (async () => {
      try {
        await getMlPipeline();
        sendResponse({ ok: true, modelId: ML_MODEL_ID });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  return false;
});
