// Reviewed, immutable model profiles. No model is fetched by importing this file.
export const POCKET_STANDARD_REVISION = "d0c0c79b7712256a32d691c67f20b8ae2e020d00";
export const POCKET_STUDIO_REVISION = "58a6d00cf13d239b6748cb0769f35c580a8f606c";
export const POCKET_STUDIO_VOICES_REVISION = "e81d79e8194ad4c7ce879c87a4258ef20cbf2487";

export const VOICE_QUALITY_PROFILES = Object.freeze({
  standard: Object.freeze({
    id: "standard", layers: 6, downloadBytes: 190 * 1024 * 1024,
    recommendedDeviceMemoryGb: 0, recommendedThreads: 0,
  }),
  studio: Object.freeze({
    id: "studio", layers: 24, downloadBytes: 466_755_162,
    recommendedDeviceMemoryGb: 8, recommendedThreads: 8,
  }),
});

export const STUDIO_MODEL_FILES = Object.freeze({
  mimi_encoder: "mimi_encoder.onnx",
  text_conditioner: "text_conditioner.onnx",
  flow_lm_main: "flow_lm_main_int8.onnx",
  flow_lm_flow: "flow_lm_flow.onnx",
  mimi_decoder: "mimi_decoder.onnx",
});

// Exact byte lengths from the pinned repositories, not download estimates.
export const STUDIO_ASSET_BYTES = Object.freeze({
  "bundle.json": 42247, "tokenizer.model": 60995, "bos_before_voice.npy": 4224,
  "mimi_encoder.onnx": 39768446, "text_conditioner.onnx": 16388344,
  "flow_lm_main_int8.onnx": 305144125, "flow_lm_flow.onnx": 39097095,
  "mimi_decoder.onnx": 41471926, "rafael.safetensors": 24777760,
});
export const STANDARD_PT_ASSET_BYTES = Object.freeze({
  "bundle.json": 24371, "tokenizer.model": 60995, "bos_before_voice.npy": 4224,
  "mimi_encoder_int8.onnx": 20779616, "text_conditioner_int8.onnx": 16388384,
  "flow_lm_main_int8.onnx": 76341079, "flow_lm_flow_int8.onnx": 9962530,
  "mimi_decoder_int8.onnx": 22684077, "voices.bin": 52401928,
});

// These are model-specific 24-layer states, never states from the small model.
export const STUDIO_VOICES = Object.freeze(["rafael", "alba", "azelma", "cosette"]);

export function resolveVoiceQuality(value, language = "pt-BR") {
  return value === "studio" && ["pt-BR", "portuguese"].includes(language)
    ? VOICE_QUALITY_PROFILES.studio : VOICE_QUALITY_PROFILES.standard;
}

// The public cloning workflow has one model, independent of TTS preferences.
export const CLONING_PROFILE = Object.freeze({ quality: "studio", language: "pt-BR" });

export function resolveVoiceTaskProfile(action, quality, language) {
  if (action === "clone") return CLONING_PROFILE;
  if (action !== "tts" || !["pt-BR", "en-US", "es-ES"].includes(language)) {
    throw new RangeError("Tarefa ou idioma de voz não suportado.");
  }
  return { quality: resolveVoiceQuality(quality, language).id, language };
}

// Advice only. Unknown or low hardware must never disable a model.
export function isStudioVoiceRecommended(deviceMemoryGb, threads) {
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
