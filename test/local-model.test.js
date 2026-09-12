/**
 * Running the model locally.
 *
 * One test here matters more than the rest: with the toggle on, nothing may
 * reach the cloud. The moment that guarantee quietly breaks is the moment the
 * user is least able to notice it has, so it is asserted from both directions —
 * the chooser, and a run with a key sitting right there unused.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBase,
  chatUrl,
  modelsUrl,
  normalizeLocalSettings,
  createLocalModel,
  probeLocal,
  chooseProvider,
  setupNote,
  explainFailure,
  LOCAL_DEFAULTS
} from "../extension/local-model.js";

// ---- the guarantee -----------------------------------------------------

test("local wins even with a cloud key saved", () => {
  const choice = chooseProvider({
    local: { LOCAL_MODEL_ENABLED: true },
    env: { OPENROUTER_API_KEY: "sk-or-something" }
  });
  assert.equal(choice.provider, "local", "a saved key must not override the toggle");
});

test("with the toggle on, not one request goes anywhere but localhost", async () => {
  const calls = [];
  const model = createLocalModel({
    settings: { LOCAL_MODEL_ENABLED: true, LOCAL_MODEL_URL: "http://localhost:11434/v1", LOCAL_MODEL_NAME: "llama3.1:8b" },
    fetchImpl: async (url, init) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "{}" } }] }) };
    }
  });

  await model({ messages: [{ role: "user", content: "hello" }] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0], "http://localhost:11434/v1/chat/completions");
  for (const url of calls) {
    assert.doesNotMatch(url, /openrouter|anthropic|openai\.com/i, "a request escaped to the cloud");
  }
});

test("a dead local server is an error, never a quiet trip to the cloud", async () => {
  const model = createLocalModel({
    settings: { LOCAL_MODEL_URL: "http://localhost:11434/v1", LOCAL_MODEL_NAME: "x" },
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED");
    }
  });

  await assert.rejects(
    () => model({ messages: [] }),
    (error) => {
      // It has to explain itself: the two causes are indistinguishable otherwise.
      assert.match(error.message, /Could not reach http:\/\/localhost:11434\/v1/);
      assert.match(error.message, /nothing is listening|refusing this extension/);
      return true;
    }
  );
});

test("without the toggle the cloud is used, and with neither there is no model", () => {
  assert.equal(chooseProvider({ local: {}, env: { OPENROUTER_API_KEY: "k" } }).provider, "cloud");
  assert.equal(chooseProvider({ local: {}, env: {} }).provider, "none");
  assert.equal(LOCAL_DEFAULTS.LOCAL_MODEL_ENABLED, false, "this must be opt-in");
});

// ---- the URL people will actually paste --------------------------------

test("whatever form the URL is pasted in, it resolves to the same endpoint", () => {
  const expected = "http://localhost:11434/v1";
  for (const input of [
    "http://localhost:11434",
    "http://localhost:11434/",
    "http://localhost:11434/v1",
    "http://localhost:11434/v1/",
    "http://localhost:11434/v1/chat/completions",
    "localhost:11434",
    "  http://localhost:11434/v1  "
  ]) {
    assert.equal(normalizeBase(input), expected, "failed on: " + input);
  }
});

test("Ollama's native API path is corrected to the compatible one", () => {
  // /api is the native endpoint and does not speak the chat-completions shape.
  assert.equal(normalizeBase("http://localhost:11434/api"), "http://localhost:11434/v1");
});

test("a non-standard port and host survive untouched", () => {
  assert.equal(normalizeBase("http://192.168.1.50:8080"), "http://192.168.1.50:8080/v1");
  assert.equal(chatUrl("http://localhost:1234"), "http://localhost:1234/v1/chat/completions");
  assert.equal(modelsUrl("http://localhost:1234"), "http://localhost:1234/v1/models");
});

test("settings are coerced, never stored as whatever was typed", () => {
  const settings = normalizeLocalSettings({ LOCAL_MODEL_ENABLED: "yes", LOCAL_MODEL_URL: "localhost:1234", LOCAL_MODEL_NAME: "  qwen2.5  " });
  assert.equal(settings.LOCAL_MODEL_ENABLED, false, "only a real boolean turns this on");
  assert.equal(settings.LOCAL_MODEL_URL, "http://localhost:1234/v1");
  assert.equal(settings.LOCAL_MODEL_NAME, "qwen2.5");

  const empty = normalizeLocalSettings({});
  assert.equal(empty.LOCAL_MODEL_URL, LOCAL_DEFAULTS.LOCAL_MODEL_URL);
});

// ---- surviving real local servers --------------------------------------

test("a server that rejects JSON mode is retried without it", async () => {
  // Not every local server implements response_format, and the prompt asks for
  // JSON in words anyway. Giving up there would lose most of the ecosystem.
  const bodies = [];
  let first = true;
  const model = createLocalModel({
    settings: { LOCAL_MODEL_URL: "http://localhost:11434", LOCAL_MODEL_NAME: "m" },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (first) {
        first = false;
        return { ok: false, status: 400, statusText: "Bad Request", text: async () => "{}" };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "{}" } }] }) };
    }
  });

  const message = await model({ messages: [], responseFormat: { type: "json_object" } });
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].response_format, "the first attempt should ask for JSON mode");
  assert.equal(bodies[1].response_format, undefined, "the retry should drop it");
  assert.equal(message.content, "{}");
});

test("the model name and tools are passed through as the server expects", async () => {
  let body;
  const model = createLocalModel({
    settings: { LOCAL_MODEL_URL: "http://localhost:11434", LOCAL_MODEL_NAME: "qwen2.5:7b" },
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: {} }] }) };
    }
  });

  await model({ messages: [{ role: "user", content: "x" }], tools: [{ type: "function" }] });
  assert.equal(body.model, "qwen2.5:7b");
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.tools.length, 1);
});

test("the probe reports what the server actually has", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ id: "llama3.1:8b" }, { id: "qwen2.5:7b" }] })
  });

  const found = await probeLocal({ settings: { LOCAL_MODEL_URL: "http://localhost:11434", LOCAL_MODEL_NAME: "qwen2.5:7b" }, fetchImpl });
  assert.equal(found.ok, true);
  assert.equal(found.has, true);
  assert.deepEqual(found.models, ["llama3.1:8b", "qwen2.5:7b"]);

  const missing = await probeLocal({ settings: { LOCAL_MODEL_URL: "http://localhost:11434", LOCAL_MODEL_NAME: "not-pulled" }, fetchImpl });
  assert.equal(missing.has, false, "a model that is not pulled should be called out before a run waits on it");
});

test("a server that lists nothing is not called broken", async () => {
  // Some servers return an empty list and serve the model perfectly well.
  const probe = await probeLocal({
    settings: { LOCAL_MODEL_URL: "http://localhost:8080", LOCAL_MODEL_NAME: "m" },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) })
  });
  assert.equal(probe.ok, true);
  assert.equal(probe.has, null, "unknown is not the same as missing");
});

test("a probe that cannot connect explains both likely causes", async () => {
  const probe = await probeLocal({
    settings: { LOCAL_MODEL_URL: "http://localhost:11434" },
    fetchImpl: async () => {
      throw new Error("Failed to fetch");
    }
  });
  assert.equal(probe.ok, false);
  assert.match(probe.error, /nothing is listening/);
  assert.match(probe.error, /refusing this extension/);
});

test("a 403 is named as the origin problem it always is", () => {
  assert.match(explainFailure(new Error("HTTP 403"), "http://localhost:11434/v1"), /refused this extension's origin/);
  assert.match(explainFailure(new Error("HTTP 404"), "http://localhost:11434/v1"), /no \/chat\/completions/);
});

// ---- telling the user what to do ---------------------------------------

test("the setup note names the right product for the port", () => {
  assert.match(setupNote("http://localhost:11434"), /OLLAMA_ORIGINS/);
  assert.match(setupNote("http://localhost:1234"), /LM Studio/);
  assert.match(setupNote("http://localhost:8080"), /llama\.cpp/);
  assert.match(setupNote("http://192.168.1.9:9000"), /OpenAI-compatible/);
});

test("the note carries this install's own origin, which cannot be documented", () => {
  const note = setupNote("http://localhost:11434", "chrome-extension://abcdef");
  assert.match(note, /chrome-extension:\/\/abcdef/);
});
