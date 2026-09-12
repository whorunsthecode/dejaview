/**
 * What the page in front of you is about.
 *
 * The topic is inferred from the title and the visible content, never from the
 * whole document: a trigger page gets a peek (600 characters of description,
 * heading and first paragraph), the same weak evidence the agent's peek_tab
 * tool is allowed. Nothing here reads a page in full.
 *
 * Pure, so the inference can be tested against real titles rather than guessed at.
 */
import { indexTerms } from "../../shared/metadata-index.js";

/**
 * Site furniture that every title on a surface carries. Left in, "GitHub" would
 * be a topic term shared by every repo page ever opened, and everything would
 * look related to everything.
 */
const CHROME_WORDS = new Set([
  "google", "docs", "sheets", "slides", "github", "gitlab", "notion", "linear",
  "jira", "atlassian", "confluence", "untitled", "document", "spreadsheet",
  "presentation", "page", "issue", "issues", "ticket", "pull", "request",
  "commit", "commits", "branch", "tree", "blob", "main", "master", "draft",
  "copy", "www", "com", "http", "https", "html", "index", "home", "dashboard",
  "edit", "view", "new", "search", "workspace", "app", "apps"
]);

/** Trailing site names, which say what the surface is, not what the page is about. */
const TITLE_TAIL = /\s*[-–—·|]\s*(google docs|google sheets|google slides|github|gitlab|notion|linear|jira|confluence|atlassian)\s*$/i;

/** A path segment that is a key rather than a word: long, and not pronounceable. */
const OPAQUE_ID = /^[A-Za-z0-9_-]{20,}$/;

/** How many terms a topic may carry. Beyond this the tail is noise, and it
 *  inflates the denominator that confidence is measured against. */
export const MAX_TOPIC_TERMS = 24;

/**
 * Strip the surface's name off a page title.
 * @param {string} title
 * @returns {string}
 */
export function cleanTitle(title) {
  let text = String(title ?? "").trim();
  // Twice: "owner/repo: thing · GitHub" and "[KEY-1] thing - Jira - Atlassian".
  text = text.replace(TITLE_TAIL, "").replace(TITLE_TAIL, "");
  return text.trim();
}

/**
 * Build the topic for a trigger page.
 *
 * @param {{title?: string, url?: string, trigger?: {subject?: string}|null,
 *          peek?: {description?: string, heading?: string, paragraph?: string}|null}} page
 * @returns {{terms: string[], text: string}}
 */
export function topicFrom({ title = "", url = "", trigger = null, peek = null } = {}) {
  const parts = [cleanTitle(title), trigger?.subject ?? "", peek?.heading ?? "", peek?.description ?? "", peek?.paragraph ?? ""];

  // The URL's own path words, minus the host: a repo or slug often names the
  // subject better than a title reading "Untitled".
  let path = "";
  try {
    path = decodeURIComponent(new URL(url).pathname)
      .split("/")
      // Opaque ids — a Google Doc key, a Notion uuid — are not words. Left in,
      // an untitled document would have its own id as its only topic term, and
      // would then relate to nothing at all while looking like it had a topic.
      .filter((segment) => !OPAQUE_ID.test(segment))
      .join(" ")
      .replace(/[_-]+/g, " ");
  } catch {
    path = "";
  }
  parts.push(path);

  const text = parts.filter(Boolean).join(" ");
  const terms = indexTerms(text)
    .filter((term) => !CHROME_WORDS.has(term))
    // A bare number is never a topic; a version or ticket number is carried by
    // the terms around it.
    .filter((term) => !/^\d+$/.test(term))
    .slice(0, MAX_TOPIC_TERMS);

  return { terms, text };
}

/** Terms of a candidate, scored against a topic. Title, URL and group name only. */
export function candidateTerms(candidate) {
  const url = String(candidate?.url ?? "").replace(/https?:\/\//, "").replace(/[/_?&=-]+/g, " ");
  return indexTerms([candidate?.title ?? "", url, candidate?.groupTitle ?? ""].join(" "))
    .filter((term) => !CHROME_WORDS.has(term));
}
