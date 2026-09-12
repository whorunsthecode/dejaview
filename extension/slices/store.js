/**
 * Saved slices, in the extension's own IndexedDB.
 *
 * Two kinds of row share the store. A draft is a review the user has not
 * confirmed yet — it exists so the habits page can hand a selection to the
 * slice page without pushing it through a URL. A slice is a generated document,
 * kept so it can be reopened, edited, and regenerated once they have read more
 * on the theme.
 *
 * Drafts are disposable and expire. Slices are not: the user made them, so
 * nothing here deletes one without being asked.
 */
import { LocalStore } from "../local-store.js";

/** An unconfirmed review older than this was abandoned. */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * `handoff` is a set of pages another surface wants sliced — written here
 * rather than passed through the URL, which a long list would overflow.
 */
export const KIND = Object.freeze({ draft: "draft", slice: "slice", handoff: "handoff" });

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export class SliceStore {
  constructor({ store = new LocalStore("slices"), now = () => Date.now() } = {}) {
    Object.assign(this, { store, now });
    this.warning = null;
  }

  async all() {
    try {
      return (await this.store.all()).map((row) => row.slice).filter(Boolean);
    } catch (error) {
      this.warning = error.message;
      return [];
    }
  }

  /** Generated slices, newest first. Drafts are not part of the library. */
  async list() {
    const rows = await this.all();
    return rows
      .filter((row) => row.kind === KIND.slice)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async get(id) {
    return (await this.all()).find((row) => row.id === id) ?? null;
  }

  /** Create or update. Returns the stored object, with its stamps set. */
  async save(slice) {
    const at = this.now();
    const stored = {
      kind: KIND.slice,
      generations: 0,
      ...slice,
      id: slice.id ?? newId(),
      createdAt: slice.createdAt ?? at,
      updatedAt: at
    };

    try {
      await this.store.put({ key: stored.id, slice: stored });
    } catch (error) {
      this.warning = error.message;
    }
    return stored;
  }

  async remove(id) {
    try {
      await this.store.delete(id);
    } catch (error) {
      this.warning = error.message;
    }
  }

  /**
   * Drop abandoned drafts and handoffs. Called on open rather than on a timer,
   * because a page that only exists when you look at it needs no scheduler.
   */
  async sweepDrafts() {
    const cutoff = this.now() - DRAFT_TTL_MS;
    const disposable = new Set([KIND.draft, KIND.handoff]);
    let removed = 0;
    for (const row of await this.all()) {
      if (disposable.has(row.kind) && (row.updatedAt ?? 0) < cutoff) {
        await this.remove(row.id);
        removed += 1;
      }
    }
    return removed;
  }

  async clear() {
    try {
      await this.store.clear();
    } catch (error) {
      this.warning = error.message;
    }
  }
}
