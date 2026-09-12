/**
 * The message bus, tested against a fake chrome.runtime that models the parts of
 * Chrome's protocol we actually depend on:
 *
 *   - every listener sees every message
 *   - the first sendResponse wins
 *   - returning true holds the port open for an async reply
 *   - if nobody responds and nobody holds the port, the send fails outright
 *
 * That last rule is why on() must return undefined for types it does not own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MSG, on, send, request } from "../shared/messages.js";

function installFakeChrome() {
  const listeners = [];
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        }
      },
      sendMessage(msg) {
        return new Promise((resolve, reject) => {
          let responded = false;
          let portHeld = false;
          const sendResponse = (value) => {
            if (responded) return;
            responded = true;
            resolve(value);
          };
          for (const fn of [...listeners]) {
            if (fn(msg, { id: "test" }, sendResponse) === true) portHeld = true;
          }
          if (!responded && !portHeld) {
            reject(new Error("Could not establish connection. Receiving end does not exist."));
          }
        });
      }
    }
  };
  return listeners;
}

test("request gets a synchronous reply", async () => {
  installFakeChrome();
  on(MSG.PING, () => ({ ok: true, version: "0.0.1" }));
  assert.deepEqual(await request(MSG.PING, {}), { ok: true, version: "0.0.1" });
});

test("request gets an asynchronous reply", async () => {
  installFakeChrome();
  on(MSG.RUN, async (payload) => {
    await new Promise((r) => setTimeout(r, 10));
    return { ok: true, goal: payload.goal };
  });
  assert.deepEqual(await request(MSG.RUN, { goal: "fix the device flow" }), {
    ok: true,
    goal: "fix the device flow"
  });
});

test("a throwing handler replies with an error instead of hanging", async () => {
  installFakeChrome();
  on(MSG.RUN, () => {
    throw new Error("tabs permission missing");
  });
  assert.deepEqual(await request(MSG.RUN, {}), { ok: false, error: "tabs permission missing" });
});

test("a rejecting async handler replies with an error", async () => {
  installFakeChrome();
  on(MSG.RUN, async () => {
    throw new Error("worker died");
  });
  assert.deepEqual(await request(MSG.RUN, {}), { ok: false, error: "worker died" });
});

test("a listener for another type does not swallow the message", async () => {
  installFakeChrome();
  on(MSG.TRACE, () => ({ ok: true, wrong: "handler" }));
  on(MSG.PING, () => ({ ok: true, right: "handler" }));
  assert.deepEqual(await request(MSG.PING, {}), { ok: true, right: "handler" });
});

test("requesting a type nobody handles rejects rather than hanging", async () => {
  installFakeChrome();
  on(MSG.TRACE, () => ({ ok: true }));
  await assert.rejects(() => request(MSG.PING, {}), /Receiving end does not exist/);
});

test("a handler returning undefined sends no reply", async () => {
  installFakeChrome();
  on(MSG.TRACE, () => undefined);
  await assert.rejects(() => request(MSG.TRACE, {}), /Receiving end does not exist/);
});

test("unsubscribing removes the listener", async () => {
  installFakeChrome();
  const off = on(MSG.PING, () => ({ ok: true }));
  assert.deepEqual(await request(MSG.PING, {}), { ok: true });
  off();
  await assert.rejects(() => request(MSG.PING, {}), /Receiving end does not exist/);
});

test("send is fire and forget and never throws with nothing listening", async () => {
  installFakeChrome();
  assert.doesNotThrow(() => send(MSG.TRACE, { kind: "note" }));
  await new Promise((r) => setTimeout(r, 5));
});

test("send still delivers to a listener", async () => {
  installFakeChrome();
  let seen = null;
  on(MSG.TRACE, (payload) => {
    seen = payload;
  });
  send(MSG.TRACE, { kind: "note", label: "hello" });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, { kind: "note", label: "hello" });
});

test("outside an extension context request fails loudly and send stays quiet", async () => {
  delete globalThis.chrome;
  await assert.rejects(() => request(MSG.PING, {}), /no chrome.runtime/);
  assert.doesNotThrow(() => send(MSG.TRACE, {}));
});
