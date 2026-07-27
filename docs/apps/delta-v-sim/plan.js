// plan.js — the single-leg mission planner (part 2). `planEfficientLaunch` jumps
// the porkchop to its minimum (the next efficient window) and returns a plan
// object whose Δv budget is BROKEN OUT from the research delta-v map (cited, not
// invented). Pure/DOM-free. Structured as an ARRAY of legs so the multi-leg
// course planner (part 3) is a natural extension — part 2 fills exactly one leg.

import { wrapPi, sub } from "./vec.js";
import { DAY_S, BODIES, MU_SUN, worldAt } from "./sim.js";
import { porkchop, bestTransferNow, transferDvs, lambert, TOF_FLOOR, TOF_MIN, TOF_MAX } from "./transfer.js";
import { surfaceToOrbitWith } from "./infra.js";
import { gravityAssist } from "./gravity-assist.js";
import { courseDvAccounting } from "./budget.js";

// Shared porkchop resolution so a single-leg course is IDENTICAL to the part-2
// single plan (same grid → same min).
const PLAN_RESOLUTION = 48;

// ---- capture Δv (Oberth) — the physics behind the research capture figure ----
// Parking-orbit periapsis (body radius + ~400 km) and μ per capture body. The
// Oberth-aided capture into a marginally-bound orbit is
//   Δv = √(v∞² + v_esc²) − v_esc,   v_esc = √(2μ/r_p).
// With the leg's actual heliocentric arrival v∞ this reproduces the research
// Mars capture ≈ 0.9 km/s (windows-and-transfers.md §Δv budget) as PHYSICS, and
// gives Earth's deep-well capture ≈ 0.4 (Oberth) — never invented.
// Capture/flyby μ and periapsis DERIVE from the body catalog now (2026-07-24): μ =
// BODIES[body].mu, periapsis = radius + a 400 km parking altitude. No magic
// constants, and a new body (Venus) is covered automatically. `captureBody(k)`
// returns null for bodies without both (e.g. the Sun) so callers guard cleanly.
const PARKING_ALT_KM = 400;
function captureBody(body) {
  const b = BODIES[body];
  if (!b || !b.mu || !b.radius) return null;
  return { mu: b.mu, rp: b.radius + PARKING_ALT_KM };
}

function oberthCapture(vInf, body) {
  const cb = captureBody(body);
  if (!cb || !(vInf >= 0)) return 0;
  const vEsc = Math.sqrt((2 * cb.mu) / cb.rp);
  return Math.sqrt(vInf * vInf + vEsc * vEsc) - vEsc;
}

// Waypoint Δv by mode, using the leg's heliocentric arrival v∞:
//   flyby → 0 HERE (the per-waypoint capture primitive; a flyby doesn't capture).
//           The REAL gravity-assist residual is priced at the COURSE level in
//           planCourse, where the outgoing leg is known (see the flyby post-pass).
//   orbit → Oberth capture into orbit (≈ research figure) at a PLANET; at a MOON,
//           the moon-orbit rendezvous (no well to capture into).
//   drop  → v1: capture then immediate re-departure (treated as orbit)
export function waypointDv(body, mode, arrVInf) {
  if (mode === "flyby") return 0;
  const b = BODIES[body];
  if (b && b.primary && b.primary !== "sun") return moonRendezvousDv(arrVInf, body); // a MOON
  return oberthCapture(arrVInf, body); // orbit | drop at a planet
}

// A MOON has negligible gravity — you can't capture INTO it, you MATCH its orbit
// around its primary. Arriving at the Mars system with hyperbolic excess `vInf`
// (relative to the PRIMARY), your speed at the moon's orbital radius r is
// √(vInf² + 2μ_p/r); burn to the moon's circular velocity √(μ_p/r) there. THIS is
// why reaching Phobos/Deimos really costs ~2 km/s ON TOP of getting to Mars — no
// aerocapture, no gravity well to sink into. `vInf` is relative to the primary
// because planCourse routes a moon leg's transfer via that primary (see below).
function moonRendezvousDv(vInf, moonKey) {
  const b = BODIES[moonKey];
  const p = b && b.primary && BODIES[b.primary];
  if (!p || !b.elem || !(vInf >= 0)) return 0;
  const r = b.elem.a; // the moon's orbital radius around its primary
  return Math.max(0, Math.sqrt(vInf * vInf + (2 * p.mu) / r) - Math.sqrt(p.mu / r));
}

// A body's HELIOCENTRIC root: itself if it orbits the Sun, else its primary (a moon
// co-moves with its primary around the Sun).
function heliocentricRoot(key) {
  const b = BODIES[key];
  return b && b.primary && b.primary !== "sun" ? b.primary : key;
}

// For interplanetary TRANSFER geometry, a moon reached from OUTSIDE its system
// routes to its PRIMARY (Earth→Phobos ≡ Earth→Mars heliocentric-ally; the moon
// rendezvous is the separate local Δv above). A moon reached from WITHIN its own
// system (Earth→Moon) stays a local transfer — the sim's coarse approximation.
export function transferBody(key, otherKey) {
  const b = BODIES[key];
  if (b && b.primary && b.primary !== "sun" && b.primary !== heliocentricRoot(otherKey)) return b.primary;
  return key;
}

// The incoming (arrival) and outgoing (departure) hyperbolic-excess vectors for a
// leg, RELATIVE TO the from/to bodies — recomputed from the leg's own Lambert
// solution (the leg keeps only magnitudes). Used to price a real gravity assist at
// a flyby, where the turn between two legs' v∞ vectors is what gravity bends.
function legVInfVectors(leg, at) {
  const w1 = at(leg.depTime);
  const w2 = at(leg.arrTime);
  const sol = lambert(w1[leg.from].pos, w2[leg.to].pos, leg.tof, MU_SUN);
  if (!sol) return null;
  return {
    depVInf: sub(sol.v1, w1[leg.from].vel), // rel to `from` at departure
    arrVInf: sub(sol.v2, w2[leg.to].vel), // rel to `to` at arrival
  };
}

// The orbital period governing a transfer window. A moon reached from OUTSIDE its
// system is timed by its PRIMARY's heliocentric period (it co-moves with the
// primary around the Sun) — this is what lets Phobos/Deimos be real waypoints
// (their 0.3-day local orbit would otherwise make the window search nonsense). A
// moon reached from within its own system (Earth→Moon) keeps its own period.
function orbitalPeriodForTransfer(key, otherKey) {
  const b = BODIES[key];
  if (b && b.primary && b.primary !== "sun" && b.primary !== heliocentricRoot(otherKey)) {
    return BODIES[b.primary].elem.period;
  }
  return b && b.elem ? b.elem.period : Infinity;
}

// Synodic period between two bodies (from their real sidereal periods; moon-aware).
export function synodicPeriod(fromKey, toKey) {
  const Tf = orbitalPeriodForTransfer(fromKey, toKey);
  const Tt = orbitalPeriodForTransfer(toKey, fromKey);
  return 1 / Math.abs(1 / Tf - 1 / Tt);
}

// Apply a launch method to a leg's DEPARTURE: recompute the surface→orbit Δv for
// the departure body (infra.js — body-asymmetric), attach it as `leg.launch`, and
// (for a part-2 leg that carries the cited surface-budget) collapse its
// surface→LEO row + total. `chemical` is a no-op on the budget (byte-identical),
// so default plans are unchanged. Unavailable methods are left as-is (the UI
// disables them; guarded here too).
export function applyLaunchMethod(leg, methodId) {
  const s = surfaceToOrbitWith(leg.from, methodId || "chemical");
  if (!s.available) return leg;
  const out = {
    ...leg,
    launch: {
      method: s.method,
      label: s.label,
      base: s.base,
      surfaceToOrbit: s.result,
      dvRemoved: s.dvRemoved,
      caveat: s.caveat,
      cite: s.cite,
    },
  };
  if (out.budget && out.budget.rows && out.budget.rows.length) {
    const rows = out.budget.rows.map((r) =>
      // Match the surface→orbit row by a STABLE field, not by parsing its label
      // (the old `/surface → (leo|orbit)/i` regex was fragile — a relabel silently
      // broke the rewrite). The row is tagged `kind:"surface-to-orbit"` in legBudget.
      r.kind === "surface-to-orbit"
        ? {
            ...r,
            dv: s.result,
            note:
              s.method === "chemical"
                ? r.note
                : `${s.label} — removes ${s.dvRemoved.toFixed(1)} km/s [${s.cite}]`,
          }
        : r,
    );
    out.budget = { ...out.budget, rows };
    out.budgetTotal = rows.reduce((sum, r) => sum + r.dv, 0);
  }
  return out;
}

// Δv budget for an Earth→Mars leg, from notes/delta-v/research/
// windows-and-transfers.md §"Delta-v budget" (the Wikipedia delta-v map) and the
// gravity-well table in launch-and-velocity-transfer.md. Figures are the
// research's, cited per row — nothing here is invented.
export function legBudget(fromKey, toKey) {
  if (fromKey === "earth" && toKey === "mars") {
    return {
      target: "Mars capture orbit",
      rows: [
        {
          label: "Earth surface → LEO",
          kind: "surface-to-orbit", // the row applyLaunchMethod rewrites (stable tag)
          dv: 9.4,
          range: [9.3, 10],
          note: "the gravity-well tax — incl. 1.5–2 km/s drag + gravity losses",
          cite: "windows-and-transfers.md §Δv budget",
        },
        {
          label: "LEO → trans-Mars injection (TMI)",
          dv: 3.6,
          note: "Oberth-aided; Hohmann floor 3.59, a budgeted window costs ~4.3",
          cite: "windows-and-transfers.md §Δv budget",
        },
        {
          label: "Mars orbit insertion (capture)",
          dv: 0.9,
          note: "propulsive; aerobraking drives it far lower (paid in months of time)",
          cite: "windows-and-transfers.md §Δv budget",
        },
      ],
      // The gravity-well argument: surface→LEO (9.3–10) dwarfs the heliocentric
      // transfer (~2.9). That gap is the case for launch infrastructure.
      infraNote:
        "Earth surface→LEO (9.3–10 km/s) dwarfs the interplanetary transfer (~2.9 km/s heliocentric) — the gravity-well tax is the argument for launch infrastructure (elevator/mass-driver/skyhook).",
      infraCite: "launch-and-velocity-transfer.md §gravity-well depth",
    };
  }
  // Non-Earth→Mars pairs: no cited per-leg breakout exists yet. Return an HONEST
  // empty state (a flag + a note), never a fake authoritative "TOTAL 0.0" — the hud
  // renders the note instead. Feasibility is unaffected (it reads leg.launch, not
  // this card). Generalizing the breakout is deferred until a journey needs it.
  return {
    target: `${toKey} orbit`,
    rows: [],
    unavailable: true,
    infraNote: `per-leg Δv-budget breakout not available for ${fromKey}→${toKey} yet — feasibility uses the mission model.`,
    infraCite: "",
  };
}

function phaseAngleDeg(world, fromKey, toKey) {
  const a = world[fromKey].pos;
  const b = world[toKey].pos;
  const g = wrapPi(Math.atan2(b[1], b[0]) - Math.atan2(a[1], a[0]));
  return (g * 180) / Math.PI;
}

// Build one leg (part 3 chains several). Carries the transfer geometry + the
// cited Δv budget + its total.
export function makeLeg(fromKey, toKey, depTime, arrTime, depDv, arrDv, bodyAt) {
  const bud = legBudget(fromKey, toKey);
  const budgetTotal = bud.rows.reduce((s, r) => s + r.dv, 0);
  return {
    from: fromKey,
    to: toKey,
    mode: "transfer",
    depTime,
    arrTime,
    tof: arrTime - depTime,
    heliocentricDepDv: depDv, // the porkchop's departure impulse (= v∞ at Earth)
    heliocentricArrDv: arrDv,
    phaseAngleDeg: phaseAngleDeg(bodyAt(depTime), fromKey, toKey),
    budget: bud,
    budgetTotal, // to the leg's target orbit (e.g. Mars capture)
  };
}

// The efficient single-leg launch: porkchop the next synodic window, take its
// minimum (min total Δv), and wrap it as a one-leg plan. Returns the plan AND the
// porkchop it used (so the UI can jump the 2D view to this window).
export function planEfficientLaunch(fromKey, toKey, now, bodyAt, opts = {}) {
  const synodic = opts.synodic || synodicPeriod(fromKey, toKey);
  const resolution = opts.resolution || PLAN_RESOLUTION;
  const pc = porkchop({
    fromKey,
    toKey,
    depWindow: [now, now + synodic],
    arrWindow: [now + 100 * DAY_S, now + synodic + 420 * DAY_S],
    resolution,
    bodyAt,
  });
  const m = pc.min;
  const depTime = pc.depAxis[m.depIdx];
  const arrTime = pc.arrAxis[m.arrIdx];
  const leg = makeLeg(fromKey, toKey, depTime, arrTime, m.dep, m.arr, bodyAt);
  return {
    legs: [leg], // one leg now — a chain of legs in part 3
    depTime,
    arrTime,
    tof: arrTime - depTime,
    heliocentricTotalDv: m.dv, // porkchop min (dep + arr)
    budgetTotal: leg.budgetTotal, // surface → target orbit, from the research map
    porkchop: pc,
  };
}

// ============================================================================
//  Multi-leg COURSE planner (part 3). A course is an ordered list of waypoints;
//  each consecutive pair is a min-Δv porkchop leg departing at its window. The
//  user SETS the order + modes; the planner OPTIMIZES timing + transfers. Pure.
//
//  Δv accounting (documented, simplified toy model): a leg's `transferDv` is the
//  porkchop-min heliocentric two-impulse cost (dep v∞ + arr v∞); each arrival
//  waypoint adds `waypointDv` (mode: flyby 0 / orbit = Oberth capture). The
//  course total is Σ(transferDv + waypointDv) — the in-space Δv (surface→LEO is a
//  separate launch cost, shown by the part-2 leg budget). Solving the optimal
//  ORDER of waypoints (TSP-in-Δv) and true gravity-assist geometry are ROADMAP.
// ============================================================================

// One leg departing at its next window ≥ notBefore (porkchop-min it).
function legNextWindow(from, to, notBefore, bodyAt) {
  const syn = synodicPeriod(from, to);
  const pc = porkchop({
    fromKey: from,
    toKey: to,
    depWindow: [notBefore, notBefore + syn],
    arrWindow: [notBefore + 100 * DAY_S, notBefore + syn + 420 * DAY_S],
    resolution: PLAN_RESOLUTION,
    bodyAt,
  });
  const m = pc.min;
  return {
    depTime: pc.depAxis[m.depIdx],
    arrTime: pc.arrAxis[m.arrIdx],
    tof: m.tof,
    heliocentricDepDv: m.dep,
    heliocentricArrDv: m.arr,
    transferDv: m.dv,
    porkchop: pc,
  };
}

// One leg departing NOW (notBefore) — higher Δv, no window wait ("leave-now").
function legLeaveNow(from, to, notBefore, bodyAt) {
  const best = bestTransferNow(from, to, notBefore, bodyAt);
  return {
    depTime: notBefore,
    arrTime: notBefore + best.tof,
    tof: best.tof,
    heliocentricDepDv: best.dv,
    heliocentricArrDv: best.arr,
    transferDv: best.dv + best.arr,
    porkchop: null,
  };
}

// ---- FAST objective: min-TOF (trade Δv for time), still affordable -----------
const FAST_DV_CAP = 20; // km/s — a "fast" leg must stay within an affordable Δv

function legFromCell(from, to, pc, depIdx, arrIdx, bodyAt) {
  const depTime = pc.depAxis[depIdx];
  const arrTime = pc.arrAxis[arrIdx];
  const tof = arrTime - depTime;
  const d = transferDvs(from, to, depTime, tof, bodyAt);
  return {
    depTime,
    arrTime,
    tof,
    heliocentricDepDv: d.dep,
    heliocentricArrDv: d.arr,
    transferDv: d.dep + d.arr,
    porkchop: pc,
  };
}

// Fastest affordable leg in the window: the min-TOF cell with finite Δv ≤ cap.
function legNextWindowFast(from, to, notBefore, bodyAt) {
  const syn = synodicPeriod(from, to);
  const pc = porkchop({
    fromKey: from,
    toKey: to,
    depWindow: [notBefore, notBefore + syn],
    arrWindow: [notBefore + 100 * DAY_S, notBefore + syn + 420 * DAY_S],
    resolution: PLAN_RESOLUTION,
    bodyAt,
  });
  let best = null;
  for (let i = 0; i < pc.depAxis.length; i++) {
    for (let j = 0; j < pc.arrAxis.length; j++) {
      const tof = pc.arrAxis[j] - pc.depAxis[i];
      const dv = pc.grid[i][j];
      if (tof > TOF_FLOOR && isFinite(dv) && dv <= FAST_DV_CAP && (!best || tof < best.tof)) {
        best = { i, j, tof };
      }
    }
  }
  if (!best) return legNextWindow(from, to, notBefore, bodyAt); // nothing affordable → efficient
  return legFromCell(from, to, pc, best.i, best.j, bodyAt);
}

// Fastest affordable leg departing NOW: the shortest TOF with finite Δv ≤ cap.
function legLeaveNowFast(from, to, notBefore, bodyAt) {
  const n = 60;
  for (let k = 0; k <= n; k++) {
    const tof = TOF_MIN + (k / n) * (TOF_MAX - TOF_MIN); // ascending → first = shortest
    const d = transferDvs(from, to, notBefore, tof, bodyAt);
    const total = d.dep + d.arr;
    if (isFinite(total) && total <= FAST_DV_CAP) {
      return {
        depTime: notBefore,
        arrTime: notBefore + tof,
        tof,
        heliocentricDepDv: d.dep,
        heliocentricArrDv: d.arr,
        transferDv: total,
        porkchop: null,
      };
    }
  }
  return legLeaveNow(from, to, notBefore, bodyAt); // nothing affordable → min-Δv
}

function selectLeg(from, to, notBefore, bodyAt, timing, objective) {
  if (objective === "fast") {
    return timing === "leave-now"
      ? legLeaveNowFast(from, to, notBefore, bodyAt)
      : legNextWindowFast(from, to, notBefore, bodyAt);
  }
  return timing === "leave-now"
    ? legLeaveNow(from, to, notBefore, bodyAt) // efficient (unchanged)
    : legNextWindow(from, to, notBefore, bodyAt);
}

// A leg departing at an EXACT epoch (not the next window) — the "leave-now from
// this instant" leg, honoring the objective. Used by the per-turnaround stay: the
// user picks HOW LONG to loiter, so the return leaves at (arrival + stay), paying
// whatever the transfer costs at that epoch (no window optimization).
function legAtEpoch(from, to, depTime, bodyAt, objective) {
  return objective === "fast"
    ? legLeaveNowFast(from, to, depTime, bodyAt)
    : legLeaveNow(from, to, depTime, bodyAt);
}

export const COURSE_DEFAULTS = {
  objective: "efficient", // vs "fast" (min-TOF); default keeps prior behavior
  refuelInOrbit: true, // each leg budgeted independently (tank resets in orbit)
  returnTiming: "wait-for-window", // vs "leave-now"
  returnStayDays: null, // null ⇒ next return window; a number ⇒ loiter exactly N days
  exhaustVelocity: 3.5, // km/s (chemical, Isp ~357 s) — the rocket-equation basis
};

// planCourse({ waypoints:[{body, mode}], startTime, assumptions }) → course.
// waypoints[0] is the origin (no mode used); each later waypoint's mode drives
// its capture Δv. The leg into a waypoint departs at its next window ≥ (previous
// arrival); the STAY at a waypoint is the resulting gap until the next departure.
// EXCEPTION — the per-turnaround stay: when `returnStayDays` is set, the RETURN
// leg (the one heading back to the origin body, i ≥ 2) departs exactly that many
// days after its arrival, instead of at the next min-Δv window — "pick how long it
// loiters at Mars before coming home."
export function planCourse({ waypoints, startTime, assumptions = {} }) {
  const A = { ...COURSE_DEFAULTS, ...assumptions };
  const at = A.bodyAt || worldAt; // injectable body-state fn (mockable in tests)
  const originBody = waypoints.length ? waypoints[0].body : null;
  const legs = [];
  let notBefore = startTime;
  for (let i = 1; i < waypoints.length; i++) {
    const from = waypoints[i - 1].body;
    const to = waypoints[i].body;
    const mode = waypoints[i].mode || "orbit";
    // A MOON routes its INTERPLANETARY transfer via its primary (Earth→Phobos is
    // planned as Earth→Mars); the leg keeps the real waypoints as its identity and
    // the moon rendezvous is priced by waypointDv. So `base` (window, transfer Δv,
    // arrival v∞) is the Earth↔Mars leg, and arrival v∞ is RELATIVE TO THE PRIMARY —
    // exactly what moonRendezvousDv needs.
    const tFrom = transferBody(from, to);
    const tTo = transferBody(to, from);
    // notBefore is the arrival at `from`; a fixed return stay overrides the window.
    const isReturnLeg = i >= 2 && to === originBody;
    const base =
      isReturnLeg && A.returnStayDays != null
        ? legAtEpoch(tFrom, tTo, notBefore + A.returnStayDays * DAY_S, at, A.objective)
        : selectLeg(tFrom, tTo, notBefore, at, A.returnTiming, A.objective);
    // Surface→orbit is paid ONCE, on the FIRST departure (the craft leaves the
    // origin body). Every LATER leg departs the ORBIT the craft captured into at the
    // previous waypoint, so it launches from orbit (0 surface→orbit) regardless of
    // the origin's method — otherwise a return would spuriously re-pay the well.
    const launchMethod = i === 1 ? waypoints[i - 1].launchMethod || "chemical" : "from-orbit";
    const leg = applyLaunchMethod(
      {
        from,
        to, // IDENTITY: the real waypoints (a moon stays a moon)
        mode,
        ...base, // interplanetary geometry (via the primary for a moon)
        waypointDv: waypointDv(to, mode, base.heliocentricArrDv), // moon → rendezvous
        phaseAngleDeg: phaseAngleDeg(at(base.depTime), tFrom, tTo),
      },
      launchMethod,
    );
    legs.push(leg);
    notBefore = base.arrTime; // the next leg departs at its window after arrival
  }
  // GRAVITY-ASSIST post-pass: a flyby waypoint (waypoints[k+1], the arrival of
  // legs[k] and the departure of legs[k+1]) now costs the REAL patched-conic
  // residual — what a burn must supply beyond the free turn gravity provides — not
  // the v1 flat 0. Needs both legs, so it runs here, after the chain is built.
  for (let k = 0; k < legs.length - 1; k++) {
    if ((waypoints[k + 1].mode || "orbit") !== "flyby") continue;
    const body = legs[k].to; // = legs[k+1].from = the flyby body
    const cb = captureBody(body); // μ + a conservative min flyby periapsis (under-credits)
    const vIn = legVInfVectors(legs[k], at);
    const vOut = legVInfVectors(legs[k + 1], at);
    if (!cb || !vIn || !vOut) continue;
    const assist = gravityAssist(vIn.arrVInf, vOut.depVInf, cb.mu, cb.rp);
    legs[k].waypointDv = assist.residualDv; // 0 ⇒ gravity did it all (a real slingshot)
    legs[k].assist = assist; // diagnostics for the HUD (free vs required turn)
  }
  // stay at each intermediate waypoint = gap between arrival and next departure
  const stays = [];
  for (let i = 0; i < legs.length - 1; i++) {
    stays.push((legs[i + 1].depTime - legs[i].arrTime) / DAY_S);
  }
  const totalDv = legs.reduce((s, l) => s + l.transferDv + l.waypointDv, 0);
  // mission duration = launch (first departure) → return (last arrival); the wait
  // for the FIRST window (startTime → first departure) is reported separately.
  const totalDurationDays = legs.length
    ? (legs[legs.length - 1].arrTime - legs[0].depTime) / DAY_S
    : 0;
  const preLaunchWaitDays = legs.length ? (legs[0].depTime - startTime) / DAY_S : 0;
  // rocket-equation accounting: refuel-ON carries only one leg's propellant (the
  // worst leg's mass ratio); refuel-OFF carries all, ratios COMPOUND (e^Σ > max).
  const ve = A.exhaustVelocity;
  // mass ratios via the shared accounting (budget.js) — the SAME refuel model as
  // mission feasibility, so the two can't drift. captureDv = the leg's waypointDv;
  // launchCost is excluded from the mass ratio (a separate launch-vehicle line).
  const { massRatioRefuelOn, massRatioRefuelOff } = courseDvAccounting({
    legs: legs.map((l) => ({ transferDv: l.transferDv, captureDv: l.waypointDv })),
    refuelInOrbit: A.refuelInOrbit,
    ve,
  });
  return {
    waypoints,
    legs,
    stays,
    assumptions: A,
    totalDv,
    totalDurationDays,
    preLaunchWaitDays,
    ve,
    massRatioRefuelOn,
    massRatioRefuelOff,
    porkchop: legs.length ? legs[0].porkchop : null,
  };
}
