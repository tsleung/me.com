// transfer.js — interplanetary transfer math (the porkchop/telemetry seam named
// in architecture.md). Pure, DOM-free. Sibling to hohmann.js: a coplanar 2D
// Lambert solver (universal-variable, Vallado) whose min-energy 180° case is the
// Hohmann degenerate point — reconciled so the two agree.
//
// A `bodyAt` argument (= sim.worldAt) supplies body states, so this module has no
// hard dependency on the catalog and stays trivially testable with a mock.

import { mag, sub, dot, cross, scale } from "./vec.js";
import { MU_SUN, DAY_S } from "./sim.js";
import { makeCraft, craftStateAt } from "./spacecraft.js";

// Stumpff functions (series near 0 for numerical stability).
function stumpffC(z) {
  if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 1 / 2 - z / 24 + (z * z) / 720;
}
function stumpffS(z) {
  if (z > 1e-6) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-6) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6 - z / 120 + (z * z) / 5040;
}

// The exact 180° (antiparallel radii) min-energy transfer: the two radii are the
// apsides, a = (r1+r2)/2, velocities are purely tangential (prograde/CCW). This
// IS the Hohmann ellipse — the degenerate point the universal-variable form is
// singular at (g → 0). Returns { v1, v2 }.
function apsidalTransfer(r1v, r2v, mu) {
  const r1 = mag(r1v);
  const r2 = mag(r2v);
  const a = (r1 + r2) / 2;
  const vmag = (rm) => Math.sqrt(mu * (2 / rm - 1 / a));
  const tangCCW = (pv) => {
    const m = mag(pv);
    return [-pv[1] / m, pv[0] / m];
  };
  return { v1: scale(tangCCW(r1v), vmag(r1)), v2: scale(tangCCW(r2v), vmag(r2)) };
}

// Coplanar 2D Lambert: given two position vectors, a time of flight and mu, find
// the transfer's departure/arrival velocity vectors. Prograde (CCW) short/long
// way is taken from the natural transfer angle. Returns { v1, v2 } or null for a
// degenerate (collinear same-direction) geometry.
export function lambert(r1v, r2v, tof, mu, longway = false) {
  const r1 = mag(r1v);
  const r2 = mag(r2v);
  const cosdnu = dot(r1v, r2v) / (r1 * r2);
  let dnu = Math.atan2(cross(r1v, r2v), dot(r1v, r2v)); // (-π, π]
  if (dnu < 0) dnu += 2 * Math.PI; // prograde CCW → (0, 2π)
  if (longway) dnu = 2 * Math.PI - dnu;

  // ONLY exactly-180° (antiparallel) is the true singularity (universal-variable
  // g → 0): there the transfer is the analytic apsidal/Hohmann ellipse. A hair
  // off 180° the universal-variable form is well-posed and — crucially — honours
  // the requested tof, which the apsidal closed form ignores, so keep the
  // exactly-180° window narrow.
  if (Math.abs(dnu - Math.PI) < 1e-7) return apsidalTransfer(r1v, r2v, mu);
  if (Math.abs(Math.sin(dnu)) < 1e-10) return null;

  const tm = dnu < Math.PI ? 1 : -1;
  const A = tm * Math.sqrt(r1 * r2 * (1 + cosdnu));
  if (A === 0) return apsidalTransfer(r1v, r2v, mu);

  let psiLow = -4 * Math.PI * Math.PI;
  let psiUp = 4 * Math.PI * Math.PI;
  let psi = 0;
  let y = r1 + r2;
  for (let i = 0; i < 100; i++) {
    const C = stumpffC(psi);
    const S = stumpffS(psi);
    y = r1 + r2 + (A * (psi * S - 1)) / Math.sqrt(C);
    if (A > 0 && y < 0) {
      // push psi up until the geometry closes (y ≥ 0)
      psiLow = psi;
      psi = 0.5 * (psiUp + psiLow);
      continue;
    }
    const chi = Math.sqrt(Math.max(y, 1e-12) / C);
    const tofCalc = ((chi * chi * chi) * S + A * Math.sqrt(y)) / Math.sqrt(mu);
    if (tofCalc <= tof) psiLow = psi;
    else psiUp = psi;
    if (Math.abs(tofCalc - tof) < 1e-7 * tof) break;
    psi = 0.5 * (psiUp + psiLow);
  }
  const C = stumpffC(psi);
  y = r1 + r2 + (A * (psi * stumpffS(psi) - 1)) / Math.sqrt(C);
  const f = 1 - y / r1;
  const g = A * Math.sqrt(y / mu);
  const gdot = 1 - y / r2;
  if (!isFinite(g) || g === 0) return null;
  const v1 = [(r2v[0] - f * r1v[0]) / g, (r2v[1] - f * r1v[1]) / g];
  const v2 = [(gdot * r2v[0] - r1v[0]) / g, (gdot * r2v[1] - r1v[1]) / g];
  if (!isFinite(v1[0]) || !isFinite(v2[0])) return null;
  return { v1, v2 };
}

// Departure + arrival Δv (km/s) for a transfer leaving `fromKey` at `depTime`,
// arriving at `toKey` after `tof`. Departure Δv = |transfer v1 − body velocity|.
export function transferDvs(fromKey, toKey, depTime, tof, bodyAt) {
  const w1 = bodyAt(depTime);
  const w2 = bodyAt(depTime + tof);
  const sol = lambert(w1[fromKey].pos, w2[toKey].pos, tof, MU_SUN);
  if (!sol) return { dep: Infinity, arr: Infinity };
  return {
    dep: mag(sub(sol.v1, w1[fromKey].vel)),
    arr: mag(sub(sol.v2, w2[toKey].vel)),
  };
}

// Departure Δv only (the documented signature).
export function departureDv(fromKey, toKey, depTime, tof, bodyAt) {
  return transferDvs(fromKey, toKey, depTime, tof, bodyAt).dep;
}

// TOF search range for a departing-now min-Δv transfer (Earth→Mars-scale).
export const TOF_MIN = 120 * DAY_S;
export const TOF_MAX = 400 * DAY_S;

// The minimum-Δv transfer departing at `now`: scans TOF over [TOF_MIN, TOF_MAX]
// for the cheapest departure, then a light parabolic refine. Returns
// { dv, tof, arr }. This is the ONE place the number is computed — telemetry,
// the chart, and live-mode all read it, so they agree by construction.
export function bestTransferNow(fromKey, toKey, now, bodyAt, n = 48) {
  let best = { dv: Infinity, tof: (TOF_MIN + TOF_MAX) / 2, arr: Infinity };
  const step = (TOF_MAX - TOF_MIN) / n;
  for (let i = 0; i <= n; i++) {
    const tof = TOF_MIN + i * step;
    const d = transferDvs(fromKey, toKey, now, tof, bodyAt);
    if (d.dep < best.dv) best = { dv: d.dep, tof, arr: d.arr };
  }
  // parabolic refine on a 3-point bracket around the sampled minimum
  const f = (tof) => transferDvs(fromKey, toKey, now, tof, bodyAt).dep;
  const a = Math.max(TOF_MIN, best.tof - step);
  const b = best.tof;
  const c = Math.min(TOF_MAX, best.tof + step);
  const fa = f(a);
  const fb = best.dv;
  const fc = f(c);
  const denom = fa - 2 * fb + fc;
  if (denom > 0) {
    let tofStar = b + (0.5 * (step * step) * (fa - fc)) / denom / step;
    tofStar = Math.max(a, Math.min(c, tofStar));
    const d = transferDvs(fromKey, toKey, now, tofStar, bodyAt);
    if (d.dep < best.dv) best = { dv: d.dep, tof: tofStar, arr: d.arr };
  }
  return best;
}

// Departure Δv of the min-Δv transfer departing now (the documented signature).
export function departureDvNow(fromKey, toKey, now, bodyAt) {
  return bestTransferNow(fromKey, toKey, now, bodyAt).dv;
}

// The transfer's HELIOCENTRIC conic: a Craft (primary = Sun, so craftStateAt
// positions ARE heliocentric) propagating the Lambert departure velocity from the
// departure body. A committed mission flies this; the trajectory samples it.
export function transferConic(fromKey, toKey, depTime, tof, bodyAt) {
  const w1 = bodyAt(depTime);
  const w2 = bodyAt(depTime + tof);
  const sol = lambert(w1[fromKey].pos, w2[toKey].pos, tof, MU_SUN);
  if (!sol) return null;
  return makeCraft(w1[fromKey].pos, sol.v1, MU_SUN, "sun", depTime);
}

// The transfer's HELIOCENTRIC trajectory as sample points (for frame-aware
// drawing): sample the conic over [depTime, depTime+tof].
export function transferTrajectory(fromKey, toKey, depTime, tof, bodyAt, samples = 96) {
  const craft = transferConic(fromKey, toKey, depTime, tof, bodyAt);
  if (!craft) return [];
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    pts.push(craftStateAt(craft, depTime + (i / samples) * tof).pos);
  }
  return pts;
}

// A departing-now Δv series over [tStart, tEnd] (n+1 samples). PURE and
// TIME-INVARIANT (each value depends only on its departure epoch), so a chart can
// cache/scroll it. Values trough to ~the Hohmann floor at each synodic window.
export function dvSeries(fromKey, toKey, tStart, tEnd, n, bodyAt) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = tStart + (i / n) * (tEnd - tStart);
    out.push({ t, dv: departureDvNow(fromKey, toKey, t, bodyAt) });
  }
  return out;
}

// ============================================================================
//  2D porkchop — the full departure×arrival Δv grid. `dvSeries` is its 1-D
//  lower-envelope slice (min over arrival for each departure); Hohmann is its
//  single min-energy point. Pure/testable. SEAM: render draws it from
//  scene.porkchop (see architecture.md).
// ============================================================================
export const TOF_FLOOR = 40 * DAY_S; // shortest sensible transfer time

// porkchop({ fromKey, toKey, depWindow:[t0,t1], arrWindow:[a0,a1], resolution,
//   bodyAt }) → { grid: Δv[dep][arr] (total dep+arr), depAxis, arrAxis,
//                 min:{depIdx,arrIdx,dv,tof,dep,arr} }.
export function porkchop({ fromKey, toKey, depWindow, arrWindow, resolution = 48, bodyAt }) {
  const [t0, t1] = depWindow;
  const [a0, a1] = arrWindow;
  const R = Math.max(2, resolution | 0);
  const depAxis = [];
  const arrAxis = [];
  for (let i = 0; i < R; i++) depAxis.push(t0 + (i / (R - 1)) * (t1 - t0));
  for (let j = 0; j < R; j++) arrAxis.push(a0 + (j / (R - 1)) * (a1 - a0));
  const grid = [];
  const min = { depIdx: -1, arrIdx: -1, dv: Infinity, tof: 0, dep: Infinity, arr: Infinity };
  for (let i = 0; i < R; i++) {
    grid[i] = [];
    for (let j = 0; j < R; j++) {
      const tof = arrAxis[j] - depAxis[i];
      let total = Infinity;
      let dep = Infinity;
      let arr = Infinity;
      if (tof > TOF_FLOOR) {
        const d = transferDvs(fromKey, toKey, depAxis[i], tof, bodyAt);
        dep = d.dep;
        arr = d.arr;
        total = dep + arr;
      }
      grid[i][j] = total;
      if (total < min.dv) {
        min.depIdx = i;
        min.arrIdx = j;
        min.dv = total;
        min.tof = tof;
        min.dep = dep;
        min.arr = arr;
      }
    }
  }
  return { grid, depAxis, arrAxis, min };
}

// Local minima of a dv series (the launch windows) — points at least as low as
// both neighbours and within `frac` of the series' floor. Returns their indices.
export function seriesMinima(series, frac = 1.15) {
  if (!series.length) return [];
  const floor = Math.min(...series.map((p) => p.dv));
  const out = [];
  for (let i = 1; i < series.length - 1; i++) {
    if (
      series[i].dv <= series[i - 1].dv &&
      series[i].dv <= series[i + 1].dv &&
      series[i].dv <= floor * frac
    ) {
      out.push(i);
    }
  }
  return out;
}
