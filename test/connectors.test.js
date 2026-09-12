/**
 * Notion and Google Docs export.
 *
 * Notion has no markdown endpoint, so a skill has to be parsed into typed blocks.
 * That parser is what can quietly lose a step of a procedure, so it is tested
 * against the real demo skill rather than toy input.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  markdownToBlocks,
  inlineRichText,
  parsePageId,
  BLOCK_BATCH
} from "../extension/panel/notion.js";
import { authUrl, tokenFromRedirect, multipartBody, SCOPE } from "../extension/panel/gdocs.js";

const DEMO = readFileSync(new URL("../extension/panel/demo-skill.md", import.meta.url), "utf8");

const typesOf = (blocks) => blocks.map((b) => b.type);
const textOf = (block) =>
  (block[block.type].rich_text ?? []).map((r) => r.text.content).join("");

// ---- notion: page ids -------------------------------------------------

test("a page id is read out of a full Notion URL", () => {
  assert.equal(
    parsePageId("https://www.notion.so/myspace/Skills-1a2b3c4d5e6f7081920a1b2c3d4e5f60"),
    "1a2b3c4d-5e6f-7081-920a-1b2c3d4e5f60"
  );
});

test("a bare id, dashed or not, is accepted", () => {
  const dashed = "1a2b3c4d-5e6f-7081-920a-1b2c3d4e5f60";
  assert.equal(parsePageId(dashed), dashed);
  assert.equal(parsePageId("1a2b3c4d5e6f7081920a1b2c3d4e5f60"), dashed);
});

test("a URL with query junk still yields the id", () => {
  assert.equal(
    parsePageId("https://notion.so/Skills-1a2b3c4d5e6f7081920a1b2c3d4e5f60?pvs=4"),
    "1a2b3c4d-5e6f-7081-920a-1b2c3d4e5f60"
  );
});

test("nonsense yields null rather than a malformed id", () => {
  assert.equal(parsePageId("not a notion page"), null);
  assert.equal(parsePageId(""), null);
  assert.equal(parsePageId(undefined), null);
});

// ---- notion: markdown -> blocks ---------------------------------------

test("headings become the matching Notion heading level", () => {
  const blocks = markdownToBlocks("# One\n## Two\n### Three");
  assert.deepEqual(typesOf(blocks), ["heading_1", "heading_2", "heading_3"]);
  assert.equal(textOf(blocks[0]), "One");
});

test("both list styles survive as list items", () => {
  const blocks = markdownToBlocks("- a\n* b\n1. first\n2) second");
  assert.deepEqual(typesOf(blocks), [
    "bulleted_list_item",
    "bulleted_list_item",
    "numbered_list_item",
    "numbered_list_item"
  ]);
  assert.equal(textOf(blocks[2]), "first");
});

test("a numbered step keeps its text but loses the marker Notion supplies", () => {
  const blocks = markdownToBlocks("1. Read the interval and poll no faster.");
  assert.equal(textOf(blocks[0]), "Read the interval and poll no faster.");
});

test("fenced code becomes a code block with a language Notion knows", () => {
  const blocks = markdownToBlocks("```js\nconst a = 1;\n```");
  assert.equal(blocks[0].type, "code");
  assert.equal(blocks[0].code.language, "javascript");
  assert.equal(textOf(blocks[0]), "const a = 1;");
});

test("an unknown code language degrades instead of being rejected", () => {
  assert.equal(markdownToBlocks("```wat\nx\n```")[0].code.language, "plain text");
  assert.equal(markdownToBlocks("```\nx\n```")[0].code.language, "plain text");
});

test("frontmatter is kept as a header block, not spilled as prose", () => {
  const blocks = markdownToBlocks(DEMO);
  assert.equal(blocks[0].type, "code");
  assert.match(textOf(blocks[0]), /^name: fix-device-flow-refresh/);
  // And the --- fences themselves never become dividers.
  assert.notEqual(blocks[1].type, "divider");
});

test("quotes and rules are recognised", () => {
  const blocks = markdownToBlocks("> quoted\n\n---");
  assert.deepEqual(typesOf(blocks), ["quote", "divider"]);
});

test("blank lines do not become empty paragraphs", () => {
  const blocks = markdownToBlocks("one\n\n\n\ntwo");
  assert.equal(blocks.length, 2);
});

test("inline code and links become annotated runs", () => {
  const runs = inlineRichText("set `interval` per [RFC 8628](https://example.com/rfc)");
  assert.equal(runs.find((r) => r.annotations?.code)?.text.content, "interval");
  const link = runs.find((r) => r.text.link);
  assert.equal(link.text.content, "RFC 8628");
  assert.equal(link.text.link.url, "https://example.com/rfc");
});

test("a line with no markup is one plain run", () => {
  const runs = inlineRichText("just text");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text.content, "just text");
  assert.equal(runs[0].annotations, undefined);
});

test("a run longer than Notion's limit is split, not truncated", () => {
  const long = "word ".repeat(1200); // 6000 chars
  const runs = inlineRichText(long);
  assert.ok(runs.length > 1, "expected the run to be split");
  for (const run of runs) assert.ok(run.text.content.length <= 2000);
  assert.equal(runs.map((r) => r.text.content).join(""), long, "splitting lost text");
});

test("the real skill converts without losing any of its steps", () => {
  const blocks = markdownToBlocks(DEMO);
  const numbered = blocks.filter((b) => b.type === "numbered_list_item");
  const bullets = blocks.filter((b) => b.type === "bulleted_list_item");

  // Seven steps, four gotchas and four sources in the fixture.
  assert.equal(numbered.length, 7, "a procedure step went missing");
  assert.ok(bullets.length >= 8, "gotchas or sources went missing");
  assert.ok(blocks.some((b) => b.type === "heading_2"));
  assert.ok(blocks.every((b) => b.object === "block"));
});

test("every block carries the shape the API requires", () => {
  for (const block of markdownToBlocks(DEMO)) {
    assert.equal(block.object, "block");
    assert.ok(block.type, "block has no type");
    assert.ok(block[block.type], "block has no payload for its type");
  }
});

test("a skill larger than one request still yields batchable blocks", () => {
  const blocks = markdownToBlocks("- item\n".repeat(250));
  assert.ok(blocks.length > BLOCK_BATCH);
  // The caller slices by BLOCK_BATCH; nothing here may exceed it per batch.
  assert.equal(blocks.slice(0, BLOCK_BATCH).length, BLOCK_BATCH);
});

// ---- google docs ------------------------------------------------------

test("the consent URL carries the parameters Google requires", () => {
  const url = authUrl({ clientId: "abc.apps.googleusercontent.com", redirect: "https://x.chromiumapp.org/" });
  assert.match(url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(url, /client_id=abc\.apps\.googleusercontent\.com/);
  assert.match(url, /response_type=token/);
  assert.match(url, /redirect_uri=https%3A%2F%2Fx\.chromiumapp\.org%2F/);
  assert.match(url, /scope=https%3A%2F%2Fwww\.googleapis\.com%2Fauth%2Fdrive\.file/);
});

test("the scope is the narrow one: only files this extension creates", () => {
  assert.equal(SCOPE, "https://www.googleapis.com/auth/drive.file");
  assert.doesNotMatch(SCOPE, /auth\/drive$/, "that would grant the whole Drive");
});

test("the access token is read from the fragment, not the query", () => {
  const { token, error } = tokenFromRedirect("https://x.chromiumapp.org/#access_token=ya29.abc&token_type=Bearer");
  assert.equal(token, "ya29.abc");
  assert.equal(error, null);
});

test("a denied consent reports the reason instead of a null token", () => {
  const denied = tokenFromRedirect("https://x.chromiumapp.org/#error=access_denied");
  assert.equal(denied.token, null);
  assert.equal(denied.error, "access_denied");

  const query = tokenFromRedirect("https://x.chromiumapp.org/?error=access_denied");
  assert.equal(query.token, null);
  assert.equal(query.error, "access_denied");
});

test("a redirect with no token at all is an error, not a silent success", () => {
  assert.equal(tokenFromRedirect("https://x.chromiumapp.org/").token, null);
  assert.equal(tokenFromRedirect(undefined).token, null);
});

test("the upload body is well-formed multipart with the Docs mime type", () => {
  const body = multipartBody({
    metadata: { name: "skill", mimeType: "application/vnd.google-apps.document" },
    content: "# Title\n\nbody",
    boundary: "BOUND"
  });

  assert.equal((body.match(/--BOUND/g) ?? []).length, 3, "expected two parts and a closing boundary");
  assert.ok(body.endsWith("--BOUND--\r\n"), "multipart body must close its boundary");
  assert.match(body, /Content-Type: application\/json; charset=UTF-8/);
  assert.match(body, /Content-Type: text\/markdown; charset=UTF-8/);
  // The Docs mime type is what makes Drive convert rather than store a .md file.
  assert.match(body, /application\/vnd\.google-apps\.document/);
  assert.match(body, /# Title/);
});

test("the upload body uses CRLF, which multipart requires", () => {
  const body = multipartBody({ metadata: {}, content: "x", boundary: "B" });
  assert.match(body, /\r\n/);
  assert.doesNotMatch(body, /[^\r]\n/, "a bare LF will break the parser");
});
