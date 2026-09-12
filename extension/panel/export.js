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
 * Protocol-handler URLs get truncated well below the browser's own URL ceiling,
 * and the failure is silent — Obsidian opens with the note cut off mid-sentence.
 * Past this length we hand the content over via the clipboard instead.
 */
export const URI_LIMIT = 6000;

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
export function obsidianTarget({ vault, folder, filename, markdown }) {
  const path = vaultPath(folder, noteName(filename));

  const params = new URLSearchParams();
  if (vault) params.set("vault", vault);
  params.set("file", path);

  // With content in the URI, Obsidian creates the note in one step.
  const withContent = new URLSearchParams(params);
  withContent.set("content", markdown ?? "");
  const full = "obsidian://new?" + withContent.toString();

  if (full.length <= URI_LIMIT) return { mode: "uri", url: full, path };

  // Too long to survive the protocol handler. Create the note empty and let the
  // user paste — the clipboard has no length limit worth worrying about.
  params.set("append", "true");
  return { mode: "clipboard", url: "obsidian://new?" + params.toString(), path };
}
