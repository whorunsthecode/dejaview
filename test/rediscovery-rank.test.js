/**
 * The bar a rediscovery has to clear, and how often it may be cleared.
 *
 * Every test here is about staying quiet. The feature's failure mode is not
 * missing something — it is interrupting with something weak, which is what
 * makes a person turn it off, after which it surfaces nothing ever again.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { rankCandidates, bestNudge, explain, DEFAULT_MIN_AGE_DAYS } from "../extension/rediscovery/rank.js";
import { rateCheck, shouldEvaluate, acceptStats, EVALUATION_COOLDOWN_MS } from "../extension/rediscovery/budget.js";

const NOW = Date.UTC(2026, 8, 12);
const DAY = 86_400_000;
const ago = (days) => NOW - days * DAY;

const TOPIC = { terms: ["oauth", "device", "flow", "refresh", "token"] };

/** Filler, so inverse document frequency has a corpus to be relative to. */
const FILLER = [
  "Best espresso grinders 2024",
  "Sourdough starter troubleshooting",
  "Flight status LHR to SFO",
  "Tax return deadlines",
  "Kubernetes ingress annotations",
  "CSS grid subgrid support",
  "Rust lifetimes explained",
  "Postgres vacuum tuning",
  "Figma auto layout tips",
  "Weekend cabin availability"
].map((title, i) => ({
  url: "https://example.com/filler/" + i,
  title,
  firstVisit: ago(200 + i),
  lastVisit: ago(100)
}));

const rank = (candidates, options = {}) =>
  rankCandidates({ topic: TOPIC, candidates: [...FILLER, ...candidates], now: NOW, ...options });

const entryFor = (ranked, url) => ranked.find((r) => r.candidate.url === url);

// ---- the age gate -----------------------------------------------------

test("an undated page is never surfaced, however well it matches", () => {
  // The whole claim is "you read this months ago". Without a first-visit date
  // that claim cannot be made, and it is never approximated from last access.
  const ranked = rank([
    {
      url: "https://ietf.org/rfc8628",
      title: "OAuth 2.0 device flow: refresh token handling",
      firstVisit: null,
      lastVisit: ago(400)
    }
  ]);

  const entry = entryFor(ranked, "https://ietf.org/rfc8628");
  assert.equal(entry.eligible, false);
  assert.match(entry.reason, /undated/);
  assert.equal(bestNudge(ranked), null);
});

test("something read last week is not a rediscovery", () => {
  const ranked = rank([
    {
      url: "https://ietf.org/rfc8628",
      title: "OAuth 2.0 device flow: refresh token handling",
      firstVisit: ago(7),
      lastVisit: ago(1)
    }
  ]);
  assert.match(entryFor(ranked, "https://ietf.org/rfc8628").reason, /too recently/);
});

test("the age floor is configurable, and the default is a month", () => {
  const candidate = [{
    url: "https://ietf.org/rfc8628",
    title: "OAuth 2.0 device flow: refresh token handling",
    firstVisit: ago(20),
    lastVisit: ago(20)
  }];

  assert.equal(DEFAULT_MIN_AGE_DAYS, 30);
  assert.equal(bestNudge(rank(candidate)), null);
  assert.ok(bestNudge(rank(candidate, { minAgeDays: 14 })), "a lower floor should let it through");
});

// ---- the relatedness gate ---------------------------------------------

test("one shared word is not a relationship", () => {
  const ranked = rank([
    {
      url: "https://example.com/oauth-pricing",
      title: "OAuth vendor pricing comparison",
      firstVisit: ago(300),
      lastVisit: ago(300)
    },
    // A second page carrying "oauth" so the term is not unique to the first.
    { url: "https://example.com/oauth-blog", title: "An OAuth rant", firstVisit: ago(300), lastVisit: ago(300) }
  ]);

  assert.match(entryFor(ranked, "https://example.com/oauth-pricing").reason, /one shared word/);
});

test("a genuinely related page read long ago is surfaced", () => {
  const ranked = rank([
    {
      url: "https://ietf.org/rfc8628",
      title: "OAuth 2.0 device flow: refresh token handling",
      firstVisit: ago(300),
      lastVisit: ago(280)
    }
  ]);

  const best = bestNudge(ranked);
  assert.ok(best, "expected a nudge");
  assert.equal(best.candidate.url, "https://ietf.org/rfc8628");
  assert.ok(best.shared.length >= 2);
  assert.ok(best.confidence > 0 && best.confidence <= 1, "confidence must be a fraction");
});

test("a page about nothing in common scores nothing", () => {
  const ranked = rank([]);
  for (const entry of ranked) {
    assert.equal(entry.eligible, false, entry.candidate.title + " should not qualify");
  }
});

// ---- feedback ---------------------------------------------------------

test("less like this buries the theme it was shown for", () => {
  const candidate = [{
    url: "https://ietf.org/rfc8628",
    title: "OAuth 2.0 device flow: refresh token handling",
    firstVisit: ago(300),
    lastVisit: ago(280)
  }];

  const before = bestNudge(rank(candidate));
  assert.ok(before, "expected it to qualify before any feedback");

  // Two pushbacks on the terms that earned it.
  const after = rank(candidate, { suppressed: { device: 1, refresh: 1, oauth: 1, flow: 1, token: 1 } });
  const entry = entryFor(after, "https://ietf.org/rfc8628");
  assert.ok(entry.confidence < before.confidence, "suppression must lower confidence");
  assert.equal(entry.eligible, false, "a suppressed theme should stop qualifying");
});

test("an item already surfaced is not surfaced again", () => {
  const candidate = [{
    url: "https://ietf.org/rfc8628",
    title: "OAuth 2.0 device flow: refresh token handling",
    firstVisit: ago(300),
    lastVisit: ago(280)
  }];

  const ranked = rank(candidate, { shown: ["https://ietf.org/rfc8628"] });
  assert.match(entryFor(ranked, "https://ietf.org/rfc8628").reason, /already surfaced/);
});

test("the page being looked at is never the rediscovery", () => {
  const url = "https://ietf.org/rfc8628";
  const ranked = rank([{ url, title: "OAuth 2.0 device flow: refresh token handling", firstVisit: ago(300), lastVisit: ago(1) }], {
    triggerUrl: url + "?utm_source=x"
  });
  // Canonicalised, so tracking parameters cannot smuggle the same page back in.
  assert.match(entryFor(ranked, url).reason, /the page you are on/);
});

// ---- ordering ---------------------------------------------------------

test("between two equally related pages, the older one wins", () => {
  const title = "OAuth 2.0 device flow: refresh token handling";
  const ranked = rank([
    { url: "https://a.example/rfc", title, firstVisit: ago(120), lastVisit: ago(100) },
    { url: "https://b.example/rfc", title, firstVisit: ago(600), lastVisit: ago(100) }
  ]);

  const best = bestNudge(ranked);
  assert.equal(best.candidate.url, "https://b.example/rfc", "the more forgotten one is the better reminder");
});

test("the reason names the words that actually matched", () => {
  const why = explain(["device", "refresh"], "this GitHub repo");
  assert.match(why, /device/);
  assert.match(why, /refresh/);
  assert.match(why, /this GitHub repo/);
  assert.ok(why.endsWith("."));
});

// ---- how often it may speak -------------------------------------------

test("one nudge an hour", () => {
  const log = [{ at: NOW - 10 * 60_000 }];
  const check = rateCheck(log, NOW);
  assert.equal(check.ok, false);
  assert.match(check.reason, /hour/);
  assert.equal(check.retryAt, NOW - 10 * 60_000 + 3_600_000);

  assert.equal(rateCheck([{ at: NOW - 61 * 60_000 }], NOW).ok, true);
});

test("three nudges a day, even when spread out", () => {
  const log = [{ at: NOW - 2 * 3_600_000 }, { at: NOW - 5 * 3_600_000 }, { at: NOW - 9 * 3_600_000 }];
  const check = rateCheck(log, NOW);
  assert.equal(check.ok, false);
  assert.match(check.reason, /day/);

  // A fourth entry from yesterday changes nothing: it is already outside the window.
  assert.equal(rateCheck([...log, { at: NOW - 25 * 3_600_000 }], NOW).ok, false);
  // Two in the day, none in the hour, is within budget.
  assert.equal(rateCheck(log.slice(0, 2), NOW).ok, true);
  // And the day's budget reopens once the oldest of the three ages out.
  assert.equal(rateCheck(log, NOW + 16 * 3_600_000).ok, true);
});

test("asking for one does not spend the budget", () => {
  // "Surprise me" is the user talking, not the extension interrupting.
  const log = [{ at: NOW - 60_000, manual: true }, { at: NOW - 120_000, manual: true }, { at: NOW - 180_000, manual: true }];
  assert.equal(rateCheck(log, NOW).ok, true);
});

test("evaluations are spaced even when none of them nudges", () => {
  assert.equal(shouldEvaluate(null, NOW), true);
  assert.equal(shouldEvaluate(NOW - 1000, NOW), false);
  assert.equal(shouldEvaluate(NOW - EVALUATION_COOLDOWN_MS, NOW), true);
});

// ---- the scoreboard ---------------------------------------------------

test("the accept rate counts answers, not nudges", () => {
  const stats = acceptStats([
    { at: 1, response: "opened" },
    { at: 2, response: "dismissed" },
    { at: 3, response: "less" },
    { at: 4, response: "opened" },
    { at: 5, response: "shown" } // still on screen: not yet an answer
  ]);

  assert.equal(stats.total, 5);
  assert.equal(stats.answered, 4);
  assert.equal(stats.pending, 1);
  assert.equal(stats.opened, 2);
  assert.equal(stats.acceptRate, 0.5);
});

test("nothing answered yet is not a zero percent accept rate", () => {
  assert.equal(acceptStats([{ at: 1, response: "shown" }]).acceptRate, null);
  assert.equal(acceptStats([]).acceptRate, null);
});
