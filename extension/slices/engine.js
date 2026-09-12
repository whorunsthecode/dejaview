/**
 * The slice flow, end to end.
 *
 * Runs in an extension page rather than the worker, the same way the habits
 * page does: a page has the same API access, and nothing here needs to survive
 * the panel being shut.
 *
 * The order is fixed and the first step is the important one — a draft is built
 * and shown, and nothing is generated until `generate` is called with what the
 * user actually confirmed. `draft` never writes a document, and `generate`
 * never adds an item the user did not keep.
 */
import { historyUrl } from "../../shared/history.js";
import { readLimit } from "../../shared/limits.js";
import { TextCache } from "../text-cache.js";
import { listTabs } from "../tabs.js";
import { clusterThemes } from "./themes.js";
import { buildReview, chosen, unreadKeys, summarize } from "./review.js";
import { composeSlice } from "./compose.js";
import { renderSlice } from "./render.js";
import { SliceStore, KIND } from "./store.js";
import { loadExtraDomains } from "./sensitive.js";
import { bestPassage } from "../rediscovery/passage.js";
import { candidateTerms } from "../rediscovery/topic.js";

/** On-demand reading during a review shares the run budget, for the same reason. */
export const MAX_CATCHUP_READS = readLimit(8);

export class Slices {
  constructor({
    api = globalThis.chrome,
    store = new SliceStore(),
    cache = new TextCache(),
    tabs = listTabs,
    model = null,
    now = () => Date.now()
  } = {}) {
    Object.assign(this, { api, store, cache, tabs, model, now });
  }

  // ---- the map ---------------------------------------------------------

  /** The themes the open tabs fall into. */
  async themes() {
    return clusterThemes(await this.tabs());
  }

  // ---- the review ------------------------------------------------------

  /**
   * Build a review and save it as a draft.
   *
   * Passages come only from text that was already extracted; this never opens
   * or reads a page. What has no passage yet is shown as such, and the user can
   * ask for those to be read from the review screen.
   */
  async draft({ theme, items }) {
    const passages = await this.cachedPassages(items);
    const review = buildReview({
      theme,
      items,
      passages,
      extraDomains: await loadExtraDomains(this.api)
    });

    return this.store.save({ ...review, kind: KIND.draft, markdown: null });
  }

  /** A draft from one clustered theme. */
  async draftFromTheme(themeId) {
    const theme = (await this.themes()).find((t) => t.id === themeId);
    if (!theme) return null;
    return this.draft({ theme, items: theme.items });
  }

  /**
   * A draft from an explicit set of pages — a result set rather than a cluster.
   * The label is whatever produced them, so the document can say where it came from.
   */
  async draftFromItems(items, label, terms = []) {
    return this.draft({
      theme: { id: "selection", label: label || "a set of pages", terms },
      items
    });
  }

  /** @returns {Promise<Map<string, string|null>>} canonical url -> extracted text */
  async cachedPassages(items = []) {
    const passages = new Map();
    for (const item of items) {
      const key = historyUrl(item?.url);
      if (!key || passages.has(key)) continue;
      try {
        passages.set(key, await this.cache.textFor(item.url));
      } catch {
        passages.set(key, null);
      }
    }
    return passages;
  }

  /**
   * Read the pages in this draft that have never been read, so they can be
   * quoted. Bounded, and only ever called from the review screen — the user
   * looking at the list and asking for it is the whole point.
   */
  async readMissing(draftId, { limit = MAX_CATCHUP_READS } = {}) {
    const draft = await this.store.get(draftId);
    if (!draft) return { ok: false, error: "no such draft" };

    const wanted = new Set(unreadKeys(draft).slice(0, limit));
    if (!wanted.size) return { ok: true, read: 0, draft };

    // Only pages that are open can be read: extraction needs a live tab.
    const open = new Map();
    for (const tab of await this.tabs()) {
      const key = historyUrl(tab.url);
      if (key && wanted.has(key) && !open.has(key)) open.set(key, tab.id);
    }

    let read = 0;
    for (const [key, tabId] of open) {
      try {
        const result = await this.cache.get(tabId);
        if (result?.textStatus === "ok" && result.text) {
          this.applyPassage(draft, key, result.text);
          read += 1;
        } else {
          this.markUnreadable(draft, key, result?.error ?? "the page could not be read");
        }
      } catch (error) {
        this.markUnreadable(draft, key, error.message);
      }
    }

    for (const key of wanted) {
      if (!open.has(key)) this.markUnreadable(draft, key, "not open in a tab, so it cannot be read now");
    }

    draft.summary = summarize(draft.entries, draft.summary);
    return { ok: true, read, notOpen: wanted.size - open.size, draft: await this.store.save(draft) };
  }

  applyPassage(draft, key, text) {
    const entry = draft.entries.find((e) => e.key === key);
    if (!entry) return;
    const passage = bestPassage(text, draft.theme?.terms ?? []);
    entry.passage = passage;
    entry.passageStatus = passage ? "quoted" : "read, but nothing in it matches the theme";
  }

  markUnreadable(draft, key, why) {
    const entry = draft.entries.find((e) => e.key === key);
    if (entry) entry.passageStatus = why;
  }

  // ---- generation ------------------------------------------------------

  /**
   * Turn a confirmed review into a document.
   *
   * @param {string} draftId
   * @param {{title?: string, intro?: string, keep?: string[]}} confirmed
   *   `keep` is the set of keys the user left switched on. It is authoritative:
   *   an item not in it is not in the document, whatever the draft said.
   */
  async generate(draftId, { title, intro, keep } = {}) {
    const draft = await this.store.get(draftId);
    if (!draft) return { ok: false, error: "no such draft" };

    if (Array.isArray(keep)) {
      const kept = new Set(keep);
      for (const entry of draft.entries) entry.included = kept.has(entry.key);
    }

    const entries = chosen(draft);
    if (!entries.length) return { ok: false, error: "nothing is left to export" };

    const theme = draft.theme;
    const composed = await composeSlice({ theme, entries, model: this.model });
    const generatedAt = this.now();

    const markdown = renderSlice({
      title: title ?? draft.title,
      intro: intro ?? draft.intro,
      entries,
      groups: composed.groups,
      notes: composed.notes,
      synthesis: composed.synthesis,
      modelWritten: composed.modelWritten,
      generatedAt
    });

    const slice = await this.store.save({
      ...draft,
      kind: KIND.slice,
      title: title ?? draft.title,
      intro: intro ?? draft.intro,
      summary: summarize(draft.entries, draft.summary),
      markdown,
      modelWritten: composed.modelWritten,
      composeError: composed.error,
      generatedAt,
      generations: (draft.generations ?? 0) + 1
    });

    return { ok: true, slice };
  }

  // ---- living with it afterwards ---------------------------------------

  /**
   * Regenerate a saved slice against what is open now.
   *
   * The point of keeping a slice is that the theme keeps growing. Anything new
   * that matches is added; every decision the user already made is preserved,
   * including the items they removed — re-adding something they took out would
   * make the feature untrustworthy.
   */
  async regenerate(id, { title, intro } = {}) {
    const existing = await this.store.get(id);
    if (!existing) return { ok: false, error: "no such slice" };

    const terms = new Set(existing.theme?.terms ?? []);
    const known = new Map(existing.entries.map((entry) => [entry.key, entry]));

    const fresh = [];
    if (terms.size) {
      for (const tab of await this.tabs()) {
        const key = historyUrl(tab.url);
        if (!key || known.has(key)) continue;
        const overlap = candidateTerms(tab).filter((term) => terms.has(term));
        // The same bar rediscovery uses: one shared word is not a relationship.
        if (overlap.length >= 2) fresh.push(tab);
      }
    }

    const rebuilt = await this.draft({
      theme: existing.theme,
      items: [...existing.entries, ...fresh]
    });

    // Carry every earlier decision forward; only genuinely new items are new.
    for (const entry of rebuilt.entries) {
      const before = known.get(entry.key);
      if (!before) continue;
      entry.included = before.included;
      entry.passage = entry.passage ?? before.passage;
      entry.passageStatus = entry.passage ? entry.passageStatus : before.passageStatus;
    }
    rebuilt.summary = summarize(rebuilt.entries, rebuilt.summary);

    await this.store.remove(rebuilt.id);
    const merged = await this.store.save({
      ...existing,
      entries: rebuilt.entries,
      summary: rebuilt.summary,
      kind: KIND.draft
    });

    const result = await this.generate(merged.id, { title, intro });
    return result.ok ? { ...result, added: fresh.length } : result;
  }

  list() {
    return this.store.list();
  }

  get(id) {
    return this.store.get(id);
  }

  remove(id) {
    return this.store.remove(id);
  }
}
