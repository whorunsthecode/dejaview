/**
 * Rediscovery's settings, and what they mean when unset.
 *
 * Shared by the worker that obeys them and the panel that edits them, so the
 * two can never disagree about a default.
 */

export const DEFAULTS = Object.freeze({
  /** The whole feature. Off means no watching, no peeking, no badge. */
  REDISCOVERY_ENABLED: true,
  /** Nothing younger than this may be called a rediscovery. */
  REDISCOVERY_MIN_AGE_DAYS: 30,
  /** How related the best candidate has to be before it is worth an interruption. */
  REDISCOVERY_THRESHOLD: 0.3,
  /**
   * Whether to look beyond open tabs into browsing history. Off by default:
   * open tabs are already the reading list this project is about, and reading
   * history in the background is a materially bigger ask.
   */
  REDISCOVERY_HISTORY: false
});

export const SETTING_KEYS = Object.freeze(Object.keys(DEFAULTS));

const clamp = (value, min, max, fallback) => {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** Coerce stored values, which may be anything a previous version wrote. */
export function normalizeSettings(stored = {}) {
  return {
    REDISCOVERY_ENABLED: stored.REDISCOVERY_ENABLED !== false,
    REDISCOVERY_MIN_AGE_DAYS: Math.round(
      clamp(stored.REDISCOVERY_MIN_AGE_DAYS, 1, 3650, DEFAULTS.REDISCOVERY_MIN_AGE_DAYS)
    ),
    REDISCOVERY_THRESHOLD: clamp(stored.REDISCOVERY_THRESHOLD, 0.05, 0.95, DEFAULTS.REDISCOVERY_THRESHOLD),
    REDISCOVERY_HISTORY: stored.REDISCOVERY_HISTORY === true
  };
}

/** @param {any} api chrome */
export async function loadSettings(api = globalThis.chrome) {
  try {
    return normalizeSettings(await api.storage.local.get(SETTING_KEYS));
  } catch {
    // Storage unavailable is not a reason to behave unpredictably.
    return normalizeSettings({});
  }
}
