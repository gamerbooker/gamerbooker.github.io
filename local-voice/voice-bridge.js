import {
  concatenateFloat32,
  LOCAL_VOICE_TEXT_LIMITS,
  normalizeVoiceText,
  prepareVoiceReferencePcm,
  resolveVoiceLanguage,
  splitVoiceText,
  stitchVoiceAudio,
} from "./text-pipeline.js?v=6.5.0";

const PROTOCOL_VERSION = 1;
const MAX_REFERENCE_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_SYNTHESIS = 8;
const MAX_TIMED_SEGMENTS = 200;
const REFERENCE_WAIT_MS = 15_000;
const PREPARATION_TIMEOUT_MS = 120_000;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MIN_SAFE_CHUNK_SECONDS = 4.8;
const MAX_SAFE_CHUNK_SECONDS = 40;
const SAFE_BASE_SECONDS = 3.04;
const SAFE_SECONDS_PER_CODE_POINT = 0.176;

function errorMessage(error) {
  return error instanceof Error ? error.message : "Falha desconhecida no motor local.";
}

function requestIdOf(value, { required = true } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== "string" || !SAFE_REQUEST_ID.test(value)) {
    throw new RangeError("requestId inválido.");
  }
  return value;
}

function codePointLength(value) {
  return Array.from(value).length;
}

export function maximumVoiceSamplesForText(value, sampleRate) {
  if (typeof value !== "string") throw new TypeError("O texto do limite de voz deve ser uma string.");
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new RangeError("A taxa de amostragem do limite de voz é inválida.");
  }
  const seconds = Math.min(
    MAX_SAFE_CHUNK_SECONDS,
    Math.max(MIN_SAFE_CHUNK_SECONDS, SAFE_BASE_SECONDS + codePointLength(value) * SAFE_SECONDS_PER_CODE_POINT),
  );
  return Math.ceil(seconds * sampleRate);
}

function ensureTtsBoundary(value) {
  const text = String(value ?? "").trim();
  return /[.!?…](?:["')\]]*)$/u.test(text) ? text : `${text}.`;
}

function hasControlCodePoint(value) {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 31 || (point >= 127 && point <= 159);
  });
}

function segmentIdOf(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || codePointLength(trimmed) > 128 || hasControlCodePoint(trimmed)) {
      throw new RangeError("Cada segmento precisa de um id textual seguro de até 128 caracteres.");
    }
    return value;
  }
  if (Number.isSafeInteger(value) && value >= 0) return value;
  throw new RangeError("O id de cada segmento deve ser uma string segura ou um inteiro não negativo.");
}

function prepareTimedSegments(value, language, fullText) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TIMED_SEGMENTS) {
    throw new RangeError(`segments deve conter entre 1 e ${MAX_TIMED_SEGMENTS} itens.`);
  }

  const identifiers = new Set();
  const prepared = [];
  let previousStart = 0;
  let rawCharacters = 0;
  let normalizedCharacters = 0;
  const chunks = [];
  const chunkMetadata = [];
  const chunkSegmentIndices = [];

  value.forEach((segment, index) => {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      throw new TypeError(`O segmento ${index + 1} deve ser um objeto.`);
    }
    const id = segmentIdOf(segment.id);
    const identifierKey = `${typeof id}:${String(id)}`;
    if (identifiers.has(identifierKey)) throw new RangeError(`id de segmento duplicado: ${String(id)}.`);
    identifiers.add(identifierKey);

    const start = segment.start;
    const end = segment.end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new RangeError(`O segmento ${String(id)} precisa de start/end finitos e end maior que start.`);
    }
    if (index > 0 && start < previousStart) {
      throw new RangeError(`O segmento ${String(id)} está fora de ordem.`);
    }
    previousStart = start;

    if (typeof segment.text !== "string") {
      throw new TypeError(`O texto do segmento ${String(id)} deve ser uma string.`);
    }
    rawCharacters += codePointLength(segment.text);
    if (rawCharacters > LOCAL_VOICE_TEXT_LIMITS.maxInputCharacters) {
      throw new RangeError(`O texto total dos segmentos deve ter no máximo ${LOCAL_VOICE_TEXT_LIMITS.maxInputCharacters} caracteres.`);
    }
    const segmentPlan = splitVoiceText(segment.text, { language });
    const text = segmentPlan.normalizedText;
    const textCharacters = codePointLength(text);
    normalizedCharacters += textCharacters;
    if (normalizedCharacters > LOCAL_VOICE_TEXT_LIMITS.maxInputCharacters) {
      throw new RangeError(`O texto normalizado dos segmentos deve ter no máximo ${LOCAL_VOICE_TEXT_LIMITS.maxInputCharacters} caracteres.`);
    }
    segmentPlan.chunks.forEach((chunk, chunkIndex) => {
      chunks.push(chunk);
      chunkMetadata.push(segmentPlan.chunkMetadata[chunkIndex]);
      chunkSegmentIndices.push(index);
    });
    prepared.push(Object.freeze({ id, start, end, text }));
  });

  const normalizedText = prepared.map(({ text }) => text).join("\n");
  if (fullText != null) {
    if (typeof fullText !== "string") throw new TypeError("O texto de síntese deve ser uma string.");
    const normalizedFullText = normalizeVoiceText(fullText, language);
    const comparable = (text) => text.replace(/\s+/gu, " ").trim();
    if (comparable(normalizedFullText) !== comparable(normalizedText)) {
      throw new RangeError("text e segments divergem depois da normalização; a geração foi bloqueada.");
    }
  }

  return Object.freeze({
    normalizedText,
    segments: Object.freeze(prepared),
    chunks: Object.freeze(chunks),
    chunkMetadata: Object.freeze(chunkMetadata),
    chunkSegmentIndices: Object.freeze(chunkSegmentIndices),
  });
}

function waitWithTimeout(register, milliseconds, message) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup?.();
      reject(new Error(message));
    }, milliseconds);
    const cleanup = register(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function installLocalVoiceBridge(app) {
  if (!app || typeof app !== "object") throw new TypeError("Pocket TTS não foi inicializado.");
  if (window.parent === window || document.body.dataset.consentGate !== "confirmed") {
    throw new Error("O bridge exige iframe same-origin e consentimento confirmado.");
  }
  if (app.__audioriaBridgeInstalled) return app.__audioriaBridgeInstalled;

  const parentWindow = window.parent;
  const targetOrigin = window.location.origin;
  const originalStartGeneration = app.startGeneration.bind(app);
  const originalFinalizePlayback = app.finalizePlayback.bind(app);
  const originalHandleStreamEnd = app.handleStreamEnd.bind(app);
  const originalBufferOrPlay = app.bufferOrPlay.bind(app);
  const originalResetUI = app.resetUI.bind(app);
  const originalHandleVoiceEncoded = app.handleVoiceEncoded.bind(app);
  const queue = [];
  const recentRequestIds = [];
  const inFlightRequestIds = new Set();
  const languageWaiters = new Map();
  const voiceWaiters = new Set();
  const progressByRequest = new Map();
  let workerObserved = null;
  let engineReady = false;
  let customVoiceReady = false;
  let activeBatch = null;
  let taskRunning = false;
  let referenceWaitTimer = null;
  let ignoreOrphanedStreamEnd = false;

  const postToParent = (message, transfer = []) => {
    if (document.body.dataset.consentGate !== "confirmed") return;
    const payload = { protocolVersion: PROTOCOL_VERSION, ...message };
    const transferable = [...new Set(transfer)].filter((buffer) => (
      buffer instanceof ArrayBuffer && buffer.byteLength > 0
    ));
    if (transferable.length) {
      try {
        parentWindow.postMessage(payload, targetOrigin, transferable);
        return;
      } catch {
        // Older WebViews can reject a transfer list while still supporting structured cloning.
      }
    }
    parentWindow.postMessage(payload, targetOrigin);
  };

  const postError = (requestId, code, error) => {
    postToParent({
      type: "audioria:voice-error",
      requestId: requestId ?? null,
      code,
      message: errorMessage(error),
    });
  };

  const postProgress = (requestId, candidate, phase, detail = {}) => {
    if (!requestId || !Number.isFinite(candidate)) return;
    const previous = progressByRequest.get(requestId) ?? 0;
    const progress = Math.max(previous, Math.min(100, Math.max(0, candidate)));
    progressByRequest.set(requestId, progress);
    postToParent({
      type: "audioria:voice-progress",
      requestId,
      progress,
      phase,
      ...detail,
    });
  };

  const rememberCompleted = (requestId) => {
    if (!requestId) return;
    inFlightRequestIds.delete(requestId);
    recentRequestIds.push(requestId);
    if (recentRequestIds.length > 64) recentRequestIds.shift();
    progressByRequest.delete(requestId);
  };

  const observeWorker = () => {
    if (!app.worker || workerObserved === app.worker) return;
    workerObserved = app.worker;
    workerObserved.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "bundle_loaded" && typeof message.language === "string") {
        const waiter = languageWaiters.get(message.language);
        if (waiter) {
          languageWaiters.delete(message.language);
          waiter.resolve(message);
        }
      }
      if (message.type === "error") {
        const failure = new Error(typeof message.error === "string" ? message.error : "O worker local falhou.");
        for (const waiter of languageWaiters.values()) waiter.reject(failure);
        languageWaiters.clear();
        for (const waiter of voiceWaiters) waiter.reject(failure);
        voiceWaiters.clear();
        if (activeBatch) {
          ignoreOrphanedStreamEnd = true;
          const durationLimitReached = failure.message.includes("AUDIORIA_DURATION_LIMIT");
          abortActiveBatch(
            durationLimitReached ? "pathological_duration" : "worker_error",
            durationLimitReached
              ? new Error("A clonagem entrou em repetição e foi bloqueada. Use uma amostra mais limpa e tente novamente.")
              : failure,
          );
        }
      }
    });
  };

  const signalEngineReady = () => {
    observeWorker();
    if (!app.isWorkerReady || engineReady) return;
    engineReady = true;
    postToParent({
      type: "audioria:voice-engine-ready",
      languages: app.audioriaQuality === "studio" ? ["pt-BR"] : ["pt-BR", "en-US", "es-ES"],
      quality: app.audioriaQuality === "studio" ? "studio" : "standard",
      execution: "local-browser-only",
    });
    void pumpQueue();
  };

  app.resetUI = function audioriaResetUI(...args) {
    const result = originalResetUI(...args);
    signalEngineReady();
    return result;
  };

  app.handleVoiceEncoded = function audioriaHandleVoiceEncoded(voiceName) {
    const result = originalHandleVoiceEncoded(voiceName);
    if (voiceName === "custom") customVoiceReady = true;
    for (const waiter of voiceWaiters) waiter.resolve(voiceName);
    voiceWaiters.clear();
    return result;
  };

  const ensureEngineReady = async () => {
    signalEngineReady();
    if (engineReady) return;
    await waitWithTimeout((resolve, reject) => {
      const check = window.setInterval(() => {
        signalEngineReady();
        if (engineReady) {
          window.clearInterval(check);
          resolve();
        }
      }, 100);
      return () => {
        window.clearInterval(check);
        reject(new Error("O motor local não ficou pronto."));
      };
    }, PREPARATION_TIMEOUT_MS, "Tempo excedido ao iniciar o motor local.");
  };

  const ensureLanguage = async (language) => {
    const resolved = resolveVoiceLanguage(language, { strict: true });
    if (app.audioriaQuality === "studio" && resolved.locale !== "pt-BR") {
      throw new RangeError("O modo Estúdio usa português. Troque o idioma na Audioria para carregar outro motor.");
    }
    await ensureEngineReady();
    if (app.currentLanguage === resolved.engineLanguage && !app.isVoicePreparing) return resolved;

    const pending = waitWithTimeout((resolve, reject) => {
      languageWaiters.set(resolved.engineLanguage, { resolve, reject });
      return () => languageWaiters.delete(resolved.engineLanguage);
    }, PREPARATION_TIMEOUT_MS, "Tempo excedido ao carregar o idioma local.");

    app.currentLanguage = resolved.engineLanguage;
    if (app.elements.languageSelect) app.elements.languageSelect.value = resolved.engineLanguage;
    app.startVoicePreparation(`Carregando ${resolved.locale}...`);
    observeWorker();
    app.worker.postMessage({ type: "set_language", data: { language: resolved.engineLanguage } });
    await pending;
    return resolved;
  };

  const encodeReference = async (task) => {
    postProgress(task.requestId, 8, "model");
    const resolved = await ensureLanguage(task.language);
    const file = task.file;
    postToParent({
      type: "audioria:voice-reference-status",
      requestId: task.requestId,
      status: "decoding",
      language: resolved.locale,
    });
    postProgress(task.requestId, 18, "reference-decoding");
    app.startVoicePreparation("Preparando amostra autorizada...");
    if (app.elements.voiceUploadStatus) {
      app.elements.voiceUploadStatus.textContent = "Processando amostra autorizada...";
      app.elements.voiceUploadStatus.className = "voice-upload-status";
    }

    const decoded = await app.audioContext.decodeAudioData(await file.arrayBuffer());
    let audioData = decoded.sampleRate === 24_000
      ? new Float32Array(decoded.getChannelData(0))
      : app.resampleAudio(decoded, 24_000);
    if (decoded.numberOfChannels > 1 && decoded.sampleRate === 24_000) {
      const left = decoded.getChannelData(0);
      const right = decoded.getChannelData(1);
      audioData = new Float32Array(left.length);
      for (let index = 0; index < left.length; index += 1) audioData[index] = (left[index] + right[index]) / 2;
    }
    audioData = prepareVoiceReferencePcm(audioData, 24_000);
    const referenceSeconds = audioData.length / 24_000;

    customVoiceReady = false;
    postToParent({
      type: "audioria:voice-reference-status",
      requestId: task.requestId,
      status: "encoding",
      language: resolved.locale,
    });
    postProgress(task.requestId, 32, "reference-encoding");
    const encoded = waitWithTimeout((resolve, reject) => {
      const waiter = { resolve, reject };
      voiceWaiters.add(waiter);
      return () => voiceWaiters.delete(waiter);
    }, PREPARATION_TIMEOUT_MS, "Tempo excedido ao codificar a voz autorizada.");
    observeWorker();
    app.worker.postMessage({ type: "encode_voice", data: { audio: audioData } }, [audioData.buffer]);
    await encoded;
    if (app.elements.voiceSelect) app.elements.voiceSelect.value = "custom";
    app.currentVoice = "custom";
    postProgress(task.requestId, 52, "reference-ready");
    postToParent({
      type: "audioria:voice-ready",
      requestId: task.requestId,
      language: resolved.locale,
      referenceSeconds,
    });
  };

  const restoreFullText = (batch) => {
    if (!batch || !app.elements.textInput) return;
    app.elements.textInput.value = batch.normalizedText;
    app.elements.textInput.dispatchEvent(new Event("input"));
  };

  const finishActiveBatch = () => {
    const batch = activeBatch;
    if (!batch) return;
    const combined = stitchVoiceAudio(batch.renderedChunks, app.currentSampleRate);
    if (!combined.length) {
      abortActiveBatch("empty_audio", new Error("O motor local não produziu áudio."));
      return;
    }

    let timedSegments;
    if (batch.timedSegments) {
      try {
        if (batch.timedChunkSegmentIndices.length !== batch.renderedChunks.length) {
          throw new Error("A saída segmentada perdeu correspondência com a linha do tempo.");
        }
        const renderedBySegment = batch.timedSegments.map(() => []);
        batch.renderedChunks.forEach((chunk, chunkIndex) => {
          const segmentIndex = batch.timedChunkSegmentIndices[chunkIndex];
          if (!Number.isSafeInteger(segmentIndex) || !renderedBySegment[segmentIndex]) {
            throw new Error("Um trecho de voz perdeu sua cena de destino.");
          }
          renderedBySegment[segmentIndex].push(chunk);
        });
        timedSegments = batch.timedSegments.map((segment, index) => {
          const audio = stitchVoiceAudio(renderedBySegment[index], app.currentSampleRate);
          if (!audio.length) throw new Error(`O segmento ${String(segment.id)} não produziu áudio.`);
          return {
            id: segment.id,
            start: segment.start,
            end: segment.end,
            text: segment.text,
            audio,
          };
        });
      } catch (error) {
        abortActiveBatch("invalid_timed_audio", error);
        return;
      }
    }

    const wavBlob = app.float32ToWavBlob(combined, app.currentSampleRate);
    postProgress(batch.requestId, 99, "mastering");
    if (app.lastCompletedAudioUrl) URL.revokeObjectURL(app.lastCompletedAudioUrl);
    app.lastCompletedAudioUrl = URL.createObjectURL(wavBlob);
    app.lastCompletedAudioFilename = app.buildAudioFilename();
    const outputAudio = document.getElementById?.("output-audio");
    if (outputAudio && typeof outputAudio.load === "function") {
      outputAudio.src = app.lastCompletedAudioUrl;
      outputAudio.hidden = false;
      outputAudio.load();
    }
    app.currentGenerationChunks = [];
    app.isGenerating = false;
    restoreFullText(batch);
    originalResetUI();
    activeBatch = null;

    if (batch.source === "bridge") {
      postProgress(batch.requestId, 100, "complete");
      postToParent({
        type: "audioria:voice-audio",
        requestId: batch.requestId,
        blob: wavBlob,
        filename: app.lastCompletedAudioFilename,
        mimeType: "audio/wav",
        normalizedText: batch.normalizedText,
        chunks: batch.chunks.length,
        chunkTexts: batch.chunks.slice(),
        chunkMetadata: batch.chunkMetadata.map(({ index, closingPunctuation, paragraphBreakAfter, boundary, pauseMs }) => ({
          index,
          closingPunctuation,
          paragraphBreakAfter,
          boundary,
          pauseMs,
        })),
        language: batch.language.locale,
        engineLanguage: batch.language.engineLanguage,
        sampleRate: app.currentSampleRate,
        terminalTailMilliseconds: LOCAL_VOICE_TEXT_LIMITS.terminalTailMilliseconds,
        ...(timedSegments ? { timedSegments } : {}),
      }, timedSegments?.map(({ audio }) => audio.buffer) ?? []);
      rememberCompleted(batch.requestId);
      taskRunning = false;
      void pumpQueue();
    } else {
      void pumpQueue();
    }
  };

  function abortActiveBatch(code, error) {
    const batch = activeBatch;
    if (!batch) return;
    app.currentGenerationChunks = [];
    app.generationWasStopped = true;
    app.isGenerating = false;
    restoreFullText(batch);
    activeBatch = null;
    originalResetUI();
    if (batch.source === "bridge") {
      postError(batch.requestId, code, error);
      rememberCompleted(batch.requestId);
      taskRunning = false;
      window.setTimeout(() => void pumpQueue(), 0);
    } else {
      window.setTimeout(() => void pumpQueue(), 0);
    }
  }

  const prepareGenerationUI = () => {
    const outputAudio = document.getElementById?.("output-audio");
    if (outputAudio && typeof outputAudio.pause === "function") outputAudio.pause();
    app.generationStartTime = performance.now();
    app.isGenerating = true;
    app.elements.generateBtn.disabled = true;
    app.elements.generateBtn.classList.add("btn--generating");
    app.elements.stopBtn.disabled = false;
    app.elements.statTTFB.textContent = "--";
    app.elements.statRTFx.textContent = "--";
    if (app.elements.ttfbBar) app.elements.ttfbBar.style.width = "0%";
    app.rtfMovingAverage = 0;
    app.lastChunkFinishTime = 0;
    app.skipNextRtf = false;
    app.deferStreamEnd = false;
    app.generationWasStopped = false;
    app.currentGenerationChunks = [];
    if (app.elements.downloadAudioBtn) app.elements.downloadAudioBtn.disabled = true;
  };

  const resolveCatalogVoice = () => {
    const current = typeof app.currentVoice === "string" ? app.currentVoice.trim() : "";
    if (current && current !== "custom") return current;
    const options = Array.from(app.elements.voiceSelect?.options ?? []);
    const candidate = options.map((option) => String(option.value ?? "").trim())
      .find((value) => value && value !== "custom");
    if (!candidate) throw new Error("Nenhuma voz de catálogo ficou disponível para este idioma.");
    return candidate;
  };

  const startNextChunk = async () => {
    const batch = activeBatch;
    if (!batch) return;
    if (batch.nextIndex >= batch.chunks.length) {
      finishActiveBatch();
      return;
    }
    const text = batch.chunks[batch.nextIndex];
    const completedChunks = batch.nextIndex;
    postProgress(
      batch.requestId,
      60 + completedChunks / Math.max(1, batch.chunks.length) * 36,
      "synthesis",
      { current: completedChunks + 1, total: batch.chunks.length },
    );
    // Autoregressive speech models may continue until their token ceiling when
    // a transcript fragment has no explicit stop. Add a synthesis-only full
    // stop; the normalized user text is restored unchanged after the batch.
    const synthesisText = ensureTtsBoundary(text);
    batch.currentChunkIndex = batch.nextIndex;
    batch.nextIndex += 1;
    app.elements.textInput.value = synthesisText;
    app.elements.textInput.dispatchEvent(new Event("input"));

    if (batch.source === "bridge") {
      prepareGenerationUI();
      app.currentVoice = batch.voice;
      if (app.elements.voiceSelect) app.elements.voiceSelect.value = batch.voice;
      app.worker.postMessage({ type: "generate", data: { text: synthesisText, voice: batch.voice } });
      return;
    }
    await originalStartGeneration();
  };

  app.bufferOrPlay = function audioriaBufferOrPlay(audioData) {
    if (activeBatch) {
      app.currentGenerationChunks.push(new Float32Array(audioData));
      return;
    }
    originalBufferOrPlay(audioData);
  };

  app.handleStreamEnd = function audioriaHandleStreamEnd() {
    if (activeBatch) {
      app.finalizePlayback();
      return;
    }
    if (ignoreOrphanedStreamEnd) {
      ignoreOrphanedStreamEnd = false;
      return;
    }
    originalHandleStreamEnd();
  };

  app.finalizePlayback = function audioriaFinalizePlayback() {
    const batch = activeBatch;
    if (!batch) {
      originalFinalizePlayback();
      return;
    }
    if (app.generationWasStopped || !app.currentGenerationChunks.length) {
      abortActiveBatch("generation_stopped", new Error("A geração local foi interrompida."));
      return;
    }
    const renderedAudio = concatenateFloat32(app.currentGenerationChunks);
    const chunkText = batch.chunks[batch.currentChunkIndex] ?? "";
    const maximumSamples = maximumVoiceSamplesForText(chunkText, app.currentSampleRate);
    if (renderedAudio.length > maximumSamples) {
      abortActiveBatch(
        "pathological_duration",
        new Error("A voz excedeu o limite seguro deste trecho; geração bloqueada para evitar repetição."),
      );
      return;
    }
    batch.renderedChunks.push({
      audio: renderedAudio,
      metadata: batch.chunkMetadata[batch.currentChunkIndex],
    });
    postProgress(
      batch.requestId,
      60 + batch.nextIndex / Math.max(1, batch.chunks.length) * 36,
      "synthesis",
      { current: batch.nextIndex, total: batch.chunks.length },
    );
    app.currentGenerationChunks = [];
    app.isGenerating = false;
    originalResetUI();
    window.setTimeout(() => void startNextChunk(), 0);
  };

  app.startGeneration = async function audioriaManualGeneration() {
    if (document.body.dataset.consentGate !== "confirmed") {
      app.updateStatus("Autorização removida; reabra o motor pelo laboratório.", "error");
      return;
    }
    if (activeBatch || taskRunning || app.isVoicePreparing || app.isGenerating) return;
    const rawText = app.elements.textInput.value;
    let plan;
    try {
      plan = splitVoiceText(rawText, { language: app.currentLanguage });
    } catch (error) {
      app.updateStatus(errorMessage(error), "error");
      return;
    }
    app.elements.textInput.value = plan.normalizedText;
    app.elements.textInput.dispatchEvent(new Event("input"));
    if (!app.isWorkerReady) {
      await originalStartGeneration();
      return;
    }
    activeBatch = {
      source: "manual",
      requestId: null,
      language: resolveVoiceLanguage(app.currentLanguage),
      normalizedText: plan.normalizedText,
      chunks: plan.chunks,
      chunkMetadata: plan.chunkMetadata,
      nextIndex: 0,
      currentChunkIndex: -1,
      renderedChunks: [],
    };
    await startNextChunk();
  };

  const runSynthesisTask = async (task) => {
    postProgress(task.requestId, 8, "model");
    const language = await ensureLanguage(task.language);
    if (task.voiceMode === "clone" && !customVoiceReady) throw new Error("Envie e aguarde uma amostra de voz autorizada antes da síntese.");
    const voice = task.voiceMode === "catalog" ? resolveCatalogVoice() : "custom";
    const plan = task.timedPlan ?? splitVoiceText(task.text, { language: language.engineLanguage });
    postProgress(task.requestId, 56, "text-ready", { total: plan.chunks.length });
    activeBatch = {
      source: "bridge",
      requestId: task.requestId,
      language,
      voice,
      normalizedText: plan.normalizedText,
      chunks: plan.chunks,
      chunkMetadata: plan.chunkMetadata,
      timedSegments: task.timedPlan?.segments ?? null,
      timedChunkSegmentIndices: task.timedPlan?.chunkSegmentIndices ?? null,
      nextIndex: 0,
      currentChunkIndex: -1,
      renderedChunks: [],
    };
    await startNextChunk();
  };

  async function pumpQueue() {
    if (document.body.dataset.consentGate !== "confirmed") return;
    if (taskRunning || activeBatch || !engineReady || !queue.length) return;
    let index = 0;
    if (!customVoiceReady && queue[0].kind === "synthesis" && queue[0].voiceMode === "clone") {
      index = queue.findIndex((task) => task.kind === "reference");
      if (index < 0) {
        if (!referenceWaitTimer) {
          referenceWaitTimer = window.setTimeout(() => {
            referenceWaitTimer = null;
            const waitingIndex = queue.findIndex((task) => task.kind === "synthesis" && task.voiceMode === "clone");
            if (waitingIndex >= 0) {
              const [waiting] = queue.splice(waitingIndex, 1);
              postError(waiting.requestId, "voice_reference_required", new Error("A amostra de voz autorizada não foi recebida."));
              rememberCompleted(waiting.requestId);
            }
            void pumpQueue();
          }, REFERENCE_WAIT_MS);
        }
        return;
      }
    }
    if (referenceWaitTimer) {
      window.clearTimeout(referenceWaitTimer);
      referenceWaitTimer = null;
    }
    const [task] = queue.splice(index, 1);
    taskRunning = true;
    try {
      if (task.kind === "reference") {
        await encodeReference(task);
        taskRunning = false;
        void pumpQueue();
      } else {
        await runSynthesisTask(task);
      }
    } catch (error) {
      if (task.kind === "reference") {
        customVoiceReady = false;
        app.finishVoicePreparation();
        postToParent({
          type: "audioria:voice-reference-status",
          requestId: task.requestId,
          status: "error",
          message: errorMessage(error),
        });
      }
      postError(task.requestId, task.kind === "reference" ? "voice_reference_failed" : "synthesis_failed", error);
      if (task.kind === "synthesis") rememberCompleted(task.requestId);
      taskRunning = false;
      void pumpQueue();
    }
  }

  const receiveParentMessage = (event) => {
    if (event.origin !== targetOrigin || event.source !== parentWindow) return;
    if (document.body.dataset.consentGate !== "confirmed") return;
    const message = event.data;
    if (!message || typeof message !== "object") return;

    if (message.type === "audioria:voice-consent") {
      if (message.confirmed === true) return;
      document.body.dataset.consentGate = "blocked";
      app.isWorkerReady = false;
      queue.splice(0);
      inFlightRequestIds.clear();
      progressByRequest.clear();
      customVoiceReady = false;
      if (referenceWaitTimer) window.clearTimeout(referenceWaitTimer);
      referenceWaitTimer = null;
      if (app.isGenerating) app.worker?.postMessage({ type: "stop" });
      if (activeBatch) abortActiveBatch("consent_revoked", new Error("A autorização da voz foi removida."));
      window.removeEventListener("message", receiveParentMessage);
      return;
    }

    if (message.type === "audioria:voice-reference") {
      try {
        const requestId = requestIdOf(message.requestId, { required: false });
        const file = message.file;
        if (!(file instanceof Blob) || file.size < 1 || file.size > MAX_REFERENCE_BYTES) {
          throw new RangeError("A amostra deve ser um Blob/File de até 64 MB.");
        }
        if (file.type && !/^(audio|video)\//iu.test(file.type)) {
          throw new RangeError("A amostra deve conter áudio ou vídeo decodificável.");
        }
        const language = resolveVoiceLanguage(message.language ?? app.currentLanguage, { strict: true });
        queue.push({ kind: "reference", requestId, file, language: language.engineLanguage });
        postProgress(requestId, 4, "queued");
        postToParent({
          type: "audioria:voice-reference-status",
          requestId,
          status: "queued",
          language: language.locale,
        });
        void pumpQueue();
      } catch (error) {
        postError(message.requestId ?? null, "invalid_voice_reference", error);
      }
      return;
    }

    if (message.type === "audioria:synthesize") {
      try {
        const requestId = requestIdOf(message.requestId);
        if (inFlightRequestIds.has(requestId) || recentRequestIds.includes(requestId)) {
          throw new Error("requestId duplicado; a geração não será repetida.");
        }
        const queuedSyntheses = queue.filter((task) => task.kind === "synthesis").length + (activeBatch?.source === "bridge" ? 1 : 0);
        if (queuedSyntheses >= MAX_PENDING_SYNTHESIS) throw new Error("A fila local está cheia.");
        const language = resolveVoiceLanguage(message.language, { strict: true });
        const voiceMode = message.voiceMode === "catalog" ? "catalog" : "clone";
        const hasSegments = message.segments !== undefined;
        const timedPlan = hasSegments
          ? prepareTimedSegments(message.segments, language.engineLanguage, message.text)
          : null;
        if (!timedPlan) {
          if (typeof message.text !== "string") throw new TypeError("O texto de síntese deve ser uma string.");
          splitVoiceText(message.text, { language: language.engineLanguage });
        }
        inFlightRequestIds.add(requestId);
        queue.push({
          kind: "synthesis",
          requestId,
          text: message.text ?? timedPlan.normalizedText,
          timedPlan,
          language: language.engineLanguage,
          voiceMode,
        });
        postProgress(requestId, 4, "queued");
        void pumpQueue();
      } catch (error) {
        postError(message.requestId ?? null, "invalid_synthesis_request", error);
      }
    }
  };

  window.addEventListener("message", receiveParentMessage);
  observeWorker();
  signalEngineReady();

  const bridge = Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    dispose() {
      window.removeEventListener("message", receiveParentMessage);
    },
  });
  Object.defineProperty(app, "__audioriaBridgeInstalled", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: bridge,
  });
  return bridge;
}
