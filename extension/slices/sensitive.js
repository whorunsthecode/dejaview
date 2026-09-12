/**
 * The sensitive domain list.
 *
 * A slice is made to be shared, which makes this the one list in the extension
 * where a false negative is expensive and a false positive is cheap. So it errs
 * hard toward excluding: the user can put anything back with one click in the
 * review screen, but nobody can unshare a document.
 *
 * It matches on the hostname, not the page text — deciding "this page is about
 * something private" by reading it would mean reading everything, and would be
 * wrong more often than a domain is.
 *
 * Nothing here is a hard block. Everything it catches is shown in the review
 * screen, switched off, with the reason. Filtering the user cannot see is worse
 * than no filtering, because they would trust the output more than it deserves.
 */

/**
 * Categories, each a hostname pattern. Deliberately broad: "bankofideas.com"
 * being excluded from a slice about banking is a shrug; a medical portal
 * appearing in a document someone posts in Slack is not.
 */
export const CATEGORIES = Object.freeze([
  {
    name: "health",
    label: "health and medical",
    host: /(^|\.)(nhs\.uk|mayoclinic\.org|webmd\.com|healthline\.com|drugs\.com|goodrx\.com|zocdoc\.com|patient\.info|plannedparenthood\.org|cancer\.org|diabetes\.org)$|health|clinic|medical|medicine|hospital|doctor|patient|symptom|diagnos|pharmac|prescription|psychiat|psycholog|therap|counsel|mental|rehab|addiction|fertility|pregnan|abortion|mychart/i
  },
  {
    name: "finance",
    label: "money and finance",
    // Banks mostly do not have "bank" in the name, so the common ones are named
    // outright. This list is a starting point, not a guarantee — which is why
    // every item still appears in the review screen for the user to check.
    host: /(^|\.)(irs\.gov|hmrc\.gov\.uk|paypal\.com|venmo\.com|wise\.com|revolut\.com|monzo\.com|starling\.com|coinbase\.com|creditkarma\.com|experian\.com|equifax\.com|chase\.com|wellsfargo\.com|bankofamerica\.com|citi\.com|capitalone\.com|discover\.com|amex\.com|americanexpress\.com|usbank\.com|pnc\.com|ally\.com|schwab\.com|fidelity\.com|vanguard\.com|etrade\.com|robinhood\.com|hsbc\.(com|co\.uk)|barclays\.co\.uk|lloydsbank\.com|natwest\.com|santander\.co\.uk|nationwide\.co\.uk|halifax\.co\.uk|rbc\.com|scotiabank\.com|td\.com|commbank\.com\.au|anz\.com|westpac\.com\.au|nab\.com\.au|hdfcbank\.com|icicibank\.com|sbi\.co\.in|axisbank\.com|paytm\.com|nubank\.com\.br)$|bank|creditunion|mortgage|payday|\bloan|lending|\bdebt|bankrupt|taxes?\.|brokerage|wallet/i
  },
  {
    name: "adult",
    label: "adult content",
    host: /porn|xxx|\bnsfw|escort|onlyfans|fansly|xhamster|xvideos|redtube|chaturbate|adultfriend/i
  },
  {
    name: "dating",
    label: "dating",
    host: /(^|\.)(tinder\.com|bumble\.com|hinge\.co|grindr\.com|okcupid\.com|match\.com|eharmony\.com|feeld\.co)$|dating/i
  },
  {
    name: "legal",
    label: "legal and immigration",
    host: /lawyer|attorney|solicitor|legalaid|immigration|asylum|visa-|divorce|custody|(^|\.)courts?\./i
  },
  {
    name: "employment",
    label: "job hunting",
    host: /(^|\.)(indeed\.com|glassdoor\.com|ziprecruiter\.com|monster\.com|lever\.co|greenhouse\.io|workday\.com)$|recruit|careers?\./i
  },
  {
    // A site that is only sensitive in one part of itself. LinkedIn is not
    // private; looking for a job on it is, so the rule is the path, not the host.
    name: "employment-jobs",
    label: "job hunting",
    host: /(^|\.)(linkedin\.com|xing\.com)$/i,
    path: /^\/jobs(\/|$)/i
  },
  {
    name: "support",
    label: "crisis and support services",
    host: /suicide|crisis|helpline|samaritans|alcoholics|narcotics|(^|\.)aa\.org$|shelter|refuge|abuse/i
  },
  {
    name: "belief",
    label: "religion and politics",
    host: /church|mosque|synagogue|temple|gurdwara|quran|bible|torah|democrat|republican|labour\.org|conservatives\.com|politic/i
  },
  {
    name: "account",
    label: "accounts and private inboxes",
    host: /(^|\.)(mail\.google\.com|outlook\.(com|office\.com)|mail\.yahoo\.com|proton\.me|1password\.com|lastpass\.com|bitwarden\.com)$|webmail|(^|\.)accounts?\./i
  }
]);

/** One-line explanations, for the count the review screen shows. */
export const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.name, c.label]));

/**
 * Is this page one to leave out by default?
 *
 * @param {string} url
 * @param {string[]} [extra]  hostnames or fragments the user added themselves
 * @returns {{sensitive: boolean, category: string|null, reason: string|null}}
 */
export function classify(url, extra = []) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Not a real page. Excluded, because an unparseable URL in a shared
    // document is at best noise.
    return { sensitive: true, category: "unknown", reason: "not a readable web address" };
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");

  for (const entry of extra) {
    const needle = String(entry ?? "").trim().toLowerCase().replace(/^www\./, "");
    if (needle && host.includes(needle)) {
      return { sensitive: true, category: "custom", reason: "on your own exclusion list" };
    }
  }

  for (const category of CATEGORIES) {
    if (!category.host.test(host)) continue;
    if (category.path && !category.path.test(parsed.pathname)) continue;
    return { sensitive: true, category: category.name, reason: category.label };
  }

  return { sensitive: false, category: null, reason: null };
}

/**
 * Split a set of pages into what is safe to include by default and what is not.
 * Both halves come back — the caller shows the second, it does not discard it.
 */
export function partition(items = [], extra = []) {
  const included = [];
  const flagged = [];

  for (const item of items) {
    const verdict = classify(item?.url, extra);
    if (verdict.sensitive) flagged.push({ item, ...verdict });
    else included.push(item);
  }

  const byCategory = {};
  for (const entry of flagged) {
    byCategory[entry.reason] = (byCategory[entry.reason] ?? 0) + 1;
  }

  return { included, flagged, count: flagged.length, byCategory };
}

/** Where the user's own additions live. */
export const SENSITIVE_SETTING = "SENSITIVE_DOMAINS";

/** @returns {Promise<string[]>} */
export async function loadExtraDomains(api = globalThis.chrome) {
  try {
    const stored = await api.storage.local.get([SENSITIVE_SETTING]);
    const raw = stored[SENSITIVE_SETTING];
    if (Array.isArray(raw)) return raw.filter((v) => typeof v === "string");
    if (typeof raw === "string") return raw.split(/[\s,]+/).filter(Boolean);
    return [];
  } catch {
    return [];
  }
}
