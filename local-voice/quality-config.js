// Reviewed, immutable model profiles. No model is fetched by importing this file.
export const POCKET_STANDARD_REVISION = "d0c0c79b7712256a32d691c67f20b8ae2e020d00";
export const POCKET_STUDIO_REVISION = "58a6d00cf13d239b6748cb0769f35c580a8f606c";
export const POCKET_STUDIO_VOICES_REVISION = "e81d79e8194ad4c7ce879c87a4258ef20cbf2487";

export const VOICE_QUALITY_PROFILES = Object.freeze({
  standard: Object.freeze({
    id: "standard", layers: 6, downloadBytes: 190 * 1024 * 1024,
    minimumDeviceMemoryGb: 0, minimumThreads: 0,
  }),
  studio: Object.freeze({
    id: "studio", layers: 24, downloadBytes: 466_755_162,
    minimumDeviceMemoryGb: 8, minimumThreads: 8,
  }),
});

export const STUDIO_MODEL_FILES = Object.freeze({
  mimi_encoder: "mimi_encoder.onnx",
  text_conditioner: "text_conditioner.onnx",
  flow_lm_main: "flow_lm_main_int8.onnx",
  flow_lm_flow: "flow_lm_flow.onnx",
  mimi_decoder: "mimi_decoder.onnx",
});

// These are model-specific 24-layer states, never states from the small model.
export const STUDIO_VOICES = Object.freeze(["rafael", "alba", "azelma", "cosette"]);

export function resolveVoiceQuality(value, language = "pt-BR") {
  return value === "studio" && ["pt-BR", "portuguese"].includes(language)
    ? VOICE_QUALITY_PROFILES.studio : VOICE_QUALITY_PROFILES.standard;
}

export function canUseStudioVoice(deviceMemoryGb, threads) {
  return Number.isFinite(deviceMemoryGb) && deviceMemoryGb >= 8
    && Number.isFinite(threads) && threads >= 8;
}

export function studioBundleUrl() {
  return `https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/${POCKET_STUDIO_REVISION}/onnx/portuguese_24l`;
}

export function studioVoiceUrl(name) {
  if (!STUDIO_VOICES.includes(name)) throw new RangeError("Voz fora do catálogo revisado.");
  return `https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/${POCKET_STUDIO_VOICES_REVISION}/languages/portuguese_24l/embeddings/${name}.safetensors`;
}

const STUDIO_ALLOWED_FILES = new Set([
  ...Object.values(STUDIO_MODEL_FILES), "bundle.json", "tokenizer.model", "bos_before_voice.npy",
].map((file) => `onnx/portuguese_24l/${file}`));
const STUDIO_ALLOWED_VOICES = new Set(STUDIO_VOICES.map((name) => `languages/portuguese_24l/embeddings/${name}.safetensors`));
const PROXY_PROFILES = Object.freeze([
  Object.freeze({
    prefix: `/api/models/pocket-studio/${POCKET_STUDIO_REVISION}/`,
    repository: "KevinAHM/pocket-tts-onnx", revision: POCKET_STUDIO_REVISION,
    isAllowed: (path) => STUDIO_ALLOWED_FILES.has(path),
  }),
  Object.freeze({
    prefix: `/api/models/pocket-studio-voices/${POCKET_STUDIO_VOICES_REVISION}/`,
    repository: "kyutai/pocket-tts-without-voice-cloning", revision: POCKET_STUDIO_VOICES_REVISION,
    isAllowed: (path) => STUDIO_ALLOWED_VOICES.has(path),
  }),
]);

export function resolveStudioProxy(pathname) {
  return PROXY_PROFILES.find((profile) => pathname.startsWith(profile.prefix)) ?? null;
}
