// structures.js — the launch-STRUCTURES catalog: the physical megastructures
// (mass driver, skyhook, lunar space elevator) as SIMULATED objects. Keyed by the
// SAME id as infra.LAUNCH_METHODS, so a structure and its launch-method knob are
// two halves of ONE row: infra.dvRemoved DERIVES from `exitVel` here (never a
// second, drifting number — design 2026-07-23 Part 2). Pure/DOM-free.
//
// `releaseState(world, params) → { pos, vel }` (heliocentric) is ANALYTIC — the
// engine has no integrator, so a structure is an analytic constraint that produces
// a release state, handed to the existing conic machinery (like elevator.js, which
// is folded in below as the first row). No per-tier timestep is needed.
//
// Rendering these as objects is Wave 3 (extentKm feeds an illustrative glyph); this
// module is the physics/data layer only.

import { add, sub, mag } from "./vec.js";
import { MU_EARTH, MU_MOON, BODIES } from "./sim.js";
import { elevatorReleaseState } from "./elevator.js";
import { TIER } from "./tiers.js";

// Measured body radii (km) the surface-mounted structures launch from — read from
// the ONE catalog (sim.BODIES.radius) now (2026-07-24), no longer duplicated here.
export const R_EARTH_KM = BODIES.earth.radius;
export const R_MOON_KM = BODIES.moon.radius;

// Radial / prograde-tangent unit vectors at angle θ around a body (CCW prograde).
function frame(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { rHat: [c, s], tHat: [-s, c] };
}

// ---- the catalog ------------------------------------------------------------
// exitVel : km/s the structure imparts, the number infra derives dvRemoved from.
//           null ⇒ "rides to the balance point" (removes ALL of surface→orbit) —
//           the space elevator.
// extentKm: TRUE physical extent, for the Wave-3 illustrative glyph.
// tier    : provenance of exitVel/extent (see tiers.js).
export const STRUCTURES = {
  "mass-driver": {
    id: "mass-driver",
    label: "mass driver",
    hostBody: "moon",
    kind: "track", // a surface EM launcher
    // O'Neill lunar mass driver: 2,400 m/s exit — comfortably > lunar escape
    // (2.38 km/s): the Moon is a body you can throw off of electromagnetically.
    exitVel: 2.4,
    extentKm: 10, // illustrative track length (the O'Neill design gives no single figure)
    tier: TIER.CITED_PROPOSAL,
    cite: "launch-and-velocity-transfer.md §A2 mass driver",
    // Payload leaves the lunar surface at `exitVel` RELATIVE TO THE MOON, launched
    // prograde along the track → a Moon-relative hyperbola (2.4 > v_esc 2.38).
    releaseState(world, params = {}) {
      const angle = params.angle || 0;
      const { rHat, tHat } = frame(angle);
      const speed = params.exitVel != null ? params.exitVel : this.exitVel;
      const pos = add(world.moon.pos, [R_MOON_KM * rHat[0], R_MOON_KM * rHat[1]]);
      const vel = add(world.moon.vel, [speed * tHat[0], speed * tHat[1]]);
      return { pos, vel, host: "moon", mu: MU_MOON };
    },
  },
  skyhook: {
    id: "skyhook",
    label: "skyhook / rotovator",
    hostBody: "earth",
    kind: "tether", // a rotating momentum-exchange tether in LEO
    // MXER (NASA ~2001): a rotating tether boosts a payload by ~2.4 km/s. This is
    // the CONSERVATIVE end of the research's 2.4–4 km/s range (the old 3.2 was an
    // untraceable mid-band pick) — the knob under-promises. Reboost NOT modeled.
    exitVel: 2.4,
    altKm: 350, // tether-centre LEO altitude
    extentKm: 100, // MXER tether length (75–100 km)
    tier: TIER.CITED_PROPOSAL,
    cite: "launch-and-velocity-transfer.md §B1 skyhook",
    reboostNote: "each throw drops the tether into a lower orbit; reboost not modeled",
    // Payload caught at the tip and released at the top of the rotation: it leaves
    // at the tether centre's circular speed PLUS the tip speed, prograde, from the
    // tip radius — a boosted Earth-relative orbit.
    releaseState(world, params = {}) {
      const angle = params.angle || 0;
      const { rHat, tHat } = frame(angle);
      const tip = params.tipVel != null ? params.tipVel : this.exitVel;
      const rCentre = R_EARTH_KM + this.altKm;
      const vCirc = Math.sqrt(MU_EARTH / rCentre); // tether-centre circular speed
      const rTip = rCentre + this.extentKm;
      const speed = vCirc + tip;
      const pos = add(world.earth.pos, [rTip * rHat[0], rTip * rHat[1]]);
      const vel = add(world.earth.vel, [speed * tHat[0], speed * tHat[1]]);
      return { pos, vel, host: "earth", mu: MU_EARTH };
    },
  },
  "space-elevator": {
    id: "space-elevator",
    label: "space elevator",
    hostBody: "moon",
    kind: "strut", // a strut fixed in the Earth–Moon synodic frame, toward L1
    exitVel: null, // rides to the balance point → removes ALL of surface→orbit
    extentKm: 58020, // near-side reach toward Earth–Moon L1 (~56,315 km + Moon radius)
    tier: TIER.CITED_PROPOSAL,
    cite: "launch-and-velocity-transfer.md §A1 space elevator",
    // Delegates to elevator.js (the model this catalog UNIFIES): release a payload
    // dFromMoon up the strut; v = v_moon + ω × offset. `params.dFromMoon` (default
    // the extent). Returns the heliocentric release state (an inertial payload).
    releaseState(world, params = {}) {
      const d = params.dFromMoon != null ? params.dFromMoon : this.extentKm;
      const rel = elevatorReleaseState(world, d);
      return { pos: rel.pos, vel: rel.vel, host: "moon", mu: MU_MOON };
    },
  },
};

export const STRUCTURE_IDS = Object.keys(STRUCTURES);

// The single derivation the launch-infra knob reads: the surface→orbit Δv a
// structure removes at a body, GIVEN that body's surface→orbit budget. `exitVel`
// caps it (the machine can only impart so much); a null exitVel (elevator) rides
// to the balance point and removes all. This is why infra.dvRemoved can't drift
// from the simulated object — they read the same field.
export function dvRemovedByStructure(id, surfaceToOrbitKmS) {
  const s = STRUCTURES[id];
  if (!s) return 0;
  if (s.exitVel == null) return surfaceToOrbitKmS; // rides to the balance point
  return Math.min(s.exitVel, surfaceToOrbitKmS);
}

// Speed of a release state relative to its host body (km/s) — the escape check.
export function speedRelHost(world, releaseState) {
  const host = releaseState.host;
  return mag(sub(releaseState.vel, world[host].vel));
}
