// Reviewed, immutable model profiles. No model is fetched by importing this file.
export const POCKET_STUDIO_REVISION = "58a6d00cf13d239b6748cb0769f35c580a8f606c";
export const POCKET_STUDIO_VOICES_REVISION = "e81d79e8194ad4c7ce879c87a4258ef20cbf2487";
// Pocket's current high-quality recipe: five flow-decoder passes at a lower
// temperature. The weights stay identical; this deliberately spends more
// compute to reduce sampling roughness and improve reconstruction quality.
export const STUDIO_SAMPLER_DECODE_STEPS = 5;
export const STUDIO_TEMPERATURE = 0.5;

export const VOICE_QUALITY_PROFILES = Object.freeze({
  studio: Object.freeze({
    id: "studio", layers: 24, downloadBytes: 466_755_162,
    samplerDecodeSteps: STUDIO_SAMPLER_DECODE_STEPS,
    temperature: STUDIO_TEMPERATURE,
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
// These are model-specific 24-layer states, never states from the small model.
export const STUDIO_VOICES = Object.freeze(["rafael", "alba", "azelma", "cosette"]);

export function resolveVoiceQuality(_value, language = "pt-BR") {
  if (!["pt-BR", "portuguese"].includes(language)) {
    throw new RangeError("O Estúdio desta edição gera voz em português do Brasil.");
  }
  return VOICE_QUALITY_PROFILES.studio;
}

// Validate before starting network or model work. Old quality links cannot
// select a removed model, and an unsupported language must never fall back.
export function resolveStudioStartup(search = "") {
  const language = new URLSearchParams(search).get("language") ?? "pt-BR";
  if (!["pt-br", "pt", "portuguese"].includes(language.trim().toLowerCase())) {
    throw new RangeError("O Estúdio desta edição gera voz em português do Brasil.");
  }
  return { engineLanguage: "portuguese", locale: "pt-BR", supported: true };
}

// Both public voice tasks use the same reviewed Portuguese Studio profile.
export const CLONING_PROFILE = Object.freeze({ quality: "studio", language: "pt-BR" });

export function resolveVoiceTaskProfile(action, quality, language = "pt-BR") {
  if (action === "clone") return CLONING_PROFILE;
  if (action !== "tts") throw new RangeError("Tarefa de voz não suportada.");
  resolveVoiceQuality(quality, language);
  return CLONING_PROFILE;
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
