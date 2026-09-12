/** Retry transport failures once; HTTP, JSON and application errors are not retried. */
export async function requestJSON(url, init, { fetchImpl = globalThis.fetch, timeoutMs = 30000, retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response, text;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
      text = await response.text();
    } catch (error) {
      if (attempt < retries) continue;
      throw new Error(controller.signal.aborted ? 'Request timed out' : 'Network request failed', { cause: error });
    } finally { clearTimeout(timer); }
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const data = JSON.parse(text);
    if (data.error) throw new Error('API returned an error');
    return data;
  }
}
