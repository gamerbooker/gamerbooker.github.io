const RUNTIME_URL = new URL("./vendor/PCMPlayerWorklet.js", import.meta.url);
const EXPECTED_SHA256 = "f501dfc7ea2161883297b7837883dcc72f7b5f3754be3d689df98bf62dc52648";

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const response = await fetch(RUNTIME_URL, { cache: "force-cache" });
if (!response.ok) throw new Error(`Falha ao baixar o player (${response.status})`);
let source = await response.text();
if (await sha256Hex(source) !== EXPECTED_SHA256) {
  throw new Error("Player remoto alterado; execução bloqueada até revisão.");
}
const eventEmitterUrl = new URL("/local-voice/EventEmitter.js", window.location.origin).href;
source = source.replace("'./EventEmitter.js'", `'${eventEmitterUrl}'`);
const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
const runtime = await import(moduleUrl);

export const PCMPlayerWorklet = runtime.PCMPlayerWorklet;
