import { STUDIO_MODEL_FILES, STUDIO_VOICES } from "./quality-config.js?v=6.5.9";

export const STUDIO_VOICE_LOADER_KEY = "__audioria_studio_voice_650";

function replaceOne(source, before, after) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
    throw new Error("O modo Estúdio não corresponde ao motor revisado.");
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

export function installStudioVoiceRuntime(source) {
  source = replaceOne(source,
    'const LANGUAGE_BUNDLES = ["english_2026-04", "german", "italian", "portuguese", "spanish"];',
    'const LANGUAGE_BUNDLES = ["portuguese"];',
  );
  const stemsStart = source.indexOf("const MODEL_STEMS = {");
  const stemsEnd = source.indexOf("\n};", stemsStart) + 3;
  if (stemsStart < 0 || stemsEnd <= stemsStart) throw new Error("Arquivos do motor não encontrados.");
  source = replaceOne(source, source.slice(stemsStart, stemsEnd), `const MODEL_STEMS = ${JSON.stringify(STUDIO_MODEL_FILES)};`);

  source = replaceOne(source,
    `    predefinedVoiceRecords = {};
    const voicesResponse = await fetch(bundlePath(language, "voices.bin"));
    if (voicesResponse.ok) {
        predefinedVoiceRecords = parseVoiceStatesBin(await voicesResponse.arrayBuffer());
    }`,
    `    predefinedVoiceRecords = {};
    bundleMetadata.predefined_voices = ${JSON.stringify(STUDIO_VOICES)};
    predefinedVoiceRecords.rafael = await globalThis[${JSON.stringify(STUDIO_VOICE_LOADER_KEY)}]("rafael");`,
  );
  source = replaceOne(source,
    `    if (!predefinedVoiceRecords[voiceName]) {
        throw new Error(\`Unknown built-in voice: \${voiceName}\`);
    }`,
    `    if (!predefinedVoiceRecords[voiceName]) {
        if (!bundleMetadata.predefined_voices.includes(voiceName)) throw new Error("Voz fora do catálogo Estúdio.");
        predefinedVoiceRecords = { [voiceName]: await globalThis[${JSON.stringify(STUDIO_VOICE_LOADER_KEY)}](voiceName) };
    }`,
  );
  // Graph loading is handled by the shared, sequential session loader so the
  // Essential profile receives the same download and initialization protection.
  // One conditioned voice at a time: each 24-layer state is ~197 MB. Rebuild
  // from its small reference when switching; never keep a growing voice cache.
  source = replaceOne(source,
    "    const conditioned = stateFromVoiceRecord(predefinedVoiceRecords[voiceName]);",
    "    voiceConditioningCache.clear();\n    const conditioned = stateFromVoiceRecord(predefinedVoiceRecords[voiceName]);",
  );
  source = replaceOne(source,
    "    const conditioned = await buildVoiceConditionedState(customVoiceEmbedding);",
    "    voiceConditioningCache.clear();\n    const conditioned = await buildVoiceConditionedState(customVoiceEmbedding);",
  );
  return source;
}
