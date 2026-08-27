const LANGUAGE_PROFILES = Object.freeze({
  portuguese: Object.freeze({
    locale: "pt-BR",
    aliases: Object.freeze(["pt", "pt-br", "portuguese", "português"]),
    symbols: Object.freeze({
      "&": " e ",
      "%": " por cento ",
      "@": " arroba ",
      "+": " mais ",
      "=": " igual a ",
      "<": " menor que ",
      ">": " maior que ",
      "#": " hashtag ",
    }),
  }),
  "english_2026-04": Object.freeze({
    locale: "en-US",
    aliases: Object.freeze(["en", "en-us", "en-gb", "english", "english_2026-04"]),
    symbols: Object.freeze({
      "&": " and ",
      "%": " percent ",
      "@": " at ",
      "+": " plus ",
      "=": " equals ",
      "<": " less than ",
      ">": " greater than ",
      "#": " hashtag ",
    }),
  }),
  spanish: Object.freeze({
    locale: "es-ES",
    aliases: Object.freeze(["es", "es-es", "es-mx", "spanish", "español"]),
    symbols: Object.freeze({
      "&": " y ",
      "%": " por ciento ",
      "@": " arroba ",
      "+": " más ",
      "=": " igual a ",
      "<": " menor que ",
      ">": " mayor que ",
      "#": " hashtag ",
    }),
  }),
});

const LANGUAGE_BY_ALIAS = new Map();
for (const [engineLanguage, profile] of Object.entries(LANGUAGE_PROFILES)) {
  LANGUAGE_BY_ALIAS.set(engineLanguage.toLowerCase(), engineLanguage);
  LANGUAGE_BY_ALIAS.set(profile.locale.toLowerCase(), engineLanguage);
  for (const alias of profile.aliases) LANGUAGE_BY_ALIAS.set(alias.toLowerCase(), engineLanguage);
}

const MAX_INPUT_CHARACTERS = 10_000;
const DEFAULT_CHUNK_CHARACTERS = 240;
const MIN_CHUNK_CHARACTERS = 80;
const MAX_CHUNK_CHARACTERS = 500;
const SILENCE_THRESHOLD_DBFS = -55;
const CROSSFADE_MILLISECONDS = 5;
// Keep materially more context after the last detected sample than before it.
// Plosives and unvoiced consonants can decay below -55 dBFS before the ear has
// perceived their release; the former symmetric 2 ms margin could therefore
// sound like a missing final phoneme on short prompts.
const TRIM_LEADING_PADDING_MILLISECONDS = 40;
const TRIM_TRAILING_PADDING_MILLISECONDS = 96;
// A short digital pre-roll protects the first phoneme when browsers/players
// open a freshly encoded stream and also gives speech recognizers a stable
// noise floor before speech begins.
const INITIAL_HEAD_MILLISECONDS = 160;
const TERMINAL_TAIL_MILLISECONDS = 160;
const REFERENCE_SILENCE_THRESHOLD_DBFS = -62;
const REFERENCE_EDGE_PADDING_MILLISECONDS = 120;
const REFERENCE_MINIMUM_SECONDS = 1;
const REFERENCE_MAXIMUM_SECONDS = 10;
const MASTERING_HIGH_PASS_HZ = 48;
const MASTERING_PEAK_CEILING = 0.965;
const MASTERING_MAXIMUM_GAIN_DB = 2.5;
const PROSODIC_PAUSES = Object.freeze({
  soft: 85,
  intermediate: 130,
  sentence: 180,
  strong: 210,
});
const BIDI_OR_ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;
const HORIZONTAL_SPACE = /[\t\f\v \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/gu;
const TYPOGRAPHIC_QUOTES = /[\u201C\u201D\u201E\u201F\u00AB\u00BB]/gu;
const TYPOGRAPHIC_APOSTROPHES = /[\u2018\u2019\u201A\u201B]/gu;
const DASHES = /[\u2010-\u2015\u2212]/gu;
const BULLETS = /[\u2022\u2023\u2043\u25E6]/gu;
const EMOJI_RESIDUE = Object.freeze([
  /(?:\uFE0E|\uFE0F|\u20E3)/gu,
  /[\u{1F3FB}-\u{1F3FF}]/gu,
  /[\u{1F1E6}-\u{1F1FF}]/gu,
  /[\u{E0020}-\u{E007F}]/gu,
]);
// A whitelist prevents a mathematical comparison such as `2 < 3 e 4 > 1`
// from being mistaken for an HTML tag while still removing common markup.
const HTML_TAG = /<\/?(?:a|abbr|article|aside|b|blockquote|body|br|button|code|div|em|figcaption|figure|footer|h[1-6]|head|header|hr|html|i|img|label|li|link|main|mark|meta|nav|ol|p|pre|script|section|small|span|strong|style|sub|sup|table|tbody|td|th|thead|title|tr|u|ul)(?:\s+[^<>\n]{0,220})?\s*\/?>/giu;
const HTML_COMMENT = /<!--[\s\S]*?-->/gu;
const EMOJI = (() => {
  try {
    return new RegExp("\\p{Extended_Pictographic}", "gu");
  } catch {
    return null;
  }
})();

function codePointLength(value) {
  return Array.from(value).length;
}

function withoutUnsafeCodePoints(value) {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (character.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    const disallowedControl = codePoint <= 0x08
      || codePoint === 0x0b
      || codePoint === 0x0c
      || (codePoint >= 0x0e && codePoint <= 0x1f)
      || (codePoint >= 0x7f && codePoint <= 0x9f);
    if (disallowedControl) {
      result += " ";
      continue;
    }
    result += character;
  }
  return result;
}

function replaceSymbols(value, profile) {
  let result = value
    .replace(/\bR\$\s*/giu, profile.locale === "pt-BR" ? " reais " : " Brazilian reais ")
    .replace(/\bUS\$\s*/giu, profile.locale === "es-ES" ? " dólares estadounidenses " : " US dollars ")
    .replace(/\$/gu, profile.locale === "pt-BR" ? " dólares " : profile.locale === "es-ES" ? " dólares " : " dollars ")
    .replace(/\u20AC/gu, profile.locale === "en-US" ? " euros " : " euros ")
    .replace(/\u00A3/gu, profile.locale === "pt-BR" ? " libras " : profile.locale === "es-ES" ? " libras " : " pounds ");

  for (const [symbol, spoken] of Object.entries(profile.symbols)) {
    result = result.replaceAll(symbol, spoken);
  }
  return result;
}

export function resolveVoiceLanguage(value, { strict = false } = {}) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  const engineLanguage = LANGUAGE_BY_ALIAS.get(normalized);
  if (engineLanguage) {
    return {
      engineLanguage,
      locale: LANGUAGE_PROFILES[engineLanguage].locale,
      supported: true,
    };
  }
  if (strict) throw new RangeError("Idioma não suportado pelo bridge local. Use pt-BR, en-US ou es-ES.");
  return {
    engineLanguage: typeof value === "string" && value.trim() ? value.trim() : "portuguese",
    locale: "pt-BR",
    supported: false,
  };
}

export function resolveStartupVoiceLanguage(search = "") {
  const requested = new URLSearchParams(typeof search === "string" ? search : "")
    .get("language") ?? "pt-BR";
  try {
    return resolveVoiceLanguage(requested, { strict: true });
  } catch {
    return resolveVoiceLanguage("pt-BR", { strict: true });
  }
}

export function normalizeVoiceText(input, language = "portuguese") {
  if (typeof input !== "string") throw new TypeError("O texto deve ser uma string.");
  if (codePointLength(input) > MAX_INPUT_CHARACTERS) {
    throw new RangeError(`O texto deve ter no máximo ${MAX_INPUT_CHARACTERS} caracteres.`);
  }

  const resolved = resolveVoiceLanguage(language);
  const profile = LANGUAGE_PROFILES[resolved.engineLanguage] ?? LANGUAGE_PROFILES.portuguese;
  const spoken = profile.locale === "en-US"
    ? { at: " at ", code: " code omitted ", dot: " dot ", link: " link " }
    : profile.locale === "es-ES"
      ? { at: " arroba ", code: " código omitido ", dot: " punto ", link: " enlace " }
      : { at: " arroba ", code: " código omitido ", dot: " ponto ", link: " link " };
  let value = withoutUnsafeCodePoints(input.normalize("NFKC"))
    .replace(/\r\n?/gu, "\n")
    .replace(BIDI_OR_ZERO_WIDTH, "")
    .replace(TYPOGRAPHIC_QUOTES, '"')
    .replace(TYPOGRAPHIC_APOSTROPHES, "'")
    .replace(DASHES, " - ")
    .replace(/\u2026/gu, "...")
    .replace(BULLETS, ". ");

  if (EMOJI) value = value.replace(EMOJI, " ");
  for (const residue of EMOJI_RESIDUE) value = value.replace(residue, " ");
  value = value
    .replace(/```[\s\S]*?```/gu, spoken.code)
    .replace(/!\[([^\]]*)\]\((?:https?:\/\/|www\.)[^)]+\)/giu, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|www\.)[^)]+\)/giu, "$1")
    .replace(HTML_COMMENT, " ")
    .replace(HTML_TAG, " ")
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>()[\]{}]+/giu, spoken.link)
    .replace(/\b([\p{L}\p{N}._%+-]+)@([\p{L}\p{N}.-]+\.[\p{L}]{2,})\b/giu, (_match, local, domain) => (
      `${String(local).replace(/[._-]+/gu, " ")}${spoken.at}${String(domain).replace(/\./gu, spoken.dot)}`
    ))
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s*[-+*]\s+/gmu, ". ")
    .replace(/[*_]{1,3}/gu, "")
    .replace(/R\$\s*(\d+(?:[.,]\d{1,2})?)/giu, "$1 reais")
    .replace(/US\$\s*(\d+(?:[.,]\d{1,2})?)/giu, "$1 US dollars");

  value = replaceSymbols(value, profile)
    .replace(/[`^~|\\{}()]/gu, " ")
    .replaceAll("[", " ")
    .replaceAll("]", " ")
    .replace(HORIZONTAL_SPACE, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/ +([,.;:!?])/gu, "$1")
    .trim();

  if (!value) throw new RangeError("O texto ficou vazio depois da normalização segura.");
  if (codePointLength(value) > MAX_INPUT_CHARACTERS) {
    throw new RangeError(`O texto normalizado deve ter no máximo ${MAX_INPUT_CHARACTERS} caracteres.`);
  }
  return value;
}

function segmentSentences(value, locale) {
  const paragraphs = value.split(/\n{2,}/u).map((paragraph) => paragraph.trim()).filter(Boolean);
  const result = [];
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const sentences = typeof Intl?.Segmenter === "function"
      ? Array.from(
        new Intl.Segmenter(locale, { granularity: "sentence" }).segment(paragraph),
        ({ segment }) => segment.trim(),
      ).filter(Boolean)
      : paragraph.match(/[^.!?\n]+(?:[.!?]+(?=\s|$)|\n+|$)/gu)?.map((segment) => segment.trim()).filter(Boolean)
        ?? [paragraph];
    sentences.forEach((text, sentenceIndex) => {
      result.push({
        text,
        paragraphBreakAfter: paragraphIndex < paragraphs.length - 1 && sentenceIndex === sentences.length - 1,
      });
    });
  }
  return result.length ? result : [{ text: value, paragraphBreakAfter: false }];
}

function findPreferredCut(characters, maximum) {
  const minimumPreferred = Math.max(1, Math.floor(maximum * 0.45));
  const terminal = /[.!?\n]/u;
  const secondary = /[,;:]/u;
  const whitespace = /\s/u;
  for (const matcher of [terminal, secondary, whitespace]) {
    for (let index = maximum; index >= minimumPreferred; index -= 1) {
      if (matcher.test(characters[index - 1])) return index;
    }
  }
  for (let index = maximum; index >= 1; index -= 1) {
    if (whitespace.test(characters[index - 1])) return index;
  }
  return maximum;
}

function splitOversizedSegment(segment, maximum) {
  const pieces = [];
  let remaining = Array.from(segment.trim());
  while (remaining.length > maximum) {
    const cut = findPreferredCut(remaining, maximum);
    const piece = remaining.slice(0, cut).join("").trim();
    if (piece) pieces.push(piece);
    remaining = remaining.slice(cut);
    while (remaining.length && /\s/u.test(remaining[0])) remaining.shift();
  }
  const tail = remaining.join("").trim();
  if (tail) pieces.push(tail);
  return pieces;
}

export function describeVoiceChunk(text, { paragraphBreakAfter = false, index = 0 } = {}) {
  if (typeof text !== "string" || !text.trim()) throw new TypeError("O chunk deve conter texto.");
  const trimmed = text.trim();
  const closingPunctuation = trimmed.match(/([,;:.!?-])(?:["')\]]*)$/u)?.[1] ?? "";
  let boundary = "soft";
  if (paragraphBreakAfter || closingPunctuation === "!" || closingPunctuation === "?") {
    boundary = "strong";
  } else if (closingPunctuation === ".") {
    boundary = "sentence";
  } else if (closingPunctuation === ";" || closingPunctuation === ":") {
    boundary = "intermediate";
  }
  return Object.freeze({
    index,
    text: trimmed,
    closingPunctuation,
    paragraphBreakAfter: Boolean(paragraphBreakAfter),
    boundary,
    pauseMs: PROSODIC_PAUSES[boundary],
  });
}

export function splitVoiceText(input, {
  language = "portuguese",
  maxCharacters = DEFAULT_CHUNK_CHARACTERS,
} = {}) {
  if (!Number.isInteger(maxCharacters) || maxCharacters < MIN_CHUNK_CHARACTERS || maxCharacters > MAX_CHUNK_CHARACTERS) {
    throw new RangeError(`maxCharacters deve estar entre ${MIN_CHUNK_CHARACTERS} e ${MAX_CHUNK_CHARACTERS}.`);
  }

  const normalizedText = normalizeVoiceText(input, language);
  const resolved = resolveVoiceLanguage(language);
  const sentences = segmentSentences(normalizedText, resolved.locale);
  const units = sentences.flatMap(({ text, paragraphBreakAfter }) => {
    const pieces = splitOversizedSegment(text, maxCharacters);
    return pieces.map((piece, index) => ({
      text: piece,
      paragraphBreakAfter: paragraphBreakAfter && index === pieces.length - 1,
    }));
  });
  const chunks = [];
  const paragraphBreaks = [];
  let current = "";
  let currentParagraphBreak = false;

  for (const unit of units) {
    const candidate = current ? `${current} ${unit.text}` : unit.text;
    if (codePointLength(candidate) <= maxCharacters) {
      current = candidate;
      currentParagraphBreak = unit.paragraphBreakAfter;
      if (currentParagraphBreak) {
        chunks.push(current);
        paragraphBreaks.push(true);
        current = "";
        currentParagraphBreak = false;
      }
      continue;
    }
    if (current) {
      chunks.push(current);
      paragraphBreaks.push(currentParagraphBreak);
    }
    current = unit.text;
    currentParagraphBreak = unit.paragraphBreakAfter;
    if (currentParagraphBreak) {
      chunks.push(current);
      paragraphBreaks.push(true);
      current = "";
      currentParagraphBreak = false;
    }
  }
  if (current) {
    chunks.push(current);
    paragraphBreaks.push(currentParagraphBreak);
  }

  if (!chunks.length || chunks.some((chunk) => !chunk || codePointLength(chunk) > maxCharacters)) {
    throw new Error("Não foi possível dividir o texto com segurança.");
  }
  const chunkMetadata = chunks.map((chunk, index) => describeVoiceChunk(chunk, {
    index,
    paragraphBreakAfter: paragraphBreaks[index],
  }));
  return { normalizedText, chunks, chunkMetadata };
}

export function concatenateFloat32(chunks) {
  if (!Array.isArray(chunks) || chunks.some((chunk) => !(chunk instanceof Float32Array))) {
    throw new TypeError("Os chunks de áudio devem ser Float32Array.");
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!Number.isSafeInteger(total)) throw new RangeError("O áudio concatenado excede o limite seguro.");
  const output = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function trimFloat32Silence(audio, sampleRate, {
  thresholdDbfs = SILENCE_THRESHOLD_DBFS,
  paddingMilliseconds,
  leadingPaddingMilliseconds = paddingMilliseconds ?? TRIM_LEADING_PADDING_MILLISECONDS,
  trailingPaddingMilliseconds = paddingMilliseconds ?? TRIM_TRAILING_PADDING_MILLISECONDS,
} = {}) {
  if (!(audio instanceof Float32Array)) throw new TypeError("O trecho de áudio deve ser Float32Array.");
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new RangeError("sampleRate deve estar entre 8000 e 192000 Hz.");
  }
  if (!Number.isFinite(thresholdDbfs) || thresholdDbfs >= 0 || thresholdDbfs < -120) {
    throw new RangeError("thresholdDbfs deve estar entre -120 e 0 dBFS.");
  }
  if (!Number.isFinite(leadingPaddingMilliseconds) || leadingPaddingMilliseconds < 0 || leadingPaddingMilliseconds > 500
    || !Number.isFinite(trailingPaddingMilliseconds) || trailingPaddingMilliseconds < 0 || trailingPaddingMilliseconds > 500) {
    throw new RangeError("As margens de silêncio devem estar entre 0 e 500 ms.");
  }
  const threshold = 10 ** (thresholdDbfs / 20);
  let first = 0;
  while (first < audio.length && Math.abs(Number.isFinite(audio[first]) ? audio[first] : 0) <= threshold) first += 1;
  if (first === audio.length) return new Float32Array(0);
  let last = audio.length - 1;
  while (last > first && Math.abs(Number.isFinite(audio[last]) ? audio[last] : 0) <= threshold) last -= 1;
  const leadingPadding = Math.round(sampleRate * leadingPaddingMilliseconds / 1000);
  const trailingPadding = Math.round(sampleRate * trailingPaddingMilliseconds / 1000);
  const start = Math.max(0, first - leadingPadding);
  const end = Math.min(audio.length, last + trailingPadding + 1);
  const trimmed = new Float32Array(end - start);
  for (let index = start; index < end; index += 1) {
    const sample = audio[index];
    trimmed[index - start] = Number.isFinite(sample) ? sample : 0;
  }
  return trimmed;
}

/**
 * Selects the useful, authorized portion of a clone reference without
 * mastering or denoising it. Removing only sub -62 dBFS outer silence before
 * the ten-second cap prevents a recorder's idle lead-in from replacing useful
 * speech while the 120 ms guards retain breath and unvoiced consonants.
 */
export function prepareVoiceReferencePcm(audio, sampleRate, {
  minimumSeconds = REFERENCE_MINIMUM_SECONDS,
  maximumSeconds = REFERENCE_MAXIMUM_SECONDS,
} = {}) {
  if (!(audio instanceof Float32Array)) throw new TypeError("A referência de voz deve ser Float32Array.");
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new RangeError("sampleRate deve estar entre 8000 e 192000 Hz.");
  }
  if (!Number.isFinite(minimumSeconds) || minimumSeconds <= 0 || minimumSeconds > 10
    || !Number.isFinite(maximumSeconds) || maximumSeconds < minimumSeconds || maximumSeconds > 30) {
    throw new RangeError("A duração útil da referência está fora do intervalo seguro.");
  }

  const useful = trimFloat32Silence(audio, sampleRate, {
    thresholdDbfs: REFERENCE_SILENCE_THRESHOLD_DBFS,
    leadingPaddingMilliseconds: REFERENCE_EDGE_PADDING_MILLISECONDS,
    trailingPaddingMilliseconds: REFERENCE_EDGE_PADDING_MILLISECONDS,
  });
  const minimumSamples = Math.ceil(sampleRate * minimumSeconds);
  if (useful.length < minimumSamples) {
    throw new RangeError(`A amostra precisa ter ao menos ${minimumSeconds} segundo(s) de voz útil.`);
  }
  const maximumSamples = Math.floor(sampleRate * maximumSeconds);
  return useful.length > maximumSamples ? useful.slice(0, maximumSamples) : useful;
}

/**
 * Conservative, deterministic mastering for a mono local-TTS chunk.
 *
 * This deliberately avoids denoising or spectral reconstruction, which can
 * change a cloned identity. It only sanitizes invalid PCM, removes DC/sub-bass,
 * applies at most +2.5 dB of whole-chunk gain and uses a soft peak knee.
 */
export function masterVoicePcm(audio, sampleRate, {
  highPassHz = MASTERING_HIGH_PASS_HZ,
  peakCeiling = MASTERING_PEAK_CEILING,
  maximumGainDb = MASTERING_MAXIMUM_GAIN_DB,
} = {}) {
  if (!(audio instanceof Float32Array)) throw new TypeError("O áudio a masterizar deve ser Float32Array.");
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new RangeError("sampleRate deve estar entre 8000 e 192000 Hz.");
  }
  if (!Number.isFinite(highPassHz) || highPassHz < 0 || highPassHz > Math.min(180, sampleRate * 0.04)) {
    throw new RangeError("highPassHz está fora do intervalo seguro.");
  }
  if (!Number.isFinite(peakCeiling) || peakCeiling < 0.5 || peakCeiling >= 1) {
    throw new RangeError("peakCeiling deve estar entre 0.5 e 1.");
  }
  if (!Number.isFinite(maximumGainDb) || maximumGainDb < 0 || maximumGainDb > 6) {
    throw new RangeError("maximumGainDb deve estar entre 0 e 6 dB.");
  }

  const output = new Float32Array(audio.length);
  for (let index = 0; index < audio.length; index += 1) {
    const sample = audio[index];
    output[index] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
  }

  // Two-pole Butterworth high-pass (Direct Form I). At 48 Hz this removes DC,
  // handling rumble and decoder offset while leaving the voice fundamental.
  if (output.length && highPassHz > 0) {
    const omega = 2 * Math.PI * highPassHz / sampleRate;
    const cosine = Math.cos(omega);
    const sine = Math.sin(omega);
    const alpha = sine / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    const b0 = (1 + cosine) / (2 * a0);
    const b1 = -(1 + cosine) / a0;
    const b2 = b0;
    const a1 = -2 * cosine / a0;
    const a2 = (1 - alpha) / a0;
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let index = 0; index < output.length; index += 1) {
      const x0 = output[index];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      output[index] = Number.isFinite(y0) ? y0 : 0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
  }

  let peak = 0;
  for (const sample of output) peak = Math.max(peak, Math.abs(sample));
  const maximumGain = 10 ** (maximumGainDb / 20);
  const gain = peak > 0 ? Math.min(maximumGain, 0.88 / peak) : 1;
  const knee = peakCeiling * 0.9;
  const kneeRange = Math.max(Number.EPSILON, peakCeiling - knee);
  for (let index = 0; index < output.length; index += 1) {
    const gained = output[index] * gain;
    const absolute = Math.abs(gained);
    output[index] = absolute <= knee
      ? gained
      : Math.sign(gained) * Math.min(
        peakCeiling,
        knee + kneeRange * (1 - Math.exp(-(absolute - knee) / kneeRange)),
      );
  }
  return output;
}

function measureInactiveEdges(audio, threshold) {
  let firstActive = 0;
  while (firstActive < audio.length && Math.abs(audio[firstActive]) <= threshold) firstActive += 1;
  let lastActive = audio.length - 1;
  while (lastActive >= firstActive && Math.abs(audio[lastActive]) <= threshold) lastActive -= 1;
  return {
    leading: firstActive,
    trailing: Math.max(0, audio.length - 1 - lastActive),
  };
}

function applyConstantPowerEdgeFades(audio, fadeSamples, inactiveEdges, { fadeIn, fadeOut }) {
  const output = new Float32Array(audio);

  // Fade only the already-inactive guard samples. The previous whole-edge
  // taper attenuated up to 20 ms upstream plus another 8 ms here, which could
  // erase the attack of /o/, /f/ and /s/ in short Portuguese prompts.
  const fadeInLength = fadeIn ? Math.min(fadeSamples, inactiveEdges.leading) : 0;
  if (fadeInLength >= 2) {
    for (let index = 0; index < fadeInLength; index += 1) {
      const phase = index / (fadeInLength - 1) * Math.PI / 2;
      output[index] *= Math.sin(phase);
    }
    output[0] = 0;
  }

  const fadeOutLength = fadeOut ? Math.min(fadeSamples, inactiveEdges.trailing) : 0;
  if (fadeOutLength >= 2) {
    const start = output.length - fadeOutLength;
    for (let index = 0; index < fadeOutLength; index += 1) {
      const phase = index / (fadeOutLength - 1) * Math.PI / 2;
      output[start + index] *= Math.cos(phase);
    }
    output[output.length - 1] = 0;
  }
  return output;
}

export function stitchVoiceAudio(renderedChunks, sampleRate, {
  thresholdDbfs = SILENCE_THRESHOLD_DBFS,
  crossfadeMilliseconds = CROSSFADE_MILLISECONDS,
} = {}) {
  if (!Array.isArray(renderedChunks) || !renderedChunks.length) {
    throw new TypeError("A costura exige ao menos um chunk renderizado.");
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new RangeError("sampleRate deve estar entre 8000 e 192000 Hz.");
  }
  if (!Number.isFinite(crossfadeMilliseconds) || crossfadeMilliseconds < 0 || crossfadeMilliseconds > 50) {
    throw new RangeError("crossfadeMilliseconds deve estar entre 0 e 50 ms.");
  }

  const fadeThreshold = 10 ** (thresholdDbfs / 20);
  const prepared = renderedChunks.flatMap((chunk, originalIndex) => {
    const audio = chunk instanceof Float32Array ? chunk : chunk?.audio;
    if (!(audio instanceof Float32Array)) throw new TypeError("Cada chunk precisa conter áudio Float32Array.");
    const metadata = chunk instanceof Float32Array
      ? describeVoiceChunk("trecho", { index: originalIndex })
      : chunk.metadata ?? describeVoiceChunk("trecho", { index: originalIndex });
    const trimmed = trimFloat32Silence(audio, sampleRate, { thresholdDbfs });
    return trimmed.length ? [{
      audio: masterVoicePcm(trimmed, sampleRate),
      inactiveEdges: measureInactiveEdges(trimmed, fadeThreshold),
      metadata,
    }] : [];
  });
  if (!prepared.length) return new Float32Array(0);

  const fadeSamples = Math.max(0, Math.round(sampleRate * crossfadeMilliseconds / 1000));
  const pauses = prepared.slice(0, -1).map(({ metadata }) => {
    const pauseMs = Number.isFinite(metadata?.pauseMs) ? metadata.pauseMs : PROSODIC_PAUSES.soft;
    return Math.max(0, Math.round(sampleRate * pauseMs / 1000));
  });
  const terminalTailSamples = Math.max(1, Math.round(sampleRate * TERMINAL_TAIL_MILLISECONDS / 1000));
  const initialHeadSamples = Math.max(1, Math.round(sampleRate * INITIAL_HEAD_MILLISECONDS / 1000));
  const totalSamples = prepared.reduce((sum, chunk) => sum + chunk.audio.length, 0)
    + pauses.reduce((sum, length) => sum + length, 0)
    + initialHeadSamples
    + terminalTailSamples;
  if (!Number.isSafeInteger(totalSamples)) throw new RangeError("O áudio costurado excede o limite seguro.");

  const output = new Float32Array(totalSamples);
  let offset = initialHeadSamples;
  prepared.forEach(({ audio, inactiveEdges }, index) => {
    const faded = applyConstantPowerEdgeFades(audio, fadeSamples, inactiveEdges, {
      fadeIn: true,
      fadeOut: true,
    });
    output.set(faded, offset);
    offset += faded.length;
    if (index < pauses.length) offset += pauses[index];
  });
  return output;
}

export const LOCAL_VOICE_TEXT_LIMITS = Object.freeze({
  maxInputCharacters: MAX_INPUT_CHARACTERS,
  defaultChunkCharacters: DEFAULT_CHUNK_CHARACTERS,
  minChunkCharacters: MIN_CHUNK_CHARACTERS,
  maxChunkCharacters: MAX_CHUNK_CHARACTERS,
  silenceThresholdDbfs: SILENCE_THRESHOLD_DBFS,
  crossfadeMilliseconds: CROSSFADE_MILLISECONDS,
  trimLeadingPaddingMilliseconds: TRIM_LEADING_PADDING_MILLISECONDS,
  trimTrailingPaddingMilliseconds: TRIM_TRAILING_PADDING_MILLISECONDS,
  initialHeadMilliseconds: INITIAL_HEAD_MILLISECONDS,
  terminalTailMilliseconds: TERMINAL_TAIL_MILLISECONDS,
  masteringHighPassHz: MASTERING_HIGH_PASS_HZ,
  masteringPeakCeiling: MASTERING_PEAK_CEILING,
  masteringMaximumGainDb: MASTERING_MAXIMUM_GAIN_DB,
  referenceSilenceThresholdDbfs: REFERENCE_SILENCE_THRESHOLD_DBFS,
  referenceEdgePaddingMilliseconds: REFERENCE_EDGE_PADDING_MILLISECONDS,
  referenceMinimumSeconds: REFERENCE_MINIMUM_SECONDS,
  referenceMaximumSeconds: REFERENCE_MAXIMUM_SECONDS,
  prosodicPausesMs: PROSODIC_PAUSES,
});
