#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runFakeLoop } from "./host.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const goal = process.argv.slice(2).join(" ").trim();
if (!goal) {
  console.error('Usage: node agent/run-local.js "your goal here"');
  process.exit(1);
}

const stubsPath = join(__dirname, "..", "shared", "stubs.json");
const tabs = JSON.parse(await readFile(stubsPath, "utf8"));

const emit = (ev) => {
  const time = new Date(ev.t).toISOString().slice(11, 19);
  const ref = ev.ref != null ? ` #${ev.ref}` : "";
  const detail = ev.detail ? `  — ${ev.detail}` : "";
  console.log(`[${time}] ${ev.kind.padEnd(6)} ${ev.label}${ref}${detail}`);
};

await runFakeLoop({ goal, tabs, emit });
