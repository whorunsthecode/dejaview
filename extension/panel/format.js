/**
 * Formatting helpers for the panel.
 *
 * Kept separate from panel.js so they can be tested without a DOM or a chrome
 * runtime — panel.js itself touches both the moment it is imported.
 */

/** Frontmatter block at the very top of a SKILL.md, if there is one. */
function frontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown ?? "");
  return match ? match[1] : "";
}

/**
 * The skill's declared name, turned into a filename safe on every platform.
 * Falls back rather than throwing: an unnamed skill still has to be downloadable.
 *
 * @param {string} markdown
 * @param {string} [fallback]
 * @returns {string}
 */
export function skillFilename(markdown, fallback = "skill") {
  const named = /^name:\s*(.+)$/m.exec(frontmatter(markdown));
  const raw = named ? named[1].trim().replace(/^["']|["']$/g, "") : "";

  const safe = (raw || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  return (safe || fallback) + ".md";
}

/**
 * The skill's one-line description, which is the line an agent matches on.
 * @param {string} markdown
 * @returns {string}
 */
export function skillDescription(markdown) {
  const block = frontmatter(markdown);
  // A YAML description usually wraps, and its continuation lines are indented.
  // Take the first line plus every indented line under it — and note that `$`
  // cannot be the terminator here, since /m would end the match at line one.
  const match = /^description:[ \t]*(.*(?:\r?\n[ \t]+.*)*)/m.exec(block);
  if (!match) return "";
  return match[1].replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "");
}

/**
 * Wall-clock time of a trace event, for the left gutter.
 * @param {number} t ms epoch
 */
export function formatClock(t) {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

/**
 * How long to wait before showing the next event when replaying a scripted run.
 * Real gaps, compressed, so the story paces like a run instead of dumping at once.
 *
 * @param {number} previous ms epoch of the event before
 * @param {number} current  ms epoch of this event
 * @returns {number} milliseconds
 */
export function replayDelay(previous, current) {
  const gap = Number.isFinite(current - previous) ? (current - previous) * 0.6 : 0;
  return Math.min(700, Math.max(100, gap));
}

/**
 * Shorten a title for the reference chip without cutting mid-word where avoidable.
 * @param {string} text
 * @param {number} [max]
 */
export function elide(text, max = 48) {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd() + "…";
}
