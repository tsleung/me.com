// controls.js — slider geometry.
//
// Every continuous control here is a RATIO quantity: speed, trail length, and
// the fork separation ε all span orders of magnitude, and what matters is the
// factor between two settings rather than the difference. So the sliders are
// geometric — equal travel gives equal ratio — and the raw 0..1000 track
// position is mapped through logs at both ends.
//
// The ranges live here as one table because they were previously written out at
// each call site: ε appeared three separate times, and the "Lorenz's rounding"
// preset button read it a fourth. Change one and the thumb silently parks in
// the wrong place, with nothing to notice.

import { SPEED_LIMITS, TRAIL_LIMITS } from "./director.js";

/** Raw track positions. Matches `min`/`max` on the range inputs in index.html. */
export const TRACK = Object.freeze({ min: 0, max: 1000 });

/**
 * ε spans twelve decades: from well below anything a measurement could resolve
 * up to a tenth, which is a difference you could see by eye.
 */
export const EPS_LIMITS = Object.freeze({ min: 1e-12, max: 1e-1 });

export const SLIDERS = Object.freeze({
  speed: SPEED_LIMITS,
  trail: TRAIL_LIMITS,
  eps: EPS_LIMITS,
});

/** Track position → value. */
export function fromSlider(raw, { min, max }) {
  const t = Math.min(TRACK.max, Math.max(TRACK.min, raw)) / TRACK.max;
  return min * Math.pow(max / min, t);
}

/** Value → track position. The exact inverse of `fromSlider`. */
export function toSlider(v, { min, max }) {
  const clamped = Math.min(max, Math.max(min, v));
  return (TRACK.max * Math.log(clamped / min)) / Math.log(max / min);
}
