// Kept self-contained because the reviewed worker receives this function as
// source. Bound the codec's working set, not the duration of the reference.
// Windowing approximates full-pass codec context; it is not numerically equal.
export async function encodeReferenceWindows(audioData, encodeWindow, onProgress = () => {}) {
  const samplesPerFrame = 1920; // Mimi: 24 kHz / 12.5 Hz.
  const payloadFrames = 48;
  const contextFrames = 8;
  const featureWidth = 1024;
  if (!(audioData instanceof Float32Array) || !audioData.length || audioData.length > 30 * 24000) {
    throw new Error("A referência deve conter até 30 segundos de áudio mono a 24 kHz.");
  }
  if (!audioData.every(Number.isFinite)) throw new Error("A referência contém valores de áudio inválidos.");
  const totalFrames = Math.ceil(audioData.length / samplesPerFrame);
  const validate = (embedding, expectedFrames) => {
    if (!(embedding?.data instanceof Float32Array) || embedding.shape?.length !== 3 ||
        embedding.shape[0] !== 1 || embedding.shape[1] !== expectedFrames || embedding.shape[2] !== featureWidth ||
        embedding.data.length !== expectedFrames * featureWidth || !embedding.data.every(Number.isFinite)) {
      throw new Error("O codificador devolveu uma referência incompleta ou incompatível.");
    }
  };
  // Leave short references on their original single-pass path.
  if (totalFrames <= payloadFrames + contextFrames) {
    const embedding = await encodeWindow(audioData);
    validate(embedding, totalFrames);
    onProgress({ current: audioData.length, total: audioData.length });
    return embedding;
  }
  const data = new Float32Array(totalFrames * featureWidth);
  for (let offset = 0; offset < totalFrames; offset += payloadFrames) {
    const contextStart = Math.max(0, offset - contextFrames);
    const endFrame = Math.min(totalFrames, offset + payloadFrames);
    const sampleEnd = Math.min(audioData.length, endFrame * samplesPerFrame);
    const embedding = await encodeWindow(audioData.subarray(contextStart * samplesPerFrame, sampleEnd));
    validate(embedding, endFrame - contextStart);
    const discardFeatures = (offset - contextStart) * featureWidth;
    data.set(embedding.data.subarray(discardFeatures), offset * featureWidth);
    // Only completed source frames advance the meter; overlap is not counted twice.
    onProgress({ current: sampleEnd, total: audioData.length });
  }
  return { data, shape: [1, totalFrames, featureWidth] };
}

// Preserve native full-context LM prefill: splitting dynamic-INT8 prefill also
// changes its quantization scales, separately from the codec windowing above.
export function installReferenceRuntime(source) {
  const encoderAnchor = "async function encodeVoiceAudio(audioData) {";
  const before = `            customVoiceEmbedding = await encodeVoiceAudio(data.audio);
            currentVoiceName = "custom";
            await ensureCustomVoiceCached({ force: true, statusText: "Preparing custom voice..." });
            postMessage({ type: "voice_encoded", voiceName: "custom" });`;
  const after = `            const audioriaRequestId = e.data.requestId ?? null;
            if (!(data.audio instanceof Float32Array) || !data.audio.length || data.audio.length > 30 * 24000) {
                throw new Error("A referência deve conter até 30 segundos de áudio mono a 24 kHz.");
            }
            // Release the previous conditioned cache before the encoder peak.
            // This does not truncate or modify the new reference waveform.
            voiceConditioningCache.clear();
            customVoiceEmbedding = null;
            postMessage({ type: "audioria_reference_progress", requestId: audioriaRequestId, phase: "reference-encoding", samples: data.audio.length });
            customVoiceEmbedding = await encodeReferenceWindows(data.audio, encodeVoiceAudio, ({ current, total }) => {
                postMessage({ type: "audioria_reference_progress", requestId: audioriaRequestId, phase: "reference-encoding", current, total });
            });
            postMessage({ type: "audioria_reference_progress", requestId: audioriaRequestId, phase: "reference-conditioning", frames: customVoiceEmbedding.shape[1] });
            currentVoiceName = "custom";
            await ensureCustomVoiceCached({ force: true, statusText: "Preparing custom voice..." });
            postMessage({ type: "voice_encoded", requestId: audioriaRequestId, voiceName: "custom" });`;
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before) ||
      !source.includes(encoderAnchor) || source.indexOf(encoderAnchor) !== source.lastIndexOf(encoderAnchor) ||
      source.includes("async function encodeReferenceWindows(")) {
    throw new Error("A preparação da referência não corresponde ao motor revisado.");
  }
  return source.replace(before, after).replace(encoderAnchor, `${encodeReferenceWindows.toString()}\n\n${encoderAnchor}`);
}
