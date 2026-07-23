// hud.js — the monospace HUD text. A pure formatter: `formatHud(view, world)`
// takes a plain snapshot of app state + the current world and returns the string
// app.js drops into the HUD element. No DOM, no app-state coupling — so the HUD
// can grow (telemetry, the porkchop chart's numeric readout) without touching
// orchestration.
//
// view = { toId, t, rate, playing, cameraScale, selected, craft, hohmann,
//          elevator }  (craft is the app's { def, obj } wrapper or null).

import { BODIES, DAY_S, YEAR_S, EPOCH_ISO } from "./sim.js";
import { FRAMES, earthMarsGeometry } from "./frames.js";

const AU = 1.495978707e8;

function fmtDate(t) {
  return new Date(Date.parse(EPOCH_ISO) + t * 1000).toISOString().slice(0, 10);
}
function fmtRate(r) {
  if (r >= YEAR_S * 0.95) return `${(r / YEAR_S).toFixed(2)} yr/s`;
  if (r >= DAY_S) return `${(r / DAY_S).toFixed(r / DAY_S < 10 ? 1 : 0)} d/s`;
  return `${(r / 3600).toFixed(1)} h/s`;
}
function fmtKm(x) {
  if (!isFinite(x)) return "∞";
  if (Math.abs(x) >= 1e6) return `${(x / AU).toFixed(4)} AU`;
  return `${Math.round(x).toLocaleString("en-US")} km`;
}

function bodyReadout(view) {
  if (view.selected === "craft" && view.craft && view.craft.obj) {
    const c = view.craft.obj;
    const lines = [
      `SELECTED   spacecraft (around ${BODIES[c.primaryKey].name})`,
      `  Δv       prograde ${view.craft.def.dv.prograde.toFixed(2)}  radial ${view.craft.def.dv.radial.toFixed(2)} km/s`,
      `  type     ${c.type}   e = ${c.e.toFixed(4)}`,
      `  periapsis ${fmtKm(c.rp)}`,
    ];
    if (c.type === "ellipse") {
      lines.push(`  apoapsis ${fmtKm(c.ra)}`);
      lines.push(`  period   ${(c.period / DAY_S).toFixed(3)} d`);
    } else {
      lines.push(`  v∞       ${c.vinf.toFixed(3)} km/s`);
    }
    return lines.join("\n");
  }
  const b = BODIES[view.selected];
  if (!b) return "SELECTED   —";
  const lines = [`SELECTED   ${b.name} (${b.role})`];
  if (b.elem) {
    lines.push(`  a        ${fmtKm(b.elem.a)}`);
    lines.push(`  e        ${b.elem.e.toFixed(4)}`);
    lines.push(`  period   ${(b.elem.period / DAY_S).toFixed(2)} d`);
    lines.push(`  primary  ${BODIES[b.primary].name}`);
  }
  return lines.join("\n");
}

// The Earth–Mars phase line — pure astronomy (phase angle + true separation) that
// holds in any frame. The transfer-timing telemetry that used to live here (fixed/
// live/both Δv, next-window) was retired with the standalone Hohmann tool: leave-
// now-vs-wait is now the mission definition's `timing`, and the metronome chart +
// the Define readout carry the window / Δv figures for the SELECTED definition.
function phaseLine(g) {
  const phaseDeg = ((g.gamma * 180) / Math.PI).toFixed(0);
  return `\nEARTH–MARS  phase ${phaseDeg}° · separation ${(g.sep / AU).toFixed(3)} AU`;
}

// The efficient-launch plan card (one leg now; a chain in part 3). The Δv budget
// rows are the research delta-v map's figures (cited in plan.js). The note flags
// that surface→LEO dwarfs the transfer — the case for launch infrastructure.
export function formatPlan(plan) {
  if (!plan || !plan.legs || !plan.legs.length) return "";
  const leg = plan.legs[0];
  const lines = [
    `EFFICIENT LAUNCH → ${leg.budget.target.toUpperCase()}   (next window)`,
    `  depart ${fmtDate(leg.depTime)}   arrive ${fmtDate(leg.arrTime)}   travel time ${(leg.tof / DAY_S).toFixed(0)} d`,
    `  departure phase ${leg.phaseAngleDeg.toFixed(1)}°   heliocentric total ${plan.heliocentricTotalDv.toFixed(2)} km/s (dep ${leg.heliocentricDepDv.toFixed(2)} + arr ${leg.heliocentricArrDv.toFixed(2)})`,
    "",
    `  Δv budget  (surface → ${leg.budget.target}):`,
  ];
  for (const r of leg.budget.rows) {
    lines.push(`    ${r.label.padEnd(32)} ${r.dv.toFixed(1).padStart(5)}   ${r.note}`);
  }
  lines.push(`    ${"TOTAL".padEnd(32)} ${leg.budgetTotal.toFixed(1).padStart(5)} km/s`);
  lines.push("");
  lines.push(`  ▸ ${leg.budget.infraNote}`);
  lines.push(`    source: ${leg.budget.rows[0].cite} · ${leg.budget.infraCite}`);
  return lines.join("\n");
}

// The multi-leg COURSE itinerary card: per-leg dates/TOF/Δv, per-waypoint
// mode + capture Δv, stays, and the totals (Δv, duration, refuel-on/off mass
// ratios). The single-leg case is consistent with the part-2 plan.
export function formatCourse(course) {
  if (!course || !course.legs || !course.legs.length) return "";
  const A = course.assumptions;
  const nm = (k) => (BODIES[k] ? BODIES[k].name : k);
  const lines = [
    `COURSE   ${course.waypoints.map((w) => nm(w.body)).join(" → ")}`,
    `  refuel-in-orbit ${A.refuelInOrbit ? "ON" : "OFF"} · timing ${A.returnTiming} · vₑ ${course.ve} km/s`,
  ];
  if (course.preLaunchWaitDays > 0.5) {
    lines.push(`  (waits ${course.preLaunchWaitDays.toFixed(0)} d for the first window)`);
  }
  lines.push("");
  course.legs.forEach((l, i) => {
    lines.push(`  leg ${i + 1}  ${nm(l.from)} → ${nm(l.to)}  [${l.mode}]`);
    lines.push(
      `    depart ${fmtDate(l.depTime)}  arrive ${fmtDate(l.arrTime)}  TOF ${(l.tof / DAY_S).toFixed(0)} d`,
    );
    if (l.launch) {
      const rm = l.launch.dvRemoved > 0.05 ? ` (−${l.launch.dvRemoved.toFixed(1)})` : "";
      const cav = l.launch.caveat ? ` ${l.launch.caveat}` : "";
      lines.push(
        `    launch  ${l.launch.label} · ${nm(l.from)} surface→orbit ${l.launch.surfaceToOrbit.toFixed(1)}${rm} km/s${cav}`,
      );
    }
    lines.push(
      `    transfer Δv ${l.transferDv.toFixed(2)}  ·  ${l.mode} capture Δv ${l.waypointDv.toFixed(2)} km/s`,
    );
    if (i < course.stays.length) {
      lines.push(`    ↳ stay ${course.stays[i].toFixed(0)} d (${A.returnTiming})`);
    }
  });
  lines.push("");
  lines.push(
    `  TOTAL Δv ${course.totalDv.toFixed(2)} km/s  ·  mission ${(course.totalDurationDays / 365.25).toFixed(2)} yr`,
  );
  lines.push(
    `  propellant mass ratio (vₑ ${course.ve}): refuel-ON ${course.massRatioRefuelOn.toFixed(1)}× · refuel-OFF ${course.massRatioRefuelOff.toFixed(1)}× (carry-all compounds)`,
  );
  lines.push(`  Δv from the porkchop minima; capture Δv = Oberth (windows-and-transfers.md).`);
  return lines.join("\n");
}

// The committed MISSION readout: craft characteristics + budget, the itinerary
// (per-leg dates/TOF/launch/transfer/capture + stays), and the three-total
// feasibility that finally makes the launch-infra knob bite —
//   requiredDv = launchCost (surface→orbit AFTER infra) + inSpaceDv  vs  budget.
export function formatMission(mission) {
  if (!mission) return "";
  const c = mission.craft || {};
  const nm = (k) => (BODIES[k] ? BODIES[k].name : k);
  const ion = c.label === "ion freighter" ? "  (impulsive model overstates low-thrust)" : "";
  const lines = [
    `MISSION  ${mission.waypoints.map((w) => nm(w.body)).join(" → ")}`,
    `  craft ${c.label || "custom"} · Isp ${c.isp} s · prop ${Math.round((c.propFraction || 0) * 100)}% · budget ${mission.budget.toFixed(1)} km/s${ion}`,
    `  objective ${mission.objective} · timing ${mission.timing}`,
  ];
  // WHY the delay: with wait-for-window the vehicle loiters in its parking orbit
  // until the transfer geometry lines up — often most of a synodic period (~2 trips
  // around the Sun). Make that explicit so the wait doesn't read as a hang.
  if (mission.course && mission.course.preLaunchWaitDays > 0.5) {
    const w = mission.course.preLaunchWaitDays;
    const orb = w / 365.25;
    lines.push(
      `  ⏱ launch window in ${w.toFixed(0)} d${orb >= 0.5 ? ` (~${orb.toFixed(1)}× around the Sun)` : ""} — loiters in ${nm(mission.waypoints[0].body)} parking orbit until the geometry lines up; leaving now costs far more Δv`,
    );
  }
  lines.push("");
  mission.legs.forEach((l, i) => {
    lines.push(`  leg ${i + 1}  ${nm(l.fromKey)} → ${nm(l.toKey)}  [${l.mode}]`);
    lines.push(
      `    depart ${fmtDate(l.tDepart)}  arrive ${fmtDate(l.tArrive)}  TOF ${(l.tof / DAY_S).toFixed(0)} d`,
    );
    lines.push(
      `    launch ${l.launchMethod} (surface→orbit ${l.launchCost.toFixed(1)}) · transfer ${l.transferDv.toFixed(2)} · ${l.mode} capture ${l.captureDv.toFixed(2)} km/s`,
    );
    if (i < mission.course.stays.length) {
      lines.push(`    ↳ stay ${mission.course.stays[i].toFixed(0)} d`);
    }
  });
  lines.push("");
  // travel time: transit (Σ TOF) + stays = total mission duration (launch→arrival)
  const transitDays = mission.legs.reduce((s, l) => s + l.tof, 0) / DAY_S;
  const stayDays = mission.course.stays.reduce((s, x) => s + x, 0);
  const totalDays = mission.course.totalDurationDays;
  lines.push(
    `  travel  transit ${transitDays.toFixed(0)} d + stays ${stayDays.toFixed(0)} d = ${totalDays.toFixed(0)} d (${(totalDays / 365.25).toFixed(2)} yr)`,
  );
  lines.push(
    `  Δv  launch ${mission.launchCost.toFixed(2)} + in-space ${mission.inSpaceDv.toFixed(2)} = REQUIRED ${mission.requiredDv.toFixed(2)}  vs  BUDGET ${mission.budget.toFixed(2)} km/s`,
  );
  lines.push(
    mission.feasible
      ? "  ✓ FEASIBLE — the craft flies the whole course"
      : `  ✗ INFEASIBLE — tank runs dry at leg ${mission.runsDryLeg + 1} (raise Isp/prop, or cut launch/capture via infra)`,
  );
  return lines.join("\n");
}

export function formatHud(view, world) {
  const days = (view.t / DAY_S).toFixed(1);
  const g = earthMarsGeometry(world);

  let elevLine = "";
  if (view.elevator) {
    elevLine = `\nELEVATOR   release ${view.elevator.dRelease.toLocaleString("en-US")} km up (toward E–M L1 @ ~58,000 km)`;
    if (view.elevator.craft) {
      const c = view.elevator.craft;
      elevLine += `\n  payload  ${c.type}  e=${c.e.toFixed(3)}  peri ${fmtKm(c.rp)}  apo ${fmtKm(c.ra)}`;
    }
  }
  let compareLine = "";
  if (view.toId === "earth-mars") {
    const au = (x) => (x / AU).toFixed(3);
    compareLine =
      `\nEARTH–MARS  pinned on screen · Sun: Earth ${au(g.earthSunDist)} AU · Mars ${au(g.marsSunDist)} AU` +
      `\n  opposition in ~${g.daysToOpposition.toFixed(0)} d`;
  }
  const scaleStr =
    view.toId === "earth-mars"
      ? "normalized (pair pinned)"
      : `${(1 / view.cameraScale).toPrecision(3)} km/px`;
  const hud = [
    `FRAME      ${FRAMES[view.toId].label}`,
    `DATE       ${fmtDate(view.t)}   (day ${days}, illustrative phase)`,
    `RATE       ${fmtRate(view.rate)}   ${view.playing ? "▶ playing" : "❚❚ paused"}`,
    `SCALE      ${scaleStr}`,
    "",
    bodyReadout(view),
  ].join("\n");
  return hud + phaseLine(g) + elevLine + compareLine;
}
