// Public, immutable assets only. A completed Blob is shared with Cache and the
// engine in sequence: never tee a large body between two unequal consumers.
export const MODEL_DOWNLOAD_LIMITS = Object.freeze({ idleMs: 60_000, cacheMs: 8_000, attempts: 3, retryDelayMs: 700 });

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("Download cancelado.", "AbortError");
}

function bounded(promise, milliseconds, signal, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      callback(value);
    };
    const cancelled = () => finish(reject, abortError(signal));
    timer = setTimeout(() => {
      const error = new Error("A conexão ficou sem responder. Tentando novamente o arquivo incompleto.");
      error.code = "MODEL_IDLE";
      finish(reject, error);
      onTimeout?.();
    }, milliseconds);
    signal?.addEventListener("abort", cancelled, { once: true });
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
    if (signal?.aborted) cancelled();
  });
}

function assetResponse(blob) {
  return new Response(blob, { headers: {
    "content-type": blob.type || "application/octet-stream",
    "content-length": String(blob.size),
    "x-audioria-complete": "1",
  } });
}

function invalidAsset(message) {
  const error = new Error(message);
  error.code = "MODEL_ASSET_INVALID";
  return error;
}

async function readCompleteBlob(response, { url, expectedBytes, phase, idleMs, signal, abort, report }) {
  if (response.status !== 200 || !response.body) throw invalidAsset("O arquivo do modelo está vazio ou incompleto.");
  const encoded = response.headers.get("content-encoding");
  const expected = expectedBytes || (!encoded ? Number(response.headers.get("content-length")) : 0) || 0;
  const reader = response.body.getReader();
  let loaded = 0;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await bounded(reader.read(), idleMs, signal, abort);
        if (done) {
          if (!loaded || (expected && loaded !== expected)) throw invalidAsset("O download do modelo chegou incompleto.");
          reader.releaseLock();
          controller.close();
          return;
        }
        loaded += value.byteLength;
        if (expected && loaded > expected) throw invalidAsset("O arquivo recebido não corresponde ao modelo revisado.");
        report({ url, loadedBytes: loaded, totalBytes: expected, phase });
        controller.enqueue(value);
      } catch (error) {
        void reader.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    cancel(reason) { abort?.(); return reader.cancel(reason); },
  });
  report({ url, loadedBytes: 0, totalBytes: expected, phase });
  const blob = await new Response(body, { headers: { "content-type": response.headers.get("content-type") || "application/octet-stream" } }).blob();
  // CDNs/error caches sometimes return a 200 HTML page instead of model bytes.
  const prefix = await blob.slice(0, 160).text();
  if (/^\s*(?:<!doctype\s+html|<html\b|<\?xml\b)/iu.test(prefix)) throw invalidAsset("O servidor devolveu uma página em vez do arquivo do modelo.");
  if (new URL(url).pathname.endsWith("/bundle.json")) {
    try {
      const metadata = JSON.parse(await blob.text());
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("invalid metadata");
    } catch { throw invalidAsset("Os dados do modelo chegaram incompletos."); }
  }
  return blob;
}

export function createModelAssetLoader({
  networkFetch = globalThis.fetch.bind(globalThis), cacheStorage = globalThis.caches,
  cacheName, isTrustedResponse, expectedBytes = () => 0, report = () => {},
  limits = MODEL_DOWNLOAD_LIMITS,
}) {
  let storageDisabled = false;
  return async function loadModelAsset(request) {
    const { signal, url } = request;
    if (signal.aborted) throw abortError(signal);
    const expected = expectedBytes(url) || 0;
    // Never inherit cookies, authentication headers, or application credentials.
    const cacheRequest = new Request(url, { mode: "cors", credentials: "omit", redirect: "follow", cache: "no-store", signal });
    let cache = null;
    try {
      if (cacheStorage && !storageDisabled) cache = await bounded(cacheStorage.open(cacheName), limits.cacheMs, signal);
      const cached = cache && await bounded(cache.match(cacheRequest), limits.cacheMs, signal);
      if (cached) {
        try {
          const blob = await readCompleteBlob(cached, { url, expectedBytes: expected, phase: "cache", idleMs: limits.cacheMs, signal, report });
          report({ url, loadedBytes: blob.size, totalBytes: blob.size, phase: "cached" });
          return assetResponse(blob);
        } catch (error) {
          if (signal.aborted) throw abortError(signal);
          if (error?.code === "MODEL_ASSET_INVALID") {
            await bounded(cache.delete(cacheRequest), limits.cacheMs, signal).catch(() => {});
            report({ url, loadedBytes: 0, totalBytes: expected, phase: "cache-repair" });
          } else {
            // A slow disk does not prove that this cached file is corrupt.
            cache = null;
            storageDisabled = true;
            report({ url, loadedBytes: 0, totalBytes: expected, phase: "storage-unavailable" });
          }
          // Only this damaged asset is replaced; successful downloads stay intact.
        }
      }
    } catch {
      if (signal.aborted) throw abortError(signal);
      cache = null;
      storageDisabled = true;
      report({ url, loadedBytes: 0, totalBytes: expected, phase: "storage-unavailable" });
    }

    for (let attempt = 1; attempt <= limits.attempts; attempt++) {
      const controller = new AbortController();
      const cancel = () => controller.abort(abortError(signal));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        const outgoing = new Request(cacheRequest, { signal: controller.signal });
        const response = await bounded(networkFetch(outgoing), limits.idleMs, signal, () => controller.abort());
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          const error = new Error(`Não foi possível baixar este componente (HTTP ${response.status}).`);
          error.retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
          throw error;
        }
        if (!isTrustedResponse(response)) {
          void response.body?.cancel().catch(() => {});
          const error = new Error("O endereço do modelo não passou pela verificação de origem.");
          error.retryable = false;
          throw error;
        }
        const blob = await readCompleteBlob(response, { url, expectedBytes: expected, phase: "download", idleMs: limits.idleMs, signal, abort: () => controller.abort(), report });
        if (cache) {
          report({ url, loadedBytes: blob.size, totalBytes: blob.size, phase: "storing" });
          try {
            await bounded(cache.put(cacheRequest, assetResponse(blob)), limits.cacheMs, signal);
          } catch {
            if (signal.aborted) throw abortError(signal);
            // The complete Blob is still available: quota failure is not a
            // reason to repeat the download or prevent this generation.
            cache = null;
            storageDisabled = true;
            report({ url, loadedBytes: blob.size, totalBytes: blob.size, phase: "storage-unavailable" });
          }
        }
        report({ url, loadedBytes: blob.size, totalBytes: blob.size, phase: "downloaded" });
        return assetResponse(blob);
      } catch (error) {
        controller.abort();
        if (signal.aborted) throw abortError(signal);
        if (error?.retryable === false || attempt === limits.attempts) {
          const failure = new Error("Não foi possível concluir o download. Os arquivos completos foram mantidos. Toque em Tentar novamente para continuar.");
          failure.code = "MODEL_DOWNLOAD_FAILED";
          failure.cause = error;
          throw failure;
        }
        report({ url, loadedBytes: 0, totalBytes: expected, phase: "retry", attempt: attempt + 1, attempts: limits.attempts });
        await bounded(new Promise((resolve) => setTimeout(resolve, limits.retryDelayMs * attempt)), limits.retryDelayMs * attempt + 1000, signal);
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }
    throw new Error("Não foi possível carregar o modelo.");
  };
}
