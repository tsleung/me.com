// color.js — the color formula, and the reasoning behind it.
//
// THE CHANNEL BUDGET
//
// A drawn trajectory has five channels available: position, hue, lightness,
// stroke width, and opacity. Every channel you couple to the same underlying
// variable costs you an independent reading. Five channels all singing the
// same note is a gorgeous image that says exactly one thing. So each is
// assigned deliberately, once:
//
//   position   → the state itself (projected 3D → 2D)
//   hue + L    → ONE selectable scalar field F  (this file)
//   width      → |dX/dt|, speed through phase space
//   opacity    → age, via the renderer's exponential trail fade
//
// THE FORMULA
//
//   f = F(sample) ∈ [0,1]                  the selected field, normalized
//   H = H₀ + arc · f                       hue, inside a NARROW arc
//   C = C₀                                 chroma, constant per palette
//   L = L₀ + (L₁ − L₀) · f                 lightness carries the magnitude
//   α = exp(−age / τ)                      applied by the renderer's fade
//   w = w₀ · (0.55 + 1.45 · speedNorm)     stroke width
//
// WHY OKLCH AND WHY A NARROW ARC
//
// Rotating raw HSL hue across a full wheel produces false structure: yellow
// is much lighter than blue at the same nominal "lightness", so a smooth
// scalar picks up bright bands that look like features of the attractor and
// are actually artifacts of the color space. OKLCH is perceptually uniform,
// so equal steps in L look equal. Keeping the hue sweep to a narrow arc
// (~70°) and putting the real magnitude on L is the standard sequential-ramp
// discipline: hue for identity, lightness for amount.
//
// The `spectrum` palette deliberately breaks this rule with a 150° arc. It is
// kept because it is beautiful and because seeing the banding it introduces,
// next to a well-behaved ramp, teaches the rule better than the rule does.
//
// OKLab is Björn Ottosson's (2020). The matrices below are his.

import { divergenceNorm } from "./fork.js";

// ---------------------------------------------------------------- OKLCH → sRGB

const srgbEncode = (c) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

/**
 * OKLCH → sRGB. L ∈ [0,1], C ≥ 0 (~0.37 max in gamut), H in DEGREES.
 * Out-of-gamut results are clipped per channel, which is fine for the narrow,
 * moderate-chroma ramps used here.
 */
export function oklchToRgb(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: clamp255(
      srgbEncode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    ),
    g: clamp255(
      srgbEncode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    ),
    b: clamp255(
      srgbEncode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ),
  };
}

export const cssRgb = ({ r, g, b }) => `rgb(${r},${g},${b})`;
export const cssRgba = ({ r, g, b }, alpha) =>
  `rgba(${r},${g},${b},${alpha.toFixed(3)})`;

// ------------------------------------------------------------------- the fields

// NaN-safe by construction: `NaN > 0` is false, so NaN collapses to 0 rather
// than propagating. The obvious `v < 0 ? 0 : v > 1 ? 1 : v` passes NaN through,
// and a single NaN reaching the color pipeline makes the stroke silently
// invisible — canvas discards `rgba(NaN,...)` without an error.
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);

/**
 * Log-normalize a positive quantity onto [0,1] against a fixed reference range.
 * The one implementation: `kappaNorm` and `divergenceNorm` are both wrappers
 * around this. They used to be independent copies, and two of them had already
 * drifted apart on their guard clauses.
 */
export const logNorm = (v, lo, hi) => {
  if (!(lo > 0) || !(hi > lo)) return 0; // degenerate range: 0, never NaN
  return clamp01(Math.log(Math.max(v, lo) / lo) / Math.log(hi / lo));
};

// Measured over 400k steps on the classic attractor: |dX/dt| has a 1st
// percentile of 29.5, a median of 78, and a 99th of 275. An earlier low end of
// 2 was well below anything the system actually does, which squashed every
// real value into the top of the ramp. Fixed reference range so the legend
// means the same thing frame to frame.
export const SPEED_RANGE = Object.freeze({ lo: 25, hi: 300 });

/**
 * Every field returns [0,1] so there is exactly ONE color code path. A sample
 * carries: {x,y,z, v (speed), delta, eps, dwell}.
 */
export const FIELDS = Object.freeze({
  lobe: {
    label: "wing",
    kind: "near-categorical",
    blurb:
      "Which wing of the butterfly. A smooth tanh across x, so the crossing " +
      "reads as a crossing rather than a hard edge.",
    of: (s) => 0.5 + 0.5 * Math.tanh(s.x / 8),
  },
  speed: {
    label: "speed",
    kind: "continuous",
    blurb:
      "|dX/dt|, log-scaled. Shows the system crawling as it spirals out near " +
      "a wing's center and screaming through the flip between wings.",
    of: (s) => logNorm(s.v, SPEED_RANGE.lo, SPEED_RANGE.hi),
  },
  divergence: {
    label: "divergence",
    kind: "continuous",
    blurb:
      "log‖Δ‖ between the twin trajectories, from the initial error up to " +
      "attractor diameter. The butterfly channel: the color tells you when " +
      "the forecast died.",
    of: (s) => divergenceNorm(s.delta, s.eps),
  },
  dwell: {
    label: "dwell",
    kind: "continuous",
    blurb:
      "Time since the last wing change, saturating. Surfaces the symbolic " +
      "dynamics — the L/R sequence that never repeats.",
    of: (s) => 1 - Math.exp(-Math.max(0, s.dwell) / 1.2),
  },
});

export const FIELD_KEYS = Object.keys(FIELDS);

// ----------------------------------------------------------------- the palettes

export const PALETTES = Object.freeze({
  ember: { label: "ember", h0: 18, arc: 72, chroma: 0.15, l0: 0.42, l1: 0.9 },
  ice: { label: "ice", h0: 208, arc: 76, chroma: 0.13, l0: 0.4, l1: 0.92 },
  moss: { label: "moss", h0: 128, arc: 64, chroma: 0.12, l0: 0.38, l1: 0.88 },
  spectrum: {
    label: "spectrum",
    h0: 250,
    arc: 150,
    chroma: 0.17,
    l0: 0.55,
    l1: 0.82,
    // Wide arc on purpose. Compare it against `ember` on the same field and
    // the false banding is visible in about two seconds.
    loud: true,
  },
});

export const PALETTE_KEYS = Object.keys(PALETTES);

/**
 * The formula, applied. Returns {rgb, f}; `f` is the normalized field value,
 * exposed so tests can assert the ramp without recomputing it. Nothing in the
 * app reads it — the legend builds its swatches from `ramp()`.
 */
export function colorFor(sample, fieldKey, paletteKey) {
  const field = FIELDS[fieldKey] ?? FIELDS.lobe;
  const pal = PALETTES[paletteKey] ?? PALETTES.ember;
  const f = clamp01(field.of(sample));
  const L = pal.l0 + (pal.l1 - pal.l0) * f;
  const H = pal.h0 + pal.arc * f;
  return { rgb: oklchToRgb(L, pal.chroma, H), f };
}

/**
 * Base stroke width in CSS pixels. Shared with the calligraphy path in app.js,
 * which multiplies it by the brush's own weight — two paths through "how thick
 * is the pen" with the number written twice is how they silently desync.
 */
export const BASE_WIDTH = 1.5;

/** Stroke width from speed — the one channel speed owns outright. */
export function widthFor(v, base = BASE_WIDTH) {
  return base * (0.55 + 1.45 * logNorm(v, SPEED_RANGE.lo, SPEED_RANGE.hi));
}

/** Evenly spaced swatches across a field's range, for the legend. */
export function ramp(paletteKey, n = 24) {
  const pal = PALETTES[paletteKey] ?? PALETTES.ember;
  return Array.from({ length: n }, (_, i) => {
    const f = n === 1 ? 0 : i / (n - 1);
    return oklchToRgb(pal.l0 + (pal.l1 - pal.l0) * f, pal.chroma, pal.h0 + pal.arc * f);
  });
}
