// app.js — the browser ORCHESTRATION shell: DOMAIN state, the ONE UI-mode reducer
// (uiState.js) it dispatches into, the RAF loop, interaction/control wiring, boot,
// and the ?selftest=1 badge. It owns no physics and no drawing — those live in the
// pure modules and in render.js / hud.js.
//
// STATE MODEL (see notes/2026_07_21_delta_v_sim_ui_state_model.md):
//   • `state.ui` = the pure VIEW/INTERACTION-MODE state (frame · camera · workspace ·
//     playback). Interaction handlers `dispatch(action)` → `reduce` → a KNOWN state;
//     NO handler mutates frame/camera/workspace/playing directly. This is what makes
//     the combination bugs (e.g. Sun-stranded-in-zoomed-out-compare) unreachable.
//   • everything else in `state` is DOMAIN DATA (the clock, the definition library,
//     the fleet, the sandbox craft, the elevator, the analysis DATA) — untouched by
//     the reducer, mutated imperatively as before.

import { worldAt, MU_SUN, MU_EARTH, DAY_S, YEAR_S } from "./sim.js";
import { sub, mag } from "./vec.js";
import { frameMap, frameUnmap } from "./frames.js";
import { frameScaleFactor } from "./visibility.js";
import { craftFromCircular } from "./spacecraft.js";
import { transferTrajectory, dvSeries, seriesMinima, porkchop } from "./transfer.js";
import { planEfficientLaunch } from "./plan.js";
import { availableMethods } from "./infra.js";
import {
  missionStateAt,
  craftBudget,
  CRAFT_ARCHETYPES,
  CRAFT_ORDER,
  turnaroundKey,
  fleetName,
  MISSION_PRESETS,
  definitionFrom,
  resolveDefinition,
  firstLegKeys,
} from "./mission.js";
import { elevatorPayloadCraft } from "./elevator.js";
import { Camera, desiredCamera, desiredCameraAt } from "./camera.js";
import { render, pickMark, COURSE_PALETTE } from "./render.js";
import { formatHud, formatPlan, formatMission } from "./hud.js";
import { drawDvChart } from "./chart.js";
import { drawPorkchop } from "./porkchop.js";
import { describe } from "./descriptions.js";
import { runSelftest } from "./selftest.js";
import { INITIAL, reduce, frameDesc, analysisVisible } from "./uiState.js";

const $ = (id) => document.getElementById(id);

// ---- state ------------------------------------------------------------------
const state = {
  // clock (DOMAIN — the value; playback MODE lives in ui.playback)
  t: 0,

  // THE UI-MODE STATE (pure reducer): { frame, camera:{kind,target}, workspace, playback }
  ui: null, // set to a fresh INITIAL in boot

  camera: null, // the imperative Camera (scale/center/ease) — reducer governs MODE, not this
  reducedMotion: false,
  selected: "earth", // which body/craft the HUD reads (a selection, not a mode)

  // ---- DOMAIN DATA (untouched by the reducer) -------------------------------
  craft: null, // { def, obj } — the manual sandbox craft
  // DEFINE: the session library of mission definitions
  definitions: [],
  selectedDefId: null,
  defSeq: 0,
  previewRender: null, // { legs:[{pts,...}] } — the SELECTED def resolved "if I launch now"
  // analysis sub-state — SUBORDINATE to workspace 'define' (reset on leave; render
  // + recompute gated by analysisVisible(ui)). The chart is fully derived (shown iff
  // define is open); porkchop/plan are collapsible sub-toggles under define.
  showPorkchop: false,
  porkchop: null,
  porkchopAtReal: 0,
  plan: null,
  chart: null,
  chartAtReal: 0,
  // FLEET: Launch APPENDS immutable snapshots
  missions: [],
  fleetCounters: {},
  fleetSeq: 0,
  elevator: null, // { dRelease, craft }
};

let ctx = null;
let canvas = null;
let chartCtx = null;
let chartCanvas = null;
let pcCtx = null;
let pcCanvas = null;
const CHART_W = 320;
const CHART_H = 90;
const PC_W = 300;
const PC_H = 220;
const SYNODIC = 779.9 * DAY_S; // Earth–Mars synodic — the analysis window width

// ============================================================================
//  DISPATCH — the ONLY path that changes UI mode. reduce → reconcile DOM/imperative.
// ============================================================================
function dispatch(action) {
  const prev = state.ui;
  const next = reduce(prev, action);
  if (next === prev) return; // no-op transition
  state.ui = next;
  applyUi(prev, next);
}

// Reconcile the imperative shell (DOM classes/visibility + the `selected` readout)
// to the new mode. The reducer decided WHAT the state is; this reflects it.
function applyUi(prev, next) {
  if (next.frame !== prev.frame) {
    syncFrameButtons();
    state.selected = frameDesc(next.frame).center; // a fresh frame reads its centre body
  }
  if (next.camera.kind === "body" && next.camera.target !== state.selected) {
    state.selected = next.camera.target; // focusing a body selects it for the HUD
  }
  if (next.workspace !== prev.workspace) applyWorkspace(prev.workspace, next.workspace);
  if (next.playback.playing !== prev.playback.playing) {
    const b = $("btn-play");
    if (b) b.textContent = next.playback.playing ? "❚❚ pause" : "▶ play";
  }
  updateHud();
}

// Reflect the workspace axis: show exactly the one open panel; build/tear-down its
// contents; the sandbox workspace = "armed to place" (crosshair cursor).
function applyWorkspace(prevW, nextW) {
  const defineOpen = nextW === "define";
  const fleetOpen = nextW === "fleet";
  const mp = $("mission-panel");
  if (mp) mp.hidden = !defineOpen;
  $("btn-mission").classList.toggle("active", defineOpen);
  const fp = $("fleet-panel");
  if (fp) fp.hidden = !fleetOpen;
  $("btn-fleet").classList.toggle("active", fleetOpen);
  if (canvas) canvas.classList.toggle("arming", nextW === "sandbox");

  if (defineOpen && prevW !== "define") {
    buildCraftMenu();
    buildDefSelect();
    syncDefineFields();
    buildWaypointEditor();
    buildReturnControl();
    refreshPreview();
    state.chartAtReal = 0; // recompute the metronome for this definition
  }
  if (!defineOpen && prevW === "define") {
    // committed missions draw from the fleet; leaving define drops the preview +
    // the subordinate analysis overlays (they only exist under 'define').
    state.previewRender = null;
    state.showPorkchop = false;
    if (pcCanvas) pcCanvas.hidden = true;
    dismissPlan();
  }
  if (fleetOpen && prevW !== "fleet") buildFleetList();
}

function syncFrameButtons() {
  for (const btn of document.querySelectorAll("[data-frame]")) {
    btn.classList.toggle("active", btn.dataset.frame === state.ui.frame);
  }
}

// ---- manual sandbox spacecraft ----------------------------------------------
function centerOfFrame(frameId) {
  return frameDesc(frameId).center;
}

function placeCraftAt(screenX, screenY) {
  const world = worldAt(state.t);
  const frameClick = state.camera.screenToWorld(screenX, screenY);
  const helio = frameUnmap(state.ui.frame, world)(frameClick);
  const centerKey = centerOfFrame(state.ui.frame);
  const centerHelio = world[centerKey].pos;
  const rRel = sub(helio, centerHelio);
  const radius = mag(rRel);
  if (!(radius > 0)) return;
  const phase = Math.atan2(rRel[1], rRel[0]);
  const mu = centerKey === "sun" ? MU_SUN : MU_EARTH;
  state.craft = {
    def: { centerKey, radius, phase, mu, t0: state.t, dv: { prograde: 0, radial: 0 } },
    obj: null,
  };
  rebuildCraft();
  state.selected = "craft";
  dispatch({ type: "CLOSE_WORKSPACE" }); // placed → disarm (workspace none)
  updateHud();
}

function rebuildCraft() {
  if (!state.craft) return;
  const d = state.craft.def;
  state.craft.obj = craftFromCircular(d.centerKey, d.radius, d.phase, d.dv, d.t0, d.mu);
}

function applyDv(kind, amount) {
  if (!state.craft) return;
  state.craft.def.dv[kind] += amount;
  rebuildCraft();
  updateHud();
}

function clearCraft() {
  state.craft = null;
  if (state.selected === "craft") state.selected = centerOfFrame(state.ui.frame);
  updateHud();
}

// ============================================================================
//  DEFINE — the library of mission definitions (the single source of truth).
// ============================================================================
function selectedDef() {
  return state.definitions.find((d) => d.id === state.selectedDefId) || state.definitions[0] || null;
}

function makeDef(spec) {
  const d = definitionFrom(spec);
  d.id = `def-${++state.defSeq}`;
  return d;
}

function initDefinitions() {
  state.defSeq = 0;
  state.definitions = MISSION_PRESETS.map((p) => makeDef(p)); // deep-copied clones
  state.selectedDefId = state.definitions[0].id;
}

const COURSE_BODIES = ["earth", "mars", "moon"];
const COURSE_MODES = ["orbit", "flyby", "drop"];

// Trajectory-affecting edit → recompute the preview + all analysis views.
function onDefStructural() {
  refreshPreview();
  updateBudgetReadout();
  state.chartAtReal = 0; // chart recomputes for the (possibly new) leg keys next frame
  if (state.showPorkchop) refreshPorkchop(performance.now(), true);
  if (state.plan) refreshPlan();
}
// Readout-only edit (craft Isp/prop/refuel) → preview readout + budget only.
function onDefReadout() {
  refreshPreview();
  updateBudgetReadout();
}

// ---- library controls ----
function buildDefSelect() {
  const sel = $("def-select");
  if (!sel) return;
  sel.textContent = "";
  for (const d of state.definitions) {
    const o = document.createElement("option");
    o.value = d.id;
    o.textContent = d.name || "(unnamed)";
    if (d.id === state.selectedDefId) o.selected = true;
    sel.appendChild(o);
  }
}

function selectDef(id) {
  if (!state.definitions.some((d) => d.id === id)) return;
  state.selectedDefId = id;
  syncDefineFields();
  buildWaypointEditor();
  buildReturnControl();
  onDefStructural();
}

function newDefinition() {
  const d = makeDef({
    name: "New mission",
    waypoints: [{ body: "earth", launchMethod: "from-orbit" }, { body: "mars", mode: "orbit" }],
  });
  state.definitions.push(d);
  state.selectedDefId = d.id;
  buildDefSelect();
  syncDefineFields();
  buildWaypointEditor();
  buildReturnControl();
  onDefStructural();
}

function duplicateDefinition() {
  const src = selectedDef();
  if (!src) return;
  const d = makeDef({ ...src, name: `${src.name} copy` });
  state.definitions.push(d);
  state.selectedDefId = d.id;
  buildDefSelect();
  syncDefineFields();
  buildWaypointEditor();
  buildReturnControl();
  onDefStructural();
}

function renameDefinition(name) {
  const def = selectedDef();
  if (!def) return;
  def.name = name;
  const sel = $("def-select");
  const opt = sel && Array.from(sel.options).find((o) => o.value === def.id);
  if (opt) opt.textContent = name || "(unnamed)"; // in-place, don't rebuild (keep input focus)
}

// ---- config setters (write to the SELECTED definition) ----
function setObjective(obj) {
  const def = selectedDef();
  if (!def) return;
  def.objective = obj;
  def.timing = obj === "fast" ? "leave-now" : "wait-for-window"; // sensible default (still editable)
  syncDefineFields();
  onDefStructural();
}
function setCraftArchetype(id) {
  const a = CRAFT_ARCHETYPES[id];
  const def = selectedDef();
  if (!a || !def) return;
  def.craftId = id;
  def.isp = a.isp;
  def.propFraction = a.propFraction;
  syncDefineFields();
  onDefReadout();
}
function setTiming(v) {
  const def = selectedDef();
  if (!def) return;
  def.timing = v;
  onDefStructural();
}
function setRefuel(v) {
  const def = selectedDef();
  if (!def) return;
  def.refuelInOrbit = v;
  onDefReadout();
}

// ---- per-Mars stay / return control ----
function hasReturnLeg(def) {
  const w = def && def.waypoints;
  if (!w || w.length < 3) return false;
  const origin = w[0].body;
  for (let i = 2; i < w.length; i++) if (w[i].body === origin) return true;
  return false;
}
function buildReturnControl() {
  const def = selectedDef();
  const row = $("return-row");
  if (!row || !def) return;
  const show = hasReturnLeg(def);
  row.hidden = !show;
  if (!show) return;
  const isFixed = def.returnStayDays != null;
  const mode = $("return-mode");
  const days = $("return-days");
  if (mode) mode.value = isFixed ? "fixed" : "window";
  if (days) {
    days.value = isFixed ? def.returnStayDays : 300;
    days.disabled = !isFixed;
  }
}
function setReturnMode(mode) {
  const def = selectedDef();
  if (!def) return;
  if (mode === "fixed") {
    const d = $("return-days");
    def.returnStayDays = d && +d.value >= 0 ? +d.value : 300;
  } else {
    def.returnStayDays = null;
  }
  buildReturnControl();
  onDefStructural();
}
function setReturnDays(n) {
  const def = selectedDef();
  if (!def || def.returnStayDays == null || !(n >= 0)) return;
  def.returnStayDays = n;
  onDefStructural();
}

// ---- waypoint editor (order · mode · departure launch), on the selected def --
function buildWaypointEditor() {
  const host = $("course-waypoints");
  const def = selectedDef();
  if (!host || !def) return;
  host.textContent = "";
  def.waypoints.forEach((wp, i) => {
    const row = document.createElement("div");
    row.className = "wp-row";
    const idx = document.createElement("span");
    idx.className = "wp-idx";
    idx.textContent = `${i + 1}.`;
    row.appendChild(idx);

    const bodySel = document.createElement("select");
    for (const b of COURSE_BODIES) {
      const o = document.createElement("option");
      o.value = b;
      o.textContent = b;
      if (b === wp.body) o.selected = true;
      bodySel.appendChild(o);
    }
    bodySel.addEventListener("change", () => {
      def.waypoints[i].body = bodySel.value;
      buildWaypointEditor(); // the launch menu is body-asymmetric — repopulate
      buildReturnControl();
      onDefStructural();
    });
    row.appendChild(bodySel);

    if (i > 0) {
      const modeSel = document.createElement("select");
      for (const m of COURSE_MODES) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m;
        if (m === (wp.mode || "orbit")) o.selected = true;
        modeSel.appendChild(o);
      }
      modeSel.addEventListener("change", () => {
        def.waypoints[i].mode = modeSel.value;
        onDefStructural();
      });
      row.appendChild(modeSel);
    } else {
      const origin = document.createElement("span");
      origin.className = "wp-origin";
      origin.textContent = "origin";
      row.appendChild(origin);
    }

    // Launch method for the FIRST departure only (the origin). Surface→orbit is
    // paid once leaving the origin; later legs depart the orbit the craft is already
    // in, so their launch method is fixed at from-orbit (0) — shown per-body with the
    // body-asymmetric availability, unavailable methods DISABLED with the reason.
    if (i === 0) {
      const launchSel = document.createElement("select");
      launchSel.className = "wp-launch";
      launchSel.title = "departure launch method (availability is body-asymmetric)";
      for (const m of availableMethods(wp.body)) {
        const o = document.createElement("option");
        o.value = m.id;
        o.textContent = m.label + (m.available ? (m.caveat ? " ◐" : "") : " ✗");
        o.disabled = !m.available;
        o.title = m.available ? m.caveat || m.maturity : m.reason;
        if (m.id === (wp.launchMethod || "chemical")) o.selected = true;
        launchSel.appendChild(o);
      }
      launchSel.addEventListener("change", () => {
        def.waypoints[i].launchMethod = launchSel.value;
        onDefStructural();
      });
      row.appendChild(launchSel);
    }

    const mk = (label, title, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ctrl wp-btn";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", fn);
      return b;
    };
    row.appendChild(mk("▲", "move up", () => moveWaypoint(i, -1)));
    row.appendChild(mk("▼", "move down", () => moveWaypoint(i, 1)));
    row.appendChild(mk("✕", "remove", () => removeWaypoint(i)));
    host.appendChild(row);
  });
}

function addWaypoint() {
  const def = selectedDef();
  if (!def) return;
  def.waypoints.push({ body: "mars", mode: "orbit" });
  buildWaypointEditor();
  buildReturnControl();
  onDefStructural();
}
function removeWaypoint(i) {
  const def = selectedDef();
  if (!def || def.waypoints.length <= 2) return; // keep ≥ 1 leg
  def.waypoints.splice(i, 1);
  buildWaypointEditor();
  buildReturnControl();
  onDefStructural();
}
function moveWaypoint(i, dir) {
  const def = selectedDef();
  if (!def) return;
  const j = i + dir;
  if (j < 0 || j >= def.waypoints.length) return;
  const w = def.waypoints;
  [w[i], w[j]] = [w[j], w[i]];
  buildWaypointEditor();
  buildReturnControl();
  onDefStructural();
}

// ---- craft characteristics + field sync ----
function buildCraftMenu() {
  const sel = $("mission-craft");
  if (!sel || sel.options.length) return; // build once
  for (const id of CRAFT_ORDER) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = CRAFT_ARCHETYPES[id].label;
    sel.appendChild(o);
  }
}
function updateBudgetReadout() {
  const def = selectedDef();
  const bud = $("mission-budget");
  if (bud && def) bud.textContent = `budget ${craftBudget(def.isp, def.propFraction).toFixed(1)} km/s`;
}
function syncDefineFields() {
  const def = selectedDef();
  if (!def) return;
  const set = (id, v) => {
    const el = $(id);
    if (el) el.value = v;
  };
  const name = $("def-name");
  if (name) name.value = def.name || "";
  set("mission-isp", def.isp);
  set("mission-prop", def.propFraction);
  set("mission-craft", def.craftId);
  set("course-timing", def.timing);
  const refuel = $("course-refuel");
  if (refuel) refuel.checked = def.refuelInOrbit;
  updateBudgetReadout();
  for (const b of document.querySelectorAll("[data-objective]")) {
    b.classList.toggle("active", b.dataset.objective === def.objective);
  }
  const sel = $("def-select");
  if (sel) sel.value = def.id;
}

// ---- preview + launch -------------------------------------------------------
// The frame-aware heliocentric arcs for a mission's legs (time-invariant Lambert
// geometry — computed once and reused every frame).
function missionLegs(mission) {
  return mission.legs.map((l) => ({
    pts: transferTrajectory(l.fromKey, l.toKey, l.tDepart, l.tof, worldAt, 96),
    from: l.fromKey,
    to: l.toKey,
    mode: l.mode,
  }));
}

// The live preview of the SELECTED definition "if I launch now": readout + ghost
// arcs. Reflects the def's objective/timing (not a standalone Δv scan).
function refreshPreview() {
  const def = analysisVisible(state.ui) ? selectedDef() : null;
  if (!def) {
    state.previewRender = null;
    return;
  }
  const preview = resolveDefinition(def, state.t, worldAt);
  state.previewRender = { legs: missionLegs(preview) };
  const ro = $("mission-readout");
  if (ro) ro.textContent = formatMission(preview);
}

// Launch: resolve the SELECTED definition to an IMMUTABLE snapshot and APPEND it to
// the fleet (never replaces; editing the def afterward never touches this craft).
function launchMission() {
  const def = selectedDef();
  if (!def) return;
  const mission = resolveDefinition(def, state.t, worldAt);
  const dest = turnaroundKey(def.waypoints).toUpperCase();
  const name = fleetName(def.waypoints, state.fleetCounters[dest] || 0);
  state.fleetCounters[dest] = (state.fleetCounters[dest] || 0) + 1;
  const color = COURSE_PALETTE[state.fleetSeq % COURSE_PALETTE.length];
  state.fleetSeq += 1;
  const id = `m${state.fleetSeq}`;
  state.missions.push({
    id,
    name,
    mission,
    color,
    launchT: state.t,
    legs: missionLegs(mission),
    defName: def.name,
  });
  buildFleetList();
  updateHud();
}

// ============================================================================
//  Analysis VIEWS of the selected definition's first transfer leg (under 'define').
// ============================================================================
function analysisKeys() {
  const def = selectedDef();
  return def ? firstLegKeys(def) : null;
}

function refreshChart(nowReal) {
  if (!analysisVisible(state.ui)) return;
  const keys = analysisKeys();
  if (!keys) return;
  const fresh = state.chart && state.chart.from === keys.from && state.chart.to === keys.to;
  if (fresh && nowReal - state.chartAtReal < 400) return;
  const t0 = state.t - 500 * DAY_S;
  const t1 = state.t + 1900 * DAY_S;
  const series = dvSeries(keys.from, keys.to, t0, t1, 96, worldAt);
  state.chart = { series, minima: seriesMinima(series), t0, t1, from: keys.from, to: keys.to };
  state.chartAtReal = nowReal;
}

function togglePorkchop() {
  state.showPorkchop = !state.showPorkchop;
  if (pcCanvas) pcCanvas.hidden = !state.showPorkchop;
  if (state.showPorkchop) refreshPorkchop(performance.now(), true);
  syncAnalysisButtons();
}

function refreshPorkchop(nowReal, force) {
  if (!state.showPorkchop) return;
  if (!force && state.porkchop && nowReal - state.porkchopAtReal < 500) return;
  const keys = analysisKeys();
  if (!keys) return;
  const pinned = state.porkchop && state.porkchop.pinned;
  const depWindow = pinned ? state.porkchop.depWindow : [state.t - 120 * DAY_S, state.t + SYNODIC];
  const arrWindow = pinned
    ? state.porkchop.arrWindow
    : [state.t + 120 * DAY_S, state.t + SYNODIC + 420 * DAY_S];
  const pc = porkchop({
    fromKey: keys.from,
    toKey: keys.to,
    depWindow,
    arrWindow,
    resolution: 44,
    bodyAt: worldAt,
  });
  state.porkchop = { pc, depWindow, arrWindow, pinned };
  state.porkchopAtReal = nowReal;
}

function refreshPlan() {
  const keys = analysisKeys();
  if (!keys) return;
  const plan = planEfficientLaunch(keys.from, keys.to, state.t, worldAt);
  state.plan = plan;
  const pc = plan.porkchop;
  state.showPorkchop = true;
  if (pcCanvas) pcCanvas.hidden = false;
  state.porkchop = {
    pc,
    depWindow: [pc.depAxis[0], pc.depAxis[pc.depAxis.length - 1]],
    arrWindow: [pc.arrAxis[0], pc.arrAxis[pc.arrAxis.length - 1]],
    pinned: true,
  };
  const card = $("plan-card");
  if (card) {
    card.textContent = formatPlan(plan);
    card.hidden = false;
  }
  syncAnalysisButtons();
}
function togglePlan() {
  if (state.plan) dismissPlan();
  else refreshPlan();
}
function dismissPlan() {
  state.plan = null;
  if (state.porkchop) state.porkchop.pinned = false;
  const card = $("plan-card");
  if (card) card.hidden = true;
  syncAnalysisButtons();
}
function syncAnalysisButtons() {
  const pk = $("btn-porkchop");
  if (pk) pk.classList.toggle("active", state.showPorkchop);
  const pl = $("btn-plan");
  if (pl) pl.classList.toggle("active", !!state.plan);
}

// ============================================================================
//  FLEET — the active-missions monitor.
// ============================================================================
const bodyName = (k) => (worldAt(0)[k] ? k[0].toUpperCase() + k.slice(1) : k);

function fleetStatusText(mission, st) {
  if (st.phase === "prelaunch") return "pre-launch";
  if (st.phase === "arrived") {
    const last = mission.legs[mission.legs.length - 1];
    return `arrived ${bodyName(last.toKey)}`;
  }
  const leg = mission.legs[st.legIndex];
  if (!leg) return st.phase;
  if (st.phase === "waiting") return `waiting at ${bodyName(leg.fromKey)}`;
  return `coasting · ${bodyName(leg.fromKey)}→${bodyName(leg.toKey)}`;
}

function fleetEtaDays(mission, t) {
  for (const leg of mission.legs) {
    if (leg.tArrive > t) return (leg.tArrive - t) / DAY_S;
  }
  return null;
}

function buildFleetList() {
  const host = $("fleet-list");
  if (!host) return;
  host.textContent = "";
  if (!state.missions.length) {
    const empty = document.createElement("div");
    empty.className = "fleet-empty";
    empty.textContent = "no active missions — define one and hit Launch.";
    host.appendChild(empty);
    return;
  }
  for (const fm of state.missions) {
    const row = document.createElement("div");
    row.className = "fleet-row";
    row.dataset.fleetId = fm.id;

    const head = document.createElement("div");
    head.className = "fleet-head";
    const sw = document.createElement("span");
    sw.className = "fleet-sw";
    sw.style.background = fm.color;
    const name = document.createElement("span");
    name.className = "fleet-name";
    name.textContent = fm.name;
    head.appendChild(sw);
    head.appendChild(name);
    row.appendChild(head);

    for (const cls of ["fleet-status", "fleet-time", "fleet-dv"]) {
      const el = document.createElement("div");
      el.className = cls;
      row.appendChild(el);
    }

    const actions = document.createElement("div");
    actions.className = "fleet-actions";
    const follow = document.createElement("button");
    follow.type = "button";
    follow.className = "ctrl fleet-btn fleet-follow";
    follow.textContent = "follow";
    follow.classList.toggle("active", isFollowing(fm.id));
    follow.addEventListener("click", () => toggleFollow(fm.id));
    const recall = document.createElement("button");
    recall.type = "button";
    recall.className = "ctrl fleet-btn";
    recall.textContent = "recall";
    recall.addEventListener("click", () => recallFleetMission(fm.id));
    actions.appendChild(follow);
    actions.appendChild(recall);
    row.appendChild(actions);

    host.appendChild(row);
  }
  refreshFleetStatuses();
}

// Per-frame text refresh (cheap): status/ETA, travel-time (total + elapsed), Δv.
function refreshFleetStatuses() {
  if (state.ui.workspace !== "fleet") return;
  for (const fm of state.missions) {
    const row = document.querySelector(`[data-fleet-id="${fm.id}"]`);
    if (!row) continue;
    const m = fm.mission;
    const st = missionStateAt(m, state.t);
    // countdown to the NEXT departure while parked (prelaunch = the first launch
    // window; waiting = the next leg after a stay), else the arrival ETA.
    let etaStr;
    if (st.phase === "prelaunch" && m.legs[0]) {
      etaStr = ` · launch in ${Math.max(0, (m.legs[0].tDepart - state.t) / DAY_S).toFixed(0)} d`;
    } else if (st.phase === "waiting" && m.legs[st.legIndex]) {
      etaStr = ` · departs in ${Math.max(0, (m.legs[st.legIndex].tDepart - state.t) / DAY_S).toFixed(0)} d`;
    } else {
      const eta = fleetEtaDays(m, state.t);
      etaStr = eta != null ? ` · arr in ${eta.toFixed(0)} d` : " · —";
    }
    const s = row.querySelector(".fleet-status");
    if (s) s.textContent = fleetStatusText(m, st) + etaStr;
    const time = row.querySelector(".fleet-time");
    if (time) {
      const elapsed = Math.max(0, (state.t - fm.launchT) / DAY_S);
      time.textContent = `duration ${m.course.totalDurationDays.toFixed(0)} d · elapsed ${elapsed.toFixed(0)} d`;
    }
    const dv = row.querySelector(".fleet-dv");
    if (dv) {
      dv.textContent = `Δv ${m.requiredDv.toFixed(1)}/${m.budget.toFixed(1)} ${m.feasible ? "✓" : "✗"}`;
      dv.classList.toggle("infeasible", !m.feasible);
    }
    const f = row.querySelector(".fleet-follow");
    if (f) f.classList.toggle("active", isFollowing(fm.id));
  }
}

const isFollowing = (id) => state.ui.camera.kind === "follow" && state.ui.camera.target === id;

function toggleFollow(id) {
  dispatch(isFollowing(id) ? { type: "UNFOLLOW" } : { type: "FOLLOW_CRAFT", id });
  refreshFleetStatuses();
}
function recallFleetMission(id) {
  if (isFollowing(id)) dispatch({ type: "UNFOLLOW" }); // followed craft gone → drop follow
  state.missions = state.missions.filter((m) => m.id !== id);
  buildFleetList();
  updateHud();
}
function clearFleet() {
  if (state.ui.camera.kind === "follow") dispatch({ type: "UNFOLLOW" });
  state.missions = [];
  buildFleetList();
  updateHud();
}

// ---- lunar elevator (a sub-tool inside 'define') ----------------------------
function toggleElevator() {
  if (state.elevator) {
    state.elevator = null;
  } else {
    state.elevator = { dRelease: 58000, craft: null };
    if (state.ui.frame !== "em-syn") dispatch({ type: "SELECT_FRAME", frame: "em-syn" });
  }
  $("btn-elevator").classList.toggle("active", !!state.elevator);
  updateHud();
}

function releasePayload() {
  if (!state.elevator) return;
  const world = worldAt(state.t);
  state.elevator.craft = elevatorPayloadCraft(world, state.elevator.dRelease, state.t);
  // The strut is a synodic-frame structure; a RELEASED payload is inertial. In the
  // rotating em-syn frame its eccentric orbit whips near perigee / swings wide (reads
  // as "too fast"); geocentric (inertial) shows its true pace. Let go, you're inertial.
  if (state.ui.frame === "em-syn") dispatch({ type: "SELECT_FRAME", frame: "geo" });
  updateHud();
}

// ---- HUD (formatting lives in hud.js; app only snapshots state → text) -------
function updateHud() {
  const el = $("hud");
  if (!el) return;
  const view = {
    toId: state.ui.frame,
    t: state.t,
    rate: state.ui.playback.rate,
    playing: state.ui.playback.playing,
    cameraScale: state.camera.scale,
    selected: state.selected,
    craft: state.craft,
    elevator: state.elevator,
  };
  el.textContent = formatHud(view, worldAt(state.t));
}

// The desired camera for the current mode — the ONE owner of the camera target.
// manual → the user owns it (no drive). follow → the craft's live position (centre
// driven, zoom preserved). body → a focused body. fit → the frame fit.
function cameraTarget(ui, world) {
  const c = ui.camera;
  if (c.kind === "manual") return null;
  if (c.kind === "follow") {
    const fm = state.missions.find((m) => m.id === c.target);
    if (!fm) return null;
    return desiredCameraAt(ui.frame, world, missionStateAt(fm.mission, state.t).pos, state.camera);
  }
  if (c.kind === "body") return desiredCamera(ui.frame, world, c.target, state.camera);
  return desiredCamera(ui.frame, world, null, state.camera); // fit
}

// ---- RAF loop ---------------------------------------------------------------
let lastReal = 0;
function frame(now) {
  if (!lastReal) lastReal = now;
  const dtReal = Math.min((now - lastReal) / 1000, 0.1); // clamp big gaps
  lastReal = now;

  if (state.ui.playback.playing) state.t += state.ui.playback.rate * dtReal;

  const world = worldAt(state.t);

  // analysis views of the selected definition (throttled recompute)
  refreshChart(now);
  refreshPorkchop(now, false);

  // a followed craft that no longer exists → drop the follow (defined transition)
  if (state.ui.camera.kind === "follow" && !state.missions.some((m) => m.id === state.ui.camera.target)) {
    dispatch({ type: "UNFOLLOW" });
  }

  // Each committed mission's active leg (the one its craft is currently flying).
  const fleetScene = state.missions.map((fm) => {
    const st = missionStateAt(fm.mission, state.t);
    // days to the next departure while parked — the on-canvas launch countdown
    let countdown = null;
    if (st.phase === "prelaunch" && fm.mission.legs[0]) {
      countdown = (fm.mission.legs[0].tDepart - state.t) / DAY_S;
    } else if (st.phase === "waiting" && fm.mission.legs[st.legIndex]) {
      countdown = (fm.mission.legs[st.legIndex].tDepart - state.t) / DAY_S;
    }
    return {
      mission: fm.mission,
      legs: fm.legs,
      color: fm.color,
      name: fm.name,
      activeLeg: st.legIndex,
      countdown,
      selected: isFollowing(fm.id),
    };
  });

  // Camera convergence on the LIVE target — recomputed every frame (never a
  // snapshot), so it can't ease toward a stale point or need a terminal jump. The
  // mode (fit / body / follow / manual) is the single owner.
  const desired = cameraTarget(state.ui, world);
  if (desired) {
    if (state.reducedMotion) state.camera.snapTo(desired);
    else state.camera.easeToward(desired, dtReal, 7);
  }

  const scene = {
    world,
    camera: state.camera,
    t: state.t,
    toId: state.ui.frame,
    selected: state.selected,
    craft: state.craft ? state.craft.obj : null,
    preview: analysisVisible(state.ui) ? state.previewRender : null, // uncommitted "launch now" arcs
    fleet: fleetScene, // every committed mission: course + flying craft
    elevator: state.elevator,
    showLagrange: true,
  };
  try {
    render(ctx, scene);
  } catch (err) {
    console.error("[delta-v-sim] render error", err); // never let a draw error kill the loop
  }
  if (analysisVisible(state.ui) && chartCtx && state.chart) {
    try {
      const finite = state.chart.series.map((p) => p.dv).filter((v) => isFinite(v));
      const floor = finite.length ? Math.min(...finite) : 2.945;
      drawDvChart(chartCtx, {
        series: state.chart.series,
        minima: state.chart.minima,
        now: state.t,
        floor,
        cap: floor * 4,
        w: CHART_W,
        h: CHART_H,
      });
    } catch {
      /* chart is decorative — never fatal */
    }
  }
  if (state.showPorkchop && pcCtx && state.porkchop) {
    try {
      drawPorkchop(pcCtx, { pc: state.porkchop.pc, now: state.t, cap: 6, w: PC_W, h: PC_H });
    } catch {
      /* porkchop is decorative — never fatal */
    }
  }
  if (state.ui.workspace === "fleet") refreshFleetStatuses(); // live status/ETA/Δv
  if (state.ui.playback.playing || state.ui.camera.kind !== "manual") updateHud();
  requestAnimationFrame(frame);
}

// ---- interaction ------------------------------------------------------------
function wireCanvas() {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let moved = 0;

  canvas.addEventListener("pointerdown", (ev) => {
    dragging = true;
    moved = 0;
    lastX = ev.clientX;
    lastY = ev.clientY;
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!dragging) {
      // hover tooltip: hit-test the marks render drew (only VISIBLE ones)
      const rect = canvas.getBoundingClientRect();
      showTooltip(pickMark(ev.clientX - rect.left, ev.clientY - rect.top), ev.clientX, ev.clientY);
      return;
    }
    const dx = ev.clientX - lastX;
    const dy = ev.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    lastX = ev.clientX;
    lastY = ev.clientY;
    state.camera.panByPixels(dx, dy); // imperative camera move
    if (moved > 4) dispatch({ type: "PAN" }); // → camera 'manual' (drops fit/follow)
  });
  canvas.addEventListener("pointerleave", () => showTooltip(null));
  canvas.addEventListener("pointerup", (ev) => {
    dragging = false;
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    if (state.ui.workspace === "sandbox" && moved < 5) {
      placeCraftAt(sx, sy);
    } else if (moved < 5) {
      pickBodyAt(sx, sy);
    }
  });
  canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = Math.pow(1.0015, -ev.deltaY);
      state.camera.zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, factor); // imperative
      // then the DEFINED zoom transition: a pinned/rotating frame past its threshold
      // cascades UP to heliocentric (the Sun disc appears — the stranded-Sun fix);
      // otherwise a translation frame stays and the camera releases to 'manual'
      // (unless following, where zoom stays user-controlled).
      const effScale = state.camera.scale * frameScaleFactor(state.ui.frame, worldAt(state.t));
      dispatch({ type: "ZOOM", effScale });
      updateHud();
    },
    { passive: false },
  );
}

// Hover tooltip: shows an entity's one-line blurb (from the registry) at the
// cursor. Called with the id render reported for the mark under the pointer.
function showTooltip(id, clientX, clientY) {
  const tip = $("tooltip");
  if (!tip) return;
  const blurb = id ? describe(id).blurb : "";
  if (!blurb) {
    tip.hidden = true;
    return;
  }
  tip.textContent = blurb;
  tip.style.left = clientX + 14 + "px";
  tip.style.top = clientY + 14 + "px";
  tip.hidden = false;
}

function pickBodyAt(sx, sy) {
  const world = worldAt(state.t);
  const map = frameMap(state.ui.frame, world);
  let best = null;
  let bestD = 22; // px pick radius
  for (const key of ["sun", "earth", "moon", "mars", "phobos", "deimos"]) {
    if (!world[key]) continue;
    const s = state.camera.worldToScreen(map(world[key].pos));
    const d = Math.hypot(s[0] - sx, s[1] - sy);
    if (d < bestD) {
      bestD = d;
      best = key;
    }
  }
  if (best) {
    state.selected = best;
    dispatch({ type: "FOCUS_BODY", key: best }); // camera → body(best); supersedes follow
  }
}

// ---- controls ---------------------------------------------------------------
function wireControls() {
  for (const btn of document.querySelectorAll("[data-frame]")) {
    btn.addEventListener("click", () => dispatch({ type: "SELECT_FRAME", frame: btn.dataset.frame }));
  }
  $("btn-play").addEventListener("click", () => {
    dispatch({ type: state.ui.playback.playing ? "PAUSE" : "PLAY" });
  });
  $("btn-step-back").addEventListener("click", () => {
    state.t -= DAY_S; // the clock is DOMAIN data (not a UI-mode transition)
    updateHud();
  });
  $("btn-step-fwd").addEventListener("click", () => {
    state.t += DAY_S;
    updateHud();
  });
  $("btn-reset-time").addEventListener("click", () => {
    state.t = 0;
    dispatch({ type: "RESET_T" }); // identity on ui; the clock reset is imperative
    updateHud();
  });
  const rate = $("rate");
  const minR = Math.log(3600); // 1 h/s
  const maxR = Math.log(YEAR_S); // 1 yr/s
  const applyRate = () => {
    const frac = +rate.value / 1000;
    dispatch({ type: "SET_RATE", rate: Math.exp(minR + frac * (maxR - minR)) });
    updateHud();
  };
  rate.addEventListener("input", applyRate);
  applyRate();

  $("btn-fit").addEventListener("click", () => dispatch({ type: "FIT" }));

  // sandbox: manual craft placement + Δv (arming = workspace 'sandbox')
  $("btn-add-craft").addEventListener("click", () => dispatch({ type: "OPEN_WORKSPACE", workspace: "sandbox" }));
  $("btn-clear-craft").addEventListener("click", clearCraft);
  $("dv-pro-plus").addEventListener("click", () => applyDv("prograde", dvStep()));
  $("dv-pro-minus").addEventListener("click", () => applyDv("prograde", -dvStep()));
  $("dv-rad-plus").addEventListener("click", () => applyDv("radial", dvStep()));
  $("dv-rad-minus").addEventListener("click", () => applyDv("radial", -dvStep()));

  // DEFINE + LAUNCH + FLEET (workspace axis)
  $("btn-mission").addEventListener("click", () => dispatch({ type: "TOGGLE_WORKSPACE", workspace: "define" }));
  $("btn-fleet").addEventListener("click", () => dispatch({ type: "TOGGLE_WORKSPACE", workspace: "fleet" }));
  $("btn-fleet-clear").addEventListener("click", clearFleet);

  // definition library
  $("def-select").addEventListener("change", (e) => selectDef(e.target.value));
  $("def-name").addEventListener("input", (e) => renameDefinition(e.target.value));
  $("btn-def-new").addEventListener("click", newDefinition);
  $("btn-def-dup").addEventListener("click", duplicateDefinition);

  // definition config
  for (const b of document.querySelectorAll("[data-objective]")) {
    b.addEventListener("click", () => setObjective(b.dataset.objective));
  }
  $("course-timing").addEventListener("change", (e) => setTiming(e.target.value));
  $("mission-craft").addEventListener("change", (e) => setCraftArchetype(e.target.value));
  $("mission-isp").addEventListener("input", (e) => {
    const v = +e.target.value;
    const def = selectedDef();
    if (def && v > 0) def.isp = v;
    onDefReadout();
  });
  $("mission-prop").addEventListener("input", (e) => {
    const v = +e.target.value;
    const def = selectedDef();
    if (def && v > 0 && v < 1) def.propFraction = v;
    onDefReadout();
  });
  $("course-refuel").addEventListener("change", (e) => setRefuel(e.target.checked));
  $("btn-add-wp").addEventListener("click", addWaypoint);
  $("return-mode").addEventListener("change", (e) => setReturnMode(e.target.value));
  $("return-days").addEventListener("input", (e) => setReturnDays(+e.target.value));
  $("btn-launch").addEventListener("click", launchMission);

  // analysis views (of the selected definition)
  $("btn-porkchop").addEventListener("click", togglePorkchop);
  $("btn-plan").addEventListener("click", togglePlan);
  const planCard = $("plan-card");
  if (planCard) planCard.addEventListener("click", dismissPlan);

  // launch infrastructure — the lunar elevator (a sub-tool inside 'define')
  $("btn-elevator").addEventListener("click", toggleElevator);
  const elev = $("elev-d");
  elev.addEventListener("input", () => {
    if (!state.elevator) return;
    state.elevator.dRelease = +elev.value;
    $("elev-d-label").textContent = `${(+elev.value).toLocaleString("en-US")} km`;
    updateHud();
  });
  $("btn-release").addEventListener("click", releasePayload);
}

function dvStep() {
  const v = parseFloat($("dv-step").value);
  return isFinite(v) && v !== 0 ? v : 0.25;
}

// ---- selftest badge ---------------------------------------------------------
function maybeSelftest() {
  const params = new URLSearchParams(location.search);
  if (params.get("selftest") !== "1") return;
  const { pass, results } = runSelftest();
  const badge = $("selftest-badge");
  if (badge) {
    badge.hidden = false;
    badge.textContent = `SELFTEST ${pass ? "PASS" : "FAIL"} (${results.filter((r) => r.ok).length}/${results.length})`;
    badge.classList.toggle("pass", pass);
    badge.classList.toggle("fail", !pass);
  }
  console.log(`[delta-v-sim] selftest ${pass ? "PASS" : "FAIL"}`);
  for (const r of results) {
    console.log(`  [${r.ok ? "ok  " : "FAIL"}] ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }
}

// ---- resize -----------------------------------------------------------------
function resize() {
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  state.camera.resize(w, h);
}

function resizeChart() {
  if (!chartCanvas || !chartCtx) return;
  const dpr = window.devicePixelRatio || 1;
  chartCanvas.width = Math.round(CHART_W * dpr);
  chartCanvas.height = Math.round(CHART_H * dpr);
  chartCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function resizePorkchop() {
  if (!pcCanvas || !pcCtx) return;
  const dpr = window.devicePixelRatio || 1;
  pcCanvas.width = Math.round(PC_W * dpr);
  pcCanvas.height = Math.round(PC_H * dpr);
  pcCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ---- boot -------------------------------------------------------------------
function boot() {
  canvas = $("view");
  if (!canvas || !canvas.getContext) return;
  ctx = canvas.getContext("2d");
  chartCanvas = $("dv-chart");
  if (chartCanvas && chartCanvas.getContext) {
    chartCtx = chartCanvas.getContext("2d");
    resizeChart();
  }
  pcCanvas = $("porkchop");
  if (pcCanvas && pcCanvas.getContext) {
    pcCtx = pcCanvas.getContext("2d");
    resizePorkchop();
  }
  state.ui = { ...INITIAL, camera: { ...INITIAL.camera }, playback: { ...INITIAL.playback } };
  state.camera = new Camera(canvas.clientWidth || 800, canvas.clientHeight || 600);
  state.reducedMotion = !!(
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  initDefinitions();
  resize();
  window.addEventListener("resize", resize);
  // Snap to the initial frame so the first paint is framed; then live tracking (fit).
  state.camera.snapTo(desiredCamera(state.ui.frame, worldAt(0), null, state.camera));
  syncFrameButtons();
  wireCanvas();
  wireControls();
  maybeSelftest();
  updateHud();
  requestAnimationFrame(frame);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
}
