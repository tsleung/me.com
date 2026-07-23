// mission.js — a COMMITTED, time-evolving craft flying a course. "Launch" commits
// a craft to a plan (it flies the arc as t advances); it is NOT a fourth preview
// mode next to live/pin/both (those are transfer-geometry ghosts). Reuses
// plan.js / transfer.js / spacecraft.js / infra.js — no duplicated math.
// Pure/DOM-free.

import { worldAt } from "./sim.js";
import { craftStateAt } from "./spacecraft.js";
import { transferConic } from "./transfer.js";
import { planCourse } from "./plan.js";

// ---- craft characteristics → Δv budget (rocket equation) --------------------
// Impulsive sim, so the only characteristic that bites is the Δv the craft can
// carry: budget = Isp · g0 · ln(1/(1−propFraction)). g0 in km/s².
export const G0 = 9.80665e-3; // km/s²
export function craftBudget(isp, propFraction) {
  if (!(isp > 0) || !(propFraction > 0) || propFraction >= 1) return 0;
  return isp * G0 * Math.log(1 / (1 - propFraction));
}

// Named archetypes (editable Isp + propFraction — the user "picks the
// characteristics"). Isp ranges cited in process.md.
export const CRAFT_ARCHETYPES = {
  "chemical-tug": { label: "chemical tug", isp: 350, propFraction: 0.9 }, // ~7.9 km/s
  "nuclear-shuttle": { label: "nuclear shuttle", isp: 900, propFraction: 0.7 }, // ~10.6 km/s
  // ion: the impulsive model overstates low-thrust practicality (a real ion craft
  // spirals for years and can't fly these ballistic arcs) — flagged in the HUD.
  "ion-freighter": { label: "ion freighter", isp: 3000, propFraction: 0.6 }, // ~27 km/s
};

export const CRAFT_ORDER = ["chemical-tug", "nuclear-shuttle", "ion-freighter"];

// ---- fleet naming: <DEST>-<n> -----------------------------------------------
// A fleet auto-names each launch after its TURNAROUND (the farthest waypoint —
// the point of the trip), not the last waypoint (which, on a round trip, is the
// origin). "Reach" ranks how far out a body sits: the Moon is a short hop, Mars
// the deep target — so Earth→Mars→Earth turns around at Mars ⇒ "MARS-n".
export const DEST_REACH = { moon: 0.5, earth: 1, mars: 2 };
export function turnaroundKey(waypoints) {
  if (!waypoints || !waypoints.length) return "earth";
  let best = waypoints[0].body;
  let bestR = -Infinity;
  for (let i = 1; i < waypoints.length; i++) {
    const r = DEST_REACH[waypoints[i].body] != null ? DEST_REACH[waypoints[i].body] : 0;
    if (r > bestR) {
      bestR = r;
      best = waypoints[i].body;
    }
  }
  return best;
}
// The next fleet name for a course, given how many craft already share its DEST.
// priorCount = current per-dest counter (0 ⇒ first) → "<DEST>-<priorCount+1>".
export function fleetName(waypoints, priorCount = 0) {
  return `${turnaroundKey(waypoints).toUpperCase()}-${priorCount + 1}`;
}

// ---- mission DEFINITIONS — the "define" layer (specs, before launch) ---------
// A definition is an editable SPEC (session-only library, no persistence). Launch
// resolves it to an immutable Mission snapshot; editing the def afterward never
// touches already-launched craft (resolveDefinition deep-copies the waypoints +
// craft, so the snapshot is fully detached). Ships with two presets.
export function definitionFrom({
  name,
  waypoints,
  objective = "efficient",
  timing = "wait-for-window",
  craftId = "nuclear-shuttle",
  refuelInOrbit = true,
  returnStayDays = null,
}) {
  const a = CRAFT_ARCHETYPES[craftId] || CRAFT_ARCHETYPES["nuclear-shuttle"];
  return {
    name,
    waypoints: waypoints.map((w) => ({ ...w })),
    objective,
    timing,
    craftId,
    isp: a.isp,
    propFraction: a.propFraction,
    refuelInOrbit,
    returnStayDays,
  };
}

// The round-trip is the DEFAULT (first) — a conjunction-class Earth→Mars→Earth is
// the headline mission; the one-way is the simpler second option.
export const MISSION_PRESETS = [
  definitionFrom({
    name: "Earth → Mars → Earth",
    waypoints: [
      { body: "earth", launchMethod: "from-orbit" },
      { body: "mars", mode: "orbit" },
      { body: "earth", mode: "orbit" },
    ],
  }),
  definitionFrom({
    name: "Earth → Mars",
    waypoints: [{ body: "earth", launchMethod: "from-orbit" }, { body: "mars", mode: "orbit" }],
  }),
];

// The from/to of a definition's FIRST transfer leg — what the analysis views
// (preview arcs, porkchop, Δv-budget plan, metronome chart) key off, instead of a
// hardcoded earth→mars. A single-waypoint def has no leg → null.
export function firstLegKeys(def) {
  const wps = def && def.waypoints;
  if (!wps || wps.length < 2) return null;
  return { from: wps[0].body, to: wps[1].body };
}

// Resolve a definition to a committed Mission at a launch epoch. Deep-copies the
// spec so the snapshot is immutable w.r.t. later edits of the definition.
export function resolveDefinition(def, launchTime = 0, bodyAt = worldAt) {
  return makeMission({
    waypoints: def.waypoints.map((w) => ({ ...w })),
    objective: def.objective,
    timing: def.timing,
    craft: {
      isp: def.isp,
      propFraction: def.propFraction,
      label: (CRAFT_ARCHETYPES[def.craftId] && CRAFT_ARCHETYPES[def.craftId].label) || "custom",
    },
    launchTime,
    assumptions: { refuelInOrbit: def.refuelInOrbit, returnStayDays: def.returnStayDays, bodyAt },
    bodyAt,
  });
}

// ---- makeMission — commit a craft to a course -------------------------------
// craft = { isp, propFraction, label? }. objective: "efficient"|"fast". timing:
// "wait-for-window"|"leave-now" (default follows objective: efficient→at-window,
// fast→now). launchTime = when the craft leaves (t=0 default). requiredDv links
// the launch-infra knob to feasibility: launchCost is surface→orbit AFTER infra.
export function makeMission({
  waypoints,
  objective = "efficient",
  timing,
  craft,
  launchTime = 0,
  assumptions = {},
  bodyAt = worldAt,
}) {
  const tmg = timing || (objective === "fast" ? "leave-now" : "wait-for-window");
  const course = planCourse({
    waypoints,
    startTime: launchTime,
    assumptions: { ...assumptions, bodyAt, objective, returnTiming: tmg },
  });

  const legs = course.legs.map((l) => ({
    fromKey: l.from,
    toKey: l.to,
    mode: l.mode,
    tDepart: l.depTime,
    tArrive: l.arrTime,
    tof: l.tof,
    helioConic: transferConic(l.from, l.to, l.depTime, l.tof, bodyAt), // primary = Sun
    transferDv: l.transferDv,
    captureDv: l.waypointDv,
    launchMethod: l.launch ? l.launch.method : "chemical",
    launchCost: l.launch ? l.launch.surfaceToOrbit : 0, // surface→orbit AFTER infra
  }));

  const inSpaceDv = legs.reduce((s, l) => s + l.transferDv + l.captureDv, 0);
  const launchCost = legs.reduce((s, l) => s + l.launchCost, 0);
  const requiredDv = inSpaceDv + launchCost;
  const budget = craft ? craftBudget(craft.isp, craft.propFraction) : 0;
  const feasible = budget >= requiredDv;

  // where the tank runs dry: first leg whose cumulative required Δv exceeds budget
  let cum = 0;
  let runsDryLeg = -1;
  for (let i = 0; i < legs.length; i++) {
    cum += legs[i].launchCost + legs[i].transferDv + legs[i].captureDv;
    if (cum > budget && runsDryLeg < 0) runsDryLeg = i;
  }

  return {
    waypoints,
    objective,
    timing: tmg,
    craft,
    launchTime,
    bodyAt,
    course,
    legs,
    inSpaceDv,
    launchCost,
    requiredDv,
    budget,
    feasible,
    runsDryLeg,
  };
}

// ---- missionStateAt — where the craft is at sim-time t ----------------------
// Piecewise + continuous by construction (Lambert targets the arrival body's
// position at tArrive): prelaunch → parked on the departure body; coasting →
// craftStateAt on the leg's helio conic; waiting → parked on the waypoint body
// (stay/refuel); arrived → parked on the final body.
export function missionStateAt(mission, t) {
  const legs = mission.legs;
  const at = mission.bodyAt || worldAt;
  const originKey = mission.waypoints && mission.waypoints[0] ? mission.waypoints[0].body : "earth";
  if (!legs.length) {
    const b = at(t)[originKey];
    return { pos: b.pos, vel: b.vel, phase: "prelaunch", legIndex: -1, dvSpent: 0 };
  }
  if (t < legs[0].tDepart) {
    const b = at(t)[legs[0].fromKey];
    return { pos: b.pos, vel: b.vel, phase: "prelaunch", legIndex: -1, dvSpent: 0 };
  }
  let dvSpent = 0;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (t < leg.tDepart) {
      // between the previous arrival and this departure → parked (stay/refuel)
      const b = at(t)[leg.fromKey];
      return { pos: b.pos, vel: b.vel, phase: "waiting", legIndex: i, dvSpent };
    }
    if (t <= leg.tArrive) {
      if (!leg.helioConic) {
        const b = at(t)[leg.toKey];
        return { pos: b.pos, vel: b.vel, phase: "coasting", legIndex: i, dvSpent: dvSpent + leg.transferDv };
      }
      const s = craftStateAt(leg.helioConic, t); // pos rel Sun = heliocentric
      const s2 = craftStateAt(leg.helioConic, t + 60); // 60 s finite-difference velocity
      return {
        pos: s.pos,
        vel: [(s2.pos[0] - s.pos[0]) / 60, (s2.pos[1] - s.pos[1]) / 60],
        phase: "coasting",
        legIndex: i,
        dvSpent: dvSpent + leg.transferDv,
      };
    }
    dvSpent += leg.transferDv + leg.captureDv; // fully paid this leg; move on
  }
  const last = legs[legs.length - 1];
  const b = at(t)[last.toKey];
  return { pos: b.pos, vel: b.vel, phase: "arrived", legIndex: legs.length - 1, dvSpent };
}
