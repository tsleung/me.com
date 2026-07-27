import { test } from "node:test";
import assert from "node:assert/strict";
import {
  oklchToRgb,
  cssRgb,
  cssRgba,
  logNorm,
  colorFor,
  widthFor,
  ramp,
  FIELDS,
  FIELD_KEYS,
  PALETTE_KEYS,
  PALETTES,
  SPEED_RANGE,
} from "../color.js";

/** Rec. 709 relative luminance, for checking the ramp behaves. */
const lum = ({ r, g, b }) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

test("OKLCH anchors: L=1,C=0 is white; L=0 is black; achromatic stays grey", () => {
  const white = oklchToRgb(1, 0, 0);
  assert.deepEqual(white, { r: 255, g: 255, b: 255 });

  const black = oklchToRgb(0, 0, 0);
  assert.deepEqual(black, { r: 0, g: 0, b: 0 });

  const grey = oklchToRgb(0.6, 0, 210);
  assert.equal(grey.r, grey.g);
  assert.equal(grey.g, grey.b);
});

test("OKLCH output is always in gamut after clipping", () => {
  for (let L = 0; L <= 1.0001; L += 0.1) {
    for (let H = 0; H < 360; H += 30) {
      const c = oklchToRgb(L, 0.3, H);
      for (const v of [c.r, c.g, c.b]) {
        assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `channel out of range: ${v}`);
      }
    }
  }
});

test("hue rotation at fixed L changes color without collapsing it", () => {
  const a = oklchToRgb(0.65, 0.14, 20);
  const b = oklchToRgb(0.65, 0.14, 200);
  assert.notDeepEqual(a, b);
});

test("css helpers format as canvas expects", () => {
  assert.equal(cssRgb({ r: 1, g: 2, b: 3 }), "rgb(1,2,3)");
  assert.equal(cssRgba({ r: 1, g: 2, b: 3 }, 0.5), "rgba(1,2,3,0.500)");
});

test("logNorm clamps to [0,1] and hits the endpoints", () => {
  assert.equal(logNorm(2, 2, 260), 0);
  assert.ok(Math.abs(logNorm(260, 2, 260) - 1) < 1e-12);
  assert.equal(logNorm(0.001, 2, 260), 0, "clamped below");
  assert.equal(logNorm(1e6, 2, 260), 1, "clamped above");
  // Log scale: the geometric midpoint should land near 0.5.
  assert.ok(Math.abs(logNorm(Math.sqrt(2 * 260), 2, 260) - 0.5) < 1e-12);
});

test("every field returns a normalized scalar for any plausible sample", () => {
  const samples = [
    { x: 0, y: 0, z: 0, v: 0, delta: 0, eps: 1e-6, dwell: 0 },
    { x: 20, y: -30, z: 48, v: 400, delta: 1e3, eps: 1e-6, dwell: 100 },
    { x: -20, y: 30, z: 1, v: 0.0001, delta: 1e-30, eps: 1e-6, dwell: -5 },
    { x: 8.4, y: 8.4, z: 27, v: 12, delta: 1e-6, eps: 1e-6, dwell: 1.2 },
  ];
  for (const key of FIELD_KEYS) {
    for (const s of samples) {
      const f = FIELDS[key].of(s);
      assert.ok(
        Number.isFinite(f) && f >= 0 && f <= 1,
        `${key} returned ${f} for ${JSON.stringify(s)}`,
      );
    }
  }
});

test("the wing field separates the lobes and crosses smoothly at x=0", () => {
  const at = (x) => FIELDS.lobe.of({ x, y: 0, z: 0, v: 1, delta: 0, eps: 1e-6, dwell: 0 });
  assert.ok(Math.abs(at(0) - 0.5) < 1e-12, "the crossing is the midpoint");
  assert.ok(at(20) > 0.9 && at(-20) < 0.1, "the wings are well separated");
  assert.ok(at(1) > at(0) && at(0) > at(-1), "monotone in x");
});

test("the divergence field is zero at the fork and saturates at diameter", () => {
  const s = (delta) => ({ x: 0, y: 0, z: 0, v: 1, delta, eps: 1e-6, dwell: 0 });
  assert.equal(FIELDS.divergence.of(s(1e-6)), 0);
  assert.ok(FIELDS.divergence.of(s(45)) > 0.999);
  assert.ok(FIELDS.divergence.of(s(1e-3)) > 0.3);
});

test("lightness carries magnitude: the ramp brightens end to end", () => {
  for (const key of PALETTE_KEYS) {
    const stops = ramp(key, 16).map(lum);
    assert.ok(
      stops.at(-1) > stops[0] + 20,
      `${key}: ramp does not brighten (${stops[0]} → ${stops.at(-1)})`,
    );
    for (let i = 1; i < stops.length; i++) {
      // Allow a hair of slack for 8-bit quantization, but no real reversals.
      assert.ok(
        stops[i] >= stops[i - 1] - 1.5,
        `${key}: luminance reverses at stop ${i}`,
      );
    }
  }
});

test("narrow-arc palettes stay narrow; spectrum is the flagged exception", () => {
  for (const key of PALETTE_KEYS) {
    if (PALETTES[key].loud) continue;
    assert.ok(
      PALETTES[key].arc <= 90,
      `${key} has a ${PALETTES[key].arc}° arc — wide arcs invent banding`,
    );
  }
  assert.ok(PALETTES.spectrum.loud, "spectrum must stay labelled as the loud one");
});

test("colorFor is total over fields x palettes", () => {
  const s = { x: 5, y: -2, z: 30, v: 40, delta: 1e-3, eps: 1e-6, dwell: 0.7 };
  for (const f of FIELD_KEYS) {
    for (const p of PALETTE_KEYS) {
      const { rgb, f: norm } = colorFor(s, f, p);
      assert.ok(norm >= 0 && norm <= 1);
      assert.ok(rgb.r >= 0 && rgb.g >= 0 && rgb.b >= 0);
    }
  }
  // Unknown keys fall back to the documented defaults rather than throwing
  // mid-frame — and to THOSE defaults specifically, not merely to something.
  assert.deepEqual(colorFor(s, "nope", "nope"), colorFor(s, "lobe", "ember"));
});

test("width tracks speed monotonically and stays positive", () => {
  const lo = widthFor(SPEED_RANGE.lo);
  const hi = widthFor(SPEED_RANGE.hi);
  assert.ok(lo > 0 && hi > lo, `width should grow with speed: ${lo} → ${hi}`);
  assert.ok(widthFor(0) > 0, "zero speed must still draw something");
  assert.equal(widthFor(1e9), hi, "clamped at the top of the reference range");
});
