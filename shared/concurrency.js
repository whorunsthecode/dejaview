/** Preserve result order while keeping only `limit` independent operations in flight. */
export async function mapConcurrent(items, limit, run) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency must be a positive integer');
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i], i);
    }
  }));
  return results;
}

/** Bound a browser API wait; this cannot cancel an injection already dispatched. */
export async function withTimeout(promise, ms = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser operation timed out')), ms); })]);
  } finally { clearTimeout(timer); }
}
