// A small data-only safetensors reader. No pickle, scripts, or remote code.
const MAX_VOICE_BYTES = 48 * 1024 * 1024;
const MAX_HEADER_BYTES = 128 * 1024;
const TYPES = Object.freeze({
  F32: { bytes: 4, name: "float32", array: Float32Array },
  I64: { bytes: 8, name: "int64", array: BigInt64Array },
  BOOL: { bytes: 1, name: "bool", array: Uint8Array },
});

export function parseVoiceSafetensors(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 10 || buffer.byteLength > MAX_VOICE_BYTES) {
    throw new RangeError("Estado de voz com tamanho inválido.");
  }
  const headerLength = Number(new DataView(buffer).getBigUint64(0, true));
  if (!Number.isSafeInteger(headerLength) || headerLength < 2 || headerLength > MAX_HEADER_BYTES || headerLength + 8 > buffer.byteLength) {
    throw new RangeError("Cabeçalho de voz inválido.");
  }
  const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(buffer, 8, headerLength)));
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new TypeError("Metadados de voz inválidos.");
  const records = Object.create(null);
  const entries = Object.entries(metadata).filter(([key]) => key !== "__metadata__");
  if (!entries.length || entries.length > 256) throw new RangeError("Quantidade de tensores inválida.");
  const planned = [];
  const regions = [];
  const payloadStart = 8 + headerLength;
  for (const [key, entry] of entries) {
    if (!/^[a-zA-Z0-9_./-]{1,220}$/u.test(key) || !entry || typeof entry !== "object") throw new TypeError("Tensor de voz inválido.");
    const type = TYPES[entry.dtype];
    if (!type || !Array.isArray(entry.shape) || entry.shape.length > 6
      || entry.shape.some((size) => !Number.isSafeInteger(size) || size < 0 || size > 1_000_000)) {
      throw new TypeError("Formato de tensor de voz não suportado.");
    }
    if (!Array.isArray(entry.data_offsets) || entry.data_offsets.length !== 2) throw new TypeError("Posição de tensor inválida.");
    const [start, end] = entry.data_offsets;
    const elements = entry.shape.reduce((count, size) => count * size, 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start
      || payloadStart + end > buffer.byteLength || !Number.isSafeInteger(elements) || end - start !== elements * type.bytes) {
      throw new RangeError("Limites de tensor de voz inválidos.");
    }
    regions.push([start, end]);
    planned.push({ key, entry, type, start, end });
  }
  regions.sort((left, right) => left[0] - right[0]);
  if (!regions.length || regions.length > 256 || regions.some((region, index) => index > 0 && region[0] < regions[index - 1][1])) {
    throw new RangeError("Tensores de voz sobrepostos ou ausentes.");
  }
  // Validate the entire data layout BEFORE allocating any tensor arrays.
  for (const { key, entry, type, start, end } of planned) {
    records[key] = { data: new type.array(buffer.slice(payloadStart + start, payloadStart + end)), shape: entry.shape, dtype: type.name };
  }
  return records;
}

export function assertStudioVoiceState(record) {
  for (let layer = 0; layer < 24; layer += 1) {
    const prefix = `transformer.layers.${layer}.self_attn/`;
    const cache = record[`${prefix}cache`];
    const offset = record[`${prefix}offset`];
    if (!cache || cache.dtype !== "float32" || cache.shape.length !== 5
      || cache.shape[0] !== 2 || cache.shape[1] !== 1 || cache.shape[3] !== 16 || cache.shape[4] !== 64
      || cache.shape[2] < 1 || cache.shape[2] > 500
      || !offset || offset.dtype !== "int64" || offset.data.length !== 1
      || Number(offset.data[0]) !== cache.shape[2]) {
      throw new RangeError("A referência não pertence ao modelo português de 24 camadas.");
    }
  }
  return record;
}
