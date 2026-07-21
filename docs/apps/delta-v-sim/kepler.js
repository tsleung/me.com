// kepler.js — Kepler's equation solvers and anomaly conversions. Pure, reusable
// by both the body catalog (sim.js) and the two-body craft propagation
// (spacecraft.js) — and by the future transfer/Lambert module. Depends only on
// the angle helper in vec.js.

import { wrapPi } from "./vec.js";

// Elliptic: solve M = E - e·sinE for E (Newton–Raphson, robust seed).
export function solveKeplerElliptic(M, e, tol = 1e-12, maxIter = 60) {
  const Mw = wrapPi(M);
  let E = e < 0.8 ? Mw : Math.PI * Math.sign(Mw || 1);
  for (let i = 0; i < maxIter; i++) {
    const f = E - e * Math.sin(E) - Mw;
    const fp = 1 - e * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    if (Math.abs(dE) < tol) break;
  }
  return E;
}

// Hyperbolic: solve M = e·sinhH - H for H.
export function solveKeplerHyperbolic(M, e, tol = 1e-12, maxIter = 100) {
  // Seed per Prussing & Conway.
  let H = Math.asinh(M / e) || (M >= 0 ? 1 : -1);
  if (!isFinite(H)) H = Math.sign(M || 1);
  for (let i = 0; i < maxIter; i++) {
    const f = e * Math.sinh(H) - H - M;
    const fp = e * Math.cosh(H) - 1;
    const dH = f / fp;
    H -= dH;
    if (Math.abs(dH) < tol) break;
  }
  return H;
}

// true anomaly from eccentric anomaly (elliptic).
export function trueFromEccentric(E, e) {
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}
// eccentric anomaly from true anomaly (elliptic).
export function eccentricFromTrue(nu, e) {
  return 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
}
