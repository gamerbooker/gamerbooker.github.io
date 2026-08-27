import { resolveStartupVoiceLanguage } from "./text-pipeline.js";

const RUNTIME_BASE = new URL("./vendor/", import.meta.url);
const MODEL_REVISION = "d0c0c79b7712256a32d691c67f20b8ae2e020d00";
const STATIC_PUBLIC_HOST = self.location.hostname.endsWith(".github.io");
const MODEL_BASE = STATIC_PUBLIC_HOST
  ? `https://huggingface.co/spaces/KevinAHM/pocket-tts-web/resolve/${MODEL_REVISION}`
  : `${self.location.origin}/api/models/pocket-tts/${MODEL_REVISION}`;
const WORKER_SHA256 = "dace0a022e17dffcf60fdb7b86e49facf093f709b352fb306c1d6641ae0f5366";
const SENTENCEPIECE_SHA256 = "fc802c6945931e685d82d0f601cda185bb43990870d712119caf5ea74e6e9c56";
const MODEL_ORIGIN = new URL(MODEL_BASE).origin;
const MODEL_PATH_PREFIX = STATIC_PUBLIC_HOST
  ? `/spaces/KevinAHM/pocket-tts-web/resolve/${MODEL_REVISION}/onnx/`
  : `/api/models/pocket-tts/${MODEL_REVISION}/onnx/`;
const MODEL_CACHE_NAME = `audioria-pocket-models-${MODEL_REVISION}-${WORKER_SHA256}`;
const SENTENCEPIECE_MODULE_KEY = `__audioria_sentencepiece_${SENTENCEPIECE_SHA256.slice(0, 16)}`;
const EXPECTED_PORTUGUESE_BUNDLE_BYTES = 190 * 1024 * 1024;
const modelTransferBytes = new Map();
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
    && url.pathname.startsWith(MODEL_PATH_PREFIX)
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
    && url.pathname.startsWith(MODEL_PATH_PREFIX)
    && !url.pathname.includes("%");
}

function reportModelTransfer(url, loadedBytes, contentLength = 0, phase = "download") {
  const safeLoaded = Number.isFinite(loadedBytes) ? Math.max(0, loadedBytes) : 0;
  const safeLength = Number.isFinite(contentLength) ? Math.max(0, contentLength) : 0;
  modelTransferBytes.set(url, { loaded: safeLoaded, total: safeLength });
  const aggregate = Array.from(modelTransferBytes.values()).reduce((sum, value) => ({
    loaded: sum.loaded + value.loaded,
    total: sum.total + value.total,
  }), { loaded: 0, total: 0 });
  const expected = Math.max(EXPECTED_PORTUGUESE_BUNDLE_BYTES, aggregate.total);
  const now = Date.now();
  const complete = safeLength > 0 && safeLoaded >= safeLength;
  if (!complete && safeLoaded > 0 && now - lastModelProgressAt < 250) return;
  lastModelProgressAt = now;
  self.postMessage({
    type: "audioria_model_progress",
    phase,
    file: new URL(url).pathname.split("/").pop() || "modelo",
    loadedBytes: aggregate.loaded,
    totalBytes: expected,
    progress: Math.min(99, aggregate.loaded / expected * 100),
  });
}

function trackModelResponse(response, requestUrl) {
  const contentLength = Number(response.headers.get("content-length")) || 0;
  if (!response.body) {
    reportModelTransfer(requestUrl, contentLength, contentLength, "complete");
    return response;
  }
  let loaded = 0;
  reportModelTransfer(requestUrl, 0, contentLength, "download");
  const trackedBody = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      reportModelTransfer(requestUrl, loaded, contentLength, "download");
      controller.enqueue(chunk);
    },
    flush() {
      reportModelTransfer(requestUrl, Math.max(loaded, contentLength), contentLength, "complete");
    },
  }));
  return new Response(trackedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function installVersionedModelCache() {
  const networkFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!isTrustedModelRequest(request) || !("caches" in globalThis)) {
      try {
        return await networkFetch(request);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "network error";
        throw new TypeError(`Audioria fetch failed for ${request.url}: ${detail}`);
      }
    }

    // Deliberately strip caller headers and credentials. Pocket model assets
    // are public, immutable inputs and must never inherit application secrets.
    // Model requests stay on Audioria's exact, revision-pinned proxy route.
    // The edge proxy owns upstream redirects and its exact file allowlist.
    const cacheRequest = new Request(request.url, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      redirect: "follow",
      cache: "no-store",
    });
    let cache = null;
    try {
      cache = await globalThis.caches.open(MODEL_CACHE_NAME);
      const cached = await cache.match(cacheRequest);
      if (cached) {
        const cachedLength = Number(cached.headers.get("content-length")) || 0;
        reportModelTransfer(cacheRequest.url, cachedLength, cachedLength, "cache");
        return cached;
      }
    } catch {
      // Private browsing/storage denial must not make the voice engine fail.
      cache = null;
    }

    let response;
    try {
      response = await networkFetch(cacheRequest);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "network error";
      throw new TypeError(`Pocket TTS fetch failed for ${new URL(cacheRequest.url).pathname}: ${detail}`);
    }
    if (!isTrustedModelResponse(response)) {
      throw new TypeError("Pocket TTS model redirect rejected");
    }
    const trackedResponse = trackModelResponse(response, cacheRequest.url);
    if (cache && trackedResponse.ok) {
      // The cache namespace follows the reviewed runtime SHA. This avoids
      // mixing model bundles across runtime revisions; it is not a claim that
      // the remotely hosted weight files have their own content hashes.
      void cache.put(cacheRequest, trackedResponse.clone()).catch(() => {});
    }
    return trackedResponse;
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

function installDurationGuard(workerSource) {
  // Pocket emits 1,920 samples per autoregressive frame at 24 kHz (80 ms).
  // A fixed 500-frame ceiling therefore permits 40 seconds *per internal
  // sentence*, even for a handful of characters. Keep generous headroom for
  // slow Portuguese prosody, but fail closed when EOS never arrives.
  let source = replaceExactlyOnce(
    workerSource,
    "        const chunkText = chunks[chunkIdx];",
    `        const chunkText = chunks[chunkIdx];
        const audioriaCodePoints = Array.from(chunkText).length;
        const audioriaWordCount = chunkText.trim().split(/\\s+/u).filter(Boolean).length;
        const audioriaMaxFrames = Math.min(
            MAX_FRAMES,
            Math.max(60, Math.ceil(38 + audioriaCodePoints * 2.2))
        );
        const audioriaMinimumFrames = Math.min(
            audioriaMaxFrames - 8,
            Math.max(
                6,
                Math.ceil(audioriaWordCount * 3.5),
                Math.ceil(audioriaCodePoints / 3)
            )
        );`,
    "do limite proporcional ao texto",
  );
  source = replaceExactlyOnce(
    source,
    "            const isEos = eosLogit > -4.0;",
    "            const isEos = eosLogit > -4.0 && step >= audioriaMinimumFrames;",
    "do piso anti-EOS precoce",
  );
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
  // The reviewed upstream runtime lets bundle metadata overwrite its special
  // short-prompt tail. Portuguese four-word prompts can therefore stop on the
  // release of the final consonant. Preserve six 80 ms decoder frames after
  // EOS for <=4 words (two for longer speech) and treat metadata as a minimum,
  // never as permission to shorten that acoustic tail.
  source = replaceExactlyOnce(
    source,
    "    let framesAfterEos = wordCount <= 4 ? 3 : 1;",
    "    let framesAfterEos = wordCount <= 4 ? 6 : 2;",
    "da cauda acústica para texto curto",
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
  return source;
}

async function boot() {
  const startupLanguage = resolveStartupVoiceLanguage(self.location.search);
  const [workerSource, sentencePieceSource] = await Promise.all([
    fetchPinnedSource("inference-worker.js", WORKER_SHA256),
    fetchPinnedSource("sentencepiece.js?v=3", SENTENCEPIECE_SHA256),
  ]);
  await installPinnedSentencePiece(sentencePieceSource);
  installVersionedModelCache();

  const sentencePieceImport = 'await import("./sentencepiece.js?v=3")';
  if (!workerSource.includes(sentencePieceImport)) {
    throw new Error("O runtime não contém a integração SentencePiece revisada.");
  }

  let source = installDurationGuard(workerSource)
    .replace(
      'const DEFAULT_LANGUAGE = "english_2026-04";',
      `const DEFAULT_LANGUAGE = ${JSON.stringify(startupLanguage.engineLanguage)};`,
    )
    .replace(
      'return `./onnx/${language}`;',
      `return \`${MODEL_BASE}/onnx/\${language}\`;`,
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
    'postMessage({ type: "error", error: "AUDIORIA_RUNTIME_620: " + (err?.stack || err?.toString() || "unknown error") });',
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
  self.postMessage({ type: "model_status", status: "loading", text: "Audioria runtime 6.2.0" });
}

try {
  await boot();
} catch (error) {
  self.removeEventListener("message", capturePendingMessage);
  self.postMessage({
    type: "error",
    error: `AUDIORIA_BOOT_620: ${error instanceof Error ? error.message : "Falha ao iniciar o motor local"}`,
  });
}
