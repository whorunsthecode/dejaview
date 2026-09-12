#!/usr/bin/env node
// Re-vendor Readability from node_modules into extension/vendor/.
// Run after bumping the @mozilla/readability devDependency.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";

const pkg = JSON.parse(readFileSync("node_modules/@mozilla/readability/package.json", "utf8"));
const src = readFileSync("node_modules/@mozilla/readability/Readability.js", "utf8");

const header = `/*
 * Vendored from @mozilla/readability v${pkg.version} (Apache-2.0).
 * https://github.com/mozilla/readability
 *
 * Vendored rather than bundled because MV3 forbids loading remote code, and
 * this repo has no bundler. Re-vendor with:
 *   npm i -D @mozilla/readability && node scripts/vendor-readability.js
 *
 * Injected as a plain file by chrome.scripting.executeScript, where \`module\` is
 * undefined, so the trailing CommonJS export is skipped and the top-level
 * \`function Readability\` simply becomes a global in the isolated world.
 */
`.replace(/\n/g, "\r\n");

mkdirSync("extension/vendor", { recursive: true });
writeFileSync("extension/vendor/readability.js", header + src.replace(/\r?\n/g, "\r\n"));
copyFileSync("node_modules/@mozilla/readability/LICENSE.md", "extension/vendor/readability-LICENSE.md");
console.log(`vendored @mozilla/readability v${pkg.version}`);
