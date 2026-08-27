import { installLocalVoiceBridge } from "./voice-bridge.js";
import { resolveStartupVoiceLanguage } from "./text-pipeline.js";

const RUNTIME_BASE = new URL("./vendor/", import.meta.url);
const MAIN_SHA256 = "39ef54d15bc41344c39e08468bac86a32a07d8f720e20e592b44ceeb36ac501b";
const PROTOCOL_VERSION = 1;
const WORKER_BOOT_ERROR_HOOK = "__audioriaReportVoiceBootFailure";
const WORKER_MODEL_PROGRESS_HOOK = "__audioriaReportVoiceModelProgress";
let parentBootFailureReported = false;

function reportParentBootFailure(code, error) {
  if (parentBootFailureReported) return;
  parentBootFailureReported = true;
  console.error("Audioria voice engine boot failed:", error);
  if (window.parent === window) return;
  window.parent.postMessage({
    protocolVersion: PROTOCOL_VERSION,
    type: "audioria:voice-error",
    requestId: null,
    code,
  }, window.location.origin);
}

Object.defineProperty(globalThis, WORKER_BOOT_ERROR_HOOK, {
  configurable: true,
  value: (code, error) => reportParentBootFailure(code, error),
});

Object.defineProperty(globalThis, WORKER_MODEL_PROGRESS_HOOK, {
  configurable: true,
  value: (detail) => {
    if (window.parent === window || !detail || typeof detail !== "object") return;
    window.parent.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "audioria:voice-boot-progress",
      requestId: globalThis.__audioriaVoiceBootRequestId ?? null,
      progress: detail.progress,
      loadedBytes: detail.loadedBytes,
      totalBytes: detail.totalBytes,
      file: detail.file,
      phase: detail.phase,
    }, window.location.origin);
  },
});

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchPinnedSource(path, expectedHash) {
  const response = await fetch(new URL(path, RUNTIME_BASE), { cache: "force-cache" });
  if (!response.ok) throw new Error(`Falha ao baixar ${path} (${response.status})`);
  const source = await response.text();
  const actualHash = await sha256Hex(source);
  if (actualHash !== expectedHash) {
    throw new Error("A versão do motor mudou. A Audioria bloqueou a execução até uma nova revisão de segurança.");
  }
  return source;
}

async function boot() {
  const startupLanguage = resolveStartupVoiceLanguage(window.location.search);
  const languageSelect = document.getElementById("language-select");
  if (languageSelect) languageSelect.value = startupLanguage.engineLanguage;
  const source = await fetchPinnedSource("onnx-streaming.js", MAIN_SHA256);
  const playerUrl = new URL("/local-voice/PCMPlayerWorklet.js", window.location.origin).href;
  const workletProbeUrl = new URL("/local-voice/empty-worklet.js", window.location.origin).href;
  const inferenceWorkerUrl = new URL("/local-voice/inference-worker.js", window.location.origin);
  inferenceWorkerUrl.searchParams.set("language", startupLanguage.locale);
  inferenceWorkerUrl.searchParams.set("release", "6.2.0");
  const replacements = [
    // Audioria owns the final PCM taper. The upstream 480-sample (20 ms)
    // in-place fade ran before capture and could attenuate a first phoneme.
    [
      "const FADE_SAMPLES = 480;",
      "const FADE_SAMPLES = 0;",
    ],
    [
      'this.currentLanguage = "english_2026-04";',
      `this.currentLanguage = ${JSON.stringify(startupLanguage.engineLanguage)};`,
    ],
    [
      'from "./PCMPlayerWorklet.js"',
      `from "${playerUrl}"`,
    ],
    [
      'audioContext.audioWorklet.addModule("PCMPlayerWorklet.js")',
      `audioContext.audioWorklet.addModule("${workletProbeUrl}")`,
    ],
    [
      'new Worker("./inference-worker.js?v=16", { type: "module" })',
      `new Worker("${inferenceWorkerUrl.href}", { type: "module" })`,
    ],
    [
      'case "model_status":\n                    this.updateModelStatus(status, text);\n                    break;',
      `case "model_status":
                    this.updateModelStatus(status, text);
                    break;
                case "audioria_model_progress":
                    globalThis[${JSON.stringify(WORKER_MODEL_PROGRESS_HOOK)}]?.(e.data);
                    break;`,
    ],
    [
      'case "error":\n                    console.error("Worker Error:", error);',
      `case "error":
                    if (!this.isWorkerReady) globalThis[${JSON.stringify(WORKER_BOOT_ERROR_HOOK)}]?.("engine_worker_failed", error);
                    console.error("Worker Error:", error);`,
    ],
    [
      'document.addEventListener("DOMContentLoaded", () => {\n    window.app = new PocketTTSStreaming();\n});',
      'if (document.readyState === "loading") {\n    document.addEventListener("DOMContentLoaded", () => { window.app = new PocketTTSStreaming(); }, { once: true });\n} else {\n    window.app = new PocketTTSStreaming();\n}',
    ],
  ];
  let patched = source;
  for (const [expected, replacement] of replacements) {
    if (!patched.includes(expected)) throw new Error("O runtime não corresponde à integração revisada.");
    patched = patched.replace(expected, replacement);
  }
  const moduleUrl = URL.createObjectURL(new Blob([patched], { type: "text/javascript" }));
  try {
    await import(moduleUrl);
    if (!window.app) throw new Error("O runtime local não expôs a instância revisada.");
    installLocalVoiceBridge(window.app);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

try {
  await boot();
} catch (error) {
  const message = error instanceof Error ? error.message : "Não foi possível iniciar o motor local.";
  const status = document.getElementById("stat-status");
  const model = document.querySelector("#model-status .model-status__text");
  if (status) status.textContent = message;
  if (model) model.textContent = "Motor bloqueado com segurança";
  document.body.dataset.runtimeError = "true";
  reportParentBootFailure("engine_boot_failed", error);
}
