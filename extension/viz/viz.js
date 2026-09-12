/**
 * The habits visualizer.
 *
 * Charts are hand-written SVG: MV3 forbids loading a charting library from a CDN
 * and this repo has no bundler, so the alternative would be vendoring one to draw
 * six bar charts.
 *
 * Every chart here is single-series, which is a deliberate simplification rather
 * than a limitation — identity never rests on colour, so no legend is needed and
 * the palette never has to separate categories from one another.
 */
import {
  topDomains,
  tabsByYear,
  tabsByGroup,
  tabSummary,
  visitsByHour,
  visitsByWeekday,
  historySummary,
  formatDay
} from "./stats.js";
import { listTabs } from "../tabs.js";
import { clusterThemes } from "../slices/themes.js";

const els = {
  tabStats: document.getElementById("tab-stats"),
  chartAge: document.getElementById("chart-age"),
  chartTabDomains: document.getElementById("chart-tab-domains"),
  chartGroups: document.getElementById("chart-groups"),
  historyBody: document.getElementById("history-body"),
  historyStats: document.getElementById("history-stats"),
  chartHour: document.getElementById("chart-hour"),
  chartWeekday: document.getElementById("chart-weekday"),
  chartHistoryDomains: document.getElementById("chart-history-domains"),
  loadHistory: document.getElementById("load-history"),
  refresh: document.getElementById("refresh"),
  themes: document.getElementById("themes"),
  allSlices: document.getElementById("all-slices"),
  tooltip: document.getElementById("tooltip")
};

const SVG = "http://www.w3.org/2000/svg";

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

// ---- tooltip ----------------------------------------------------------

function showTooltip(text, event) {
  els.tooltip.textContent = text;
  els.tooltip.hidden = false;
  const pad = 12;
  const { width, height } = els.tooltip.getBoundingClientRect();
  const x = Math.min(event.clientX + pad, window.innerWidth - width - pad);
  const y = Math.max(event.clientY - height - pad, pad);
  els.tooltip.style.transform = "translate(" + x + "px," + y + "px)";
}

function hideTooltip() {
  els.tooltip.hidden = true;
}

/** Bigger hit target than the mark, per the interaction rules. */
function attachHover(target, text) {
  target.addEventListener("mousemove", (e) => showTooltip(text, e));
  target.addEventListener("mouseleave", hideTooltip);
  target.addEventListener("focus", (e) => showTooltip(text, e));
  target.addEventListener("blur", hideTooltip);
}

// ---- charts -----------------------------------------------------------

function emptyNote(container, message) {
  container.replaceChildren();
  const p = document.createElement("p");
  p.className = "empty-note";
  p.textContent = message;
  container.appendChild(p);
}

/**
 * Vertical bars. For ordered buckets — years, hours, weekdays — where the axis
 * order carries meaning and zeros must stay visible as gaps.
 */
function columnChart(container, rows, { series = "1", unit = "" } = {}) {
  container.replaceChildren();
  if (!rows.length) return emptyNote(container, "Nothing to show yet.");

  const max = Math.max(...rows.map((r) => r.value), 1);
  const W = 100;
  const H = 46;
  const gap = 2; // the 2px surface gap between adjacent fills
  const slot = W / rows.length;
  const barW = Math.max(slot - gap, 1);

  const svg = svgEl("svg", {
    viewBox: "0 0 " + W + " " + (H + 10),
    preserveAspectRatio: "none",
    class: "col-chart series-" + series,
    role: "img"
  });

  rows.forEach((row, i) => {
    const h = row.value === 0 ? 0 : Math.max((row.value / max) * H, 1.2);
    const x = i * slot + gap / 2;
    const label = (row.full ?? row.label) + " · " + row.value + (unit ? " " + unit : "");

    // A zero still gets a baseline tick, so an empty hour reads as measured.
    if (h === 0) {
      svg.appendChild(svgEl("rect", { x, y: H - 0.4, width: barW, height: 0.4, class: "zero" }));
    } else {
      const bar = svgEl("rect", {
        x,
        y: H - h,
        width: barW,
        height: h,
        rx: Math.min(1.2, barW / 2),
        class: row.isUndated ? "bar muted" : "bar"
      });
      svg.appendChild(bar);
    }

    // Hit target spans the full column height, not just the drawn bar.
    const hit = svgEl("rect", { x, y: 0, width: barW, height: H, class: "hit", tabindex: "0" });
    hit.appendChild(svgEl("title")).textContent = label;
    attachHover(hit, label);
    svg.appendChild(hit);
  });

  container.appendChild(svg);

  // Axis labels sit outside the SVG so they never scale with preserveAspectRatio.
  const axis = document.createElement("div");
  axis.className = "col-axis";
  axis.style.setProperty("--cols", String(rows.length));
  for (const row of rows) {
    const tick = document.createElement("span");
    // Only every other hour is labelled; 24 labels would collide.
    tick.textContent = rows.length > 12 && Number(row.label) % 3 !== 0 ? "" : row.label;
    axis.appendChild(tick);
  }
  container.appendChild(axis);
}

/**
 * Horizontal bars with direct labels. For named categories — domains, groups —
 * where the label is long and the order is by magnitude.
 */
function barChart(container, rows, { series = "1", unit = "" } = {}) {
  container.replaceChildren();
  if (!rows.length) return emptyNote(container, "Nothing to show yet.");

  const max = Math.max(...rows.map((r) => r.value), 1);
  const list = document.createElement("ul");
  list.className = "bar-chart series-" + series;

  for (const row of rows) {
    const li = document.createElement("li");
    if (row.isOther) li.className = "muted";

    const name = document.createElement("span");
    name.className = "bar-label";
    name.textContent = row.label;
    name.title = row.label;

    const track = document.createElement("span");
    track.className = "bar-track";
    const fill = document.createElement("span");
    fill.className = "bar-fill";
    fill.style.width = (row.value / max) * 100 + "%";
    track.appendChild(fill);

    const value = document.createElement("span");
    value.className = "bar-value";
    value.textContent = String(row.value);

    li.append(name, track, value);
    attachHover(li, row.label + " · " + row.value + (unit ? " " + unit : ""));
    list.appendChild(li);
  }

  container.appendChild(list);
}

/** The headline numbers. A stat tile is the right form when there is no shape. */
function statRow(container, stats) {
  container.replaceChildren();
  for (const { label, value, hint } of stats) {
    const tile = document.createElement("div");
    tile.className = "stat";

    const v = document.createElement("strong");
    v.textContent = String(value);
    const l = document.createElement("span");
    l.textContent = label;

    tile.append(v, l);
    if (hint) tile.title = hint;
    container.appendChild(tile);
  }
}

// ---- data -------------------------------------------------------------

async function renderTabs() {
  // An extension page has the same API access as the worker, so the dating logic
  // is reused directly rather than duplicated behind a message.
  const tabs = await listTabs();
  const summary = tabSummary(tabs);

  statRow(els.tabStats, [
    { label: "tabs open", value: summary.total },
    { label: "sites", value: summary.domains },
    { label: "windows", value: summary.windows },
    { label: "undated", value: summary.undated, hint: "History has no record of when these were first opened." },
    { label: "oldest", value: formatDay(summary.oldest), hint: "First visit of the oldest tab you still have open." }
  ]);

  columnChart(els.chartAge, tabsByYear(tabs), { unit: "tabs" });
  barChart(els.chartTabDomains, topDomains(tabs, 8), { unit: "tabs" });
  barChart(els.chartGroups, tabsByGroup(tabs, 8), { unit: "tabs" });

  renderThemes(tabs);
}

/** Where the slice page lives, however this page was opened. */
const sliceUrl = (query) => chrome.runtime.getURL("extension/slices/slices.html") + query;

/**
 * The themes the open tabs fall into, each with a way out to an export.
 *
 * This is the one thing on this page that could put words in the user's mouth,
 * so a theme says only how many pages it holds, when they were read, and what
 * it was named after. It never characterises them.
 */
function renderThemes(tabs) {
  const themes = clusterThemes(tabs);
  els.themes.replaceChildren();

  if (!themes.length) {
    emptyNote(els.themes, "No themes yet — this needs a few tabs on one subject, or a tab group with a name.");
    return;
  }

  for (const theme of themes) {
    const card = document.createElement("div");
    card.className = "theme-card";

    const name = document.createElement("h3");
    name.textContent = theme.label;

    const meta = document.createElement("p");
    meta.className = "theme-meta";
    const parts = [theme.size + (theme.size === 1 ? " page" : " pages")];
    if (theme.span) parts.push(formatDay(theme.span.from) + " to " + formatDay(theme.span.to));
    if (theme.undated) parts.push(theme.undated + " undated");
    meta.textContent = parts.join(" · ");

    const source = document.createElement("p");
    source.className = "theme-terms";
    source.textContent = theme.source === "group" ? "a tab group you named" : theme.terms.slice(0, 5).join(", ");

    const action = document.createElement("button");
    action.type = "button";
    action.textContent = "export this theme";
    action.addEventListener("click", () => {
      chrome.tabs.create({ url: sliceUrl("?theme=" + encodeURIComponent(theme.id)) });
    });

    card.append(name, meta, source, action);
    els.themes.appendChild(card);
  }
}

/** History is read only when asked for, and only here. */
async function renderHistory() {
  els.loadHistory.disabled = true;
  els.loadHistory.textContent = "reading…";

  try {
    const since = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const items = await chrome.history.search({
      text: "",
      startTime: since,
      maxResults: 5000
    });

    const summary = historySummary(items);
    statRow(els.historyStats, [
      { label: "pages", value: summary.pages },
      { label: "visits", value: summary.visits },
      { label: "sites", value: summary.domains },
      { label: "since", value: formatDay(summary.since) }
    ]);

    columnChart(els.chartHour, visitsByHour(items), { series: "2", unit: "pages" });
    columnChart(els.chartWeekday, visitsByWeekday(items), { series: "2", unit: "pages" });
    barChart(els.chartHistoryDomains, topDomains(items, 10), { series: "2", unit: "visits" });

    els.historyBody.hidden = false;
    els.loadHistory.textContent = "refresh history";
  } catch (err) {
    emptyNote(els.historyStats, "Could not read history: " + err.message);
    els.historyBody.hidden = false;
    els.loadHistory.textContent = "read history";
  } finally {
    els.loadHistory.disabled = false;
  }
}

els.allSlices?.addEventListener("click", () => {
  chrome.tabs.create({ url: sliceUrl("") });
});

els.loadHistory.addEventListener("click", renderHistory);
els.refresh.addEventListener("click", () => {
  renderTabs();
  if (!els.historyBody.hidden) renderHistory();
});

await renderTabs();
