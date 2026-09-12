#!/usr/bin/env node
// Smoke test for the Exa wiring, independent of the agent loop.
//   npm run try:exa -- "oauth device flow slow_down repeated backoff"
//
// Checks the gate the agent itself applies (ENABLE_EXA plus a key) before making
// one real request, so a misconfigured run fails here rather than mid-demo.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { search } from "./exa.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(join(__dirname, "..", ".env"));
} catch {}

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: npm run try:exa -- "your query"');
  process.exit(1);
}

const { ENABLE_EXA, EXA_API_KEY } = process.env;

console.log("ENABLE_EXA  " + (ENABLE_EXA === "1" ? "1 (search enabled)" : (ENABLE_EXA ?? "unset") + " (agent will skip search)"));
console.log("EXA_API_KEY " + (EXA_API_KEY ? "set (" + EXA_API_KEY.length + " chars)" : "missing"));

if (ENABLE_EXA !== "1" || !EXA_API_KEY) {
  console.error("\nThe agent gates web_search on both. Set them in .env (see .env.example).");
  process.exit(1);
}

const results = await search(query, { apiKey: EXA_API_KEY });
console.log("\n" + results.length + ' results for "' + query + '"\n');

for (const r of results) {
  const date = r.publishedDate ? "  (" + r.publishedDate.slice(0, 10) + ")" : "";
  console.log(r.title);
  console.log("  " + r.url + date);
  if (r.highlights[0]) {
    console.log("  " + r.highlights[0].replace(/\s+/g, " ").slice(0, 160) + "…");
  }
  console.log();
}
