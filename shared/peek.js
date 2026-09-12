export const MAX_PEEK_CHARS = 600;
export const MAX_PEEKS = 48;
export function validatePeek(value, id) {
  if (!value || value.id !== id || !['ok', 'empty', 'blocked', 'error'].includes(value.textStatus)) throw new Error('Invalid peek response');
  const fields = ['description', 'heading', 'paragraph'];
  if (fields.some(k => typeof value[k] !== 'string') || fields.reduce((n, k) => n + value[k].length, 0) > MAX_PEEK_CHARS) throw new Error('Peek exceeds its text contract');
  return { id, textStatus: value.textStatus, ...Object.fromEntries(fields.map(k => [k, value[k]])) };
}
