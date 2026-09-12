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

export function obsidianTarget({ vault, folder, filename, markdown }) {
  const path = vaultPath(folder, noteName(filename));
  const base = [
    ["vault", vault],
    ["file", path]
  ];

  // With content in the URI, Obsidian creates the note in one step.
  const full = "obsidian://new?" + query([...base, ["content", markdown ?? ""]]);
  if (full.length <= URI_LIMIT) return { mode: "uri", url: full, path };

  // Too long to survive the protocol handler. Create the note empty and let the
  // user paste — the clipboard has no length limit worth worrying about.
  return { mode: "clipboard", url: "obsidian://new?" + query([...base, ["append", "true"]]), path };
}
