// spacecraft.js — the spacecraft TOOL: two-body conic classification, sampling,
// and Kepler propagation of a placed craft. Pure. A craft is built by makeCraft
// / craftFromCircular and advanced by craftStateAt; render draws sampleConic.

import { mag, cross, dot, wrapPi } from "./vec.js";
import {
  solveKeplerElliptic,
  solveKeplerHyperbolic,
  trueFromEccentric,
  eccentricFromTrue,
} from "./kepler.js";

// Classify a state (position/velocity RELATIVE to the primary) into orbital
// elements. Returns everything the HUD shows + what sampling/propagation need.
export function orbitFromState(r, v, mu) {
  const rMag = mag(r);
  const vMag = mag(v);
  const energy = (vMag * vMag) / 2 - mu / rMag; // specific orbital energy
  const a = -mu / (2 * energy); // <0 for hyperbola
  const h = cross(r, v); // scalar angular momentum (signed)
  // eccentricity vector: ((v^2 - mu/r) r - (r·v) v) / mu
  const rv = dot(r, v);
  const ex = ((vMag * vMag - mu / rMag) * r[0] - rv * v[0]) / mu;
  const ey = ((vMag * vMag - mu / rMag) * r[1] - rv * v[1]) / mu;
  const e = Math.hypot(ex, ey);
  const argp = Math.atan2(ey, ex); // periapsis direction
  const type = e < 1 - 1e-9 ? "ellipse" : e > 1 + 1e-9 ? "hyperbola" : "parabola";
  const rp = a * (1 - e); // periapsis radius (finite for ellipse & hyperbola)
  const ra = e < 1 ? a * (1 + e) : Infinity; // apoapsis (ellipse only)
  const period = e < 1 ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : Infinity;
  const vinf = e > 1 ? Math.sqrt(-mu / a) : 0; // hyperbolic excess speed
  const prograde = h >= 0 ? 1 : -1; // orbit sense (CCW positive)
  return { a, e, argp, energy, h, rp, ra, period, vinf, type, mu, r0: r, v0: v, prograde };
}

// Sample a conic's shape (relative to the primary) as a polyline for drawing.
// Ellipse: full loop. Hyperbola: the swept arc within a plotting window.
export function sampleConic(el, samples = 360) {
  const { a, e, argp, prograde } = el;
  const p = a * (1 - e * e); // semi-latus rectum (>0 for both ellipse & hyperbola)
  const pts = [];
  if (e < 1) {
    for (let i = 0; i <= samples; i++) {
      const nu = (i / samples) * 2 * Math.PI;
      const r = p / (1 + e * Math.cos(nu));
      const theta = argp + prograde * nu;
      pts.push([r * Math.cos(theta), r * Math.sin(theta)]);
    }
  } else {
    const nuMax = Math.acos(-1 / e) - 1e-3; // asymptote
    for (let i = 0; i <= samples; i++) {
      const nu = -nuMax + (i / samples) * 2 * nuMax;
      const r = p / (1 + e * Math.cos(nu));
      if (r <= 0) continue;
      const theta = argp + prograde * nu;
      pts.push([r * Math.cos(theta), r * Math.sin(theta)]);
    }
  }
  return pts;
}

// Build a propagatable craft from a state relative to `primaryKey` at t0.
export function makeCraft(rRel, vRel, mu, primaryKey, t0, label = "craft") {
  const el = orbitFromState(rRel, vRel, mu);
  // Anchor the mean anomaly at t0 so craftStateAt round-trips exactly.
  const nu0 = wrapPi(Math.atan2(rRel[1], rRel[0]) - el.argp) * el.prograde;
  let M0;
  if (el.e < 1) {
    const E0 = eccentricFromTrue(nu0, el.e);
    M0 = E0 - el.e * Math.sin(E0);
  } else {
    const H0 = 2 * Math.atanh(Math.sqrt((el.e - 1) / (el.e + 1)) * Math.tan(nu0 / 2));
    M0 = el.e * Math.sinh(H0) - H0;
  }
  return { ...el, primaryKey, t0, M0, label };
}

// State of a craft (relative to its primary) at absolute time t.
export function craftStateAt(craft, t) {
  const { a, e, mu, argp, prograde, t0, M0 } = craft;
  const p = a * (1 - e * e);
  let nu, r;
  if (e < 1) {
    const n = Math.sqrt(mu / (a * a * a));
    const M = M0 + prograde * n * (t - t0);
    const E = solveKeplerElliptic(M, e);
    nu = trueFromEccentric(E, e);
    r = a * (1 - e * Math.cos(E));
  } else {
    const n = Math.sqrt(mu / (-a * -a * -a));
    const M = M0 + prograde * n * (t - t0);
    const H = solveKeplerHyperbolic(M, e);
    nu = 2 * Math.atan2(Math.sqrt(e + 1) * Math.sinh(H / 2), Math.sqrt(e - 1) * Math.cosh(H / 2));
    r = p / (1 + e * Math.cos(nu));
  }
  const theta = argp + prograde * nu;
  return { pos: [r * Math.cos(theta), r * Math.sin(theta)], nu, r };
}

// Place a craft in a CIRCULAR orbit of radius rCirc around `primaryKey`, at a
// given phase angle, then apply a Δv. dv = { prograde, radial } in km/s.
export function craftFromCircular(primaryKey, rCirc, phase, dv, t0, mu) {
  const pos = [rCirc * Math.cos(phase), rCirc * Math.sin(phase)];
  const vCirc = Math.sqrt(mu / rCirc);
  // prograde (CCW) unit = tangent; radial unit = outward.
  const rhat = [Math.cos(phase), Math.sin(phase)];
  const that = [-Math.sin(phase), Math.cos(phase)];
  const dp = dv && dv.prograde ? dv.prograde : 0;
  const dr = dv && dv.radial ? dv.radial : 0;
  const vel = [that[0] * (vCirc + dp) + rhat[0] * dr, that[1] * (vCirc + dp) + rhat[1] * dr];
  return makeCraft(pos, vel, mu, primaryKey, t0, "craft");
}
