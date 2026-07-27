// calligraphy.js — a brush model for the pen.
//
// A pen moving at constant speed is a plotter. A brush is not: in Chinese and
// Japanese calligraphy the speed of the stroke is itself expressive, and it
// varies to a grammar. This module borrows three ideas from that grammar,
// because the Lorenz trajectory happens to have exactly the structure they
// want.
//
// 提按 (tí àn) — LIFT AND PRESS. The brush is not held at one height. Pressing
// gives a slow, thick, saturated line; lifting gives a fast, thin one. Speed
// and weight are not independent controls, they are two readings of one
// gesture. So this model computes a single scalar, `press`, and derives speed,
// width and opacity from it rather than exposing three knobs.
//
// 轉折 (zhuǎn zhé) — TURN AND FOLD. You do not take a corner at speed. A round
// turn (轉) decelerates through the arc; an angular fold (折) stops, presses,
// and changes direction. Either way curvature is where the brush slows. This
// is the model's master signal: κ high → press high → slow and thick.
//
// 起筆 (qǐ bǐ) — THE ENTRY. A stroke does not begin at full speed. The brush
// enters deliberately, often doubling back on itself before travelling. Here a
// "stroke" is one residency in a wing, so the entry is the moment just after
// the trajectory crosses between wings, and it is pressed regardless of what
// the curvature is doing.
//
// 飛白 (fēi bái) — FLYING WHITE. Move fast enough with a dry brush and the
// hairs separate: the stroke breaks up and the paper shows through. The fast
// traverse between wings is drawn lighter for the same reason.
//
// One thing this model does NOT borrow: real calligraphy is anticipatory — the
// brush slows *before* the corner because the writer knows the character. We
// only know where the trajectory is, not where it is going, so deceleration
// here is reactive. That is a real difference and it is why the model reads as
// "responsive" rather than "composed".

// NaN-safe by construction: `NaN > 0` is false, so NaN collapses to 0 rather
// than propagating. The obvious `v < 0 ? 0 : v > 1 ? 1 : v` passes NaN through,
// and a single NaN reaching the color pipeline makes the stroke silently
// invisible — canvas discards `rgba(NaN,...)` without an error.
import { logNorm } from "./color.js";

const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);

/**
 * Measured over 400k steps on the classic attractor: κ spans about 0.027 to
 * 0.55, with the 1st–99th percentiles inside [0.027, 0.25]. The range below
 * puts the traverse near 0 and the tightest part of the inner spiral near 1.
 */
export const KAPPA_RANGE = Object.freeze({ lo: 0.03, hi: 0.3 });

export const BRUSH = Object.freeze({
  entryTau: 0.5, // sim time units the entry stroke stays pressed
  inertiaTau: 0.15, // sim time units for the brush to follow a change in press
  widthLift: 0.55, // width multiplier fully lifted
  widthPress: 2.6, // width multiplier fully pressed
  feibai: 0.55, // how translucent the fastest traverse goes
});

/** Jacobian of the Lorenz field at a state. */
export function jacobian(s, p) {
  return [
    [-p.sigma, p.sigma, 0],
    [p.rho - s.z, -1, -s.x],
    [s.y, s.x, -p.beta],
  ];
}

const apply = (J, v) => ({
  x: J[0][0] * v.x + J[0][1] * v.y + J[0][2] * v.z,
  y: J[1][0] * v.x + J[1][1] * v.y + J[1][2] * v.z,
  z: J[2][0] * v.x + J[2][1] * v.y + J[2][2] * v.z,
});

/**
 * Curvature of the trajectory, κ = |v × a| / |v|³.
 *
 * The acceleration is exact rather than a finite difference: since v = F(X),
 * a = dv/dt = J(X)·F(X). No step size, no noise, no tuning.
 */
export function curvature(s, p, fieldFn) {
  const v = fieldFn(s, p);
  const a = apply(jacobian(s, p), v);
  const cx = v.y * a.z - v.z * a.y;
  const cy = v.z * a.x - v.x * a.z;
  const cz = v.x * a.y - v.y * a.x;
  const sp = Math.hypot(v.x, v.y, v.z);
  if (!(sp > 0)) return 0;
  return Math.hypot(cx, cy, cz) / (sp * sp * sp);
}

/**
 * Log-normalize κ onto [0,1]. A thin wrapper over color.js's `logNorm` — this
 * was an independent copy of the same formula, verified bit-identical across
 * the range before being collapsed.
 */
export function kappaNorm(kappa, range = KAPPA_RANGE) {
  return kappa > 0 ? logNorm(kappa, range.lo, range.hi) : 0;
}

/** 起筆: how much of the deliberate entry is still in effect. */
export function entryWeight(sinceFlip, cfg = BRUSH) {
  if (!(cfg.entryTau > 0)) return 0;
  return Math.exp(-Math.max(0, sinceFlip) / cfg.entryTau);
}

/**
 * The one scalar. A turn presses the brush; so does the start of a stroke;
 * whichever is stronger wins, because they are the same gesture asserted for
 * different reasons — you do not get a *light* corner just because it happens
 * to fall early in a stroke.
 */
export const pressure = (kn, entry) => clamp01(Math.max(kn, entry));

/**
 * THE BRUSH HAS INERTIA.
 *
 * `pressure()` above is a TARGET, and on its own it is not smooth: `entry`
 * snaps from ~0 to 1 the instant the trajectory crosses between wings, and
 * `kappaNorm` has corners where it saturates. Driving stroke width straight
 * off that target produces exactly what it sounds like — the line changing
 * thickness in one step, which reads as a glitch rather than a gesture.
 *
 * A loaded brush cannot do that. It has mass, the hand has inertia, and the
 * ink has to travel. So the drawn pressure chases the target through a
 * first-order lag, and every visible discontinuity in the model is absorbed
 * into a curve.
 *
 * The lag is in SIMULATED time, so it is invariant to playback speed and to
 * how many steps land in a frame — the same reason the trail fade is
 * (render.js). A wall-clock filter would make the brush stiffen and soften
 * as the animation sped up.
 */
export function smoothToward(prev, target, dt, tau) {
  if (!(tau > 0) || !(dt > 0)) return target;
  return prev + (target - prev) * (1 - Math.exp(-dt / tau));
}

/** Width multiplier. Pressed is thick — 提按 in one line. */
export const widthMult = (press, cfg = BRUSH) =>
  cfg.widthLift + (cfg.widthPress - cfg.widthLift) * clamp01(press);

/** 飛白: the lifted, fast traverse goes translucent. */
export const alphaMult = (press, cfg = BRUSH) =>
  1 - cfg.feibai * Math.pow(1 - clamp01(press), 1.5);

/**
 * The TARGET pressure at one point. Deliberately does not return width or
 * alpha: those must be derived from the SMOOTHED press (see `smoothToward`),
 * and a `brush().width` sitting here would be a ready-made way to reintroduce
 * exactly the width-stepping glitch the lag exists to remove.
 *
 * `fieldFn` is passed in rather than imported, which keeps this module off
 * lorenz.js — though `jacobian` above is the Lorenz Jacobian by name, so the
 * independence is partial and should not be mistaken for genericity.
 */
export function brush(s, p, sinceFlip, fieldFn, cfg = BRUSH) {
  const kappa = curvature(s, p, fieldFn);
  const kn = kappaNorm(kappa);
  const entry = entryWeight(sinceFlip, cfg);
  return { kappa, kappaNorm: kn, entry, press: pressure(kn, entry) };
}
