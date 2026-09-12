#!/usr/bin/env node
// Smoke test for the Exa wiring, independent of the agent loop.
//   node agent/try-exa.js "oauth device flow slow_down repeated backoff"
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { web_search } from "./tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(join(__dirname, "..", ".env"));
} catch {}

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: node agent/try-exa.js "your query"');
  process.exit(1);
}

const results = await web_search(query);
console.log(`${results.length} results for "${query}"\n`);

for (const r of results) {
  const date = r.publishedDate ? `  (${r.publishedDate.slice(0, 10)})` : "";
  console.log(r.title);
  console.log(`  ${r.url}${date}`);
  if (r.highlights[0]) {
    console.log(`  ${r.highlights[0].replace(/\s+/g, " ").slice(0, 160)}…`);
  }
  console.log();
}
