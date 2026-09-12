/**
 * The slice page: the interest map, the review screen, and the library.
 *
 * An extension page rather than the side panel, for the same reason the habits
 * page is one — a review screen is a list of twenty things with their quotes,
 * and that does not fit a 400px strip.
 *
 * The rule this file exists to enforce: nothing is generated until the user
 * presses the button. Everything before that is showing them what they would
 * be sharing.
 */
import { Slices } from "./engine.js";
import { SliceStore, KIND } from "./store.js";
import { PASSAGE_STATUS } from "./review.js";
import { createOpenRouterModel } from "../../agent/host.js";
import { loadLocalSettings, createLocalModel } from "../local-model.js";
import { obsidianTarget } from "../panel/export.js";
import { createNotionPage } from "../panel/notion.js";
import { createGoogleDoc } from "../panel/gdocs.js";

const els = {
  pageTitle: document.getElementById("page-title"),
  back: document.getElementById("back"),
  refresh: document.getElementById("refresh"),

  library: document.getElementById("library-view"),
  themes: document.getElementById("themes"),
  saved: document.getElementById("saved"),

  review: document.getElementById("review-view"),
  title: document.getElementById("slice-title"),
  intro: document.getElementById("slice-intro"),
  summary: document.getElementById("review-summary"),
  excludedBox: document.getElementById("excluded-box"),
  excludedSummary: document.getElementById("excluded-summary"),
  excludedList: document.getElementById("excluded-list"),
  list: document.getElementById("review-list"),
  readMissing: document.getElementById("read-missing"),
  cancel: document.getElementById("cancel-review"),
  generate: document.getElementById("generate"),

  sliceView: document.getElementById("slice-view"),
  sliceHeading: document.getElementById("slice-heading"),
  sliceMeta: document.getElementById("slice-meta"),
  sliceBody: document.getElementById("slice-body"),
  sliceStatus: document.getElementById("slice-status"),
  edit: document.getElementById("slice-edit"),
  regenerate: document.getElementById("slice-regenerate"),
  remove: document.getElementById("slice-delete"),
  copy: document.getElementById("slice-copy"),
  download: document.getElementById("slice-download"),
  obsidian: document.getElementById("slice-obsidian"),
  notion: document.getElementById("slice-notion"),
  gdocs: document.getElementById("slice-gdocs")
};

const store = new SliceStore();
let slices;
let current = null;

const plural = (n, one, many = one + "s") => n + " " + (n === 1 ? one : many);

// ---- setup -------------------------------------------------------------

/**
 * The model, when there is a key. Without one the document is still produced —
 * just assembled mechanically, and it says so in its own footer.
 */
async function buildModel() {
  try {
    // Local first, and with no fallback: turning it on is a statement about
    // where the reading goes, so a local server that is down means no model,
    // never a quiet trip to OpenRouter instead.
    const local = await loadLocalSettings();
    if (local.LOCAL_MODEL_ENABLED) {
      return {
        model: createLocalModel({ settings: local }),
        label: "a language model running on this machine (" + local.LOCAL_MODEL_NAME + ")"
      };
    }

    const env = await chrome.storage.local.get(["OPENROUTER_API_KEY", "OPENROUTER_MODEL"]);
    return env.OPENROUTER_API_KEY
      ? { model: createOpenRouterModel({ env }), label: "a language model" }
      : { model: null, label: "a language model" };
  } catch {
    return { model: null, label: "a language model" };
  }
}

function show(view) {
  els.library.hidden = view !== "library";
  els.review.hidden = view !== "review";
  els.sliceView.hidden = view !== "slice";
  els.back.hidden = view === "library";
}

function setStatus(text) {
  els.sliceStatus.textContent = text ?? "";
}

// ---- the library -------------------------------------------------------

function card(children) {
  const node = document.createElement("div");
  node.className = "card";
  for (const child of children) node.appendChild(child);
  return node;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function renderLibrary() {
  show("library");
  els.pageTitle.textContent = "Slices";

  const themes = await slices.themes();
  els.themes.replaceChildren();

  if (!themes.length) {
    els.themes.appendChild(
      el("p", "empty-state", "No themes yet. Open a few pages on the same subject, or name a tab group, and they will show up here.")
    );
  }

  for (const theme of themes) {
    const meta = [plural(theme.size, "page")];
    if (theme.span) meta.push("first read " + day(theme.span.from) + " to " + day(theme.span.to));
    if (theme.undated) meta.push(theme.undated + " undated");

    const action = el("button", null, "export this theme");
    action.addEventListener("click", () => openTheme(theme.id));

    els.themes.appendChild(
      card([
        el("h3", null, theme.label),
        el("p", "card-meta", meta.join(" · ")),
        el("p", "card-terms", theme.source === "group" ? "a tab group you named" : theme.terms.slice(0, 5).join(", ")),
        (() => {
          const row = el("div", "card-actions");
          row.appendChild(action);
          return row;
        })()
      ])
    );
  }

  const saved = await slices.list();
  els.saved.replaceChildren();

  if (!saved.length) {
    els.saved.appendChild(el("p", "empty-state", "Nothing saved yet."));
  }

  for (const slice of saved) {
    const open = el("button", null, "open");
    open.addEventListener("click", () => openSlice(slice.id));

    els.saved.appendChild(
      card([
        el("h3", null, slice.title),
        el("p", "card-meta", plural(slice.summary?.included ?? 0, "page") + " · " + day(slice.updatedAt) +
          (slice.generations > 1 ? " · regenerated " + (slice.generations - 1) + "×" : "")),
        el("p", "card-terms", slice.modelWritten ? "written with a model" : "assembled without a model"),
        (() => {
          const row = el("div", "card-actions");
          row.appendChild(open);
          return row;
        })()
      ])
    );
  }
}

const day = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "undated");

// ---- the review --------------------------------------------------------

function itemRow(entry, { onToggle }) {
  const li = el("li", "item" + (entry.included ? "" : " out"));

  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = entry.included;
  box.setAttribute("aria-label", (entry.included ? "Remove" : "Include") + " " + entry.title);
  box.addEventListener("change", () => onToggle(entry.key, box.checked));
  li.appendChild(box);

  const title = el("div", "item-title");
  const link = document.createElement("a");
  link.href = entry.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = entry.title;
  title.appendChild(link);
  li.appendChild(title);

  li.appendChild(el("div", "item-meta", entry.domain + " · " + (entry.date ? "first read " + entry.date : "first read: unknown")));

  if (entry.passage) li.appendChild(el("p", "item-passage", entry.passage));
  else li.appendChild(el("p", "item-nopassage", "No quote: " + entry.passageStatus));

  if (entry.autoExcluded) {
    li.appendChild(el("p", "item-flag", "Left out by default — " + entry.excludedReason));
  }

  return li;
}

function renderReview(draft) {
  current = draft;
  show("review");
  els.pageTitle.textContent = draft.theme?.label ? "Export: " + draft.theme.label : "Export";
  els.title.value = draft.title ?? "";
  els.intro.value = draft.intro ?? "";

  const onToggle = async (key, included) => {
    const entry = current.entries.find((e) => e.key === key);
    if (!entry) return;
    entry.included = included;
    current = await store.save(current);
    renderReview(current);
  };

  const included = current.entries.filter((e) => !e.autoExcluded);
  const flagged = current.entries.filter((e) => e.autoExcluded);

  els.list.replaceChildren(...included.map((entry) => itemRow(entry, { onToggle })));

  // The count is shown whether or not the list is expanded: filtering the user
  // cannot see is worse than no filtering.
  els.excludedBox.hidden = flagged.length === 0;
  if (flagged.length) {
    const kinds = Object.entries(current.summary?.byCategory ?? {})
      .map(([label, count]) => count + " " + label)
      .join(", ");
    els.excludedSummary.textContent =
      plural(flagged.length, "page") + " left out automatically" + (kinds ? " (" + kinds + ")" : "");
    els.excludedList.replaceChildren(...flagged.map((entry) => itemRow(entry, { onToggle })));
  }

  const live = current.entries.filter((e) => e.included);
  const quoted = live.filter((e) => e.passage).length;
  const unread = live.filter((e) => e.passageStatus === PASSAGE_STATUS.unread).length;

  els.summary.replaceChildren(
    stat(String(live.length), "going in"),
    stat(String(quoted), "with a quote"),
    stat(String(flagged.length), "auto-excluded"),
    stat(String(live.filter((e) => !e.date).length), "undated")
  );

  els.readMissing.hidden = unread === 0;
  els.readMissing.textContent = "read " + plural(unread, "page") + " that has no quote yet";
  els.generate.disabled = live.length === 0;
}

function stat(value, label) {
  const node = el("div", "stat");
  node.appendChild(el("strong", null, value));
  node.appendChild(el("span", null, label));
  return node;
}

// ---- the document ------------------------------------------------------

function renderSliceView(slice) {
  current = slice;
  show("slice");
  els.pageTitle.textContent = "Slices";
  els.sliceHeading.textContent = slice.title;

  const bits = [
    plural(slice.summary?.included ?? 0, "page"),
    slice.modelWritten
      ? "grouped and annotated by a model"
      : "assembled without a model" + (slice.composeError ? " (" + slice.composeError + ")" : ""),
    "generated " + day(slice.generatedAt ?? slice.updatedAt)
  ];
  els.sliceMeta.textContent = bits.join(" · ");
  els.sliceBody.textContent = slice.markdown ?? "";
  setStatus("");
}

const filename = (slice) =>
  (String(slice.title ?? "slice").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "slice") + ".md";

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

// ---- routing -----------------------------------------------------------

async function openTheme(themeId) {
  setStatus("");
  const draft = await slices.draftFromTheme(themeId);
  if (!draft) return renderLibrary();
  history.replaceState(null, "", "?draft=" + encodeURIComponent(draft.id));
  renderReview(draft);
}

async function openSlice(id) {
  const slice = await slices.get(id);
  if (!slice) return renderLibrary();
  history.replaceState(null, "", "?slice=" + encodeURIComponent(id));
  renderSliceView(slice);
}

/**
 * A set of pages handed over from another surface — the panel's run sources,
 * say. Written to the store rather than the URL so a long list cannot be
 * truncated by a URL length limit.
 */
async function consumeHandoff(id) {
  const row = await store.get(id);
  if (!row?.urls?.length) return renderLibrary();

  const open = new Map();
  for (const tab of await slices.tabs()) open.set(tab.url, tab);

  const items = row.urls.map(
    (url) => open.get(url) ?? { url, title: row.titles?.[url] ?? url, groupTitle: null, firstVisit: null }
  );

  const draft = await slices.draftFromItems(items, row.label, row.terms ?? []);
  await store.remove(id);
  history.replaceState(null, "", "?draft=" + encodeURIComponent(draft.id));
  renderReview(draft);
}

async function route() {
  const params = new URLSearchParams(location.search);

  if (params.has("handoff")) return consumeHandoff(params.get("handoff"));
  if (params.has("theme")) return openTheme(params.get("theme"));
  if (params.has("slice")) return openSlice(params.get("slice"));

  if (params.has("draft")) {
    const draft = await slices.get(params.get("draft"));
    if (draft) return draft.kind === KIND.slice ? renderSliceView(draft) : renderReview(draft);
  }

  return renderLibrary();
}

// ---- wiring ------------------------------------------------------------

els.back.addEventListener("click", () => {
  history.replaceState(null, "", location.pathname);
  renderLibrary();
});

els.refresh.addEventListener("click", () => route());

els.cancel.addEventListener("click", async () => {
  if (current?.kind === KIND.draft) await slices.remove(current.id);
  history.replaceState(null, "", location.pathname);
  renderLibrary();
});

els.readMissing.addEventListener("click", async () => {
  els.readMissing.disabled = true;
  els.readMissing.textContent = "reading…";
  const result = await slices.readMissing(current.id);
  els.readMissing.disabled = false;
  if (result.ok) renderReview(result.draft);
});

els.generate.addEventListener("click", async () => {
  els.generate.disabled = true;
  els.generate.textContent = "writing…";

  const result = await slices.generate(current.id, {
    title: els.title.value.trim() || current.title,
    intro: els.intro.value.trim(),
    keep: current.entries.filter((e) => e.included).map((e) => e.key)
  });

  els.generate.disabled = false;
  els.generate.textContent = "generate the document";

  if (!result.ok) {
    els.summary.replaceChildren(stat("!", result.error));
    return;
  }
  history.replaceState(null, "", "?slice=" + encodeURIComponent(result.slice.id));
  renderSliceView(result.slice);
});

els.edit.addEventListener("click", () => {
  // Back to the same review, with every earlier decision still on it.
  history.replaceState(null, "", "?draft=" + encodeURIComponent(current.id));
  renderReview(current);
});

els.regenerate.addEventListener("click", async () => {
  els.regenerate.disabled = true;
  setStatus("looking for anything new on this theme…");
  const result = await slices.regenerate(current.id);
  els.regenerate.disabled = false;

  if (!result.ok) return setStatus(result.error);
  renderSliceView(result.slice);
  setStatus(result.added ? "Added " + plural(result.added, "new page") + "." : "Nothing new on this theme yet.");
});

els.remove.addEventListener("click", async () => {
  if (!confirm("Delete this slice? The document is not kept anywhere else.")) return;
  await slices.remove(current.id);
  history.replaceState(null, "", location.pathname);
  renderLibrary();
});

els.copy.addEventListener("click", async () => {
  setStatus((await copyText(current.markdown)) ? "Copied." : "Could not copy — use download.");
});

els.download.addEventListener("click", () => {
  const blob = new Blob([current.markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename(current);
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

els.obsidian.addEventListener("click", async () => {
  const stored = await chrome.storage.local.get(["OBSIDIAN_VAULT", "OBSIDIAN_FOLDER"]);
  const target = obsidianTarget({
    vault: stored.OBSIDIAN_VAULT,
    folder: stored.OBSIDIAN_FOLDER,
    filename: filename(current),
    markdown: current.markdown
  });

  if (target.mode === "manual") {
    const copied = await copyText(current.markdown);
    return setStatus(copied ? "Too long for one obsidian:// call — copied instead, paste it in." : "Too long for Obsidian, and the copy failed.");
  }

  for (let i = 0; i < target.urls.length; i++) {
    const link = document.createElement("a");
    link.href = target.urls[i];
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    if (i < target.urls.length - 1) await new Promise((r) => setTimeout(r, 350));
  }
  setStatus("Wrote " + target.path + " to Obsidian.");
});

els.notion.addEventListener("click", async () => {
  setStatus("sending to Notion…");
  const stored = await chrome.storage.local.get(["NOTION_TOKEN", "NOTION_PARENT"]);
  const result = await createNotionPage({
    token: stored.NOTION_TOKEN,
    parentId: stored.NOTION_PARENT,
    title: current.title,
    markdown: current.markdown
  });
  setStatus(result.ok ? "Created in Notion." : "Notion: " + result.error);
  if (result.ok && result.url) chrome.tabs.create({ url: result.url, active: false });
});

els.gdocs.addEventListener("click", async () => {
  setStatus("sending to Google Docs…");
  const stored = await chrome.storage.local.get(["GOOGLE_CLIENT_ID"]);
  const result = await createGoogleDoc({
    clientId: stored.GOOGLE_CLIENT_ID,
    name: current.title,
    markdown: current.markdown
  });
  setStatus(result.ok ? "Created in Google Docs." : "Google Docs: " + result.error);
  if (result.ok && result.url) chrome.tabs.create({ url: result.url, active: false });
});

// ---- go ----------------------------------------------------------------

const chosen = await buildModel();
slices = new Slices({ model: chosen.model, modelLabel: chosen.label });
await store.sweepDrafts();
await route();
