#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runAgent } from './host.js';
import { StubTabSource } from './tab-sources.js';
import { createOfflineModel } from './offline-model.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Keys live in .env, which is gitignored. Absent file is fine until a tool needs one.
try {
  process.loadEnvFile(join(__dirname, '..', '.env'));
} catch {}

const args = process.argv.slice(2);
const offlineFlag = args.includes('--offline');
const liveFlag = args.includes('--live');
const goal = args.filter(arg => arg !== '--offline' && arg !== '--live').join(' ').trim();
if (!goal || (offlineFlag && liveFlag)) {
  console.error('Usage: node agent/run-local.js [--offline|--live] "your goal here"');
  process.exitCode = 1;
} else {
  const offline = offlineFlag || (!liveFlag && !process.env.OPENROUTER_API_KEY);
  console.log(offline ? 'OFFLINE FIXTURE — no model or web search will run.' : 'LIVE — OpenRouter with local stub tabs.');
  try {
    const result = await runAgent({
      goal, tabSource: new StubTabSource(),
      env: offline ? { ...process.env, ENABLE_EXA: '0' } : process.env,
      ...(offline ? { model: createOfflineModel() } : {}),
      onTrace(event) {
        const time = new Date(event.t).toISOString().slice(11, 19);
        console.log(`[${time}] ${event.kind.padEnd(6)} ${event.label}${event.ref === null ? '' : ` #${event.ref}`}${event.detail ? ` — ${event.detail}` : ''}`);
      }
    });
    console.log(`Status: ${result.status}; reads: ${result.reads}; iterations: ${result.iterations}`);
    if (result.status === 'error') process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
