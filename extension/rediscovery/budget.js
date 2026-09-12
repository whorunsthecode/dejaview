/**
 * How often the feature is allowed to speak.
 *
 * The limits are the product, not a safety valve bolted on afterwards. An
 * assistant that interrupts four times in an afternoon gets turned off, and
 * then it surfaces nothing at all — so the ceiling is low and the arithmetic is
 * kept here where it can be tested rather than spread through the engine.
 *
 * Manual resurfacing ("surprise me") never counts against any of this: the user
 * asked, so there is nothing to ration.
 */

export const PER_HOUR = 1;
export const PER_DAY = 3;

/**
 * Minimum gap between evaluations, whether or not one produced a nudge.
 * Without it, a quiet afternoon of GitHub tabs would re-scan on every page load
 * and find nothing over and over.
 */
export const EVALUATION_COOLDOWN_MS = 5 * 60 * 1000;

const HOUR = 3_600_000;
const DAY = 86_400_000;

const automatic = (entry) => entry && entry.manual !== true;

/**
 * May an automatic nudge fire right now?
 *
 * @param {{at: number, manual?: boolean}[]} log
 * @param {number} now
 * @returns {{ok: boolean, reason: string, retryAt: number|null}}
 */
export function rateCheck(log = [], now = Date.now(), { perHour = PER_HOUR, perDay = PER_DAY } = {}) {
  const fired = log.filter(automatic).map((entry) => entry.at).filter(Number.isFinite);

  const lastHour = fired.filter((at) => at > now - HOUR);
  if (lastHour.length >= perHour) {
    return {
      ok: false,
      reason: "one nudge an hour",
      retryAt: Math.min(...lastHour) + HOUR
    };
  }

  const lastDay = fired.filter((at) => at > now - DAY);
  if (lastDay.length >= perDay) {
    return {
      ok: false,
      reason: "three nudges a day",
      retryAt: Math.min(...lastDay) + DAY
    };
  }

  return { ok: true, reason: "within budget", retryAt: null };
}

/** Whether enough time has passed to look again at all. */
export function shouldEvaluate(lastEvaluatedAt, now = Date.now(), cooldownMs = EVALUATION_COOLDOWN_MS) {
  if (!Number.isFinite(lastEvaluatedAt)) return true;
  return now - lastEvaluatedAt >= cooldownMs;
}

/**
 * The accept rate, as shown in settings.
 *
 * "Accepted" means the user opened the item. A nudge still on screen is not
 * counted either way — it has not been answered yet, and folding it into the
 * denominator would make a fresh nudge look like a rejection.
 */
export function acceptStats(log = []) {
  const entries = log.filter((entry) => entry && Number.isFinite(entry.at));
  const answered = entries.filter((entry) => entry.response && entry.response !== "shown");
  const opened = answered.filter((entry) => entry.response === "opened").length;
  const dismissed = answered.filter((entry) => entry.response === "dismissed").length;
  const less = answered.filter((entry) => entry.response === "less").length;

  return {
    total: entries.length,
    answered: answered.length,
    pending: entries.length - answered.length,
    opened,
    dismissed,
    less,
    manual: entries.filter((entry) => entry.manual === true).length,
    // Null rather than zero: nothing answered yet is not a 0% accept rate.
    acceptRate: answered.length ? opened / answered.length : null
  };
}
