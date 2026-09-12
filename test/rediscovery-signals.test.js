/**
 * The three signals a nudge is built from: is this page work, what is it about,
 * and where in the old page should the link land.
 *
 * The expensive failure for all three is silent. A trigger that fires on a mail
 * tab interrupts constantly; a topic full of site furniture relates everything
 * to everything; a fragment that does not match the page opens at the top with
 * no error at all. So each is tested against real-shaped input.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detectTrigger, TRIGGER_KINDS } from "../extension/rediscovery/triggers.js";
import { cleanTitle, topicFrom, candidateTerms } from "../extension/rediscovery/topic.js";
import { bestPassage, fragmentUrl, encodeFragment } from "../extension/rediscovery/passage.js";

// ---- triggers ---------------------------------------------------------

test("the surfaces that mean active work are recognised", () => {
  const cases = [
    ["https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit", "gdoc"],
    ["https://docs.google.com/spreadsheets/d/1AbC/edit#gid=0", "gdoc"],
    ["https://github.com/anthropics/claude-code", "github"],
    ["https://github.com/anthropics/claude-code/pull/42/files", "github"],
    ["https://www.notion.so/myteam/Roadmap-1a2b3c4d5e6f7081920a1b2c3d4e5f60", "notion"],
    ["https://linear.app/acme/issue/ENG-42/fix-the-refresh", "linear"],
    ["https://acme.atlassian.net/browse/ENG-42", "jira"]
  ];

  for (const [url, kind] of cases) {
    const trigger = detectTrigger(url);
    assert.ok(trigger, url + " should trigger");
    assert.equal(trigger.kind, kind, url);
    assert.ok(TRIGGER_KINDS.includes(trigger.kind));
    assert.ok(trigger.label.length, "a trigger needs prose for the why sentence");
  }
});

test("a second signed-in Google account still reads as a document", () => {
  // /u/1/ sits between the kind and the id; counting path segments misses it.
  assert.equal(detectTrigger("https://docs.google.com/document/u/1/d/1AbC/edit")?.kind, "gdoc");
});

test("pages that are not somebody's work never trigger", () => {
  const quiet = [
    "https://mail.google.com/mail/u/0/#inbox",
    "https://www.google.com/search?q=oauth+device+flow",
    "https://docs.google.com/document/u/0/",
    "https://github.com/notifications",
    "https://github.com/explore",
    "https://github.com/anthropics",
    "https://www.notion.so/pricing",
    "https://www.notion.so/my-integrations",
    "https://linear.app/acme/team/ENG/all",
    "https://acme.atlassian.net/jira/dashboards",
    "https://news.ycombinator.com/item?id=1",
    "chrome://extensions"
  ];
  for (const url of quiet) assert.equal(detectTrigger(url), null, url + " must stay quiet");
});

test("a trigger carries the words the title usually leaves out", () => {
  assert.match(detectTrigger("https://github.com/anthropics/claude-code").subject, /claude/);
  assert.match(
    detectTrigger("https://www.notion.so/team/Auth-Rewrite-1a2b3c4d5e6f7081920a1b2c3d4e5f60").subject,
    /auth rewrite/i
  );
  assert.equal(detectTrigger("https://acme.atlassian.net/browse/ENG-42").subject, "ENG-42");
});

test("a Jira board keeps the open ticket from the query string", () => {
  const trigger = detectTrigger("https://acme.atlassian.net/jira/software/projects/ENG/boards/1?selectedIssue=ENG-7");
  assert.equal(trigger?.kind, "jira");
  assert.equal(trigger.subject, "ENG-7");
});

// ---- topic ------------------------------------------------------------

test("the surface's own name is stripped off the title", () => {
  assert.equal(cleanTitle("Device flow refresh - Google Docs"), "Device flow refresh");
  assert.equal(cleanTitle("anthropics/claude-code: the CLI · GitHub"), "anthropics/claude-code: the CLI");
  assert.equal(cleanTitle("[ENG-42] Refresh loop - Jira"), "[ENG-42] Refresh loop");
});

test("site furniture never becomes a topic term", () => {
  const topic = topicFrom({
    title: "anthropics/claude-code: the CLI · GitHub",
    url: "https://github.com/anthropics/claude-code",
    trigger: detectTrigger("https://github.com/anthropics/claude-code")
  });
  // "github" in every repo title would relate every repo to every other one.
  assert.ok(!topic.terms.includes("github"), "github leaked into the topic");
  assert.ok(topic.terms.includes("claude"));
  assert.ok(topic.terms.includes("anthropics"));
});

test("what is visible on the page feeds the topic", () => {
  const bare = topicFrom({ title: "Untitled document - Google Docs", url: "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit" });
  assert.ok(!bare.terms.length, "an untitled doc has nothing to go on yet");

  const withPeek = topicFrom({
    title: "Untitled document - Google Docs",
    url: "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit",
    peek: { heading: "OAuth device flow", description: "Handling slow_down backoff", paragraph: "" }
  });
  assert.ok(withPeek.terms.includes("oauth"));
  assert.ok(withPeek.terms.includes("backoff"));
});

test("a candidate is scored on its title, its URL and its tab group", () => {
  const terms = candidateTerms({
    title: "RFC 8628",
    url: "https://datatracker.ietf.org/doc/html/rfc8628",
    groupTitle: "device flow"
  });
  assert.ok(terms.includes("device"));
  assert.ok(terms.includes("ietf"));
  assert.ok(!terms.includes("https"));
});

// ---- passages ---------------------------------------------------------

const ARTICLE = [
  "This page is about a number of unrelated things.",
  "The device code grant requires the client to respect the slow_down interval before polling again.",
  "Nothing in this final sentence is relevant to anything at all."
].join(" ");

test("the passage is the sentence that actually matches", () => {
  const passage = bestPassage(ARTICLE, ["slow_down", "polling"]);
  assert.match(passage, /slow_down interval/);
});

test("no match means no passage, rather than a wrong one", () => {
  // A passage that is not really in the page fails silently in the browser:
  // the link opens at the top and nothing explains why.
  assert.equal(bestPassage(ARTICLE, ["kubernetes"]), null);
  assert.equal(bestPassage(null, ["anything"]), null);
  assert.equal(bestPassage(ARTICLE, []), null);
});

test("fragment syntax inside the quote is escaped", () => {
  // A literal comma would be read as a start,end range; a hyphen pair ends the
  // directive. Both break the match without any error.
  const encoded = encodeFragment("slow_down, then back-off");
  assert.ok(!encoded.includes(","), "a raw comma splits the directive");
  assert.ok(!encoded.includes("-"), "a raw hyphen can end the directive");
  assert.equal(decodeURIComponent(encoded), "slow_down, then back-off");
});

test("a short passage is linked literally", () => {
  const url = fragmentUrl("https://example.com/rfc", "respect the interval");
  assert.equal(url, "https://example.com/rfc#:~:text=respect%20the%20interval");
});

test("a long passage is linked as a range so a reflow cannot break it", () => {
  const long = "The device code grant requires that the client respect the slow down interval before it polls the token endpoint again for a result.";
  const url = fragmentUrl("https://example.com/rfc", long);
  const directive = url.split("#:~:text=")[1];
  assert.ok(directive.includes(","), "expected a start,end range");

  const [start, end] = directive.split(",").map(decodeURIComponent);
  assert.ok(long.startsWith(start), "the range must start where the passage does");
  assert.ok(long.endsWith(end), "the range must end where the passage does");
});

test("an existing fragment is replaced, never stacked", () => {
  const url = fragmentUrl("https://example.com/rfc#section-3", "respect the interval");
  assert.equal((url.match(/#/g) ?? []).length, 1);
  assert.ok(url.includes("#:~:text="));
});

test("no passage leaves the URL exactly as it was", () => {
  assert.equal(fragmentUrl("https://example.com/rfc", null), "https://example.com/rfc");
  assert.equal(fragmentUrl("https://example.com/rfc", "   "), "https://example.com/rfc");
});
