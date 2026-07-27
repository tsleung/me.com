// pen.js — how a vertex becomes ink.
//
// Four independent things decide what a segment looks like: the color formula
// (color.js), the brush weight (calligraphy.js), the blend preset, and the
// twin's subordination. Composing them belongs to none of those modules, and
// it was living inside a closure in the animation frame where nothing could
// test it. `render.js`'s `attrs` callback is the seam; this is what plugs in.
//
// The blend presets live here rather than in render.js because a blend is a
// property of the pen, not of the painter — render.js never reads them.

import { colorFor, widthFor, BASE_WIDTH } from "./color.js";
import { widthMult, alphaMult } from "./calligraphy.js";

/**
 * The twin draws thinner and fainter than the reference.
 *
 * It keeps the SAME color formula on purpose — while the two trajectories
 * agree you should not be able to tell which is which, and that is the whole
 * demonstration. But once they separate, two equally weighted lines read as a
 * rendering fault rather than as the point. Weight only: never a hue, never a
 * different palette.
 */
export const TWIN = Object.freeze({ width: 0.62, ink: 0.55 });

export const BLENDS = Object.freeze({
  filament: {
    label: "filament",
    op: "source-over",
    alpha: 0.85,
    widthScale: 1,
    blurb: "One readable line. Use with a short trail.",
  },
  density: {
    label: "density",
    op: "lighter",
    alpha: 0.075,
    widthScale: 0.8,
    blurb:
      "Additive. Overlaps accumulate, so a long trail renders the attractor's " +
      "invariant measure — where the system actually spends its time — as glow.",
  },
});

export const BLEND_KEYS = Object.keys(BLENDS);

/**
 * Build the per-vertex attribute function `drawTrail` expects.
 *
 * @param {object} cfg
 *   field, palette   color.js keys
 *   blend            a BLENDS key
 *   calligraphic     true when the brush owns weight and ink
 *   dim              true for the twin
 * @returns {(sample, fade) => {rgb, width, alpha}}
 *
 * `fade` comes from the trail's own age curve (trail.js) and is multiplied in
 * last, so the cutoff cannot be overridden by a blend or by the brush.
 */
export function attrsFor(cfg) {
  const { field, palette, calligraphic = false, dim = false } = cfg;
  const blend = BLENDS[cfg.blend] ?? BLENDS.filament;
  const widthScale = blend.widthScale * (dim ? TWIN.width : 1);
  const inkScale = blend.alpha * (dim ? TWIN.ink : 1);

  return (s, fade) => ({
    rgb: colorFor(s, field, palette).rgb,
    width: (calligraphic ? widthMult(s.press) * BASE_WIDTH : widthFor(s.v)) * widthScale,
    alpha: fade * inkScale * (calligraphic ? alphaMult(s.press) : 1),
  });
}
