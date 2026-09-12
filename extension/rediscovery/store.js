/**
 * Everything rediscovery remembers, in the extension's own IndexedDB.
 *
 * Four kinds of row, in one store, distinguished by key prefix:
 *
 *   log:<id>      every nudge, its trigger, and what the user did about it
 *   dwell:<url>   accumulated foreground time per page
 *   suppress      theme -> how strongly the user has pushed back
 *   state         the pending nudge and when we last looked
 *
 * The log is the feature's own accountability: the accept rate in settings is
 * computed from it, so a feature that is not earning its interruptions can be
 * seen to be failing rather than argued about.
 */
import { LocalStore } from "../local-store.js";
import { pruneDwell, mergeDwell, MAX_DWELL_ROWS } from "./dwell.js";

const LOG = "log:";
const DWELL = "dwell:";
const SUPPRESS = "suppress";
const STATE = "state";

/** Enough history to judge the feature by; old nudges are not evidence. */
export const MAX_LOG_ROWS = 200;

/** A theme cannot be suppressed past this, or it could never recover. */
export const MAX_SUPPRESSION = 4;

/** An explicit "less like this" outweighs a shrug. */
export const WEIGHT_LESS = 1;
export const WEIGHT_DISMISS = 0.34;

export class RediscoveryStore {
  constructor({ store = new LocalStore("rediscovery"), now = () => Date.now() } = {}) {
    Object.assign(this, { store, now });
    this.rows = new Map();
    this.warning = null;
    this.ready = this.load();
  }

  async load() {
    try {
      for (const row of await this.store.all()) this.rows.set(row.key, row);
    } catch (error) {
      // A store that will not open must not take the browser half down with it.
      this.warning = error.message;
    }
  }

  async put(row) {
    this.rows.set(row.key, row);
    try {
      await this.store.put(row);
    } catch (error) {
      this.warning = error.message;
    }
  }

  async drop(key) {
    this.rows.delete(key);
    try {
      await this.store.delete(key);
    } catch (error) {
      this.warning = error.message;
    }
  }

  // ---- the nudge log --------------------------------------------------

  /** Every nudge, newest first. */
  async entries() {
    await this.ready;
    return [...this.rows.values()]
      .filter((row) => row.key.startsWith(LOG))
      .map((row) => row.entry)
      .sort((a, b) => b.at - a.at);
  }

  /** Record a nudge as shown. Returns the stored entry. */
  async record(nudge) {
    await this.ready;
    const entry = { ...nudge, response: nudge.response ?? "shown" };
    await this.put({ key: LOG + entry.id, entry });

    const all = [...this.rows.values()].filter((row) => row.key.startsWith(LOG));
    if (all.length > MAX_LOG_ROWS) {
      const oldest = all.sort((a, b) => a.entry.at - b.entry.at).slice(0, all.length - MAX_LOG_ROWS);
      for (const row of oldest) await this.drop(row.key);
    }
    return entry;
  }

  /** Answer a nudge: opened, dismissed, or "less like this". */
  async respond(id, response) {
    await this.ready;
    const row = this.rows.get(LOG + id);
    if (!row) return null;
    const entry = { ...row.entry, response, respondedAt: this.now() };
    await this.put({ key: LOG + id, entry });
    return entry;
  }

  /** Item keys already surfaced, so nothing is shown twice unasked. */
  async shownKeys() {
    return new Set((await this.entries()).map((entry) => entry.item?.key).filter(Boolean));
  }

  // ---- suppression ----------------------------------------------------

  async suppressed() {
    await this.ready;
    return { ...(this.rows.get(SUPPRESS)?.terms ?? {}) };
  }

  /**
   * Push a theme down the ranking. Called with the terms that earned the nudge,
   * so what gets suppressed is the reason it was shown, not the page itself.
   */
  async suppress(terms = [], weight = WEIGHT_LESS) {
    await this.ready;
    const current = { ...(this.rows.get(SUPPRESS)?.terms ?? {}) };
    for (const term of terms) {
      current[term] = Math.min(MAX_SUPPRESSION, (current[term] ?? 0) + weight);
    }

    // Bounded: keep the strongest signals, forget the rest.
    const kept = Object.entries(current)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200);
    await this.put({ key: SUPPRESS, terms: Object.fromEntries(kept) });
    return Object.fromEntries(kept);
  }

  // ---- dwell ----------------------------------------------------------

  /** @returns {Promise<Map<string, {ms: number, title: string}>>} */
  async dwell() {
    await this.ready;
    const out = new Map();
    for (const row of this.rows.values()) {
      if (row.key.startsWith(DWELL)) out.set(row.key.slice(DWELL.length), row);
    }
    return out;
  }

  async recordDwell({ key, url, title, ms, at }) {
    await this.ready;
    const rowKey = DWELL + key;
    const merged = mergeDwell({ ...(this.rows.get(rowKey) ?? {}), key, url }, { ms, at, title });
    await this.put({ ...merged, key: rowKey });

    const rows = [...this.rows.values()].filter((row) => row.key.startsWith(DWELL));
    if (rows.length > MAX_DWELL_ROWS) {
      const { drop } = pruneDwell(rows, MAX_DWELL_ROWS);
      for (const row of drop) await this.drop(row.key);
    }
    return merged;
  }

  // ---- state ----------------------------------------------------------

  async state() {
    await this.ready;
    const { key, ...rest } = this.rows.get(STATE) ?? {};
    return { lastEvaluatedAt: null, pending: null, ...rest };
  }

  async setState(patch) {
    const next = { ...(await this.state()), ...patch };
    await this.put({ key: STATE, ...next });
    return next;
  }

  // ---- housekeeping ---------------------------------------------------

  async clear() {
    await this.ready;
    this.rows.clear();
    try {
      await this.store.clear();
    } catch (error) {
      this.warning = error.message;
    }
  }

  /** Forget the log and the suppression weights, but keep dwell. */
  async clearLog() {
    await this.ready;
    for (const row of [...this.rows.values()]) {
      if (row.key.startsWith(LOG) || row.key === SUPPRESS) await this.drop(row.key);
    }
    await this.setState({ pending: null });
  }
}
