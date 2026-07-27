// intro.js — the opening.
//
// On first load the page is black, the pen is already moving, and the only
// interface is one small button. Everything else — masthead, readouts, legend,
// chart, notes, the frame around the stage, even the markers on the pen itself
// — arrives a few seconds later. The panel does not arrive at all until asked
// for.
//
// The reason is not restraint for its own sake. The first thing anyone should
// see is the line, and a line that starts mid-flight at full speed reads as a
// screensaver already in progress. Starting nearly still and accelerating lets
// you watch a single point become a curve become a wing, which is the order
// the thing was actually discovered in.
//
// Two schedules, both pure functions of elapsed REAL seconds since the first
// frame (paused time does not count — the opening is a thing you watch, so it
// waits when you do):
//
//   speed   ramps from `speedStart` to whatever the resting speed currently is
//   reveal  a single threshold, after which CSS handles the fade
//
// The ramp is geometric AND eased, which is deliberate double-slowness:
// `lerpGeom` alone still leaves the first second feeling brisk because speed
// is a ratio quantity, and the quadratic ease buys back the lingering start.

import { lerpGeom } from "./director.js";

export const INTRO = Object.freeze({
  speedStart: 0.3, // sim units per real second — a crawl
  rampSeconds: 26, // real seconds to reach the resting speed
  revealAt: 11, // real seconds before the chrome fades in
});

// NaN-safe by construction: `NaN > 0` is false, so NaN collapses to 0 rather
// than propagating. The obvious `v < 0 ? 0 : v > 1 ? 1 : v` passes NaN through,
// and a single NaN reaching the color pipeline makes the stroke silently
// invisible — canvas discards `rgba(NaN,...)` without an error.
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);

/** Lingers slow, then picks up. u ∈ [0,1] → eased [0,1]. */
export const introEase = (u) => {
  const t = clamp01(u);
  return t * t;
};

/** Fraction of the ramp completed. */
export function introProgress(elapsed, cfg = INTRO) {
  if (!(cfg.rampSeconds > 0)) return 1;
  return clamp01(elapsed / cfg.rampSeconds);
}

/**
 * Speed during the opening, or `null` once the opening is over — null is the
 * signal to hand control back to the hand controls and the director, rather
 * than a speed the caller has to compare against a sentinel.
 *
 * `resting` is read every frame rather than captured at load, so if the
 * director or a slider moves the target mid-ramp the opening chases it.
 */
export function introSpeed(elapsed, resting, cfg = INTRO) {
  const u = introProgress(elapsed, cfg);
  if (u >= 1) return null;
  // Never ramp *down*: if the resting speed is already slower than the
  // opening's floor, there is no opening to perform.
  const start = Math.min(cfg.speedStart, resting);
  return lerpGeom(start, resting, introEase(u));
}

/** Whether the chrome should be on screen yet. */
export function introRevealed(elapsed, cfg = INTRO) {
  return elapsed >= cfg.revealAt;
}
