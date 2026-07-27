// scene.js — the VIEW-MODEL seam. `buildScene` is a PURE function (world + domain
// state) → the flat `Scene` object render.js paints. It is the ONE place mission
// physics is resolved for drawing: each fleet entry's live craft state (position +
// phase) is computed HERE via missionStateAt and handed to render as data, so
// render.js imports NO physics and never re-derives what the loop already knew.
//
// Before this module, app.js assembled the scene inline AND render.js independently
// re-ran missionStateAt for the same mission at the same t — the render→physics
// back-channel the design (R3/R4, 2026-07-24) removes. DOM-free; node-importable;
// snapshot-tested in __tests__/.

import { missionStateAt } from "./mission.js";
import { DAY_S } from "./sim.js";
import { STRUCTURES, STRUCTURE_IDS } from "./structures.js";

// A legible glyph per structure kind — the ONLY job is to make a surface launch /
// skyhook throw READABLE (observe, not manage; see the sim/game split note). A
// launch badge is a fact you watch, never a resource you tend.
const LAUNCH_GLYPH = { track: "⚡", tether: "✦", strut: "⇡" };

// The launch STRUCTURE a mission departs its origin with, as a legible badge, or
// null for a plain chemical / from-orbit departure (which get no badge). This is
// how the sim makes it CLEAR a structure launch is happening: the fleet marks the
// craft and render shows the badge at the launch (prelaunch + the first leg).
export function launchBadge(mission) {
  const l0 = mission && mission.legs && mission.legs[0];
  if (!l0 || !STRUCTURE_IDS.includes(l0.launchMethod)) return null;
  const s = STRUCTURES[l0.launchMethod];
  return { id: s.id, label: s.label, kind: s.kind, glyph: LAUNCH_GLYPH[s.kind] || "▸", host: s.hostBody };
}

// One committed mission → its render-ready entry. `craftState` is the live
// {pos, vel, phase, legIndex} from missionStateAt (the ONLY missionStateAt call in
// the draw path). `activeLeg` is that same legIndex (leg styling); `countdown` is
// days to the next departure while parked (prelaunch = first window, waiting = next
// leg), else null. `selected` = is this the followed mission.
export function fleetEntry(fm, t, followId) {
  const st = missionStateAt(fm.mission, t);
  let countdown = null;
  if (st.phase === "prelaunch" && fm.mission.legs[0]) {
    countdown = (fm.mission.legs[0].tDepart - t) / DAY_S;
  } else if (st.phase === "waiting" && fm.mission.legs[st.legIndex]) {
    countdown = (fm.mission.legs[st.legIndex].tDepart - t) / DAY_S;
  }
  return {
    mission: fm.mission,
    legs: fm.legs,
    color: fm.color,
    name: fm.name,
    craftState: st,
    activeLeg: st.legIndex,
    countdown,
    launch: launchBadge(fm.mission), // the origin launch structure (or null) — legibility
    selected: fm.id === followId,
  };
}

export function buildFleetScene(missions, t, followId) {
  return (missions || []).map((fm) => fleetEntry(fm, t, followId));
}

// The full Scene for one RAF frame. All inputs are plain values (no ui/DOM): the
// caller resolves which craft is followed (followId) and whether the preview is
// live (preview already gated). `toId` is the active frame id — the name render.js
// reads. Pure: same inputs → same Scene.
export function buildScene({
  world,
  camera,
  t,
  frameId,
  selected,
  craftObj = null,
  preview = null,
  missions = [],
  elevator = null,
  followId = null,
  showLagrange = true,
}) {
  return {
    world,
    camera,
    t,
    toId: frameId,
    selected,
    craft: craftObj,
    preview,
    fleet: buildFleetScene(missions, t, followId),
    elevator,
    showLagrange,
  };
}
