/**
 * What counts as active work.
 *
 * Rediscovery fires on context, not on a timer, so the whole feature rests on
 * this file being narrow. A trigger is a page that says "I am working on
 * something right now": a doc, a repo, a Notion page, a ticket. Everything else
 * — search results, a mail tab, the Notion pricing page, the GitHub explore
 * feed — must not trigger, because a nudge there interrupts nothing useful.
 *
 * Pure: no chrome APIs, so the list can be argued with in tests rather than in
 * the browser.
 */

/**
 * GitHub paths that look like `/owner/repo` but are not repositories. Without
 * this list, opening the notifications page reads as active work on a project
 * called "notifications".
 */
const GITHUB_RESERVED = new Set([
  "about", "account", "apps", "collections", "contact", "customer-stories",
  "dashboard", "enterprise", "events", "explore", "features", "issues", "login",
  "logout", "marketplace", "new", "notifications", "organizations", "orgs",
  "pricing", "pulls", "search", "security", "sessions", "settings", "signup",
  "sponsors", "stars", "topics", "trending", "watching"
]);

/** Notion's own marketing and account pages, which are not anybody's workspace. */
const NOTION_RESERVED = new Set([
  "login", "signup", "pricing", "product", "help", "templates", "guides",
  "my-integrations", "desktop", "mobile", "customers", "careers", "about"
]);

/** A Jira or Linear issue key: two or more letters, a dash, digits. */
const ISSUE_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;

/**
 * Decide whether a page signals active work.
 *
 * @param {string} url
 * @param {string} [title]
 * @returns {{kind: string, label: string, subject: string}|null}
 *   `label` names the surface in prose ("this GitHub repo"); `subject` is the
 *   part of the URL worth treating as topic words — a repo name, a ticket key —
 *   which the title alone often does not carry.
 */
export function detectTrigger(url, title = "") {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  const host = parsed.hostname.replace(/^www\./, "");
  const segments = parsed.pathname.split("/").filter(Boolean);

  // ---- Google Docs, Sheets, Slides ----
  if (host === "docs.google.com") {
    const kinds = { document: "Google Doc", spreadsheets: "spreadsheet", presentation: "deck" };
    const label = kinds[segments[0]];
    // A file always has an id: /document/d/<id>/edit — but a second signed-in
    // account puts /u/1/ in front of the d, so the id is found, not counted to.
    const at = segments.indexOf("d");
    if (label && at > 0 && segments[at + 1]) {
      return { kind: "gdoc", label: "this " + label, subject: "" };
    }
    return null;
  }

  // ---- GitHub repositories ----
  if (host === "github.com") {
    const [owner, repo] = segments;
    if (owner && repo && !GITHUB_RESERVED.has(owner.toLowerCase())) {
      return { kind: "github", label: "this GitHub repo", subject: owner + " " + repo.replace(/\.git$/, "") };
    }
    return null;
  }

  // ---- Notion ----
  if (host === "notion.so" || host.endsWith(".notion.so") || host.endsWith(".notion.site")) {
    const first = (segments[0] ?? "").toLowerCase();
    if (!segments.length || NOTION_RESERVED.has(first)) return null;
    // A page slug ends in its id: "Roadmap-1a2b3c...". The words before it are
    // the page title, which is exactly what we want as topic words.
    const slug = segments[segments.length - 1].replace(/-?[0-9a-f]{32}$/i, "");
    return { kind: "notion", label: "this Notion page", subject: slug.replace(/-/g, " ").trim() };
  }

  // ---- Linear ----
  if (host === "linear.app") {
    const at = segments.indexOf("issue");
    if (at !== -1 && segments[at + 1]) {
      const rest = segments.slice(at + 2).join(" ").replace(/-/g, " ");
      return { kind: "linear", label: "this Linear ticket", subject: (segments[at + 1] + " " + rest).trim() };
    }
    return null;
  }

  // ---- Jira ----
  if (host.endsWith(".atlassian.net")) {
    if (segments[0] === "browse" && ISSUE_KEY.test(segments[1] ?? "")) {
      return { kind: "jira", label: "this Jira ticket", subject: segments[1] };
    }
    // The board and backlog views keep the open issue in the query string.
    const selected = parsed.searchParams.get("selectedIssue");
    if (selected && ISSUE_KEY.test(selected)) {
      return { kind: "jira", label: "this Jira ticket", subject: selected };
    }
    // A ticket key in the title is the last resort, for the newer /jira/ routes.
    const fromTitle = ISSUE_KEY.exec(String(title));
    if (fromTitle && parsed.pathname.startsWith("/jira/")) {
      return { kind: "jira", label: "this Jira ticket", subject: fromTitle[1] };
    }
    return null;
  }

  return null;
}

/** Every trigger kind, for the settings copy and for tests to enumerate. */
export const TRIGGER_KINDS = Object.freeze(["gdoc", "github", "notion", "linear", "jira"]);
