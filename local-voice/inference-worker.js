import { splitVoiceTextByTokens } from "./text-pipeline.js?v=6.7.0";
import { POCKET_STANDARD_REVISION, POCKET_STUDIO_REVISION, POCKET_STUDIO_VOICES_REVISION, STANDARD_ASSET_BYTES, STUDIO_ASSET_BYTES, resolveStudioStartup, resolveVoiceQuality, studioVoiceUrl } from "./quality-config.js?v=6.7.0";
import { assertStudioVoiceState, parseVoiceSafetensors } from "./voice-state.js?v=6.7.0";
import { installStudioVoiceRuntime, STUDIO_VOICE_LOADER_KEY } from "./quality-runtime.js?v=6.7.0";
import { installReferenceRuntime } from "./reference-runtime.js?v=6.7.0";
import { createModelAssetLoader } from "./model-download.js?v=6.7.0";
import { installModelSessionRuntime, loadModelSessions, MODEL_SESSION_LOADER_KEY } from "./model-session.js?v=6.7.0";

const RUNTIME_BASE = new URL("./vendor/", import.meta.url);
const STARTUP = resolveStudioStartup(self.location.search);
const QUALITY = resolveVoiceQuality(new URLSearchParams(self.location.search).get("quality"), STARTUP.locale);
const STATIC_PUBLIC_HOST = self.location.hostname.endsWith(".github.io");
const MODEL_BASE = STATIC_PUBLIC_HOST
  ? QUALITY.id === "studio"
    ? `https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/${POCKET_STUDIO_REVISION}`
    : `https://huggingface.co/spaces/KevinAHM/pocket-tts-web/resolve/${POCKET_STANDARD_REVISION}`
  : QUALITY.id === "studio"
    ? `${self.location.origin}/api/models/pocket-studio/${POCKET_STUDIO_REVISION}`
    : `${self.location.origin}/api/models/pocket-tts/${POCKET_STANDARD_REVISION}`;
const WORKER_SHA256 = "dace0a022e17dffcf60fdb7b86e49facf093f709b352fb306c1d6641ae0f5366";
const SENTENCEPIECE_SHA256 = "fc802c6945931e685d82d0f601cda185bb43990870d712119caf5ea74e6e9c56";
const MODEL_ORIGIN = new URL(MODEL_BASE).origin;
const MODEL_DIRECTORY = QUALITY.id === "studio" ? "portuguese_24l" : "portuguese";
const MODEL_PATH_PREFIX = STATIC_PUBLIC_HOST
  ? QUALITY.id === "studio"
    ? `/KevinAHM/pocket-tts-onnx/resolve/${POCKET_STUDIO_REVISION}/onnx/${MODEL_DIRECTORY}/`
    : `/spaces/KevinAHM/pocket-tts-web/resolve/${POCKET_STANDARD_REVISION}/onnx/${MODEL_DIRECTORY}/`
  : QUALITY.id === "studio"
    ? `/api/models/pocket-studio/${POCKET_STUDIO_REVISION}/onnx/${MODEL_DIRECTORY}/`
    : `/api/models/pocket-tts/${POCKET_STANDARD_REVISION}/onnx/${MODEL_DIRECTORY}/`;
const STUDIO_VOICE_PATH_PREFIX = STATIC_PUBLIC_HOST
  ? `/kyutai/pocket-tts-without-voice-cloning/resolve/${POCKET_STUDIO_VOICES_REVISION}/languages/portuguese_24l/embeddings/`
  : `/api/models/pocket-studio-voices/${POCKET_STUDIO_VOICES_REVISION}/languages/portuguese_24l/embeddings/`;
const MODEL_CACHE_NAME = QUALITY.id === "studio"
  ? `audioria-pocket-models-studio-${POCKET_STUDIO_REVISION}-${POCKET_STUDIO_VOICES_REVISION}-v1`
  : `audioria-pocket-models-standard-${POCKET_STANDARD_REVISION}-v2`;
const SENTENCEPIECE_MODULE_KEY = `__audioria_sentencepiece_${SENTENCEPIECE_SHA256.slice(0, 16)}`;
const TEXT_CHUNKER_KEY = "__audioria_unicode_chunker_640";
const EXPECTED_PORTUGUESE_BUNDLE_BYTES = QUALITY.downloadBytes;
const SELECTED_ASSET_BYTES = QUALITY.id === "studio" ? STUDIO_ASSET_BYTES : STANDARD_ASSET_BYTES;
const modelTransferBytes = new Map();
let compiledModelGraphs = 0;
let lastModelProgressAt = 0;
const pendingMessages = [];
const capturePendingMessage = (event) => {
  pendingMessages.push(event.data);
  event.stopImmediatePropagation();
};
self.addEventListener("message", capturePendingMessage);

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
    throw new Error(`Runtime remoto alterado em ${path}; execução bloqueada até revisão.`);
  }
  return source;
}

function isTrustedModelRequest(request) {
  const url = new URL(request.url);
  return request.method === "GET"
    && url.origin === MODEL_ORIGIN
    && url.username === ""
    && url.password === ""
    && (url.pathname.startsWith(MODEL_PATH_PREFIX)
      || (QUALITY.id === "studio" && url.pathname.startsWith(STUDIO_VOICE_PATH_PREFIX)))
    && !url.pathname.includes("%");
}

function isTrustedModelResponse(response) {
  // Static hosting starts from an exact revision-pinned Hugging Face URL.
  // Signed CDN redirects can change origin and path, but remain CORS-checked
  // by the browser; accept only successful CORS responses in that mode.
  if (STATIC_PUBLIC_HOST) return response.ok && response.type === "cors";
  if (!response.url) return false;
  const url = new URL(response.url);
  return url.origin === MODEL_ORIGIN
    && url.username === ""
    && url.password === ""
    && (url.pathname.startsWith(MODEL_PATH_PREFIX)
      || (QUALITY.id === "studio" && url.pathname.startsWith(STUDIO_VOICE_PATH_PREFIX)))
    && !url.pathname.includes("%");
}

function reportModelTransfer(url, loadedBytes, contentLength = 0, phase = "download", detail = {}) {
  const safeLoaded = Number.isFinite(loadedBytes) ? Math.max(0, loadedBytes) : 0;
  const safeLength = Number.isFinite(contentLength) ? Math.max(0, contentLength) : 0;
  modelTransferBytes.set(url, { loaded: safeLoaded, total: safeLength });
  const aggregate = Array.from(modelTransferBytes.values()).reduce((sum, value) => ({
    loaded: sum.loaded + value.loaded,
    total: sum.total + value.total,
  }), { loaded: 0, total: 0 });
  const exactBundle = SELECTED_ASSET_BYTES;
  const expected = Math.max(exactBundle ? Object.values(exactBundle).reduce((sum, size) => sum + size, 0) : EXPECTED_PORTUGUESE_BUNDLE_BYTES, aggregate.total);
  const now = Date.now();
  const complete = safeLength > 0 && safeLoaded >= safeLength;
  if (["download", "cache"].includes(phase) && !complete && safeLoaded > 0 && now - lastModelProgressAt < 250) return;
  lastModelProgressAt = now;
  self.postMessage({
    type: "audioria_model_progress",
    phase,
    file: new URL(url).pathname.split("/").pop() || "modelo",
    loadedBytes: aggregate.loaded,
    totalBytes: expected,
    progress: Math.min(99, Math.min(1, aggregate.loaded / expected) * 84 + compiledModelGraphs / 5 * 16),
    ...detail,
  });
}

function reportModelInitialization(detail) {
  if (detail.phase === "initialized") compiledModelGraphs = detail.current;
  const entry = Array.from(modelTransferBytes.entries()).find(([url]) => new URL(url).pathname.endsWith(`/${detail.file}`));
  if (!entry) return;
  reportModelTransfer(entry[0], entry[1].loaded, entry[1].total, detail.phase, { current: detail.current, total: detail.total });
}

function installVersionedModelCache() {
  const networkFetch = globalThis.fetch.bind(globalThis);
  const loader = createModelAssetLoader({
    networkFetch,
    cacheName: MODEL_CACHE_NAME,
    isTrustedResponse: isTrustedModelResponse,
    expectedBytes: (value) => {
      const url = new URL(value);
      const name = url.pathname.split("/").pop();
      return SELECTED_ASSET_BYTES[name] ?? 0;
    },
    report: ({ url, loadedBytes, totalBytes, phase, attempt, attempts }) => reportModelTransfer(url, loadedBytes, totalBytes, phase, { attempt, attempts }),
  });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!isTrustedModelRequest(request)) {
      try {
        return await networkFetch(request);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "network error";
        throw new TypeError(`Audioria fetch failed for ${request.url}: ${detail}`);
      }
    }

    return loader(request);
  };
}

async function installPinnedSentencePiece(source) {
  const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const sentencePieceModule = await import(moduleUrl);
    Object.defineProperty(globalThis, SENTENCEPIECE_MODULE_KEY, {
      value: sentencePieceModule,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

function replaceExactlyOnce(source, search, replacement, integrationName) {
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`A integração revisada ${integrationName} não corresponde ao runtime fixado.`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`;
}

function installDurationGuard(workerSource, {
  samplerDecodeSteps = 5,
  temperature = 0.5,
  randomSeedSalt = 1,
} = {}) {
  if (!Number.isInteger(samplerDecodeSteps) || samplerDecodeSteps < 1 || samplerDecodeSteps > 8) {
    throw new RangeError("A quantidade de etapas do Estúdio está fora do intervalo revisado.");
  }
  if (!Number.isFinite(temperature) || temperature < 0.1 || temperature > 1) {
    throw new RangeError("A temperatura do Estúdio está fora do intervalo revisado.");
  }
  if (!Number.isSafeInteger(randomSeedSalt) || randomSeedSalt < 0 || randomSeedSalt > 0xffffffff) {
    throw new RangeError("A semente de estabilidade está fora do intervalo revisado.");
  }
  // Mirror Pocket 3.0.2's native generation budget: three text tokens per
  // second plus two seconds of headroom at 12.5 acoustic frames per second.
  // A small word-rate plausibility floor rejects the Portuguese model's
  // occasional *premature* EOS spike. The official token budget remains the
  // hard ceiling, so this cannot restore the old unbounded repetition path.
  let source = replaceExactlyOnce(
    workerSource,
    "        const chunkText = chunks[chunkIdx];",
    `        const audioriaPreparedChunk = prepareTextPrompt(chunks[chunkIdx]);
        const chunkText = audioriaPreparedChunk.text;
        const audioriaFramesAfterEos = audioriaPreparedChunk.framesAfterEos;`,
    "da preparação oficial por trecho",
  );
  source = replaceExactlyOnce(
    source,
    "        const tokenIds = tokenizerProcessor.encodeIds(chunkText);",
    `        const tokenIds = tokenizerProcessor.encodeIds(chunkText);
        const audioriaWordCount = chunkText.trim().split(/\\s+/u).filter(Boolean).length;
        const audioriaMaxFrames = Math.min(
            MAX_FRAMES,
            Math.max(32, Math.ceil((tokenIds.length / 3 + 2) * 12.5))
        );
        const audioriaMinimumEosFrame = Math.min(
            audioriaMaxFrames - audioriaFramesAfterEos - 1,
            Math.max(6, Math.ceil(audioriaWordCount * 3.25))
        );`,
    "do teto nativo guiado pelos tokens",
  );
  source = replaceExactlyOnce(
    source,
    "            const isEos = eosLogit > -4.0;",
    "            const isEos = eosLogit > -4.0 && step >= audioriaMinimumEosFrame;",
    "da rejeição de EOS precoce em português",
  );
  source = replaceExactlyOnce(
    source,
    "const LSD_STEPS = 1;",
    `const LSD_STEPS = ${samplerDecodeSteps};`,
    "da decodificação Estúdio Max em cinco etapas",
  );
  // Match manifest fills for every dtype, including boolean first-call flags.
  // This is a state-initialization fix, not a guarantee of word completeness.
  source = replaceExactlyOnce(
    source,
    `    } else {
        data = new Float32Array(size);
        if (fill === "nan") {
            data.fill(NaN);
        } else if (fill === "ones") {
            data.fill(1);
        }
    }

    return data;`,
    `    } else {
        data = new Float32Array(size);
    }
    if (fill === "ones") {
        data.fill(dtype === "int64" ? 1n : 1);
    } else if (fill === "nan" && data instanceof Float32Array) {
        data.fill(NaN);
    }

    return data;`,
    "da inicialização tipada dos estados de primeira chamada",
  );
  source = replaceExactlyOnce(
    source,
    "    if (prompt && !/[A-ZÀ-Þ]/.test(prompt[0])) {",
    "    if (/^\\p{Ll}/u.test(prompt) && !/^\\p{Ll}[\\p{L}\\p{M}\\p{N}]*\\p{Lu}/u.test(prompt.split(/\\s+/u)[0])) {",
    "da preservação de nomes com caixa mista",
  );
  const chunkerStart = source.indexOf("function splitTokenIdsIntoChunks(");
  const chunkerEnd = source.indexOf("\nfunction precomputeFlowBuffers(", chunkerStart);
  if (chunkerStart < 0 || chunkerEnd <= chunkerStart) {
    throw new Error("O divisor de texto não corresponde ao motor revisado.");
  }
  source = replaceExactlyOnce(
    source,
    source.slice(chunkerStart, chunkerEnd),
    `function audioriaStableSeed(value) {
    let hash = (2166136261 ^ ${randomSeedSalt >>> 0}) >>> 0;
    const text = String(value ?? "");
    for (let index = 0; index < text.length; index++) {
        hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
    }
    return hash || 1;
}

function closeAudioriaSynthesisPhrase(value) {
    const text = String(value ?? "").trim();
    const parts = text.match(/^(.*?)(["')\\]]*)$/u);
    const body = (parts?.[1] ?? text).trimEnd();
    const closers = parts?.[2] ?? "";
    if (/[.!?…]$/u.test(body)) return body + closers;
    if (/[,;:-]$/u.test(body)) return body.slice(0, -1) + "." + closers;
    return body + "." + closers;
}

function splitIntoBestSentences(text) {
    const prepared = prepareTextPrompt(text.normalize("NFC"));
    const chunks = globalThis[${JSON.stringify(TEXT_CHUNKER_KEY)}](prepared.text, {
        encode: (candidate) => tokenizerProcessor.encodeIds(candidate),
        maxTokens: currentMaxTokenPerChunk,
        language: currentLanguage,
        prepareText: (candidate) => prepareTextPrompt(candidate).text,
    }).map(closeAudioriaSynthesisPhrase);
    return { chunks, framesAfterEos: prepared.framesAfterEos };
}
`,
    "da divisão Unicode sem fragmentar palavras nem acentos",
  );
  source = replaceExactlyOnce(
    source,
    "            const shouldStop = eosStep != null && step >= eosStep + framesAfterEos;",
    "            const shouldStop = eosStep != null && step >= eosStep + audioriaFramesAfterEos;",
    "da cauda oficial específica de cada trecho",
  );
  source = replaceExactlyOnce(
    source,
    "    const firstChunkFrames = 3;",
    "    const firstChunkFrames = 12;",
    "do pré-buffer de qualidade do primeiro fonema",
  );
  source = replaceExactlyOnce(
    source,
    "        const chunkLatents = [];",
    `        let audioriaRandomState = audioriaStableSeed(voiceName + "\\0" + chunkIdx + "\\0" + chunkText);
        const audioriaRandom = () => {
            let value = audioriaRandomState += 0x6D2B79F5;
            value = Math.imul(value ^ value >>> 15, value | 1);
            value ^= value + Math.imul(value ^ value >>> 7, value | 61);
            return ((value ^ value >>> 14) >>> 0) / 4294967296;
        };

        const chunkLatents = [];`,
    "da amostragem determinística por texto",
  );
  const randomCalls = source.match(/Math\.random\(\)/gu) ?? [];
  if (randomCalls.length !== 2) {
    throw new Error("A amostragem do runtime fixado mudou sem revisão.");
  }
  source = source.replaceAll("Math.random()", "audioriaRandom()");
  // Match the current native Pocket pipeline: prepare EACH internal sentence.
  // Splitting trims short-input padding, and the final sentence can be much
  // shorter than the outer request. Its decoder tail must follow its own text.
  source = replaceExactlyOnce(
    source,
    "        for (let step = 0; step < MAX_FRAMES; step++) {",
    "        for (let step = 0; step < audioriaMaxFrames; step++) {",
    "do laço autoregressivo limitado",
  );
  source = replaceExactlyOnce(
    source,
    "        if (chunkEnded && isGenerating && chunkIdx < chunks.length - 1) {",
    `        if (!chunkEnded && isGenerating) {
            throw new Error(
                "AUDIORIA_DURATION_LIMIT: a voz não encerrou no limite seguro; geração bloqueada para evitar repetição."
            );
        }

        if (chunkEnded && isGenerating && chunkIdx < chunks.length - 1) {`,
    "da falha segura após o limite",
  );
  // Pocket 3.0.2 emits 5/3 frames including its post-EOS drain. This web loop
  // decodes the stop frame before breaking, so 4/2 yields the same effective
  // 5/3 frames instead of one extra opportunity to repeat a word.
  source = replaceExactlyOnce(
    source,
    "    let framesAfterEos = wordCount <= 4 ? 3 : 1;",
    "    let framesAfterEos = wordCount <= 4 ? 4 : 2;",
    "da cauda acústica oficial do Pocket 3.0.2",
  );
  source = replaceExactlyOnce(
    source,
    "        framesAfterEos = Number(bundleMetadata.model_recommended_frames_after_eos);",
    "        framesAfterEos = Math.max(framesAfterEos, Number(bundleMetadata.model_recommended_frames_after_eos));",
    "da recomendação de cauda sem regressão",
  );
  // The reviewed web runtime prefers Alba whenever that name is present,
  // including inside the Portuguese bundle. Prefer Pocket's native Portuguese
  // catalogue voice Rafael; falling back preserves every other language.
  source = replaceExactlyOnce(
    source,
    '    let defaultVoice = bundleMetadata.predefined_voices?.includes("alba") ? "alba" : null;',
    `    let defaultVoice = currentLanguage === "portuguese" && bundleMetadata.predefined_voices?.includes("rafael")
        ? "rafael"
        : bundleMetadata.predefined_voices?.includes("alba") ? "alba" : null;`,
    "da voz nativa padrão em português",
  );
  // Pocket's documented high-quality recipe combines five flow-decoder passes
  // with temperature 0.5. This route is PT-BR-only and intentionally favors
  // fidelity and generation stability over speed.
  source = replaceExactlyOnce(
    source,
    "            const temperature = 0.7;",
    `            const temperature = ${temperature};`,
    "da temperatura Estúdio Max",
  );
  return source;
}

async function boot() {
  const startupLanguage = STARTUP;
  const [workerSource, sentencePieceSource] = await Promise.all([
    fetchPinnedSource("inference-worker.js", WORKER_SHA256),
    fetchPinnedSource("sentencepiece.js?v=3", SENTENCEPIECE_SHA256),
  ]);
  await installPinnedSentencePiece(sentencePieceSource);
  Object.defineProperty(globalThis, TEXT_CHUNKER_KEY, {
    value: splitVoiceTextByTokens,
    configurable: false,
    writable: false,
  });
  installVersionedModelCache();
  Object.defineProperty(globalThis, MODEL_SESSION_LOADER_KEY, {
    value: (files, createSession) => loadModelSessions(files, createSession, {
      fetchModel: globalThis.fetch,
      onStage: reportModelInitialization,
    }),
    configurable: false,
    writable: false,
  });
  if (QUALITY.id === "studio") {
    Object.defineProperty(globalThis, STUDIO_VOICE_LOADER_KEY, {
      value: async (name) => {
        const pinnedUrl = studioVoiceUrl(name);
        const voiceUrl = STATIC_PUBLIC_HOST ? pinnedUrl : `${self.location.origin}${STUDIO_VOICE_PATH_PREFIX}${name}.safetensors`;
        const response = await fetch(voiceUrl);
        if (!response.ok) throw new Error("Não foi possível carregar a referência de voz Estúdio.");
        const bytes = await response.arrayBuffer();
        if (name === "rafael") {
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
          if (hash !== "f51d1b95e3510c1a7b05efe81693cd52cdcde261464179cde8410a14b98ee5e6") throw new Error("Integridade da referência de voz não confirmada.");
        }
        return assertStudioVoiceState(parseVoiceSafetensors(bytes));
      },
      configurable: false,
      writable: false,
    });
  }

  const sentencePieceImport = 'await import("./sentencepiece.js?v=3")';
  if (!workerSource.includes(sentencePieceImport)) {
    throw new Error("O runtime não contém a integração SentencePiece revisada.");
  }

  let source = installDurationGuard(workerSource, {
    samplerDecodeSteps: QUALITY.samplerDecodeSteps,
    temperature: QUALITY.temperature,
  });
  // Studio keeps Pocket's native full-context codec pass for the closest
  // possible timbre match. The mobile profile windows only the codec input to
  // bound peak memory; both retain every selected reference frame.
  source = installReferenceRuntime(source, { windowed: QUALITY.id !== "studio" });
  if (QUALITY.id === "studio") source = installStudioVoiceRuntime(source);
  source = installModelSessionRuntime(source);
  source = source
    .replace(
      'const DEFAULT_LANGUAGE = "english_2026-04";',
      `const DEFAULT_LANGUAGE = ${JSON.stringify(startupLanguage.engineLanguage)};`,
    )
    .replace(
      'return `./onnx/${language}`;',
      `return ${JSON.stringify(`${MODEL_BASE}/onnx/${MODEL_DIRECTORY}`)};`,
    )
    .replace(
      sentencePieceImport,
      `globalThis[${JSON.stringify(SENTENCEPIECE_MODULE_KEY)}]`,
    );
  source = replaceExactlyOnce(
    source,
    "const ortModule = await import(`https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/ort.min.mjs`);",
    `let ortModule;
    try {
        ortModule = await import(\`https://cdn.jsdelivr.net/npm/onnxruntime-web@\${version}/dist/ort.min.mjs\`);
    } catch (error) {
        throw new Error(\`AUDIORIA_ORT_IMPORT: \${error instanceof Error ? error.message : "network error"}\`);
    }`,
    "do diagnóstico do ONNX Runtime",
  );
  const runtimeErrorPost = 'postMessage({ type: "error", error: err.toString() });';
  if (source.split(runtimeErrorPost).length - 1 !== 2) {
    throw new Error("O runtime não contém os dois limites de erro revisados.");
  }
  source = source.replaceAll(
    runtimeErrorPost,
    'postMessage({ type: "error", error: "AUDIORIA_RUNTIME_640: " + (err?.stack || err?.toString() || "unknown error") });',
  );

  const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    await import(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }

  self.removeEventListener("message", capturePendingMessage);
  const runtimeHandler = self.onmessage;
  if (typeof runtimeHandler !== "function") throw new Error("O motor não registrou seu processador de mensagens.");
  for (const data of pendingMessages.splice(0)) {
    await runtimeHandler.call(self, { data });
  }
  self.postMessage({ type: "audioria_runtime", version: "6.7.0" });
}

try {
  await boot();
} catch (error) {
  self.removeEventListener("message", capturePendingMessage);
  self.postMessage({
    type: "error",
    error: `AUDIORIA_BOOT_655: ${error instanceof Error ? error.message : "Falha ao iniciar o motor local"}`,
  });
}
