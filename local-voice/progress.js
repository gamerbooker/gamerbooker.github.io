// Shared stage boundaries: the parent and iframe must never disagree about 52%.
// These represent completed stages, not elapsed/remaining time estimates.
export const VOICE_PROGRESS = Object.freeze({
  queued: 4, downloadEnd: 36, modelReady: 40, referenceDecoding: 44,
  referenceEncoding: 48, referenceConditioning: 58, referenceReady: 68,
  textReady: 70, synthesisStart: 72, synthesisEnd: 96, mastering: 99, complete: 100,
});

export const VOICE_TIMEOUTS = Object.freeze({
  bootIdleMs: 300_000,
  initializationIdleMs: 900_000,
  preparationIdleMs: 900_000,
  synthesisIdleMs: 900_000,
});
