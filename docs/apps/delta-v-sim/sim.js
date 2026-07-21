// sim.js — the PHYSICS / STATE core for delta-v-sim: constants, the body
// catalog, and the heliocentric world state at time t (Keplerian, patched-conic,
// side-effect-free). No canvas, no window, no d3 — imports cleanly under `node`.
// Vector math lives in vec.js; the Kepler solvers in kepler.js; the craft /
// hohmann / elevator TOOLS in their own modules.
//
// Conventions:
//   - Positions/velocities are 2D vectors [x, y]. Units: km and km/s.
//   - Time `t` is seconds since the sim epoch (2026-07-20, illustrative).
//   - "state" = { pos:[x,y], vel:[vx,vy] }, always heliocentric unless noted.
//
// Fidelity is documented in notes/delta-v-sim/requirements.md: coplanar 2D,
// real orbital elements, real constants, illustrative phasing, bodies NOT to
// physical scale (distances are).

import { add } from "./vec.js";
import { solveKeplerElliptic, trueFromEccentric } from "./kepler.js";

// ---- constants (match notes/delta-v/research/windows-and-transfers.md) ------
export const AU_KM = 1.495978707e8; // IAU 2012 definition
export const MU_SUN = 1.32712440018e11; // km^3/s^2 (JPL DE)
export const MU_EARTH = 3.986004418e5; // km^3/s^2
export const MU_MOON = 4.9028695e3; // km^3/s^2
export const MU_MARS = 4.282837e4; // km^3/s^2 (JPL) — governs Phobos/Deimos
export const DAY_S = 86400;
export const YEAR_S = 365.25 * DAY_S;

// Body masses (kg) — only their RATIO matters, for the CR3BP Lagrange points.
export const M_SUN = 1.98892e30;
export const M_EARTH = 5.97219e24;
export const M_MOON = 7.34767e22;
// μ = m2 / (m1 + m2), the CR3BP mass parameter of the secondary.
export const EARTH_MOON_MU = M_MOON / (M_EARTH + M_MOON); // ~0.012150
export const SUN_EARTH_MU = M_EARTH / (M_SUN + M_EARTH); // ~3.003e-6

export const EPOCH_ISO = "2026-07-20T00:00:00Z";

// ---- Keplerian orbital elements → state (relative to the primary) -----------
// elem: { a (km), e, argp (rad, longitude of periapsis), M0 (rad at epoch),
//         period (s), mu (km^3/s^2) }. Coplanar; returns { pos, vel } relative
// to the primary body (add the primary's own state for heliocentric).
export function elementState(elem, t) {
  const { a, e, argp, M0, period, mu } = elem;
  const n = (2 * Math.PI) / period; // mean motion from the stated period
  const M = M0 + n * t;
  const E = solveKeplerElliptic(M, e);
  const nu = trueFromEccentric(E, e);
  const r = a * (1 - e * Math.cos(E));
  const theta = argp + nu; // position angle in the (coplanar) frame
  const pos = [r * Math.cos(theta), r * Math.sin(theta)];
  // velocity from specific angular momentum
  const h = Math.sqrt(mu * a * (1 - e * e));
  const vr = (mu / h) * e * Math.sin(nu); // radial
  const vt = h / r; // transverse
  const rhat = [Math.cos(theta), Math.sin(theta)];
  const that = [-Math.sin(theta), Math.cos(theta)];
  const vel = [vr * rhat[0] + vt * that[0], vr * rhat[1] + vt * that[1]];
  return { pos, vel, r, nu, E };
}

// ---- the body catalog -------------------------------------------------------
// argp / M0 are illustrative (see requirements.md), chosen for a legible
// starting spread — NOT a real ephemeris. Orbits themselves are physical.
export const BODIES = {
  sun: {
    key: "sun",
    name: "Sun",
    primary: null,
    role: "star",
    color: "#ffd25a",
    glow: "#ffb638",
    radiusPx: 15,
    mu: MU_SUN,
  },
  earth: {
    key: "earth",
    name: "Earth",
    primary: "sun",
    role: "planet",
    color: "#5aa9ff",
    glow: "#2f7fe0",
    radiusPx: 7,
    mu: MU_EARTH,
    elem: {
      a: 1.00000261 * AU_KM,
      e: 0.0167,
      argp: (102.9 * Math.PI) / 180,
      M0: (100.0 * Math.PI) / 180,
      period: 365.25 * DAY_S,
      mu: MU_SUN,
    },
  },
  mars: {
    key: "mars",
    name: "Mars",
    primary: "sun",
    role: "planet",
    color: "#ff6a4a",
    glow: "#d8452a",
    radiusPx: 5.5,
    mu: MU_MARS,
    elem: {
      a: 1.52371034 * AU_KM,
      e: 0.0934,
      argp: (336.0 * Math.PI) / 180,
      M0: (23.0 * Math.PI) / 180,
      period: 686.98 * DAY_S,
      mu: MU_SUN,
    },
  },
  // Mars's moons — VERIFIED elements (JPL / NASA fact sheets):
  //   Phobos a=9,376 km, e=0.0151, T=0.31891 d (7h 39.2m); GM_mars=4.282837e4
  //   ⇒ T=2π√(a³/μ)=0.319 d, self-consistent.
  //   Deimos a=23,463 km, e=0.00033, T=1.26244 d (30h 18m) ⇒ 1.263 d, consistent.
  phobos: {
    key: "phobos",
    name: "Phobos",
    primary: "mars",
    role: "moon",
    color: "#b8a898",
    glow: "#7a6f60",
    radiusPx: 2.4,
    mu: 7.11e-4, // GM_Phobos (tiny; only used if a craft ever orbits it)
    elem: {
      a: 9376,
      e: 0.0151,
      argp: (150.0 * Math.PI) / 180,
      M0: (10.0 * Math.PI) / 180,
      period: 0.31891 * DAY_S,
      mu: MU_MARS,
    },
  },
  deimos: {
    key: "deimos",
    name: "Deimos",
    primary: "mars",
    role: "moon",
    color: "#a9a096",
    glow: "#6f685e",
    radiusPx: 2.2,
    mu: 9.6e-5, // GM_Deimos
    elem: {
      a: 23463,
      e: 0.00033,
      argp: (300.0 * Math.PI) / 180,
      M0: (200.0 * Math.PI) / 180,
      period: 1.26244 * DAY_S,
      mu: MU_MARS,
    },
  },
  moon: {
    key: "moon",
    name: "Moon",
    primary: "earth",
    role: "moon",
    color: "#c8c8cf",
    glow: "#8a8a94",
    radiusPx: 3.5,
    mu: MU_MOON,
    elem: {
      a: 384400,
      e: 0.0549,
      argp: (60.0 * Math.PI) / 180,
      M0: (210.0 * Math.PI) / 180,
      period: 27.321661 * DAY_S,
      mu: MU_EARTH,
    },
  },
};

export const BODY_KEYS = ["sun", "earth", "moon", "mars", "phobos", "deimos"];

// Heliocentric state of every body at time t. Satellites = primary + relative.
export function worldAt(t) {
  const out = {};
  out.sun = { pos: [0, 0], vel: [0, 0] };
  const e = elementState(BODIES.earth.elem, t);
  out.earth = { pos: e.pos, vel: e.vel };
  const m = elementState(BODIES.mars.elem, t);
  out.mars = { pos: m.pos, vel: m.vel };
  const moonRel = elementState(BODIES.moon.elem, t);
  out.moon = { pos: add(out.earth.pos, moonRel.pos), vel: add(out.earth.vel, moonRel.vel) };
  const phRel = elementState(BODIES.phobos.elem, t);
  out.phobos = { pos: add(out.mars.pos, phRel.pos), vel: add(out.mars.vel, phRel.vel) };
  const deRel = elementState(BODIES.deimos.elem, t);
  out.deimos = { pos: add(out.mars.pos, deRel.pos), vel: add(out.mars.vel, deRel.vel) };
  return out;
}

// A body's orbit trace (relative to its primary), as a closed polyline of [x,y].
export function orbitTrace(bodyKey, samples = 256) {
  const b = BODIES[bodyKey];
  if (!b || !b.elem) return [];
  const { a, e, argp } = b.elem;
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const nu = (i / samples) * 2 * Math.PI;
    const r = (a * (1 - e * e)) / (1 + e * Math.cos(nu));
    const theta = argp + nu;
    pts.push([r * Math.cos(theta), r * Math.sin(theta)]);
  }
  return pts;
}
