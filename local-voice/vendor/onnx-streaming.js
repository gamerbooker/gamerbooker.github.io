
import { PCMPlayerWorklet as PCMPlayer } from "./PCMPlayerWorklet.js";

const SAMPLE_RATE = 24000;
const FADE_SAMPLES = 480;
const LANGUAGE_OPTIONS = [
    { value: "english_2026-04", label: "English (April 2026)" },
    { value: "german", label: "German" },
    { value: "italian", label: "Italian" },
    { value: "portuguese", label: "Portuguese" },
    { value: "spanish", label: "Spanish" },
];
const SAMPLE_TEXTS = {
    "english_2026-04": [
        ["Demo greeting", "Hello, welcome to Pocket TTS. This is the updated multilingual web demo running entirely in your browser."],
        ["Supportive", "I completely understand how frustrating this has been. Let me take care of it and keep you updated."],
        ["Excited", "Wow, congratulations. That is fantastic news, and I am genuinely thrilled for you."],
        ["Compassionate", "I am sorry you are going through this. Please take the time you need, and know that we are here for you."],
        ["Helpful guide", "Great question. I will walk you through it step by step, starting with the part that matters most."],
    ],
    german: [
        ["Begruessung", "Hallo und willkommen bei Pocket TTS. Dies ist die neue mehrsprachige Webdemo direkt im Browser."],
        ["Hilfsbereit", "Gute Frage. Ich erklaere dir das jetzt Schritt fuer Schritt und beginne mit dem wichtigsten Teil."],
        ["Freudig", "Wow, herzlichen Glueckwunsch. Das sind wirklich fantastische Neuigkeiten."],
        ["Mitgefuehl", "Es tut mir leid, dass du das gerade durchmachst. Nimm dir die Zeit, die du brauchst."],
        ["Klar", "Ich uebernehme das jetzt und halte dich auf dem Laufenden."],
    ],
    italian: [
        ["Benvenuto", "Ciao e benvenuto in Pocket TTS. Questa e la nuova demo multilingue che gira direttamente nel browser."],
        ["Guida", "Ottima domanda. Ti accompagno passo dopo passo, iniziando dalla parte piu importante."],
        ["Entusiasta", "Wow, congratulazioni. E una notizia davvero fantastica."],
        ["Empatico", "Mi dispiace che tu stia passando questo momento. Prenditi tutto il tempo che ti serve."],
        ["Chiaro", "Me ne occupo io adesso e ti tengo aggiornato."],
    ],
    portuguese: [
        ["Boas-vindas", "Ola e bem-vindo ao Pocket TTS. Esta e a nova demo multilingue funcionando diretamente no navegador."],
        ["Guia", "Otima pergunta. Vou explicar passo a passo, comecando pela parte mais importante."],
        ["Animado", "Uau, parabens. Essa e uma noticia realmente fantastica."],
        ["Empatico", "Sinto muito que voce esteja passando por isso. Tome o tempo de que precisar."],
        ["Direto", "Vou cuidar disso agora e manter voce atualizado."],
    ],
    spanish: [
        ["Bienvenida", "Hola y bienvenido a Pocket TTS. Esta es la nueva demo multilingue funcionando directamente en tu navegador."],
        ["Guia", "Muy buena pregunta. Voy a explicarlo paso a paso, empezando por la parte mas importante."],
        ["Entusiasta", "Vaya, felicidades. Es una noticia realmente fantastica."],
        ["Empatico", "Siento mucho que estes pasando por esto. Toma el tiempo que necesites."],
        ["Directo", "Me encargo de esto ahora mismo y te mantendre al tanto."],
    ],
};

export class PocketTTSStreaming {
    constructor() {
        this.worker = null;
        this.player = null;
        this.audioContext = null;
        this.isGenerating = false;
        this.isWorkerReady = false;
        this.isVoicePreparing = false;
        this.pendingGeneration = false;

        this.availableVoices = [];
        this.currentVoice = null;
        this.currentLanguage = "english_2026-04";
        this.currentSampleRate = SAMPLE_RATE;

        this.generationStartTime = 0;
        this.lastChunkFinishTime = 0;
        this.rtfMovingAverage = 0;
        this.skipNextRtf = false;

        this.deferStreamEnd = false;
        this.currentGenerationChunks = [];
        this.lastCompletedAudioUrl = null;
        this.lastCompletedAudioFilename = null;
        this.generationWasStopped = false;

        this.elements = {
            textInput: document.getElementById("text-input"),
            generateBtn: document.getElementById("generate-btn"),
            stopBtn: document.getElementById("stop-btn"),
            statusText: document.getElementById("stat-status"),
            statusIndicator: document.getElementById("status-indicator"),
            modelStatusIcon: document.querySelector("#model-status .model-status__dot"),
            modelStatusText: document.querySelector("#model-status .model-status__text"),
            btnLoader: document.getElementById("btn-loader"),
            statTTFB: document.getElementById("stat-ttfb"),
            statRTFx: document.getElementById("stat-rtfx"),
            ttfbBar: document.getElementById("ttfb-bar"),
            rtfxContext: document.getElementById("rtfx-context"),
            languageSelect: document.getElementById("language-select"),
            voiceSelect: document.getElementById("voice-select"),
            voiceUpload: document.getElementById("voice-upload"),
            voiceUploadBtn: document.getElementById("voice-upload-btn"),
            voiceUploadStatus: document.getElementById("voice-upload-status"),
            downloadAudioBtn: document.getElementById("download-audio-btn"),
        };

        this.attachEventListeners();
        this.initLanguageSelector();
        this.updateSampleButtons(this.currentLanguage);
        this.init();
        this.setupVisualization();
    }

    initLanguageSelector() {
        if (!this.elements.languageSelect) {
            return;
        }
        this.elements.languageSelect.innerHTML = "";
        for (const optionData of LANGUAGE_OPTIONS) {
            const option = document.createElement("option");
            option.value = optionData.value;
            option.textContent = optionData.label;
            if (optionData.value === this.currentLanguage) {
                option.selected = true;
            }
            this.elements.languageSelect.appendChild(option);
        }
    }

    updateSampleButtons(language) {
        const samples = SAMPLE_TEXTS[language] || SAMPLE_TEXTS["english_2026-04"];
        document.querySelectorAll(".sample-btn").forEach((button, index) => {
            const sample = samples[index] || samples[samples.length - 1];
            button.textContent = sample[0];
            button.setAttribute("data-text", sample[1]);
        });
    }

    async init() {
        this.updateStatus("Initializing...", "running");
        this.elements.generateBtn.disabled = true;
        if (this.elements.voiceUploadBtn) this.elements.voiceUploadBtn.disabled = true;
        if (this.elements.voiceSelect) this.elements.voiceSelect.disabled = true;
        if (this.elements.languageSelect) this.elements.languageSelect.disabled = true;

        const btnText = this.elements.generateBtn.querySelector(".btn__text");
        if (btnText) btnText.textContent = "Loading Models...";
        this.elements.btnLoader.style.display = "block";

        if (!window.isSecureContext) {
            this.updateStatus("AudioWorklet requires HTTPS or localhost.", "error");
            this.elements.btnLoader.style.display = "none";
            if (btnText) btnText.textContent = "Secure Context Required";
            return;
        }

        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: SAMPLE_RATE,
                latencyHint: "interactive",
            });
            if (!this.audioContext.audioWorklet) {
                throw new Error("AudioWorklet not supported in this browser.");
            }
            await this.audioContext.audioWorklet.addModule("PCMPlayerWorklet.js");
            this.player = new PCMPlayer(this.audioContext);
            this.player.addEventListener("audioEnded", () => {
                if (this.deferStreamEnd) {
                    this.deferStreamEnd = false;
                    this.finalizePlayback();
                }
            });
        } catch (err) {
            this.updateStatus(`Audio init failed: ${err.message}`, "error");
            this.elements.btnLoader.style.display = "none";
            if (btnText) btnText.textContent = "Audio Error";
            return;
        }

        this.worker = new Worker("./inference-worker.js?v=16", { type: "module" });
        this.worker.onmessage = (e) => {
            const { type, data, error, status, state, text, voices, defaultVoice, voiceName, language } = e.data;
            switch (type) {
                case "status":
                    this.updateStatus(status, state);
                    break;
                case "model_status":
                    this.updateModelStatus(status, text);
                    break;
                case "voices_loaded":
                    this.handleVoicesLoaded(voices, defaultVoice, language);
                    break;
                case "voice_encoded":
                    this.handleVoiceEncoded(voiceName);
                    this.finishVoicePreparation();
                    break;
                case "voice_set":
                    this.currentVoice = voiceName;
                    this.finishVoicePreparation();
                    break;
                case "bundle_loaded":
                    this.currentLanguage = language;
                    if (e.data.sampleRate) {
                        this.currentSampleRate = e.data.sampleRate;
                    }
                    this.finishVoicePreparation();
                    break;
                case "loaded":
                    this.isWorkerReady = true;
                    this.resetUI();
                    if (this.pendingGeneration) {
                        this.pendingGeneration = false;
                        this.startGeneration();
                    }
                    break;
                case "generation_started":
                    break;
                case "audio_chunk":
                    this.handleAudioChunk(data, e.data.metrics);
                    break;
                case "stream_ended":
                    this.handleStreamEnd();
                    break;
                case "error":
                    console.error("Worker Error:", error);
                    this.updateStatus(`Error: ${error}`, "error");
                    this.currentGenerationChunks = [];
                    this.generationWasStopped = true;
                    this.finishVoicePreparation();
                    this.resetUI();
                    break;
            }
        };

        this.worker.postMessage({ type: "load" });
    }

    handleVoicesLoaded(voices, defaultVoice, language) {
        this.availableVoices = voices || [];
        this.currentVoice = defaultVoice;
        if (language) {
            this.currentLanguage = language;
            if (this.elements.languageSelect) {
                this.elements.languageSelect.value = language;
            }
            this.updateSampleButtons(language);
        }

        if (this.elements.voiceSelect) {
            this.elements.voiceSelect.innerHTML = "";
            for (const voice of this.availableVoices) {
                const option = document.createElement("option");
                option.value = voice;
                option.textContent = voice.charAt(0).toUpperCase() + voice.slice(1);
                if (voice === defaultVoice) {
                    option.selected = true;
                }
                this.elements.voiceSelect.appendChild(option);
            }
            const customOption = document.createElement("option");
            customOption.value = "custom";
            customOption.textContent = "Custom (Upload)";
            this.elements.voiceSelect.appendChild(customOption);
        }
    }

    startVoicePreparation(statusText = "Preparing...") {
        this.isVoicePreparing = true;
        this.elements.generateBtn.disabled = true;
        const btnText = this.elements.generateBtn.querySelector(".btn__text");
        if (btnText) btnText.textContent = "Preparing...";
        this.elements.btnLoader.style.display = "block";
        if (this.elements.voiceUploadBtn) this.elements.voiceUploadBtn.disabled = true;
        if (this.elements.voiceSelect) this.elements.voiceSelect.disabled = true;
        if (this.elements.languageSelect) this.elements.languageSelect.disabled = true;
        this.updateStatus(statusText, "loading");
    }

    finishVoicePreparation() {
        this.isVoicePreparing = false;
        if (!this.isWorkerReady || this.isGenerating) return;
        this.resetUI();
    }

    handleVoiceEncoded(voiceName) {
        this.currentVoice = voiceName;
        if (this.elements.voiceUploadStatus) {
            this.elements.voiceUploadStatus.textContent = "Voice encoded successfully!";
            this.elements.voiceUploadStatus.className = "voice-upload-status success";
        }
        if (this.elements.voiceSelect) {
            this.elements.voiceSelect.value = "custom";
        }
    }

    async handleVoiceUpload(file) {
        if (!file) return;
        this.startVoicePreparation("Preparing custom voice...");

        if (this.elements.voiceUploadStatus) {
            this.elements.voiceUploadStatus.textContent = "Processing audio...";
            this.elements.voiceUploadStatus.className = "voice-upload-status";
        }

        try {
            const arrayBuffer = await file.arrayBuffer();
            const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

            let audioData;
            if (audioBuffer.sampleRate !== SAMPLE_RATE) {
                audioData = this.resampleAudio(audioBuffer, SAMPLE_RATE);
            } else {
                audioData = audioBuffer.getChannelData(0);
            }

            if (audioBuffer.numberOfChannels > 1 && audioBuffer.sampleRate === SAMPLE_RATE) {
                const left = audioBuffer.getChannelData(0);
                const right = audioBuffer.getChannelData(1);
                audioData = new Float32Array(left.length);
                for (let i = 0; i < left.length; i++) {
                    audioData[i] = (left[i] + right[i]) / 2;
                }
            }

            const maxSamples = SAMPLE_RATE * 10;
            if (audioData.length > maxSamples) {
                audioData = audioData.slice(0, maxSamples);
            }

            this.worker.postMessage({ type: "encode_voice", data: { audio: audioData } });
        } catch (err) {
            console.error("Voice upload error:", err);
            this.finishVoicePreparation();
            if (this.elements.voiceUploadStatus) {
                this.elements.voiceUploadStatus.textContent = `Error: ${err.message}`;
                this.elements.voiceUploadStatus.className = "voice-upload-status error";
            }
        }
    }

    resampleAudio(audioBuffer, targetRate) {
        const sourceRate = audioBuffer.sampleRate;
        const sourceData = audioBuffer.getChannelData(0);

        let monoData = sourceData;
        if (audioBuffer.numberOfChannels > 1) {
            const right = audioBuffer.getChannelData(1);
            monoData = new Float32Array(sourceData.length);
            for (let i = 0; i < sourceData.length; i++) {
                monoData[i] = (sourceData[i] + right[i]) / 2;
            }
        }

        const ratio = sourceRate / targetRate;
        const outputLength = Math.floor(monoData.length / ratio);
        const output = new Float32Array(outputLength);
        for (let i = 0; i < outputLength; i++) {
            const srcIndex = i * ratio;
            const srcFloor = Math.floor(srcIndex);
            const srcCeil = Math.min(srcFloor + 1, monoData.length - 1);
            const t = srcIndex - srcFloor;
            output[i] = monoData[srcFloor] * (1 - t) + monoData[srcCeil] * t;
        }
        return output;
    }

    attachEventListeners() {
        this.elements.generateBtn.addEventListener("click", () => this.startGeneration());
        this.elements.stopBtn.addEventListener("click", () => this.stopGeneration());
        if (this.elements.downloadAudioBtn) {
            this.elements.downloadAudioBtn.addEventListener("click", () => this.downloadLastAudio());
        }

        if (this.elements.languageSelect) {
            this.elements.languageSelect.addEventListener("change", (e) => {
                const language = e.target.value;
                this.currentLanguage = language;
                this.updateSampleButtons(language);
                this.startVoicePreparation(`Loading ${e.target.selectedOptions[0].text} bundle...`);
                this.worker.postMessage({ type: "set_language", data: { language } });
            });
        }

        if (this.elements.voiceSelect) {
            this.elements.voiceSelect.addEventListener("change", (e) => {
                const voice = e.target.value;
                if (voice === "custom") {
                    if (this.currentVoice) {
                        this.elements.voiceSelect.value = this.currentVoice;
                    }
                    if (this.elements.voiceUpload) {
                        this.elements.voiceUpload.click();
                    }
                } else {
                    this.startVoicePreparation(`Switching to ${voice} voice...`);
                    this.worker.postMessage({ type: "set_voice", data: { voiceName: voice } });
                }
            });
        }

        if (this.elements.voiceUpload) {
            this.elements.voiceUpload.addEventListener("change", (e) => {
                const file = e.target.files[0];
                if (file) {
                    this.handleVoiceUpload(file);
                }
            });
        }

        if (this.elements.voiceUploadBtn) {
            this.elements.voiceUploadBtn.addEventListener("click", () => {
                if (this.elements.voiceUpload) {
                    this.elements.voiceUpload.click();
                }
            });
        }

        document.querySelectorAll(".sample-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                this.elements.textInput.value = btn.getAttribute("data-text");
                this.elements.textInput.dispatchEvent(new Event("input"));
            });
        });

        this.elements.textInput.addEventListener("input", () => {
            const countEl = document.getElementById("char-count");
            if (countEl) {
                countEl.textContent = this.elements.textInput.value.length;
            }
        });

        this.elements.textInput.addEventListener("keydown", (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                this.startGeneration();
            }
        });
    }

    async startGeneration() {
        this.generationStartTime = performance.now();
        try {
            if (!this.isWorkerReady) {
                this.pendingGeneration = true;
                const btnText = this.elements.generateBtn.querySelector(".btn__text");
                if (btnText) btnText.textContent = "Starting soon...";
                return;
            }
            if (this.isVoicePreparing || this.isGenerating) {
                return;
            }
            if (this.audioContext && this.audioContext.state === "suspended") {
                await this.audioContext.resume();
            }

            const text = this.elements.textInput.value.trim();
            if (!text) return;

            this.isGenerating = true;
            this.elements.generateBtn.disabled = true;
            this.elements.generateBtn.classList.add("btn--generating");
            this.elements.stopBtn.disabled = false;
            if (this.player) this.player.reset();

            this.elements.statTTFB.textContent = "--";
            this.elements.statRTFx.textContent = "--";
            if (this.elements.ttfbBar) this.elements.ttfbBar.style.width = "0%";
            this.rtfMovingAverage = 0;
            this.lastChunkFinishTime = 0;
            this.skipNextRtf = false;
            this.deferStreamEnd = false;
            this.generationWasStopped = false;
            this.currentGenerationChunks = [];
            if (this.elements.downloadAudioBtn) {
                this.elements.downloadAudioBtn.disabled = true;
            }

            const voice = this.elements.voiceSelect ? this.elements.voiceSelect.value : this.currentVoice;
            this.worker.postMessage({ type: "generate", data: { text, voice } });
        } catch (err) {
            console.error("Error in startGeneration:", err);
            this.updateStatus(`Error: ${err.message}`, "error");
            this.currentGenerationChunks = [];
            this.generationWasStopped = true;
            this.isGenerating = false;
            this.resetUI();
        }
    }

    stopGeneration() {
        if (!this.isGenerating) return;
        this.generationWasStopped = true;
        this.worker.postMessage({ type: "stop" });
        this.handleStreamEnd();
    }

    applyFadeIn(audioData) {
        const fadeLen = Math.min(FADE_SAMPLES, audioData.length);
        for (let i = 0; i < fadeLen; i++) {
            audioData[i] *= i / fadeLen;
        }
    }

    applyFadeOut(audioData) {
        const fadeLen = Math.min(FADE_SAMPLES, audioData.length);
        const startIdx = audioData.length - fadeLen;
        for (let i = 0; i < fadeLen; i++) {
            audioData[startIdx + i] *= 1 - i / fadeLen;
        }
    }

    bufferOrPlay(audioData) {
        this.currentGenerationChunks.push(new Float32Array(audioData));
        this.player.playAudio(audioData);
    }

    finalizePlayback() {
        if (!this.generationWasStopped && this.currentGenerationChunks.length) {
            this.storeCompletedAudio();
        } else {
            this.currentGenerationChunks = [];
        }
        this.isGenerating = false;
        this.resetUI();
    }

    handleAudioChunk(audioData, metrics) {
        if (!this.isGenerating) return;
        if (metrics.isSilence) {
            this.bufferOrPlay(audioData);
            this.skipNextRtf = true;
            return;
        }

        if (metrics.isFirst || metrics.chunkStart) this.applyFadeIn(audioData);
        if (metrics.isLast) this.applyFadeOut(audioData);

        const now = performance.now();
        let ttfb = 0;
        let instantaneousRTF = 0;
        let arrivalRTF = 0;

        if (metrics.isFirst) {
            ttfb = now - this.generationStartTime;
            this.lastChunkFinishTime = now;
        } else if (this.skipNextRtf) {
            this.lastChunkFinishTime = now;
            this.skipNextRtf = false;
        } else if (this.lastChunkFinishTime > 0) {
            const timeSinceLastChunk = (now - this.lastChunkFinishTime) / 1000;
            this.lastChunkFinishTime = now;
            if (timeSinceLastChunk > 0) {
                arrivalRTF = metrics.chunkDuration / timeSinceLastChunk;
            }
        }

        if (metrics.genTimeSec && metrics.genTimeSec > 0) {
            instantaneousRTF = metrics.chunkDuration / metrics.genTimeSec;
        } else if (arrivalRTF > 0) {
            instantaneousRTF = arrivalRTF;
        }

        if (instantaneousRTF > 0) {
            if (this.rtfMovingAverage === 0) {
                this.rtfMovingAverage = instantaneousRTF;
            } else {
                this.rtfMovingAverage = this.rtfMovingAverage * 0.8 + instantaneousRTF * 0.2;
            }
        }

        this.bufferOrPlay(audioData);
        const rtfxToDisplay = this.rtfMovingAverage;
        requestAnimationFrame(() => {
            if (metrics.isFirst) this.updateTTFB(ttfb);
            if (rtfxToDisplay > 0) this.updateRTFx(rtfxToDisplay);
        });
    }

    handleStreamEnd() {
        if (this.player.notifyStreamEnded) this.player.notifyStreamEnded();
        this.deferStreamEnd = true;
    }

    resetUI() {
        const canGenerate = this.isWorkerReady && !this.isVoicePreparing && !this.isGenerating;
        this.elements.generateBtn.disabled = !canGenerate;
        this.elements.generateBtn.classList.remove("btn--generating");
        const btnText = this.elements.generateBtn.querySelector(".btn__text");
        if (btnText) {
            if (!this.isWorkerReady) btnText.textContent = "Loading Models...";
            else if (this.isVoicePreparing) btnText.textContent = "Preparing...";
            else btnText.textContent = "Generate Audio";
        }
        this.elements.stopBtn.disabled = true;
        if (this.elements.voiceUploadBtn) this.elements.voiceUploadBtn.disabled = !canGenerate;
        if (this.elements.voiceSelect) this.elements.voiceSelect.disabled = !canGenerate;
        if (this.elements.languageSelect) this.elements.languageSelect.disabled = !canGenerate;
        if (this.elements.downloadAudioBtn) {
            this.elements.downloadAudioBtn.disabled = this.isGenerating || !this.lastCompletedAudioUrl;
        }
        this.elements.btnLoader.style.display = canGenerate ? "none" : "block";
    }

    storeCompletedAudio() {
        const totalSamples = this.currentGenerationChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const combined = new Float32Array(totalSamples);
        let offset = 0;
        for (const chunk of this.currentGenerationChunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }

        const wavBlob = this.float32ToWavBlob(combined, this.currentSampleRate);
        if (this.lastCompletedAudioUrl) {
            URL.revokeObjectURL(this.lastCompletedAudioUrl);
        }
        this.lastCompletedAudioUrl = URL.createObjectURL(wavBlob);
        this.lastCompletedAudioFilename = this.buildAudioFilename();
        this.currentGenerationChunks = [];
    }

    buildAudioFilename() {
        const voice = (this.currentVoice || "voice").replace(/[^a-z0-9_-]+/gi, "-");
        const language = (this.currentLanguage || "language").replace(/[^a-z0-9_-]+/gi, "-");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        return `pocket-tts-${language}-${voice}-${stamp}.wav`;
    }

    float32ToWavBlob(float32Audio, sampleRate) {
        const bytesPerSample = 2;
        const dataSize = float32Audio.length * bytesPerSample;
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);

        const writeString = (offset, value) => {
            for (let i = 0; i < value.length; i++) {
                view.setUint8(offset + i, value.charCodeAt(i));
            }
        };

        writeString(0, "RIFF");
        view.setUint32(4, 36 + dataSize, true);
        writeString(8, "WAVE");
        writeString(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * bytesPerSample, true);
        view.setUint16(32, bytesPerSample, true);
        view.setUint16(34, 16, true);
        writeString(36, "data");
        view.setUint32(40, dataSize, true);

        let offset = 44;
        for (let i = 0; i < float32Audio.length; i++, offset += 2) {
            const sample = Math.max(-1, Math.min(1, float32Audio[i]));
            const pcm = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
            view.setInt16(offset, pcm, true);
        }

        return new Blob([buffer], { type: "audio/wav" });
    }

    downloadLastAudio() {
        if (!this.lastCompletedAudioUrl || !this.lastCompletedAudioFilename || this.isGenerating) {
            return;
        }
        const link = document.createElement("a");
        link.href = this.lastCompletedAudioUrl;
        link.download = this.lastCompletedAudioFilename;
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    updateStatus(text, state) {
        this.elements.statusText.textContent = text;
        this.elements.statusIndicator.className = `status-indicator status-${state}`;
    }

    updateModelStatus(state, text) {
        this.elements.modelStatusText.textContent = text;
        const modelStatus = document.getElementById("model-status");
        if (modelStatus) {
            modelStatus.className = `model-status status-${state}`;
        }
        this.elements.modelStatusIcon.className = "model-status__dot";
    }

    updateTTFB(ms) {
        this.elements.statTTFB.textContent = Math.round(ms);
        const percentage = Math.min((ms / 2000) * 100, 100);
        this.elements.ttfbBar.style.width = `${percentage}%`;
        this.elements.ttfbBar.style.background = ms < 500 ? "#00d4aa" : ms < 1000 ? "#ffd93d" : "#ff6b6b";
    }

    updateRTFx(val) {
        this.elements.statRTFx.textContent = `${val.toFixed(2)}x`;
        this.elements.rtfxContext.style.color = val >= 1.0 ? "#00d4aa" : "#ff6b6b";
    }

    setupVisualization() {
        this.waveformCanvas = document.getElementById("visualizer-waveform");
        this.barsCanvas = document.getElementById("visualizer-bars");
        if (!this.waveformCanvas || !this.barsCanvas) return;

        this.waveformCtx = this.waveformCanvas.getContext("2d");
        this.barsCtx = this.barsCanvas.getContext("2d");
        this.resizeCanvases();
        window.addEventListener("resize", () => this.resizeCanvases());
        requestAnimationFrame(() => this.draw());
    }

    resizeCanvases() {
        if (!this.waveformCanvas || !this.barsCanvas) return;
        const parent = this.waveformCanvas.parentElement;
        const width = parent.clientWidth;
        const height = parent.clientHeight;
        const dpr = window.devicePixelRatio || 1;

        [this.waveformCanvas, this.barsCanvas].forEach((canvas) => {
            canvas.width = width * dpr;
            canvas.height = height * dpr;
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
            const ctx = canvas.getContext("2d");
            ctx.scale(dpr, dpr);
        });
    }

    draw() {
        requestAnimationFrame(() => this.draw());
        if (!this.player || !this.player.analyser) return;

        const bufferLength = this.player.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        this.player.analyser.getByteFrequencyData(dataArray);
        this.drawBars(dataArray);
        this.player.analyser.getByteTimeDomainData(dataArray);
        this.drawWaveform(dataArray);
    }

    drawWaveform(dataArray) {
        const ctx = this.waveformCtx;
        const width = this.waveformCanvas.width / (window.devicePixelRatio || 1);
        const height = this.waveformCanvas.height / (window.devicePixelRatio || 1);

        ctx.clearRect(0, 0, width, height);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#00d4aa";
        ctx.beginPath();

        const sliceWidth = width / dataArray.length;
        let x = 0;
        for (let i = 0; i < dataArray.length; i++) {
            const y = (dataArray[i] / 128.0) * height / 2;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
            x += sliceWidth;
        }
        ctx.lineTo(width, height / 2);
        ctx.stroke();
    }

    drawBars(dataArray) {
        const ctx = this.barsCtx;
        const width = this.barsCanvas.width / (window.devicePixelRatio || 1);
        const height = this.barsCanvas.height / (window.devicePixelRatio || 1);

        ctx.clearRect(0, 0, width, height);
        const barCount = 120;
        const barWidth = width / barCount;
        const samplesPerBar = Math.floor(dataArray.length / barCount);

        for (let i = 0; i < barCount; i++) {
            let sum = 0;
            for (let j = 0; j < samplesPerBar; j++) {
                sum += dataArray[i * samplesPerBar + j];
            }
            const average = sum / samplesPerBar;
            const barHeight = (average / 255) * height * 0.8;

            const gradient = ctx.createLinearGradient(0, height, 0, height - barHeight);
            gradient.addColorStop(0, "#3eb48944");
            gradient.addColorStop(1, "#7fffd4cc");
            ctx.fillStyle = gradient;

            const x = i * barWidth;
            const y = height - barHeight;
            ctx.beginPath();
            ctx.roundRect(x + 1, y, barWidth - 2, barHeight, [2, 2, 0, 0]);
            ctx.fill();
        }
    }
}

document.addEventListener("DOMContentLoaded", () => {
    window.app = new PocketTTSStreaming();
});
