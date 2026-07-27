// sim.js — the running simulation: the fork pair, its clock, and one step of
// all of it.
//
// `lorenz.js` is the SYSTEM (a vector field and an integrator, knowing nothing
// about twins or brushes). This is the SIMULATION over it: two trajectories, a
// clock, and a pen state for each.
//
// Everything here is pure. `step` takes a sim and returns a new one; it does
// not mutate its input. That matters for one reason beyond tidiness: this loop
// body used to live inside the animation frame, where no test could reach it,
// so the test pinning the brush model had to RE-IMPLEMENT it by hand. A test
// that re-implements the code under test pins a copy, not a contract — change
// the ordering in one and the other keeps passing. Now both run this.
//
// EACH TRAJECTORY CARRIES ITS OWN PEN. This was a real bug once: `dwell` and
// `press` were computed from the reference and then written onto BOTH trails.
// After the twins separate — the entire point of the app — the twin could be
// in the opposite wing while being colored by the reference's time-since-
// crossing, and pressing into turns it was not taking. A pen belongs to the
// hand holding it.
//
// ON ALLOCATION. `step` allocates a handful of objects per call, and a frame
// runs at most ~900 steps (realDt clamps to 0.1s, speed to 36 sim-units/sec,
// so 3.6/0.004). One step already allocates ~28 short-lived objects inside
// `rk4` and `brush`; these are noise, and all of them die in the nursery. Do
// not "optimize" into a mutating step with scratch buffers — pooling would buy
// nothing measurable and cost the property that makes this testable.
//
// Returned objects are explicit literals rather than spreads, deliberately: a
// fixed key order keeps one hidden class, and a spread would silently carry
// along any field a future edit adds.

import { DT, rk4, field, seed, perturb, phaseSpeed } from "./lorenz.js";
import { brush, smoothToward, BRUSH } from "./calligraphy.js";

/**
 * A dwell long enough that `entryWeight` has fully released. Used when seeding
 * so a pen starts at the pressure its point actually calls for, rather than
 * opening with a spurious swell up from nothing.
 */
const SETTLED = 1e3;

const penAt = (p, params) => ({
  lobeSign: Math.sign(p.x) || 1,
  lastFlipT: 0,
  press: brush(p, params, SETTLED, field).press,
});

/**
 * A fresh simulation: reference on the attractor, twin forked `eps` away.
 * `burnIn` is how far to walk before starting — varying it is what makes
 * "new seed" land somewhere different each press.
 */
export function makeSim(params, eps, burnIn = 12) {
  const a = seed(params, burnIn);
  const b = perturb(a, eps);
  return {
    a,
    b,
    t: 0,
    forkT: 0,
    eps,
    penA: penAt(a, params),
    penB: penAt(b, params),
  };
}

/**
 * Put the twin back on top of the reference. `eps` lives on the sim because it
 * defines the fork rather than the system — changing it means a new fork.
 *
 * The twin's pen is re-seeded from the reference's, because the twin now IS
 * the reference: carrying the old pen across would draw the new twin with the
 * weight of a trajectory it no longer has anything to do with.
 */
export function refork(s, eps = s.eps) {
  return {
    a: s.a,
    b: perturb(s.a, eps),
    t: s.t,
    forkT: s.t,
    eps,
    penA: s.penA,
    penB: { ...s.penA },
  };
}

/**
 * Advance one pen alongside its trajectory.
 *
 * Ordering is load-bearing: `lastFlipT` updates BEFORE the dwell that feeds the
 * brush, so on a step that crosses between wings the dwell is 0 and the entry
 * is fully pressed. Invert it and the brush enters one step late — nearly
 * invisible on screen, and exactly the kind of thing a refactor drops.
 */
function stepPen(pen, p, params, t) {
  const lobeSign = Math.sign(p.x) || pen.lobeSign;
  const lastFlipT = lobeSign !== pen.lobeSign ? t : pen.lastFlipT;
  const press = smoothToward(
    pen.press,
    brush(p, params, t - lastFlipT, field).press,
    DT,
    BRUSH.inertiaTau,
  );
  return { lobeSign, lastFlipT, press };
}

/** One integration step of both trajectories, and both pens. */
export function step(s, params) {
  const a = rk4(s.a, params, DT);
  const b = rk4(s.b, params, DT);
  const t = s.t + DT;
  return {
    a,
    b,
    t,
    forkT: s.forkT,
    eps: s.eps,
    penA: stepPen(s.penA, a, params, t),
    penB: stepPen(s.penB, b, params, t),
  };
}

/** Simulated time since the current fork began. */
export const sinceFork = (s) => s.t - s.forkT;

/** Time since a trajectory last crossed between wings. */
export const dwellOf = (s, pen) => s.t - pen.lastFlipT;

/**
 * One trail vertex. Carries STATE — never a screen position and never a color
 * — so that yaw, resize and a change of color field all re-render the existing
 * trail rather than only affecting what is drawn next.
 */
export function vertex(s, params, which, delta) {
  const p = which === "b" ? s.b : s.a;
  const pen = which === "b" ? s.penB : s.penA;
  return {
    x: p.x,
    y: p.y,
    z: p.z,
    v: phaseSpeed(p, params),
    t: s.t,
    eps: s.eps,
    delta,
    dwell: dwellOf(s, pen),
    press: pen.press,
  };
}
