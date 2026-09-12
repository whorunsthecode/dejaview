// Keys must be safe for HTTP headers, with no pasted quotes or whitespace.
export const isCredentialText = value => /^[\x21-\x7e]+$/.test(value) && !/["']/.test(value);

/** Never include a credential's value in an error or status message. */
export function credentialState(value, secret = true, key = '') {
  if (typeof value !== 'string' || !value.trim()) return 'Not saved';
  if (key === 'OPENROUTER_API_KEY' && !value.trim().startsWith('sk-or-')) return 'Needs attention';
  return secret && !isCredentialText(value.trim()) ? 'Needs attention' : 'Saved locally';
}

export async function persistCredentials(storage, entries, settings = {}) {
  const update = {};
  for (const entry of entries) {
    const value = entry.value?.trim();
    if (!value) continue; // Blank means retain the existing value.
    if (entry.secret && !isCredentialText(value)) {
      throw new Error(`${entry.label}: paste only the key, without quotes, spaces or hidden characters.`);
    }
    if (entry.key === 'OPENROUTER_API_KEY' && !value.startsWith('sk-or-')) {
      throw new Error('OpenRouter: paste the full API key beginning sk-or- from openrouter.ai/settings/keys.');
    }
    update[entry.key] = value;
  }
  try {
    await storage.set({ ...settings, ...update });
    const stored = await storage.get(Object.keys(update));
    if (Object.keys(update).some(key => stored[key] !== update[key])) throw new Error('Write was not retained');
  } catch {
    throw new Error('Could not confirm the save. Your entries are still here; try Save again.');
  }
  return update;
}
