export const DEFAULT_READ_LIMIT = 8;
export const MAX_READ_LIMIT = 48;
export const PASSAGE_BATCH_SIZE = 8;

export function readLimit(value = DEFAULT_READ_LIMIT) {
  const limit = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
    throw new Error(`Page budget must be an integer from 1 to ${MAX_READ_LIMIT}`);
  }
  return limit;
}
