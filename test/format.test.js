/**
 * Panel formatting helpers.
 *
 * These are the parts of the panel that can be wrong without anything throwing:
 * a download named "undefined.md", a description that swallows the whole
 * frontmatter, a replay that dumps every event at once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { skillFilename, skillDescription, formatClock, replayDelay, elide } from "../extension/panel/format.js";

const DEMO = readFileSync(new URL("../extension/panel/demo-skill.md", import.meta.url), "utf8");

test("filename comes from the frontmatter name", () => {
  assert.equal(skillFilename(DEMO), "fix-device-flow-refresh.md");
});

test("filename is made safe for the filesystem", () => {
  const md = ["---", "name: Fix The/Device Flow: refresh!", "---", "body"].join("\n");
  assert.equal(skillFilename(md), "fix-the-device-flow-refresh.md");
});

test("filename falls back when there is no frontmatter", () => {
  assert.equal(skillFilename("just a body, no frontmatter"), "skill.md");
  assert.equal(skillFilename(""), "skill.md");
  assert.equal(skillFilename(undefined), "skill.md");
});

test("filename never comes out as a bare or hidden file", () => {
  assert.equal(skillFilename(["---", "name: ...", "---"].join("\n")), "skill.md");
  assert.equal(skillFilename(["---", "name: '   '", "---"].join("\n")), "skill.md");
});

test("description is the whole wrapped line, not just its first row", () => {
  const desc = skillDescription(DEMO);
  assert.match(desc, /^Use when a device-authorization/);
  assert.match(desc, /invalid_grant/, "stopped at the line break");
  assert.doesNotMatch(desc, /\n/);
});

test("description is empty rather than undefined when absent", () => {
  assert.equal(skillDescription("no frontmatter here"), "");
  assert.equal(skillDescription(["---", "name: x", "---"].join("\n")), "");
});

test("description does not swallow the following key", () => {
  const md = ["---", "name: x", "description: one line", "author: someone", "---"].join("\n");
  assert.equal(skillDescription(md), "one line");
});

test("clock formatting pads every field", () => {
  const t = new Date(2024, 2, 15, 9, 5, 3).getTime();
  assert.equal(formatClock(t), "09:05:03");
});

test("clock formatting survives a bad timestamp", () => {
  assert.equal(formatClock(NaN), "--:--:--");
});

test("replay compresses real gaps but stays inside human range", () => {
  assert.equal(replayDelay(0, 0), 100, "back-to-back events still pause");
  assert.equal(replayDelay(0, 1000), 600);
  assert.equal(replayDelay(0, 60_000), 700, "a long real gap is capped");
});

test("replay of the shipped stub trace runs in a demo-sized window", () => {
  const events = JSON.parse(
    readFileSync(new URL("../shared/trace-stubs.json", import.meta.url), "utf8")
  );
  let total = 0;
  let previous = events[0].t;
  for (const ev of events) {
    total += replayDelay(previous, ev.t);
    previous = ev.t;
  }
  assert.ok(total > 2000, "too fast to read: " + total + "ms");
  assert.ok(total < 15_000, "too slow to demo: " + total + "ms");
});

test("elide keeps short titles untouched", () => {
  assert.equal(elide("RFC 8628"), "RFC 8628");
});

test("elide cuts long titles on a word boundary", () => {
  const out = elide("Device Authorization Flow — Auth0 Docs, the complete reference guide", 30);
  assert.ok(out.length <= 31, out);
  assert.ok(out.endsWith("…"));
  assert.doesNotMatch(out.slice(0, -1), /\s$/);
});

test("elide collapses the whitespace a page title arrives with", () => {
  assert.equal(elide("  RFC   8628\n  Device Grant  "), "RFC 8628 Device Grant");
});

test("the shipped demo skill is well formed", () => {
  assert.match(DEMO, /^---\r?\n/, "missing frontmatter");
  assert.notEqual(skillFilename(DEMO), "skill.md", "name did not parse");
  assert.notEqual(skillDescription(DEMO), "", "description did not parse");
  assert.match(DEMO, /## Sources/, "a skill without sources is not citable");
  // Karmen's convert-skill prompt: every source carries the date its tab was opened.
  assert.match(DEMO, /first opened 20\d\d-\d\d-\d\d/);
});
