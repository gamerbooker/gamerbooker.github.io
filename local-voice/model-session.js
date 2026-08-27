export const MODEL_SESSION_LOADER_KEY = "__audioria_model_session_652";

// Fetch/read one graph, compile it, then release its input buffer before
// starting the next. Used by BOTH profiles, not just the larger model.
export async function loadModelSessions(files, createSession, { fetchModel = globalThis.fetch, onStage = () => {} } = {}) {
  const sessions = [];
  try {
    for (const [index, file] of files.entries()) {
      const response = await fetchModel(file.url);
      if (!response.ok) throw new Error("Um componente do motor não pôde ser carregado.");
      let bytes = new Uint8Array(await response.arrayBuffer());
      onStage({ phase: "initializing", file: file.name, current: index + 1, total: files.length });
      let session;
      try { session = await createSession(bytes); }
      catch (cause) {
        const error = new Error("Os arquivos chegaram, mas este aparelho não conseguiu preparar o modelo. Feche outras abas e tente novamente, ou escolha Essencial.");
        error.code = "MODEL_INITIALIZATION_FAILED";
        error.cause = cause;
        throw error;
      } finally { bytes = null; }
      sessions.push(session);
      onStage({ phase: "initialized", file: file.name, current: index + 1, total: files.length });
    }
    return sessions;
  } catch (error) {
    await Promise.allSettled(sessions.map((session) => session.release?.()));
    throw error;
  }
}

export function installModelSessionRuntime(source) {
  const before = `    const [encoderRes, textCondRes, flowMainRes, flowFlowRes, decoderRes] = await Promise.all([
        ort.InferenceSession.create(bundlePath(language, MODEL_STEMS.mimi_encoder), sessionOptions),
        ort.InferenceSession.create(bundlePath(language, MODEL_STEMS.text_conditioner), sessionOptions),
        ort.InferenceSession.create(bundlePath(language, MODEL_STEMS.flow_lm_main), sessionOptions),
        ort.InferenceSession.create(bundlePath(language, MODEL_STEMS.flow_lm_flow), sessionOptions),
        ort.InferenceSession.create(bundlePath(language, MODEL_STEMS.mimi_decoder), sessionOptions),
    ]);`;
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error("A inicialização não corresponde ao motor revisado.");
  return source.replace(before, `    const [encoderRes, textCondRes, flowMainRes, flowFlowRes, decoderRes] = await globalThis[${JSON.stringify(MODEL_SESSION_LOADER_KEY)}](
        Object.values(MODEL_STEMS).map((name) => ({ name, url: bundlePath(language, name) })),
        (bytes) => ort.InferenceSession.create(bytes, sessionOptions),
    );`);
}
