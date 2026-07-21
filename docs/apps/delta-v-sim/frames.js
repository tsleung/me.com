// frames.js — pure, DOM-free reference-frame math: the six heliocentric→display
// maps (inertial / synodic / compare), the synodic geometry, the Earth–Mars
// comparison geometry, and the CR3BP Lagrange points. Must run under `node`
// (selftest asserts it).
//
// The pipeline everywhere in the app: physics lives in HELIOCENTRIC coordinates
// (sim.worldAt). A "frame" is a pure map helio → display. To draw anything in a
// frame, map its heliocentric position. The synodic frame's whole payoff — the
// pair sitting still, the L-points sitting still — falls straight out of that
// map being applied to points that co-rotate with the pair.

import { add, sub, rot, scale, mag, cross, wrapPi } from "./vec.js";
import { BODIES, DAY_S, EARTH_MOON_MU, SUN_EARTH_MU } from "./sim.js";

// ---- frame catalog ----------------------------------------------------------
export const FRAMES = {
  helio: { id: "helio", label: "heliocentric", kind: "inertial", center: "sun" },
  geo: { id: "geo", label: "geocentric", kind: "inertial", center: "earth" },
  areo: { id: "areo", label: "areocentric", kind: "inertial", center: "mars" },
  "em-syn": {
    id: "em-syn",
    label: "Earth–Moon synodic",
    kind: "synodic",
    primary: "earth",
    secondary: "moon",
    mu: EARTH_MOON_MU,
    center: "earth",
  },
  "se-syn": {
    id: "se-syn",
    label: "Sun–Earth synodic",
    kind: "synodic",
    primary: "sun",
    secondary: "earth",
    mu: SUN_EARTH_MU,
    center: "sun",
  },
  "earth-mars": {
    id: "earth-mars",
    label: "Earth–Mars comparison",
    kind: "compare",
    a: "earth",
    b: "mars",
    center: "earth",
  },
};

export const FRAME_ORDER = ["helio", "geo", "areo", "em-syn", "se-syn", "earth-mars"];

// ---- zoom-out cascade to the heliocentric container -------------------------
// Heliocentric is the universal zoom-out container. But NOT every frame needs to
// cascade into it, and cascading the wrong ones is jarring: the frame flip throws
// the focused body off-centre and drops a new origin in the middle, so the user
// loses their place mid-zoom (reported while watching a launch in geocentric).
//
// The distinction is whether a frame is a pure TRANSLATION of heliocentric, or a
// rotation / normalization:
//   • geo, areo — translations (origin moved to Earth / Mars, no rotation). Zoom
//     out and the whole system simply appears CENTRED ON THE BODY (render draws
//     every body in every frame). Nothing collapses, nothing is mis-placed — so
//     they NEVER cascade. Staying in-frame IS the smooth transition, which is what
//     the user asked for: "stay in the mode we're in, even zoomed out."
//   • em-syn, se-syn — rotating frames whose content spins at the frame's rate as
//     you pull back; earth-mars — a pinned / separation-normalized pair where zoom
//     is meaningless. These genuinely stop being legible zoomed out, so they DO
//     cascade UP to "helio" past a per-frame threshold (the camera then eases to
//     the system fit via the live-target convergence).
//
// Thresholds are in effScale = camera.scale × frameScaleFactor (helio-km → px).
// A heliocentric fit is effScale ≈ 1.4e-6 (the scale the cascade lands near).
//
//   frame        fit effScale   threshold   cascades at ~(fit/threshold)× zoom-out
//   em-syn         9.8e-4        3.0e-5      ~33×   (Earth–Moon synodic spins out)
//   se-syn         2.4e-6        1.5e-6      ~1.6×  (already ≈ Sun–Earth AU scale)
//   earth-mars     1.9e-6        1.5e-6      ~1.3×  (pinned pair; zoom-out is useless)
//
// ONE-DIRECTIONAL: heliocentric never cascades further out, and zoom-IN never
// down-cascades (no flicker) — to re-enter a local frame the user picks it or
// focuses a body.
export const CASCADE_EFFSCALE = {
  "em-syn": 3.0e-5,
  "se-syn": 1.5e-6,
  "earth-mars": 1.5e-6,
};

// Pure: the frame a given (frame, effScale) should be in on zoom-OUT. Below the
// current frame's threshold → "helio"; otherwise unchanged. Translation frames
// (geo/areo) have no threshold → always returned unchanged (they stay in-frame at
// any zoom). Heliocentric is terminal (the container never cascades further).
export function frameForZoom(frameId, effScale) {
  if (frameId === "helio") return "helio";
  const thr = CASCADE_EFFSCALE[frameId];
  return thr != null && effScale < thr ? "helio" : frameId;
}

// The comparison frame pins Earth and Mars to fixed on-screen anchors: the TRUE
// separation (which really swings 0.37–2.5 AU over the synodic cycle) is
// normalized to this constant frame distance, so both planets sit still while
// time runs. The true distance is surfaced in the HUD, never as screen motion.
export const EM_COMPARE_SEP = 3.0e8; // frame km between the two anchors
export const EM_ANCHOR_EARTH = [-EM_COMPARE_SEP / 2, 0];
export const EM_ANCHOR_MARS = [EM_COMPARE_SEP / 2, 0];

// ---- synodic geometry -------------------------------------------------------
// The angle φ of the primary→secondary line, its rotation rate ω, and the
// separation. ω = (r × v)/|r|² is the instantaneous angular velocity of the
// line — exactly what a co-rotating structure (the elevator) turns at.
export function synodicState(primaryState, secondaryState) {
  const r = sub(secondaryState.pos, primaryState.pos);
  const v = sub(secondaryState.vel, primaryState.vel);
  const sep = mag(r);
  const phi = Math.atan2(r[1], r[0]);
  const omega = cross(r, v) / (sep * sep);
  return { phi, omega, sep, r, v };
}

// ---- frame map: heliocentric point → display point --------------------------
export function frameMap(frameId, world) {
  const f = FRAMES[frameId] || FRAMES.helio;
  if (f.kind === "inertial") {
    if (f.center === "sun") return (p) => p;
    const c = world[f.center].pos;
    return (p) => sub(p, c);
  }
  if (f.kind === "compare") {
    // similarity: Earth→left anchor, Mars→right anchor, uniform scale s so the
    // pair separation is constant on screen. Uniform ⇒ all sizes (moon orbits
    // included) keep their TRUE ratios — no per-body exaggeration.
    const g = earthMarsGeometry(world);
    return (p) => add(scale(rot(sub(p, g.E), -g.phi), g.s), EM_ANCHOR_EARTH);
  }
  // synodic: translate to primary, rotate by −φ so the pair lands on +x.
  const primary = world[f.primary].pos;
  const { phi } = synodicState(world[f.primary], world[f.secondary]);
  return (p) => rot(sub(p, primary), -phi);
}

// Inverse map: display point → heliocentric point (for click-to-place).
export function frameUnmap(frameId, world) {
  const f = FRAMES[frameId] || FRAMES.helio;
  if (f.kind === "inertial") {
    if (f.center === "sun") return (p) => p;
    const c = world[f.center].pos;
    return (p) => add(p, c);
  }
  if (f.kind === "compare") {
    const g = earthMarsGeometry(world);
    return (p) => add(rot(scale(sub(p, EM_ANCHOR_EARTH), 1 / g.s), g.phi), g.E);
  }
  const primary = world[f.primary].pos;
  const { phi } = synodicState(world[f.primary], world[f.secondary]);
  return (p) => add(rot(p, phi), primary);
}

// ---- Earth–Mars comparison geometry -----------------------------------------
// The live numbers behind the pinned view: the TRUE separation (HUD), each
// planet's true solar distance, the Sun's bearing in the rotated frame (the
// arrow directions — whose sweep over time IS the synodic cycle), and the
// synodic phase / days-to-opposition.
export function earthMarsGeometry(world) {
  const E = world.earth.pos;
  const M = world.mars.pos;
  const d = sub(M, E);
  const sep = mag(d); // TRUE Earth–Mars separation, km
  const phi = Math.atan2(d[1], d[0]); // Earth→Mars line angle
  const s = EM_COMPARE_SEP / sep; // normalization scale
  // Sun direction from each planet, expressed in the rotated compare frame.
  const sunFromEarth = rot(sub(world.sun.pos, E), -phi); // = rot(−E, −φ)
  const sunFromMars = rot(sub(world.sun.pos, M), -phi);
  const bearingEarth = Math.atan2(sunFromEarth[1], sunFromEarth[0]);
  const bearingMars = Math.atan2(sunFromMars[1], sunFromMars[0]);
  // synodic phase: heliocentric angle of Mars minus Earth. 0 ⇒ opposition
  // (Sun–Earth–Mars aligned, closest); ±π ⇒ conjunction (farthest).
  const gamma = wrapPi(Math.atan2(M[1], M[0]) - Math.atan2(E[1], E[0]));
  const nE = (2 * Math.PI) / BODIES.earth.elem.period;
  const nM = (2 * Math.PI) / BODIES.mars.elem.period;
  const rate = nE - nM; // synodic drift (rad/s), Earth faster ⇒ >0
  const g2 = ((gamma % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const daysToOpposition = g2 / rate / DAY_S; // gamma decreases to 0
  return {
    E,
    M,
    sep,
    phi,
    s,
    earthSunDist: mag(E),
    marsSunDist: mag(M),
    bearingEarth,
    bearingMars,
    gamma,
    daysToOpposition,
  };
}

// ============================================================================
//  Lagrange points — CR3BP, mass parameter μ = m2/(m1+m2).
// ============================================================================

// Collinear equilibrium: root of the effective-potential gradient on the x-axis,
// in barycentric normalized units (R=1, primary at −μ, secondary at 1−μ). The
// derivative is 1 + 2(1−μ)/r1³ + 2μ/r2³ > 0 everywhere, so Newton is stable.
function collinearRoot(seed, mu) {
  let x = seed;
  for (let i = 0; i < 100; i++) {
    const u = x + mu; // x − primaryX
    const w = x - (1 - mu); // x − secondaryX
    const r1 = Math.abs(u);
    const r2 = Math.abs(w);
    const f = x - ((1 - mu) * u) / r1 ** 3 - (mu * w) / r2 ** 3;
    const fp = 1 + (2 * (1 - mu)) / r1 ** 3 + (2 * mu) / r2 ** 3;
    const dx = f / fp;
    x -= dx;
    if (Math.abs(dx) < 1e-14) break;
  }
  return x;
}

// The five Lagrange points for a pair, in SYNODIC coordinates (primary at
// origin, secondary at (+sep, 0)). L4/L5 are exact equilateral; L1/L2/L3 are
// the CR3BP roots (the (μ/3)^(1/3) Hill radius seeds Newton, then it converges
// to the true quintic root). Returns [{ name, syn:[x,y] }].
export function lagrangeSynodic(sep, mu) {
  const x2 = 1 - mu; // secondary position in barycentric units
  const rH = Math.cbrt(mu / 3); // Hill-radius seed
  const toSyn = (xb) => [(xb + mu) * sep, 0]; // barycentric → primary-origin, ×sep
  const l1 = collinearRoot(x2 - rH, mu);
  const l2 = collinearRoot(x2 + rH, mu);
  const l3 = collinearRoot(-(1 + (5 * mu) / 12), mu);
  const h = (Math.sqrt(3) / 2) * sep;
  return [
    { name: "L1", syn: toSyn(l1) },
    { name: "L2", syn: toSyn(l2) },
    { name: "L3", syn: toSyn(l3) },
    { name: "L4", syn: [0.5 * sep, h] },
    { name: "L5", syn: [0.5 * sep, -h] },
  ];
}

// Lagrange points as HELIOCENTRIC positions for the current world, so the
// renderer runs them through whatever display frame is active. In the pair's
// own synodic frame they map back to the stationary `syn` coordinates.
export function lagrangeHelio(world, frameId) {
  const f = FRAMES[frameId];
  if (!f || f.kind !== "synodic") return [];
  const primaryState = world[f.primary];
  const secondaryState = world[f.secondary];
  const { phi, sep } = synodicState(primaryState, secondaryState);
  const pts = lagrangeSynodic(sep, f.mu);
  return pts.map((p) => ({
    name: p.name,
    syn: p.syn,
    helio: add(rot(p.syn, phi), primaryState.pos),
  }));
}

// Distances of the Earth–Moon L-points (for the HUD / selftest), in km.
export function earthMoonLagrangeDistances(sep = 384400) {
  const pts = lagrangeSynodic(sep, EARTH_MOON_MU);
  const byName = Object.fromEntries(pts.map((p) => [p.name, p.syn]));
  return {
    L1_fromEarth: byName.L1[0],
    L1_fromMoon: sep - byName.L1[0],
    L2_fromEarth: byName.L2[0],
    L2_fromMoon: byName.L2[0] - sep,
    L3_fromEarth: -byName.L3[0], // L3 is on the far side of Earth (x<0)
  };
}
