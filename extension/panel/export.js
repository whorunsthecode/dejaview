/**
 * Export targets for a finished skill.
 *
 * Obsidian is reachable without a server, an account or OAuth, because it
 * registers the `obsidian://` protocol. That makes it the one note app a Chrome
 * extension can write to directly.
 *
 * Everything else — Google Docs, Notion, a repo — is covered by clipboard and
 * the .md download, deliberately: those need OAuth and a cloud project, which is
 * a lot of setup to buy something Ctrl+V already does.
 */

/**
 * The most a whole obsidian:// URL may be before the content has to go via the
 * clipboard instead.
 *
 * Windows passes a protocol URL to its handler through the registry and cuts it
 * near 2048 characters. The failure is worse than a truncated note: the cut
 * usually lands inside a percent-escape, decoding the parameter throws, and
 * Obsidian drops `content` entirely — so the note arrives correctly named and
 * completely empty. 2000 leaves room for the vault and file parameters.
 *
 * Most real skills are several kilobytes, so the clipboard path is the normal
 * one, not the exception.
 */
export const URI_LIMIT = 2000;

/** Strip the characters Obsidian and the filesystem refuse in a note name. */
export function noteName(filename, fallback = "skill") {
  const base = String(filename ?? "")
    .replace(/\.md$/i, "")
    .replace(/[\\/:*?"<>|#^[\]]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-.]+|[-.]+$/g, "");
  return base || fallback;
}

/** Join a folder and a note into an Obsidian vault-relative path. */
export function vaultPath(folder, name) {
  const clean = String(folder ?? "")
    .replace(/[\\]+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  return clean ? clean + "/" + name : name;
}

/**
 * Decide how to get `markdown` into Obsidian.
 *
 * Returns the URI to open and whether the content rides in the URI or has to go
 * through the clipboard first. The caller does the opening, so this stays pure
 * and testable.
 *
 * @param {{vault?: string, folder?: string, filename: string, markdown: string}} opts
 * @returns {{mode: "uri"|"clipboard", url: string, path: string}}
 */
/**
 * Build a query string with percent-encoding.
 *
 * Deliberately not URLSearchParams: that encodes a space as "+", which is
 * form-encoding. Obsidian percent-decodes its parameters, so a "+" arrives as a
 * literal plus and every space in the note turns into one.
 */
function query(pairs) {
  return pairs
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => key + "=" + encodeURIComponent(value))
    .join("&");
}

/** Beyond this many calls the note is better delivered another way. */
export const MAX_CHUNKS = 12;

/**
 * Split markdown so each piece fits in a URL of its own once percent-encoded.
 *
 * Encoding is what decides the size, not the character count: a space and a
 * newline each cost three characters, so the budget is measured against the
 * encoded form rather than guessed from a ratio. Splits prefer a line break so
 * a chunk boundary never lands inside a word.
 *
 * @param {string} markdown
 * @param {number} budget encoded characters available for the content parameter
 * @returns {string[]}
 */
export function chunkMarkdown(markdown, budget) {
  const chunks = [];
  let rest = markdown ?? "";

  while (rest) {
    if (encodeURIComponent(rest).length <= budget) {
      chunks.push(rest);
      break;
    }

    // Grow a candidate until it no longer fits, then back off to a line break.
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (encodeURIComponent(rest.slice(0, mid)).length <= budget) lo = mid;
      else hi = mid - 1;
    }
    if (lo < 1) lo = 1; // pathological: a single character over budget

    let cut = lo;
    const breakAt = rest.lastIndexOf("\n", cut);
    if (breakAt > cut * 0.5) cut = breakAt + 1;

    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }

  return chunks;
}

/**
 * Plan how to deliver a skill to Obsidian.
 *
 * A short skill rides in one URL. A longer one is written across several: the
 * first creates the note, the rest append in order. That keeps the clipboard out
 * of it entirely, which matters because clipboard writes from a side panel can
 * report success and still leave nothing to paste.
 *
 * @param {{vault?: string, folder?: string, filename: string, markdown: string}} opts
 * @returns {{mode: "uri"|"append"|"manual", urls: string[], path: string, chunks: number}}
 */
export function obsidianTarget({ vault, folder, filename, markdown }) {
  const path = vaultPath(folder, noteName(filename));
  const base = [
    ["vault", vault],
    ["file", path]
  ];
  const body = markdown ?? "";

  const single = "obsidian://new?" + query([...base, ["content", body]]);
  if (single.length <= URI_LIMIT) {
    return { mode: "uri", urls: [single], path, chunks: 1 };
  }

  // Whatever is left for content once the fixed parameters are accounted for.
  // Built literally rather than through query(), which drops empty values and
  // would leave "&content=" out of the measurement.
  const prefix = "obsidian://new?" + query([...base, ["append", "true"]]) + "&content=";
  const budget = URI_LIMIT - prefix.length;

  const chunks = chunkMarkdown(body, budget);
  if (chunks.length > MAX_CHUNKS) {
    // Too many round trips to be worth it; the caller offers copy or download.
    return { mode: "manual", urls: [], path, chunks: chunks.length };
  }

  const urls = chunks.map((chunk, i) =>
    i === 0
      ? "obsidian://new?" + query([...base, ["content", chunk]])
      : "obsidian://new?" + query([...base, ["append", "true"], ["content", chunk]])
  );

  return { mode: "append", urls, path, chunks: urls.length };
}
