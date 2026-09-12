/**
 * Running the model on your own machine instead of somebody else's.
 *
 * Anything that speaks the OpenAI chat-completions shape works — Ollama, LM
 * Studio, llama.cpp's server, vLLM, Jan — so this is a base URL and a model
 * name rather than an integration with one product.
 *
 * The rule that makes the toggle mean anything:
 *
 *   when local is on and the local server cannot be reached, NOTHING falls back
 *   to the cloud.
 *
 * A silent fallback would be the worst possible behaviour here: the user turned
 * this on precisely so their reading would not leave the machine, and the one
 * moment it would betray them is the moment they are least able to notice. A
 * failure is reported as a failure.
 */
import { requestJSON } from "../agent/transport.js";

export const LOCAL_DEFAULTS = Object.freeze({
  /** Off by default: it needs a server running, which most people will not have. */
  LOCAL_MODEL_ENABLED: false,
  /** Ollama's OpenAI-compatible endpoint, the most common thing to be running. */
  LOCAL_MODEL_URL: "http://localhost:11434/v1",
  LOCAL_MODEL_NAME: "llama3.1:8b"
});

export const LOCAL_SETTING_KEYS = Object.freeze(Object.keys(LOCAL_DEFAULTS));

/**
 * Local models are slow, and a 7B on a CPU can genuinely take a minute. The
 * cloud timeout would give up on a working setup and look like a broken one.
 */
export const LOCAL_TIMEOUT_MS = 180_000;

/** Normalize whatever the user pasted into a base ending in /v1. */
export function normalizeBase(url) {
  let text = String(url ?? "").trim().replace(/\s+/g, "");
  if (!text) return "";
  if (!/^https?:\/\//i.test(text)) text = "http://" + text;

  text = text.replace(/\/+$/, "");
  // People paste the full endpoint out of a curl example.
  text = text.replace(/\/chat\/completions$/i, "");
  // Ollama's native API is not the compatible one; point at the compatible one.
  text = text.replace(/\/api$/i, "/v1");
  if (!/\/v\d+$/i.test(text)) text += "/v1";
  return text;
}

export const chatUrl = (base) => normalizeBase(base) + "/chat/completions";
export const modelsUrl = (base) => normalizeBase(base) + "/models";

export function normalizeLocalSettings(stored = {}) {
  const url = normalizeBase(stored.LOCAL_MODEL_URL) || LOCAL_DEFAULTS.LOCAL_MODEL_URL;
  const name = String(stored.LOCAL_MODEL_NAME ?? "").trim() || LOCAL_DEFAULTS.LOCAL_MODEL_NAME;
  return {
    LOCAL_MODEL_ENABLED: stored.LOCAL_MODEL_ENABLED === true,
    LOCAL_MODEL_URL: url,
    LOCAL_MODEL_NAME: name
  };
}

/** @param {any} api chrome */
export async function loadLocalSettings(api = globalThis.chrome) {
  try {
    return normalizeLocalSettings(await api.storage.local.get(LOCAL_SETTING_KEYS));
  } catch {
    return normalizeLocalSettings({});
  }
}

/**
 * A failed fetch to localhost is almost always one of two things, and the raw
 * error says neither. Naming both saves the twenty minutes it otherwise costs.
 */
export function explainFailure(error, base) {
  const message = error?.message ?? String(error);
  if (/Network request failed|Failed to fetch|timed out/i.test(message)) {
    return (
      "Could not reach " + base + ". Either nothing is listening there, or the server is " +
      "refusing this extension's origin — see the setup note under the toggle."
    );
  }
  if (/HTTP 404/.test(message)) {
    return base + " answered, but has no /chat/completions endpoint. Check the URL points at an OpenAI-compatible API.";
  }
  if (/HTTP 403/.test(message)) {
    return base + " refused this extension's origin. Allow it in the server's CORS settings.";
  }
  return message;
}

/**
 * A model function with the same shape the agent and the slice composer already
 * use: ({messages, tools, responseFormat, maxOutputTokens}) -> message.
 */
export function createLocalModel({ settings, fetchImpl = globalThis.fetch, timeoutMs = LOCAL_TIMEOUT_MS } = {}) {
  const { LOCAL_MODEL_URL: base, LOCAL_MODEL_NAME: model } = normalizeLocalSettings(settings);
  const url = chatUrl(base);

  return async ({ messages, tools, responseFormat, maxOutputTokens = 4096 }) => {
    const body = {
      model,
      messages,
      ...(tools ? { tools, tool_choice: "auto" } : {}),
      ...(responseFormat ? { response_format: responseFormat, max_tokens: maxOutputTokens } : {})
    };

    const send = (payload) =>
      requestJSON(
        url,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
        // No retry: retrying a call that may already have run for two minutes
        // wastes another two and usually fails the same way.
        { fetchImpl, timeoutMs, retries: 0 }
      );

    let data;
    try {
      data = await send(body);
    } catch (error) {
      // Not every local server implements JSON mode. One retry without it is
      // worth trying, because the prompt already asks for JSON in words.
      if (responseFormat && /HTTP (400|422|501)/.test(error?.message ?? "")) {
        const { response_format: _dropped, ...plain } = body;
        data = await send(plain);
      } else {
        throw new Error(explainFailure(error, base));
      }
    }

    return data.choices?.[0]?.message;
  };
}

/**
 * Check the server is there and say what it has. Used by the test button, which
 * exists because the failure mode of this feature is a wall of nothing.
 *
 * @returns {Promise<{ok: boolean, models: string[], error: string|null, base: string}>}
 */
export async function probeLocal({ settings, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const { LOCAL_MODEL_URL: base, LOCAL_MODEL_NAME: wanted } = normalizeLocalSettings(settings);

  try {
    const data = await requestJSON(modelsUrl(base), { method: "GET" }, { fetchImpl, timeoutMs, retries: 0 });
    const models = (Array.isArray(data?.data) ? data.data : [])
      .map((entry) => entry?.id)
      .filter((id) => typeof id === "string");

    return {
      ok: true,
      base,
      models,
      // Listed models are a courtesy, not a contract: some servers return none
      // and still serve the model perfectly well.
      has: models.length ? models.includes(wanted) : null,
      error: null
    };
  } catch (error) {
    return { ok: false, base, models: [], has: null, error: explainFailure(error, base) };
  }
}

/**
 * What the user has to do on their side, chosen from the port they pointed at.
 * The CORS step is the one everybody hits: these servers check the Origin header
 * and a chrome-extension:// origin is not allowed by default.
 */
export function setupNote(url, extensionOrigin = "chrome-extension://<this extension's id>") {
  const base = normalizeBase(url);

  if (/:11434(\/|$)/.test(base)) {
    return (
      "Ollama: run `ollama serve`, pull a model with `ollama pull <name>`, and allow this " +
      "extension by starting it with OLLAMA_ORIGINS=" + extensionOrigin + " (or OLLAMA_ORIGINS=chrome-extension://*)."
    );
  }
  if (/:1234(\/|$)/.test(base)) {
    return "LM Studio: start the local server tab, load a model, and turn on “Enable CORS” in its settings.";
  }
  if (/:8080(\/|$)/.test(base)) {
    return "llama.cpp: run `llama-server -m <model.gguf> --port 8080`; it allows every origin by default.";
  }
  return (
    "Point this at any OpenAI-compatible server's base URL. It must allow this extension's " +
    "origin (" + extensionOrigin + ") in its CORS settings."
  );
}

/**
 * Pick the provider for a model call.
 *
 * The whole contract is in the second branch: local on, cloud key present, and
 * the answer is still local. Turning this on is a statement about where the
 * reading goes, not a preference about which model is better.
 *
 * @returns {{provider: "local"|"cloud"|"none", settings: object, reason: string}}
 */
export function chooseProvider({ local, env = {} }) {
  if (local?.LOCAL_MODEL_ENABLED) {
    return { provider: "local", settings: local, reason: "local processing is on" };
  }
  if (env.OPENROUTER_API_KEY) {
    return { provider: "cloud", settings: local, reason: "using OpenRouter" };
  }
  return { provider: "none", settings: local, reason: "no model is configured" };
}
