// lorenz.js — the system itself. Pure, dependency-free, no DOM.
//
// Edward Lorenz, "Deterministic Nonperiodic Flow", J. Atmos. Sci. 20 (1963).
// Three ODEs distilled from Barry Saltzman's model of a fluid layer warmed
// from below (Rayleigh–Bénard convection):
//
//   dx/dt = σ (y − x)
//   dy/dt = x (ρ − z) − y
//   dz/dt = x y − β z
//
// x is proportional to convective overturning rate, y to the horizontal
// temperature difference, z to the vertical temperature profile's departure
// from linear. The famous values σ=10, ρ=28, β=8/3 are Lorenz's own.
//
// Everything here is a pure function of (state, params). The integrator is
// fixed-step RK4 and `dt` is a CONSTANT of the app, never a speed control —
// Playback speed changes how many steps we consume per frame, never the step
// size, so it provably cannot change the trajectory.

export const CLASSIC = Object.freeze({ sigma: 10, rho: 28, beta: 8 / 3 });

/** Integration step. Small enough that RK4 error is far below screen pixels. */
export const DT = 0.004;

/** Rough attractor extent in state units — used to normalize divergence. */
export const ATTRACTOR_DIAMETER = 45;

/** The vector field at a state. */
export function field(s, p) {
  return {
    x: p.sigma * (s.y - s.x),
    y: s.x * (p.rho - s.z) - s.y,
    z: s.x * s.y - p.beta * s.z,
  };
}

/** s + k·h, componentwise. */
const step = (s, k, h) => ({
  x: s.x + k.x * h,
  y: s.y + k.y * h,
  z: s.z + k.z * h,
});

/** One classical Runge–Kutta 4 step. */
export function rk4(s, p, dt = DT) {
  const k1 = field(s, p);
  const k2 = field(step(s, k1, dt / 2), p);
  const k3 = field(step(s, k2, dt / 2), p);
  const k4 = field(step(s, k3, dt), p);
  return {
    x: s.x + ((k1.x + 2 * k2.x + 2 * k3.x + k4.x) * dt) / 6,
    y: s.y + ((k1.y + 2 * k2.y + 2 * k3.y + k4.y) * dt) / 6,
    z: s.z + ((k1.z + 2 * k2.z + 2 * k3.z + k4.z) * dt) / 6,
  };
}

/** Advance n steps. */
export function advance(s, p, n, dt = DT) {
  let cur = s;
  for (let i = 0; i < n; i++) cur = rk4(cur, p, dt);
  return cur;
}

/**
 * Speed through phase space, |dX/dt|. Named `phaseSpeed`, not `speed`, because
 * this app has a second unrelated "speed" — the playback rate in director.js —
 * and callers were renaming this one on import to tell them apart.
 */
export function phaseSpeed(s, p) {
  const v = field(s, p);
  return Math.hypot(v.x, v.y, v.z);
}

/**
 * The three fixed points: the origin, and the pair C± at the centers of the
 * two wings. C± exist (and the origin loses stability) for ρ > 1.
 */
export function fixedPoints(p) {
  const origin = { x: 0, y: 0, z: 0 };
  if (p.rho <= 1) return [origin];
  const r = Math.sqrt(p.beta * (p.rho - 1));
  return [
    origin,
    { x: r, y: r, z: p.rho - 1 },
    { x: -r, y: -r, z: p.rho - 1 },
  ];
}

/**
 * Divergence of the field, ∂ẋ/∂x + ∂ẏ/∂y + ∂ż/∂z. Constant and negative:
 * every volume of initial conditions contracts at rate e^(−(σ+1+β)t) toward a
 * set of zero volume. That contraction is why an attractor exists at all —
 * and its coexistence with exponential *separation* is exactly the paradox
 * the butterfly effect names.
 */
export function contraction(p) {
  return -(p.sigma + 1 + p.beta);
}

/** Euclidean separation between two states. */
export function separation(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** A state nudged by `eps` along x — the "typo" that starts the whole story. */
export function perturb(s, eps) {
  return { x: s.x + eps, y: s.y, z: s.z };
}

/** Default seed, then a burn-in so we start ON the attractor, not near it. */
export function seed(p, burnIn = 12) {
  return advance({ x: 1, y: 1, z: 1 }, p, Math.round(burnIn / DT));
}
