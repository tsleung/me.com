// hohmann.js — the Hohmann-transfer TOOL (heliocentric, circular-coplanar).
// Verified against notes/delta-v/research/windows-and-transfers.md: Earth→Mars
// departure Δv = 2.945 km/s. Pure.
//
// ROLE: this module is now a TEST ORACLE. `transfer.js`'s Lambert solver is the
// production path; Hohmann is the closed-form 180° degenerate case the selftest
// cross-checks `transfer.js` against (imported only by selftest.js / core.test.js).

import { BODIES, MU_SUN, DAY_S } from "./sim.js";

export function hohmannEarthMars() {
  const r1 = BODIES.earth.elem.a; // Earth heliocentric radius (semi-major)
  const r2 = BODIES.mars.elem.a; // Mars heliocentric radius
  return hohmann(r1, r2, MU_SUN);
}

// General Hohmann between two circular radii around a primary of gravitational
// parameter mu. Δv1 = heliocentric departure impulse (= v_inf at Earth).
export function hohmann(r1, r2, mu) {
  const v1 = Math.sqrt(mu / r1); // circular speed at departure
  const v2 = Math.sqrt(mu / r2); // circular speed at arrival
  const at = (r1 + r2) / 2; // transfer semi-major axis
  const vPeri = Math.sqrt(mu * (2 / r1 - 1 / at)); // speed at transfer periapsis
  const vApo = Math.sqrt(mu * (2 / r2 - 1 / at)); // speed at transfer apoapsis
  const dv1 = vPeri - v1; // departure burn (prograde)
  const dv2 = v2 - vApo; // arrival circularization burn
  const tof = Math.PI * Math.sqrt((at * at * at) / mu); // half-period, seconds
  const eT = Math.abs(r2 - r1) / (r2 + r1);
  return {
    r1,
    r2,
    at,
    eT,
    dv1: Math.abs(dv1),
    dv2: Math.abs(dv2),
    dvTotal: Math.abs(dv1) + Math.abs(dv2),
    tof,
    tofDays: tof / DAY_S,
  };
}
