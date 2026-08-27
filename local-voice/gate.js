const status = document.getElementById("stat-status");
const model = document.querySelector("#model-status .model-status__text");
const PROTOCOL_VERSION = 1;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requestIdFrom(value) {
  return typeof value === "string" && SAFE_REQUEST_ID.test(value) ? value : null;
}

const receiveBootRequest = (event) => {
  if (event.origin !== window.location.origin || event.source !== window.parent) return;
  if (event.data?.type !== "audioria:voice-boot-request") return;
  globalThis.__audioriaVoiceBootRequestId = requestIdFrom(event.data.requestId);
};

if (window.parent !== window) window.addEventListener("message", receiveBootRequest);

function reportParentBootFailure(code) {
  if (window.parent === window) return;
  window.parent.postMessage({
    protocolVersion: PROTOCOL_VERSION,
    type: "audioria:voice-error",
    requestId: null,
    code,
  }, window.location.origin);
}

function setBlocked(message) {
  if (status) status.textContent = message;
  if (model) model.textContent = "Aguardando consentimento";
  document.body.dataset.consentGate = "blocked";
}

if (window.parent === window) {
  setBlocked("Abra este motor pelo Laboratório Audioria e confirme a autorização da voz.");
} else {
  setBlocked("Confirmando autorização da voz…");
  const timeout = window.setTimeout(() => {
    setBlocked("Autorização não recebida. Reabra o motor pelo laboratório.");
    reportParentBootFailure("engine_consent_timeout");
  }, 10_000);

  const receiveConsent = async (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.source !== window.parent) return;
    if (event.data?.type !== "audioria:voice-consent" || event.data.confirmed !== true) return;
    window.removeEventListener("message", receiveConsent);
    window.clearTimeout(timeout);
    const requestId = requestIdFrom(event.data.requestId);
    Object.defineProperty(globalThis, "__audioriaVoiceBootRequestId", {
      configurable: true,
      value: requestId,
      writable: true,
    });
    document.body.dataset.consentGate = "confirmed";
    if (model) model.textContent = "Baixando modelos locais";
    try {
      await import("./bootstrap.js?v=6.4.0");
    } catch (error) {
      setBlocked(error instanceof Error ? error.message : "O motor local não pôde iniciar.");
      reportParentBootFailure("engine_boot_failed");
    }
  };
  window.addEventListener("message", receiveConsent);
}
