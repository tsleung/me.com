// trail.js — the drawn trail: what is kept, and how it dies.
//
// WHY THIS FILE EXISTS (it reverses an earlier decision)
//
// The first renderer never kept the trail. It painted new segments onto a
// canvas that was never cleared, and aged the old ones by pulling alpha out of
// the whole surface once a frame. Cheap, and the exponential decay came free.
//
// But a per-frame multiplicative fade can produce EXACTLY ONE curve. Every
// pixel gets the same treatment every frame, so a pixel's alpha after age t is
// exp(−t/τ), always. There is no way to make old ink fade faster than young
// ink, because the surface has no idea how old any pixel is. And the tail is
// long: at τ = 5 you can still see ink from seven orbits ago at a third of its
// original strength, which is the haze that made the attractor look dirty.
//
// So the trail is kept as vertices and redrawn. That buys an arbitrary alpha
// curve, and it buys a real cutoff.
//
// THE CURVE
//
//   a(u) = (e^(−k·u) − e^(−k)) / (1 − e^(−k)),  u = age/τ, zero for u ≥ 1
//
// Exponential in shape, but shifted and normalized so it reaches exactly zero
// at the cutoff instead of asymptoting. Steeper than a plain exponential
// everywhere, and past the cutoff the ink is simply gone rather than lingering
// at one part in 255 forever. k sets how front-loaded it is.
//
// WHAT THE REWRITE ALSO FIXED, for free
//
//   · resizing no longer wipes the drawing
//   · changing the color field recolors the WHOLE trail, not just what comes next
//   · marks no longer need their own canvas — everything is redrawn anyway
//
// WHAT IT COSTS
//
// Draw calls. Mitigated by two things: the trail is short now (a real cutoff,
// not an asymptote), and attributes vary smoothly ALONG a trajectory, so
// quantizing them yields long runs of identical state — see `runKey`.

import { ringBuffer } from "./history.js";

/** Vertices kept per trajectory. Caps both memory and per-frame draw cost. */
export const MAX_VERTS = 1200;

/** How front-loaded the decay is. Higher = more of the trail is faint. */
export const FADE_K = 4;

/**
 * Trail opacity at normalized age u ∈ [0,∞). Exactly 1 at u=0, exactly 0 at
 * u ≥ 1, exponential in between.
 */
export function trailAlpha(u, k = FADE_K) {
  if (!(u > 0)) return 1;
  if (u >= 1) return 0;
  if (!(k > 0)) return 1 - u; // degenerate k: fall back to linear, never NaN
  const e = Math.exp(-k);
  return (Math.exp(-k * u) - e) / (1 - e);
}

/**
 * One trajectory's vertex history, with emission gated so that a trail of any
 * length is stored at roughly MAX_VERTS resolution. Long trails are recorded
 * more coarsely rather than more expensively — the alternative is a vertex
 * count that scales with the trail control, which is how a smooth app becomes
 * a slideshow at the far end of a slider.
 */
export function makeTrail(capacity = MAX_VERTS) {
  const buf = ringBuffer(capacity);
  let nextEmitAt = -Infinity;

  return {
    /** Record `sample` if enough simulated time has passed. */
    record(sample, t, trailSpan) {
      if (t < nextEmitAt) return false;
      const spacing = Math.max(1e-9, trailSpan / capacity);
      nextEmitAt = t + spacing;
      buf.push(sample);
      return true;
    },
    clear() {
      buf.clear();
      nextEmitAt = -Infinity;
    },
    samples: () => buf.toArray(),
    get size() {
      return buf.size;
    },
  };
}

/**
 * A packed integer identifying "same pen state". Segments sharing a key can be
 * stroked as one path, which is the whole performance argument for redrawing:
 * color, alpha and width all vary SMOOTHLY along a trajectory, so quantizing
 * them turns 1200 segments into a few dozen runs.
 *
 * 5 bits per color channel, 8 bits of alpha, 6 bits of width — 29 bits, still
 * inside the 31-bit range where JS bitwise ops stay exact.
 *
 * Alpha gets 8 bits rather than 5 for a specific reason. Blend modes scale the
 * whole alpha range: `density` caps at 0.075, so with a 5-bit field quantizing
 * over [0,1] the entire fade from full to gone collapsed into THREE buckets —
 * and since a run keeps the strokeStyle of its first segment, the carefully
 * shaped fade curve rendered as three flat steps. 8 bits keeps ~19 distinct
 * levels even at the narrowest blend.
 */
export function runKey(rgb, alpha, width) {
  const a = Math.min(255, Math.max(0, Math.round(alpha * 255)));
  const w = Math.min(63, Math.max(0, Math.round(width * 4)));
  return (
    (rgb.r >> 3) |
    ((rgb.g >> 3) << 5) |
    ((rgb.b >> 3) << 10) |
    (a << 15) |
    (w << 23)
  );
}
