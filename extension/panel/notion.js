/**
 * Notion export.
 *
 * Notion has no "paste markdown" endpoint: a page is a tree of typed blocks, so
 * the skill has to be parsed into them. That parsing is the bulk of this file and
 * is pure, so it can be tested without touching the network.
 *
 * Auth is an internal integration token rather than OAuth — the user creates one
 * at notion.so/my-integrations and shares a page with it. No redirect, no cloud
 * project, and the token only reaches pages they explicitly shared.
 */

import { isCredentialText } from "./credentials.js";

const API = "https://api.notion.com/v1";

/** Pinned: Notion's API is versioned by header and changes behaviour without it. */
const NOTION_VERSION = "2022-06-28";

/** Notion rejects a rich_text run longer than this. */
const TEXT_LIMIT = 2000;

/** Notion accepts at most this many children per request. */
export const BLOCK_BATCH = 100;

// ---- ids --------------------------------------------------------------

/**
 * Pull a page id out of whatever the user pasted — a bare id, a dashed uuid, or
 * a full notion.so URL with a slug in front of it.
 * @returns {string|null}
 */
export function parsePageId(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;

  // The last 32 hex characters of a URL or id are the page id.
  const matches = text.replace(/-/g, "").match(/[0-9a-fA-F]{32}/g);
  if (!matches?.length) return null;

  const raw = matches[matches.length - 1].toLowerCase();
  return [raw.slice(0, 8), raw.slice(8, 12), raw.slice(12, 16), raw.slice(16, 20), raw.slice(20)].join("-");
}

// ---- markdown -> blocks -----------------------------------------------

/** Split a long run so no single rich_text exceeds Notion's limit. */
function richText(text) {
  const out = [];
  let rest = String(text ?? "");
  if (!rest) return out;

  while (rest.length > TEXT_LIMIT) {
    // Prefer a space so a word is not cut in half across two runs.
    let cut = rest.lastIndexOf(" ", TEXT_LIMIT);
    if (cut < TEXT_LIMIT * 0.5) cut = TEXT_LIMIT;
    out.push({ type: "text", text: { content: rest.slice(0, cut) } });
    rest = rest.slice(cut);
  }
  out.push({ type: "text", text: { content: rest } });
  return out;
}

/**
 * Inline markdown Notion can represent: code spans and links. Everything else is
 * left as written — a skill is a procedure, and mangling its punctuation to add
 * emphasis is a worse trade than leaving the markers visible.
 */
export function inlineRichText(line) {
  const runs = [];
  const pattern = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let at = 0;
  let match;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > at) runs.push(...richText(line.slice(at, match.index)));

    if (match[1] !== undefined) {
      runs.push({ type: "text", text: { content: match[1] }, annotations: { code: true } });
    } else {
      runs.push({ type: "text", text: { content: match[2], link: { url: match[3] } } });
    }
    at = match.index + match[0].length;
  }

  if (at < line.length) runs.push(...richText(line.slice(at)));
  return runs.length ? runs : richText(line);
}

const block = (type, extra) => ({ object: "block", type, [type]: extra });

/**
 * Parse a skill into Notion blocks.
 *
 * Handles what a SKILL.md actually contains: frontmatter, headings, ordered and
 * unordered lists, fenced code, quotes and rules. Anything else becomes a
 * paragraph rather than being dropped.
 *
 * @param {string} markdown
 * @returns {object[]}
 */
export function markdownToBlocks(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const blocks = [];

  let i = 0;

  // Frontmatter is metadata, not prose. Keep it, but as a code block so it reads
  // as the header it is rather than as a stray paragraph of "name: ...".
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, n) => n > 0 && l.trim() === "---");
    if (close > 0) {
      const front = lines.slice(1, close).join("\n").trim();
      if (front) {
        blocks.push(
          block("code", { rich_text: richText(front), language: "yaml" })
        );
      }
      i = close + 1;
    }
  }

  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) continue;

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(block("divider", {}));
      continue;
    }

    const fence = /^```(\w*)/.exec(trimmed);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) body.push(lines[i++]);
      blocks.push(
        block("code", {
          rich_text: richText(body.join("\n")),
          language: notionLanguage(fence[1])
        })
      );
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      blocks.push(
        block("heading_" + heading[1].length, { rich_text: inlineRichText(heading[2]) })
      );
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      blocks.push(block("quote", { rich_text: inlineRichText(quote[1]) }));
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      blocks.push(block("bulleted_list_item", { rich_text: inlineRichText(bullet[1]) }));
      continue;
    }

    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      blocks.push(block("numbered_list_item", { rich_text: inlineRichText(numbered[1]) }));
      continue;
    }

    blocks.push(block("paragraph", { rich_text: inlineRichText(trimmed) }));
  }

  return blocks;
}

/** Notion only accepts languages it knows; anything else has to be plain text. */
const LANGUAGES = new Set([
  "bash", "c", "c++", "c#", "css", "diff", "docker", "go", "graphql", "html", "java",
  "javascript", "json", "kotlin", "markdown", "typescript", "python", "ruby", "rust",
  "shell", "sql", "swift", "xml", "yaml", "plain text"
]);

function notionLanguage(tag) {
  const name = String(tag ?? "").toLowerCase();
  const alias = { js: "javascript", ts: "typescript", py: "python", sh: "shell", yml: "yaml", "": "plain text" };
  const mapped = alias[name] ?? name;
  return LANGUAGES.has(mapped) ? mapped : "plain text";
}

// ---- api --------------------------------------------------------------

async function notionFetch(path, { token, method = "POST", body }) {
  const response = await fetch(API + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Notion's own message is more useful than anything invented here.
    throw new Error(data?.message ?? response.status + " " + response.statusText);
  }
  return data;
}

/**
 * Create a page under `parentId` holding the skill.
 *
 * Notion caps children per request, so the first batch rides with the page and
 * the rest are appended. Always resolves with a result object rather than
 * throwing, so a failure can be shown in the trace like any other step.
 *
 * @param {{token: string, parentId: string, title: string, markdown: string}} opts
 */
export async function createNotionPage({ token, parentId, title, markdown }) {
  token = typeof token === "string" ? token.trim() : "";
  if (!token) return { ok: false, error: "No Notion integration token set." };
  if (!isCredentialText(token)) {
    return { ok: false, error: "Notion token contains unsupported characters. Paste the original integration token under keys and save again." };
  }

  const parent = parsePageId(parentId);
  if (!parent) return { ok: false, error: "Could not read a page id out of the Notion parent setting." };

  const blocks = markdownToBlocks(markdown);

  try {
    const page = await notionFetch("/pages", {
      token,
      body: {
        parent: { page_id: parent },
        properties: {
          title: { title: [{ type: "text", text: { content: title || "skill" } }] }
        },
        children: blocks.slice(0, BLOCK_BATCH)
      }
    });

    for (let at = BLOCK_BATCH; at < blocks.length; at += BLOCK_BATCH) {
      await notionFetch("/blocks/" + page.id + "/children", {
        token,
        method: "PATCH",
        body: { children: blocks.slice(at, at + BLOCK_BATCH) }
      });
    }

    return { ok: true, url: page.url, id: page.id, blocks: blocks.length };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
