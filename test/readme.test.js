/**
 * The README is the only thing standing between a fresh clone and a working run,
 * so the parts of it that can silently go stale are checked here: the permission
 * table, the message table, the files it points at, and the Chrome floor.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { MSG } from "../shared/messages.js";

const root = new URL("../", import.meta.url);
const README = readFileSync(new URL("README.md", root), "utf8");
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

test("every manifest permission is explained in the README", () => {
  for (const permission of manifest.permissions) {
    assert.ok(README.includes("`" + permission + "`"), "undocumented permission: " + permission);
  }
});

test("the README does not claim permissions the manifest no longer asks for", () => {
  const table = README.slice(README.indexOf("## Permissions"), README.indexOf("## Privacy"));
  const claimed = [...table.matchAll(/^\| `([a-zA-Z_]+)`/gm)].map((m) => m[1]);
  assert.ok(claimed.length >= manifest.permissions.length, "permission table looks truncated");
  for (const name of claimed) {
    assert.ok(manifest.permissions.includes(name), "README documents a dropped permission: " + name);
  }
});

test("host_permissions is justified, not just declared", () => {
  assert.ok(manifest.host_permissions.includes("<all_urls>"));
  assert.match(README, /host_permissions/);
});

test("every message type is documented", () => {
  for (const type of Object.values(MSG)) {
    assert.ok(README.includes("`" + type + "`"), "undocumented message type: " + type);
  }
});

test("privacy documents optional history discovery and default open-tab dating", () => {
  assert.match(README, /By default, history is used only to date already-open tabs/);
  assert.match(README, /Include recent\nhistory/);
  assert.match(README, /Only selected pages are reopened and read/);
  assert.match(README, /no background history collection/);
});

test("the stated Chrome floor matches the manifest", () => {
  assert.ok(manifest.minimum_chrome_version, "manifest declares no floor");
  assert.ok(
    README.includes("Chrome " + manifest.minimum_chrome_version),
    "README and manifest disagree on the Chrome floor"
  );
});

test("the no-content-script claim is true", () => {
  assert.equal(manifest.content_scripts, undefined, "a content script was reintroduced");
  assert.match(README, /no content script/i);
});

test("the zero-runtime-dependency claim is true", () => {
  assert.deepEqual(pkg.dependencies ?? {}, {}, "a runtime dependency was added");
  assert.match(README, /No build step and no `npm install`/);
});

test("every file the README points at exists", () => {
  const mentioned = [...README.matchAll(/`((?:extension|agent|shared|test)\/[a-zA-Z0-9/_.-]+)`/g)]
    .map((m) => m[1])
    .filter((p) => /\.(js|json|md)$/.test(p));
  assert.ok(mentioned.length > 5, "expected the README to reference real files");
  for (const file of new Set(mentioned)) {
    assert.ok(existsSync(new URL(file, root)), "README points at a missing file: " + file);
  }
});

test("the commands the README tells you to run exist", () => {
  assert.ok(pkg.scripts["run:local"], "run:local is documented but missing");
  assert.ok(pkg.scripts.test, "npm test is documented but missing");
  assert.match(README, /npm run run:local/);
  assert.match(README, /npm test/);
});

test("everything the manifest points at is present for load-unpacked", () => {
  const refs = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...(manifest.content_scripts ?? []).flatMap((c) => c.js ?? [])
  ];
  for (const ref of refs) {
    assert.ok(existsSync(new URL(ref, root)), "manifest points at a missing file: " + ref);
  }
});

test("the vendored Readability the extension injects is actually present", () => {
  // extract.js injects this exact path; a missing file fails only at runtime.
  assert.ok(existsSync(new URL("extension/vendor/readability.js", root)));
  const extract = readFileSync(new URL("extension/extract.js", root), "utf8");
  const path = /READABILITY_FILE = "([^"]+)"/.exec(extract);
  assert.ok(path, "extract.js no longer names the vendored file");
  assert.ok(existsSync(new URL(path[1], root)), "extract.js injects a missing file: " + path[1]);
});
