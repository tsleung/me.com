// L3 — Analytics renderer. Function of snapshot. No L1 imports. No setTimeout.
// Never mutates snapshot or controller state.
//
// Four panels (built once on mount, updated on every snapshot tick via D3
// data joins; never re-created):
//   1. Assignment heatmap (rows = weapons, cols = scenario archetypes)
//   2. Score-over-time (advance + inverted survival, dual line)
//   3. Loadout status (HTML rows; ammo, reload, cooldown ring, uses)
//   4. Wave summary (alive-by-tier stack + total-killed stack)
//
// D3 is fetched from a CDN ESM endpoint, so this file is browser-only.
// All testable math lives in `analytics-helpers.js` so node:test can
// exercise it without a browser.

import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import {
  aliveCountsByTier,
  historyAxisBounds,
  cooldownDashArray,
  foldHeatmapCredits,
  shortArchLabel,
} from "./analytics-helpers.js";

// Stable weapon-row ids (architecture: 4 strats + primary + secondary + grenade).
const WEAPON_ROW_IDS = [
  "primary",
  "secondary",
  "grenade",
  "strat-1",
  "strat-2",
  "strat-3",
  "strat-4",
];

const TIER_KEYS   = ["light", "medium", "heavy", "boss"];
const TIER_COLORS = {
  light:  "#8d8d92",
  medium: "#d97a2c",
  heavy:  "#c0413f",
  boss:   "#ff3a3a",
};

const HEATMAP_W = 280;
const ROW_H     = 22;
const COL_W     = 38;
const LABEL_PAD_LEFT = 70;
const LABEL_PAD_TOP  = 60;

const CHART_W = 280;
const CHART_H = 120;
const CHART_M = { top: 10, right: 28, bottom: 22, left: 28 };

const RING_R    = 10;
const RING_VBOX = 28;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") node.setAttribute("style", v);
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function injectScopedStyles(rootEl) {
  if (rootEl.querySelector("style[data-analytics]")) return;
  const css = `
    .ana-stack { display: flex; flex-direction: column; gap: 12px; }
    .ana-panel { background: var(--panel); border: 1px solid var(--dim);
                 border-radius: 2px; padding: 10px 12px 12px;
                 display: flex; flex-direction: column; gap: 8px; }
    .ana-title { font-size: 10px; color: var(--ink-muted);
                 letter-spacing: 0.12em; text-transform: uppercase; }
    .ana-svg   { display: block; width: 100%; height: auto; }
    .ana-axis text { fill: var(--ink-muted); font-size: 9px;
                     font-family: var(--mono); }
    .ana-axis path, .ana-axis line { stroke: var(--dim); }
    .ana-cell { stroke: var(--bg); stroke-width: 1; }
    .ana-row-label, .ana-col-label { fill: var(--ink-muted); font-size: 9px;
                                     font-family: var(--mono); }
    .ana-line-advance  { fill: none; stroke: var(--accent); stroke-width: 1.5; }
    .ana-line-survival { fill: none; stroke: var(--on);     stroke-width: 1.5; }
    .ana-legend { display: flex; gap: 10px; font-size: 10px;
                  color: var(--ink-muted); }
    .ana-legend .swatch { display: inline-block; width: 8px; height: 8px;
                          border-radius: 1px; margin-right: 4px;
                          vertical-align: middle; }
    .ana-loadout-row { display: grid;
                       grid-template-columns: 110px 1fr auto;
                       align-items: center; gap: 8px;
                       padding: 4px 0; border-bottom: 1px solid var(--dim);
                       font-size: 11px; }
    .ana-loadout-row:last-child { border-bottom: 0; }
    .ana-loadout-row[data-id] { cursor: pointer; }
    .ana-loadout-row[data-id]:hover { background: rgba(255, 255, 255, 0.03); }
    .ana-loadout-row[data-id]:hover .ana-slot-name::after {
      content: " ↻"; color: var(--on); font-size: 11px;
    }
    .ana-slot-id { color: var(--ink-muted); display: flex; flex-direction: column;
                   line-height: 1.2; min-width: 0; }
    .ana-slot-name { color: var(--ink); font-size: 11px;
                     white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ana-slot-sub  { color: var(--ink-muted); font-size: 9px;
                     letter-spacing: 0.06em; text-transform: uppercase; }
    .ana-bar-wrap { background: var(--dim); height: 6px; border-radius: 1px;
                    overflow: hidden; position: relative; }
    .ana-bar-fill { background: var(--ink); height: 100%; transition: width 100ms; }
    .ana-bar-reload { background: var(--accent); height: 100%; transition: width 100ms; }
    .ana-bar-overlay { margin-top: 2px; height: 3px; }
    .ana-bar-ready    { background: var(--on); }
    .ana-bar-cooldown { background: linear-gradient(90deg, var(--accent) 0%, #ffb13a 100%); }
    .ana-bar-exhausted { background: var(--dim); }
    .ana-bar-rearm    { background: linear-gradient(90deg, #6db5ff 0%, var(--on) 100%); }
    .ana-bar-callin   { background: #6db5ff; height: 100%; }
    .ana-wave-timer { display: flex; justify-content: space-between; align-items: baseline;
                      font-size: 11px; color: var(--ink-muted);
                      padding: 4px 8px; background: var(--panel-2);
                      border-top: 1px solid var(--dim); }
    .ana-wave-timer .ana-wave-timer-val { color: var(--ink); font-variant-numeric: tabular-nums; }
    .ana-uses { color: var(--ink-muted); font-size: 10px; }
    .ana-uses.dry { color: #ff5050; font-weight: 600; letter-spacing: 0.04em; }
    .ana-bar-fill.dry { background: #ff5050; }
    .ana-dry-banner { font-size: 10px; padding: 4px 8px; margin: 4px 0 2px;
                       border: 1px solid #ff5050; color: #ff5050;
                       background: rgba(255, 80, 80, 0.08);
                       letter-spacing: 0.04em; text-transform: uppercase; }
    .ana-ring-wrap { display: flex; align-items: center; gap: 6px; }
    .ana-ring { transform: rotate(-90deg); }
    .ana-ring-bg { stroke: var(--dim); fill: none; stroke-width: 3; }
    .ana-ring-fg { stroke: var(--accent); fill: none; stroke-width: 3;
                   transition: stroke-dasharray 100ms; }
    .ana-wave-row { display: flex; align-items: center; gap: 8px;
                    font-size: 10px; color: var(--ink-muted); }
    .ana-wave-label { width: 50px; flex-shrink: 0; }
    .ana-wave-bar { flex: 1; display: flex; height: 10px;
                    background: var(--dim); border-radius: 1px; overflow: hidden; }
    .ana-wave-seg { transition: flex 200ms; }
    .ana-wave-total { width: 30px; text-align: right;
                      color: var(--ink); font-variant-numeric: tabular-nums; }
    .ana-note { font-size: 9px; color: var(--dim); font-style: italic; }
    .ana-mode-chip { font-size: 10px; font-variant-numeric: tabular-nums;
                     padding: 1px 6px; border-radius: 2px; letter-spacing: 0.08em;
                     background: var(--dim); color: var(--ink); }
    .ana-mode-chip[data-mode="KITE"] { background: var(--accent); color: var(--bg); }
    .ana-mode-chip[data-mode="PUSH"] { background: var(--on);     color: var(--bg); }
    .ana-mode-chip[data-mode="HOLD"] { background: var(--dim);    color: var(--ink); }
    .ana-policy-grid { display: grid;
                       grid-template-columns: 70px repeat(4, 1fr);
                       gap: 2px; }
    .ana-policy-corner, .ana-policy-col-head, .ana-policy-row-head,
    .ana-policy-cell { font-size: 10px; font-family: var(--mono);
                       text-align: center; padding: 4px 0;
                       color: var(--ink-muted); user-select: none; }
    .ana-policy-row-head { text-align: right; padding-right: 6px; }
    .ana-policy-col-head { text-transform: uppercase; letter-spacing: 0.08em; }
    .ana-policy-cell { background: var(--on); color: var(--bg);
                       cursor: pointer; border-radius: 1px;
                       font-weight: 600; transition: background 100ms; }
    .ana-policy-cell[data-state="deny"] { background: var(--dim);
                                          color: var(--ink-muted); }
    .ana-policy-cell:hover { outline: 1px solid var(--accent); }
    .ana-policy-hint { font-size: 9px; color: var(--ink-muted);
                       font-style: italic; margin-top: 2px; }
  `;
  const style = document.createElement("style");
  style.setAttribute("data-analytics", "");
  style.textContent = css;
  rootEl.appendChild(style);
}

// ---------------- panel: policy grid (authoring) ----------------

// Authoring surface for the WTA policy. Rows = the 7 fixed weapon slots,
// cols = threat tiers. Click toggles allow ↔ deny. The solver reads this
// every tick; the assignment heatmap below shows whether the policy
// actually held (a denied cell here should be black there, modulo the
// "no permitted shooter" fallback in wta-solver.js:assign).
function buildPolicyPanel(rootEl, controller) {
  const grid = el("div", { class: "ana-policy-grid" });
  // header row
  grid.appendChild(el("div", { class: "ana-policy-corner" }));
  for (const tier of TIER_KEYS) {
    grid.appendChild(el("div", { class: "ana-policy-col-head" }, [tier]));
  }
  // weapon rows
  const cellByKey = new Map();
  for (const wid of WEAPON_ROW_IDS) {
    grid.appendChild(el("div", { class: "ana-policy-row-head" }, [wid]));
    for (const tier of TIER_KEYS) {
      const key = `${wid}|${tier}`;
      const cell = el("div", { class: "ana-policy-cell", "data-state": "allow" }, ["✓"]);
      cell.addEventListener("click", () => {
        const cur = cell.getAttribute("data-state");
        const next = cur === "deny" ? "allow" : "deny";
        controller.dispatch({ type: "SET_POLICY_CELL", weaponId: wid, tier, value: next });
      });
      cellByKey.set(key, cell);
      grid.appendChild(cell);
    }
  }
  const panel = el("div", { class: "ana-panel" }, [
    el("div", { class: "ana-title" }, ["assignment policy (click to deny)"]),
    grid,
    el("div", { class: "ana-policy-hint" }, [
      "denied = solver will skip this pair unless no permitted shooter exists.",
    ]),
  ]);
  rootEl.appendChild(panel);
  return { panel, cellByKey };
}

function updatePolicyPanel(state, getCfg) {
  const policy = getCfg()?.solver?.policy ?? {};
  for (const [key, cell] of state.cellByKey) {
    const [wid, tier] = key.split("|");
    const denied = policy[wid]?.[tier] === "deny";
    const want = denied ? "deny" : "allow";
    if (cell.getAttribute("data-state") !== want) {
      cell.setAttribute("data-state", want);
      cell.textContent = denied ? "✕" : "✓";
    }
  }
}

// ---------------- panel: heatmap ----------------

function buildHeatmapPanel(rootEl) {
  const panel = el("div", { class: "ana-panel" }, [
    el("div", { class: "ana-title" }, ["assignment heatmap"]),
  ]);
  const svg = d3.select(panel)
    .append("svg")
    .attr("class", "ana-svg")
    .attr("preserveAspectRatio", "xMinYMin meet");
  svg.append("g").attr("class", "ana-cells").attr("transform",
    `translate(${LABEL_PAD_LEFT}, ${LABEL_PAD_TOP})`);
  svg.append("g").attr("class", "ana-rows").attr("transform",
    `translate(0, ${LABEL_PAD_TOP})`);
  svg.append("g").attr("class", "ana-cols").attr("transform",
    `translate(${LABEL_PAD_LEFT}, ${LABEL_PAD_TOP - 4})`);
  rootEl.appendChild(panel);
  return { panel, svg, cum: new Map(), lastTickN: -1 };
}

function updateHeatmap(svgSel, snapshot, heatState) {
  const archetypes = (snapshot.scenario && snapshot.scenario.archetypes) || [];
  const archIds = archetypes.map((a) => a.id);
  const rowIds = WEAPON_ROW_IDS;

  const W = LABEL_PAD_LEFT + Math.max(1, archIds.length) * COL_W + 8;
  const H = LABEL_PAD_TOP  + rowIds.length * ROW_H + 8;
  svgSel
    .attr("viewBox", `0 0 ${W} ${H}`)
    .attr("width",   W)
    .attr("height",  H);

  foldHeatmapCredits(heatState, snapshot);
  const credits = heatState.cum;

  // Build flat cell array.
  const cells = [];
  let maxV = 0;
  for (let r = 0; r < rowIds.length; r++) {
    const wid = rowIds[r];
    const row = credits.get(wid);
    for (let c = 0; c < archIds.length; c++) {
      const aid = archIds[c];
      const v = row ? (row.get(aid) || 0) : 0;
      if (v > maxV) maxV = v;
      cells.push({ key: `${wid}|${aid}`, r, c, v });
    }
  }
  const color = d3.scaleSequential(d3.interpolateReds).domain([0, maxV || 1]);

  // Cells.
  const cellSel = svgSel.select("g.ana-cells")
    .selectAll("rect.ana-cell")
    .data(cells, (d) => d.key);
  cellSel.exit().remove();
  cellSel.enter().append("rect")
    .attr("class", "ana-cell")
    .attr("width",  COL_W - 2)
    .attr("height", ROW_H - 2)
    .attr("x", (d) => d.c * COL_W)
    .attr("y", (d) => d.r * ROW_H)
    .attr("fill", "#000")
    .merge(cellSel)
    .transition().duration(200)
    .attr("fill", (d) => d.v === 0 ? "#000" : color(d.v));

  // Row labels (stable).
  const rowSel = svgSel.select("g.ana-rows")
    .selectAll("text.ana-row-label")
    .data(rowIds, (d) => d);
  rowSel.exit().remove();
  rowSel.enter().append("text")
    .attr("class", "ana-row-label")
    .attr("x", LABEL_PAD_LEFT - 6)
    .attr("text-anchor", "end")
    .attr("dominant-baseline", "middle")
    .attr("y", (_d, i) => i * ROW_H + ROW_H / 2)
    .text((d) => d);

  // Col labels (stable for the run).
  const colSel = svgSel.select("g.ana-cols")
    .selectAll("text.ana-col-label")
    .data(archIds, (d) => d);
  colSel.exit().remove();
  colSel.enter().append("text")
    .attr("class", "ana-col-label")
    .attr("transform", (_d, i) => `translate(${i * COL_W + COL_W / 2}, 0) rotate(-50)`)
    .attr("text-anchor", "start")
    .text(shortArchLabel);
}

// ---------------- panel: score chart ----------------

function buildScorePanel(rootEl) {
  const panel = el("div", { class: "ana-panel" }, [
    el("div", { class: "ana-title" }, ["score over time"]),
    el("div", { class: "ana-legend" }, [
      el("span", { html: '<span class="swatch" style="background:var(--accent)"></span>advance' }),
      el("span", { html: '<span class="swatch" style="background:var(--on)"></span>survival (m, inverted)' }),
    ]),
  ]);
  const svg = d3.select(panel).append("svg")
    .attr("class", "ana-svg")
    .attr("viewBox", `0 0 ${CHART_W} ${CHART_H}`)
    .attr("preserveAspectRatio", "xMinYMin meet");
  svg.append("g").attr("class", "ana-axis ana-axis-x")
    .attr("transform", `translate(0, ${CHART_H - CHART_M.bottom})`);
  svg.append("g").attr("class", "ana-axis ana-axis-yL")
    .attr("transform", `translate(${CHART_M.left}, 0)`);
  svg.append("g").attr("class", "ana-axis ana-axis-yR")
    .attr("transform", `translate(${CHART_W - CHART_M.right}, 0)`);
  svg.append("path").attr("class", "ana-line-advance");
  svg.append("path").attr("class", "ana-line-survival");
  const timer = el("div", { class: "ana-wave-timer" }, [
    el("span", {}, ["next spawn"]),
    el("span", { class: "ana-wave-timer-val" }, ["—"]),
  ]);
  panel.appendChild(timer);
  const modeRow = el("div", { class: "ana-wave-timer" }, [
    el("span", {}, ["diver"]),
    el("span", { class: "ana-mode-chip", "data-mode": "HOLD" }, ["HOLD"]),
  ]);
  panel.appendChild(modeRow);
  rootEl.appendChild(panel);
  return { panel, svg, timer, modeRow };
}

function updateModeChip(modeRowEl, snapshot) {
  if (!modeRowEl) return;
  const chip = modeRowEl.querySelector(".ana-mode-chip");
  if (!chip) return;
  const mode = snapshot?.player?.mode ?? "HOLD";
  chip.textContent = mode;
  chip.setAttribute("data-mode", mode);
}

function updateWaveTimer(timerEl, snapshot) {
  if (!timerEl) return;
  const valEl = timerEl.querySelector(".ana-wave-timer-val");
  if (!valEl) return;
  const next = snapshot.nextWaveT;
  const now = snapshot.t ?? 0;
  if (next == null || next <= now) {
    const aliveCount = (snapshot.enemies ?? []).filter((e) => e.alive).length;
    valEl.textContent = aliveCount > 0 ? "wave in progress" : "wave complete";
    return;
  }
  const secs = Math.max(0, (next - now) / 1000);
  valEl.textContent = secs >= 1
    ? `${secs.toFixed(1)}s`
    : `${Math.round(secs * 1000)}ms`;
}

function updateScoreChart(svgSel, snapshot) {
  const history = (snapshot.scores && snapshot.scores.history) || [];
  const b = historyAxisBounds(history);

  // Defensive: clamp any non-finite bound to a safe default before building scales.
  // A degenerate or non-finite domain causes scale(x) to return NaN, which then
  // bleeds into the SVG `d` attribute as "M28,NaN..." path errors.
  const safeNum = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  const tMinS = safeNum(b.tMin, 0) / 1000;
  let tMaxS = safeNum(b.tMax, 1) / 1000;
  if (tMaxS <= tMinS) tMaxS = tMinS + 1; // guarantee non-degenerate domain
  const advMin = safeNum(b.advanceMin, 0);
  const advMax = safeNum(b.advanceMax, 1) > advMin ? safeNum(b.advanceMax, 1) : advMin + 1;
  const survMin = safeNum(b.survivalMin, 0);
  const survMax = safeNum(b.survivalMax, 80) > survMin ? safeNum(b.survivalMax, 80) : survMin + 1;

  const x = d3.scaleLinear()
    .domain([tMinS, tMaxS])
    .range([CHART_M.left, CHART_W - CHART_M.right]);
  const yL = d3.scaleLinear()
    .domain([advMin, advMax])
    .range([CHART_H - CHART_M.bottom, CHART_M.top]);
  // INVERTED: 80m at top (safer), 0m at bottom.
  const yR = d3.scaleLinear()
    .domain([survMax, survMin])
    .range([CHART_H - CHART_M.bottom, CHART_M.top]);

  svgSel.select("g.ana-axis-x").call(
    d3.axisBottom(x).ticks(4).tickFormat((d) => `${d.toFixed(0)}s`),
  );
  svgSel.select("g.ana-axis-yL").call(
    d3.axisLeft(yL).ticks(3).tickFormat(d3.format(".0%")),
  );
  svgSel.select("g.ana-axis-yR").call(
    d3.axisRight(yR).ticks(3).tickFormat((d) => `${d}m`),
  );

  // history entries are { t, advance: number, survival: number } from scoring.js
  // Layered defenses against NaN reaching the SVG path:
  //   1. .defined() filters bad data points entirely (D3 emits a path break).
  //   2. safeAdv/safeSurv clamp non-finite values to safe defaults pre-scale.
  //   3. wrapped scale outputs (sx/sy below) clamp post-scale NaN to a finite
  //      value so even a surprise degenerate scale can't bleed NaN into `d`.
  const safeAdv = (v) => (Number.isFinite(v) ? v : 0);
  const safeSurv = (v) => (Number.isFinite(v) ? v : 80);
  const sx = (t) => {
    const v = x(t);
    return Number.isFinite(v) ? v : CHART_M.left;
  };
  const syL = (a) => {
    const v = yL(safeAdv(a));
    return Number.isFinite(v) ? v : CHART_H - CHART_M.bottom;
  };
  const syR = (s) => {
    const v = yR(safeSurv(s));
    return Number.isFinite(v) ? v : CHART_M.top;
  };

  const lineAdvance = d3.line()
    .defined((d) => d != null && Number.isFinite(d.t) && Number.isFinite(d.advance))
    .x((d) => sx(d.t / 1000))
    .y((d) => syL(d.advance))
    .curve(d3.curveMonotoneX);
  const lineSurvival = d3.line()
    .defined((d) => d != null && Number.isFinite(d.t))
    .x((d) => sx(d.t / 1000))
    .y((d) => syR(d.survival))
    .curve(d3.curveMonotoneX);

  // Filter to finite points BEFORE handing to D3 — belt-and-suspenders.
  const cleanHistory = (history || []).filter((d) => d != null && Number.isFinite(d.t));
  svgSel.select("path.ana-line-advance").datum(cleanHistory).attr("d", lineAdvance);
  svgSel.select("path.ana-line-survival").datum(cleanHistory).attr("d", lineSurvival);
}

// ---------------- panel: loadout status (HTML) ----------------

function buildLoadoutPanel(rootEl, controller = null) {
  const panel = el("div", { class: "ana-panel" }, [
    el("div", { class: "ana-title" }, ["loadout status"]),
  ]);
  const body = el("div", { class: "ana-loadout-body" });
  panel.appendChild(body);
  rootEl.appendChild(panel);
  // Click-to-refresh on a loadout row dispatches a debug refresh: weapons get
  // a free reload + reserve refill, stratagems clear their cooldown and uses.
  // Useful for "what if this came back right now?" inspection without a full
  // restart. Lane analytics passes no controller (no dispatch), so the click
  // handler short-circuits there.
  if (controller && typeof controller.dispatch === "function") {
    body.addEventListener("click", (ev) => {
      const row = ev.target.closest(".ana-loadout-row");
      if (!row || row.dataset.id == null) return;
      const kind = row.dataset.kind;
      const id = row.dataset.id;
      if (kind === "weapon") controller.dispatch({ type: "REFRESH_WEAPON", weaponId: id });
      else if (kind === "strat") controller.dispatch({ type: "REFRESH_STRATAGEM", stratagemId: id });
    });
  }
  return { panel, body };
}

function updateLoadout(body, snapshot) {
  const weapons    = snapshot.weapons    || [];
  const stratagems = snapshot.stratagems || [];

  paintDryBanner(body, weapons, stratagems);

  const sel = d3.select(body).selectAll("div.ana-loadout-row")
    .data([
      ...weapons.map((w) => ({ kind: "weapon", id: w.id, item: w })),
      ...stratagems.map((s) => ({ kind: "strat", id: s.id, item: s })),
    ], (d) => d.id);

  sel.exit().remove();

  const enter = sel.enter().append("div")
    .attr("class", "ana-loadout-row")
    .attr("data-id", (d) => d.id)
    .attr("data-kind", (d) => d.kind)
    .attr("title", (d) => d.kind === "weapon"
      ? "click to refill mag + reserve"
      : "click to clear cooldown + refill uses");
  const slotCell = enter.append("div").attr("class", "ana-slot-id");
  slotCell.append("div").attr("class", "ana-slot-name");
  slotCell.append("div").attr("class", "ana-slot-sub");
  enter.append("div").attr("class", "ana-loadout-mid");
  enter.append("div").attr("class", "ana-loadout-right");

  const merged = enter.merge(sel);

  merged.each(function (d) {
    const nameEl = this.querySelector(".ana-slot-name");
    const subEl  = this.querySelector(".ana-slot-sub");
    const mid    = this.querySelector(".ana-loadout-mid");
    const right  = this.querySelector(".ana-loadout-right");
    const friendly = d.kind === "strat" ? (d.item.name || d.item.defId || d.id) : d.id;
    const showSub  = d.kind === "strat" && friendly !== d.id;
    nameEl.textContent = friendly;
    nameEl.title = friendly;
    subEl.textContent = showSub ? d.id : "";
    subEl.style.display = showSub ? "" : "none";
    if (d.kind === "weapon") {
      const w = d.item;
      const magPct = w.magCap > 0 ? Math.max(0, Math.min(1, w.ammoInMag / w.magCap)) : 0;
      const reloadingNow = (w.reloadingPct ?? 1) < 1;
      const reloadPct = Math.max(0, Math.min(1, w.reloadingPct ?? 0));
      const reserveOut = (w.ammoReserve ?? Infinity) <= 0;
      const isDry = (w.ammoInMag ?? 0) <= 0 && reserveOut;
      const fillClass = isDry ? "ana-bar-fill dry" : "ana-bar-fill";
      mid.innerHTML =
        `<div class="ana-bar-wrap"><div class="${fillClass}" style="width:${(magPct * 100).toFixed(1)}%"></div></div>` +
        (reloadingNow
          ? `<div class="ana-bar-wrap ana-bar-overlay"><div class="ana-bar-reload" style="width:${(reloadPct * 100).toFixed(1)}%"></div></div>`
          : "");
      right.innerHTML = isDry
        ? `<span class="ana-uses dry">DRY</span>`
        : `<span class="ana-uses">${w.ammoInMag}/${w.ammoReserve ?? "∞"}</span>`;
    } else {
      const s = d.item;
      // Use horizontal bars for stratagems too — rings render badly at small
      // sizes and don't compose with reload-progress overlays.
      const cdPct = Math.max(0, Math.min(1, s.cooldownPct ?? 1));
      // Eagles share a single rearm timer once the loadout is fully spent.
      // Surface that as the bar instead of the per-eagle "exhausted" state, so
      // the player can see uses are about to come back.
      const rearmingPct = s.rearmingPct != null ? Math.max(0, Math.min(1, s.rearmingPct)) : null;
      const isRearming = rearmingPct != null;
      const isReady = cdPct >= 1 && (s.usesRemaining == null || s.usesRemaining > 0);
      const isExhausted = !isRearming && s.usesRemaining === 0;
      const callInPct = s.callInPct != null ? Math.max(0, Math.min(1, s.callInPct)) : null;
      const barClass = isRearming
        ? "ana-bar-fill ana-bar-rearm"
        : isExhausted
          ? "ana-bar-fill ana-bar-exhausted"
          : isReady
            ? "ana-bar-fill ana-bar-ready"
            : "ana-bar-fill ana-bar-cooldown";
      const barPct = isRearming ? rearmingPct : cdPct;
      mid.innerHTML =
        `<div class="ana-bar-wrap"><div class="${barClass}" style="width:${(barPct * 100).toFixed(1)}%"></div></div>` +
        (callInPct != null
          ? `<div class="ana-bar-wrap ana-bar-overlay"><div class="ana-bar-callin" style="width:${(callInPct * 100).toFixed(1)}%"></div></div>`
          : "");
      const usesText = s.usesRemaining == null ? "∞" : String(s.usesRemaining);
      const stateText = isRearming
        ? `rearm ${Math.round(rearmingPct * 100)}%`
        : isExhausted ? "spent" : isReady ? "ready" : `${Math.round(cdPct * 100)}%`;
      right.innerHTML = `<span class="ana-uses">${stateText} · ${usesText}</span>`;
    }
  });
}

// Surface the "all guns dry" state at the top of the loadout panel, plus the
// status of the resupply path (either the call-in stratagem or the supply
// pack backpack). When every magazine-fed weapon is bone-dry, the diver can't
// shoot until a supply lands; if no resupply path exists in the loadout at
// all, the run is effectively stuck and the user should know.
function paintDryBanner(body, weapons, stratagems) {
  let banner = body.querySelector(":scope > .ana-dry-banner");
  const magWeapons = weapons.filter((w) => (w.magCap ?? 0) > 0);
  if (magWeapons.length === 0) {
    if (banner) banner.remove();
    return;
  }
  const dry = magWeapons.filter((w) => (w.ammoInMag ?? 0) <= 0 && (w.ammoReserve ?? Infinity) <= 0);
  if (dry.length === 0) {
    if (banner) banner.remove();
    return;
  }
  const allDry = dry.length === magWeapons.length;
  const resupply = stratagems.find((s) => s.defId === "resupply");
  const supplyPack = stratagems.find((s) => s.defId === "supply-pack" || /supply.?pack/i.test(s.defId || ""));
  let pathText;
  if (resupply) {
    if (resupply.callInPct != null && resupply.callInPct < 1) pathText = "resupply inbound";
    else if ((resupply.cooldownPct ?? 1) < 1) pathText = `resupply ${Math.round((resupply.cooldownPct ?? 0) * 100)}%`;
    else pathText = "resupply ready";
  } else if (supplyPack) {
    pathText = "supply pack equipped (manual)";
  } else {
    pathText = "no resupply in loadout";
  }
  const headline = allDry ? "diver is dry" : `${dry.length}/${magWeapons.length} weapon${dry.length === 1 ? "" : "s"} dry`;
  const text = `${headline} · ${pathText}`;
  if (!banner) {
    banner = document.createElement("div");
    banner.className = "ana-dry-banner";
    body.insertBefore(banner, body.firstChild);
  }
  if (banner.textContent !== text) banner.textContent = text;
}

// ---------------- panel: wave summary ----------------

function buildWavePanel(rootEl) {
  const panel = el("div", { class: "ana-panel" }, [
    el("div", { class: "ana-title" }, ["wave summary"]),
  ]);
  const body = el("div", { class: "ana-wave-body" });
  panel.appendChild(body);
  rootEl.appendChild(panel);
  return { panel, body };
}

function updateWaveSummary(body, snapshot) {
  const alive = aliveCountsByTier(snapshot.enemies || []);
  const aliveTotal = TIER_KEYS.reduce((s, k) => s + alive[k], 0);
  const advance = (snapshot.scores && snapshot.scores.advance) || {};
  const killsTotal = advance.kills || 0;
  const killsByTier = advance.killsByTier || { light: 0, medium: 0, heavy: 0, boss: 0 };

  if (body.children.length === 0) {
    body.appendChild(buildStackRow("alive"));
    body.appendChild(buildStackRow("killed"));
  }
  const aliveRow  = body.children[0];
  const killedRow = body.children[1];

  paintTierStack(aliveRow.querySelector(".ana-wave-bar"), alive, aliveTotal);
  aliveRow.querySelector(".ana-wave-total").textContent = String(aliveTotal);

  paintTierStack(killedRow.querySelector(".ana-wave-bar"), killsByTier, killsTotal);
  killedRow.querySelector(".ana-wave-total").textContent = String(killsTotal);
}

function paintTierStack(bar, counts, total) {
  while (bar.firstChild) bar.removeChild(bar.firstChild);
  for (const tier of TIER_KEYS) {
    const n = counts[tier] || 0;
    if (n === 0) continue;
    const seg = document.createElement("div");
    seg.className = "ana-wave-seg";
    seg.style.background = TIER_COLORS[tier];
    seg.style.flex = String(n);
    seg.title = `${tier}: ${n}`;
    bar.appendChild(seg);
  }
  if (total === 0) {
    const filler = document.createElement("div");
    filler.style.flex = "1";
    bar.appendChild(filler);
  }
}

function buildStackRow(label) {
  return el("div", { class: "ana-wave-row" }, [
    el("div", { class: "ana-wave-label" }, [label]),
    el("div", { class: "ana-wave-bar" }),
    el("div", { class: "ana-wave-total" }, ["0"]),
  ]);
}

// ---------------- mount: per-lane (compare mode) ----------------

/**
 * Per-lane analytics mount.
 *
 * Same panel cluster as the global `mountAnalytics`, but driven by the
 * caller (`render(snapshot)` each tick) since lane snapshots come from
 * independent engines rather than a subscribable controller.
 *
 * Panel order is intentional and surfaces the questions the user asks
 * during a compare run, top-down:
 *   1. loadout status — "is anything dry / on cooldown / rooting?"
 *   2. assignment heatmap (+ policy authoring grid embedded above) —
 *      "where are my shots actually landing, and is the policy I set
 *      respected?"
 *   3. score over time — "is this run trending toward push or run?"
 *   4. wave summary — "what's left alive, what's been killed?"
 *
 * The policy grid is shared across all lanes (one global policy applies
 * to every solver). Editing it in one lane immediately affects all of
 * them. We embed it in each lane anyway because (a) it's the only way
 * to keep policy editable when the global analytics column is hidden in
 * compare mode, and (b) it has to sit next to the heatmap for the
 * deny→black-cell relationship to read.
 *
 * Pass `controller` to enable policy authoring (it dispatches
 * SET_POLICY_CELL actions). Without a controller, the policy panel is
 * skipped entirely.
 *
 * Returns `{ render, unmount }`.
 */
export function mountLaneAnalytics(rootEl, getCfg = () => ({}), controller = null) {
  if (!rootEl) throw new Error("mountLaneAnalytics: rootEl is required");
  injectScopedStyles(rootEl);
  const stack = el("div", { class: "ana-stack ana-stack-lane" });
  rootEl.appendChild(stack);

  // Order is the user's reading order for a compare lane: loadout first
  // (am I starving?), then heatmap+policy (what's hitting what?), then
  // score chart (where's the trend?), then wave summary (what's left?).
  const loadout = buildLoadoutPanel(stack);
  const policyPanel = (controller && typeof controller.dispatch === "function")
    ? buildPolicyPanel(stack, controller)
    : null;
  const heatmap = buildHeatmapPanel(stack);
  const score   = buildScorePanel(stack);
  const wave    = buildWavePanel(stack);

  function render(snapshot) {
    if (!snapshot) return;
    updateLoadout(loadout.body, snapshot);
    if (policyPanel) updatePolicyPanel(policyPanel, getCfg);
    updateHeatmap(heatmap.svg, snapshot, heatmap);
    updateScoreChart(score.svg, snapshot);
    updateWaveTimer(score.timer, snapshot);
    updateModeChip(score.modeRow, snapshot);
    updateWaveSummary(wave.body, snapshot);
  }

  function unmount() {
    if (stack.parentNode === rootEl) rootEl.removeChild(stack);
  }

  return { render, unmount };
}

// ---------------- mount ----------------

/**
 * Mount the analytics panel cluster into `rootEl`.
 * @param {HTMLElement} rootEl
 * @param {{subscribe:(fn:(s:object)=>void)=>()=>void}} controller
 * @returns {() => void} unmount
 */
export function mountAnalytics(rootEl, controller) {
  if (!rootEl) throw new Error("mountAnalytics: rootEl is required");
  if (!controller || typeof controller.subscribe !== "function") {
    throw new Error("mountAnalytics: controller.subscribe required");
  }

  injectScopedStyles(rootEl);

  // Persistent root inside `rootEl` so unmount is a clean teardown.
  const stack = el("div", { class: "ana-stack" });
  rootEl.appendChild(stack);

  // Policy panel only renders if the controller can be dispatched to —
  // tests that pass a stub controller without `dispatch` skip authoring.
  const canAuthor = typeof controller.dispatch === "function";
  const policyPanel = canAuthor ? buildPolicyPanel(stack, controller) : null;
  const heatmap = buildHeatmapPanel(stack);
  const score   = buildScorePanel(stack);
  const loadout = buildLoadoutPanel(stack, canAuthor ? controller : null);
  const wave    = buildWavePanel(stack);

  const getCfg = controller.getCfg ? () => controller.getCfg() : () => ({});

  const render = (snapshot) => {
    if (!snapshot) return;
    if (policyPanel) updatePolicyPanel(policyPanel, getCfg);
    updateHeatmap(heatmap.svg, snapshot, heatmap);
    updateScoreChart(score.svg, snapshot);
    updateWaveTimer(score.timer, snapshot);
    updateModeChip(score.modeRow, snapshot);
    updateLoadout(loadout.body, snapshot);
    updateWaveSummary(wave.body, snapshot);
  };

  // ResizeObserver — the SVG viewBox handles scaling but we re-render so
  // the heatmap can recompute its viewBox if the archetype list changes.
  // (No layout math depends on rootEl pixel size; this is defensive.)
  let ro = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => {
      const last = controller.getSnapshot ? controller.getSnapshot() : null;
      if (last) render(last);
    });
    ro.observe(rootEl);
  }

  const unsubscribe = controller.subscribe(render);

  return function unmount() {
    if (ro) ro.disconnect();
    unsubscribe && unsubscribe();
    if (stack.parentNode === rootEl) rootEl.removeChild(stack);
  };
}
