// fork.js — the butterfly effect, measured.
//
// Drawing one Lorenz trajectory makes a pretty picture. It does not show the
// butterfly effect. The effect is a statement about TWO trajectories: start
// them a hair apart and they stay indistinguishable, then indistinguishable,
// then gone. This module owns that pair and the numbers that come out of it.
//
// Three quantities, in order of how much they matter:
//
//   δ(t)  separation between twin and reference
//   λ     largest Lyapunov exponent — the rate δ grows while it is still small
//   t_h   predictability horizon = (1/λ)·ln(tol/ε)
//
// t_h is the punchline. It says: halving your initial error buys you
// ln(2)/λ ≈ 0.77 more time units of forecast. Not double. A constant.
// You cannot buy your way out of chaos with better instruments.

import { DT, rk4, separation, ATTRACTOR_DIAMETER } from "./lorenz.js";

/**
 * Largest Lyapunov exponent by the Benettin algorithm: walk a reference and a
 * shadow trajectory, and every `tRenorm` measure how much the gap grew, then
 * pull the shadow back to distance d0 along the same direction. Summing the
 * logs of those growth factors and dividing by elapsed time gives λ.
 *
 * The renormalization is the whole trick — without it the gap saturates at
 * attractor diameter and the average slope collapses toward zero.
 *
 * For the classic parameters this returns ≈ 0.905.
 */
export function lyapunovBenettin(p, opts = {}) {
  const {
    dt = DT,
    d0 = 1e-9,
    tRenorm = 0.5,
    total = 200,
    burnIn = 20,
    start = { x: 1, y: 1, z: 1 },
  } = opts;

  let a = start;
  const burnSteps = Math.round(burnIn / dt);
  for (let i = 0; i < burnSteps; i++) a = rk4(a, p, dt);

  let b = { x: a.x + d0, y: a.y, z: a.z };
  const stepsPer = Math.max(1, Math.round(tRenorm / dt));
  const rounds = Math.max(1, Math.round(total / tRenorm));

  let sumLog = 0;
  let elapsed = 0;
  for (let r = 0; r < rounds; r++) {
    for (let k = 0; k < stepsPer; k++) {
      a = rk4(a, p, dt);
      b = rk4(b, p, dt);
    }
    const d = separation(a, b);
    if (!(d > 0)) break; // twin collapsed onto reference; nothing to measure
    sumLog += Math.log(d / d0);
    elapsed += stepsPer * dt;
    const f = d0 / d; // pull the shadow back in, direction preserved
    b = {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      z: a.z + (b.z - a.z) * f,
    };
  }

  return { lambda: elapsed > 0 ? sumLog / elapsed : 0, elapsed };
}

/**
 * How long until an initial error `eps` grows to `tol`.
 * The forecast horizon, in the system's own time units.
 */
export function horizon(lambda, eps, tol) {
  if (!(lambda > 0) || !(eps > 0) || !(tol > eps)) return null;
  return Math.log(tol / eps) / lambda;
}

/**
 * What a 10× better initial measurement buys you, in time units.
 * Deliberately exposed because the number is so much smaller than people
 * expect: ln(10)/0.905 ≈ 2.54.
 */
export function horizonGainPerDecade(lambda) {
  return lambda > 0 ? Math.LN10 / lambda : null;
}

/**
 * Separation normalized to [0,1] on a log scale, from the initial error up to
 * attractor diameter. 0 = "twins agree to the last bit", 1 = "the twin is
 * somewhere else entirely and knowing where it started tells you nothing".
 * This is the scalar the divergence color field reads.
 */
export function divergenceNorm(delta, eps, ceiling = ATTRACTOR_DIAMETER) {
  if (!(delta > 0) || !(eps > 0) || !(ceiling > eps)) return 0;
  const t = Math.log(delta / eps) / Math.log(ceiling / eps);
  return Math.min(1, Math.max(0, t));
}

/**
 * Least-squares slope of ln δ against t over the samples still inside the
 * exponential-growth band — above the numerical-noise floor, below the point
 * where the gap starts feeling the size of the attractor. This is the LIVE
 * estimate drawn on the chart; `lyapunovBenettin` is the careful one.
 *
 * Returns null when there isn't enough of the band to fit, which is the
 * honest answer for the first second of a fresh fork.
 */
export function fitGrowthRate(samples, eps, ceiling = ATTRACTOR_DIAMETER) {
  const lo = eps * 10;
  const hi = ceiling * 0.1;
  const band = samples.filter((s) => s.d >= lo && s.d <= hi && s.d > 0);
  if (band.length < 8) return null;

  const n = band.length;
  let st = 0;
  let sl = 0;
  let stt = 0;
  let stl = 0;
  for (const s of band) {
    const l = Math.log(s.d);
    st += s.t;
    sl += l;
    stt += s.t * s.t;
    stl += s.t * l;
  }
  const denom = n * stt - st * st;
  if (Math.abs(denom) < 1e-12) return null;
  return { lambda: (n * stl - st * sl) / denom, n, tSpan: band[band.length - 1].t - band[0].t };
}
