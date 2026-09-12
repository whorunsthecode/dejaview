/**
 * The agent bridge.
 *
 * renderSkill is the piece that decides what the user actually downloads, so it
 * is checked by round-tripping: what the agent wrote must come back out of the
 * panel's own frontmatter parser unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderSkill, loadEnv, SETTING_KEYS } from "../extension/agent-bridge.js";
import { skillFilename, skillDescription } from "../extension/panel/format.js";

const MAR_2024 = 1710460800000;
const JAN_2024 = 1706745600000;

const SKILL = {
  name: "fix-device-flow-refresh",
  description:
    "Use when a device-authorization client is failing on token refresh or polling, " +
    "with repeated authorization_pending or a sudden invalid_grant after a refresh.",
  body: "## Steps\n\n1. Read the interval and poll no faster than it.\n2. Treat authorization_pending as normal.",
  sources: [
    { url: "https://auth0.com/docs/device-flow", firstVisit: MAR_2024 },
    { url: "https://datatracker.ietf.org/doc/html/rfc8628", firstVisit: JAN_2024 }
  ]
};

test("renders frontmatter the panel can parse back", () => {
  const md = renderSkill(SKILL);
  assert.equal(skillFilename(md), "fix-device-flow-refresh.md");
  assert.equal(skillDescription(md), SKILL.description);
});

test("a long description wraps but survives the round trip intact", () => {
  const long =
    "Use when a device-authorization client is failing, and the symptoms include " +
    "repeated authorization_pending responses, a sudden invalid_grant after a token " +
    "refresh, or the endpoint rejecting the device outright after repeated polling.";
  const md = renderSkill({ ...SKILL, description: long });

  assert.ok(md.split("\n").every((l) => l.length <= 90), "a line ran long");
  assert.equal(skillDescription(md), long, "wrapping lost or mangled the description");
});

test("the body is carried through verbatim", () => {
  const md = renderSkill(SKILL);
  assert.match(md, /1\. Read the interval and poll no faster than it\./);
});

test("every source carries the date its tab was first opened", () => {
  const md = renderSkill(SKILL);
  assert.match(md, /- https:\/\/auth0\.com\/docs\/device-flow — tab first opened 2024-03-15/);
  assert.match(md, /rfc8628 — tab first opened 2024-02-01/);
});

test("an undated source says so rather than inventing a date", () => {
  const md = renderSkill({ ...SKILL, sources: [{ url: "https://x.example/", firstVisit: null }] });
  assert.match(md, /tab date unknown/);
  assert.doesNotMatch(md, /1970-01-01/);
});

test("a source found by search is not passed off as an open tab", () => {
  const md = renderSkill({
    ...SKILL,
    sources: [{ url: "https://errata.example/", firstVisit: null, source: "web" }]
  });
  assert.match(md, /found by search, no open tab/);
  assert.doesNotMatch(md, /tab first opened/);
});

test("a skill with no sources admits it", () => {
  const md = renderSkill({ ...SKILL, sources: [] });
  assert.match(md, /## Sources/);
  assert.match(md, /without a cited source/);
});

test("an unsafe name still yields a usable filename", () => {
  const md = renderSkill({ ...SKILL, name: "Fix The/Device Flow: refresh!" });
  assert.equal(skillFilename(md), "fix-the-device-flow-refresh.md");
});

test("a missing name or description does not produce broken frontmatter", () => {
  const md = renderSkill({ body: "just a body", sources: [] });
  assert.equal(skillFilename(md), "skill.md");
  assert.notEqual(skillDescription(md), "");
});

test("renderSkill refuses a missing payload rather than emitting an empty file", () => {
  assert.throws(() => renderSkill(null), /no skill payload/);
});

// ---- credentials ------------------------------------------------------

function installFakeStorage(data) {
  globalThis.chrome = { storage: { local: { get: async () => ({ ...data }) } } };
}

test("loadEnv reads only the settings it knows about", async () => {
  installFakeStorage({ OPENROUTER_API_KEY: "sk-or-live", SOMETHING_ELSE: "ignored" });
  const env = await loadEnv();
  assert.equal(env.OPENROUTER_API_KEY, "sk-or-live");
  assert.equal(env.SOMETHING_ELSE, undefined);
  assert.ok(SETTING_KEYS.includes("OPENROUTER_API_KEY"));
});

test("loadEnv treats blank settings as absent", async () => {
  installFakeStorage({ OPENROUTER_API_KEY: "   ", EXA_API_KEY: "" });
  const env = await loadEnv();
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.ENABLE_EXA, undefined);
});

test("an Exa key turns on the search the agent gates behind a flag", async () => {
  installFakeStorage({ OPENROUTER_API_KEY: "sk-or-live", EXA_API_KEY: "exa-live" });
  const env = await loadEnv();
  assert.equal(env.ENABLE_EXA, "1");
});

test("no Exa key leaves search off", async () => {
  installFakeStorage({ OPENROUTER_API_KEY: "sk-or-live" });
  assert.equal((await loadEnv()).ENABLE_EXA, undefined);
});
