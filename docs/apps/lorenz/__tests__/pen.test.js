import { test } from "node:test";
import assert from "node:assert/strict";
import { colorFor, widthFor, BASE_WIDTH } from "../color.js";
import { widthMult, alphaMult } from "../calligraphy.js";
import { attrsFor, BLENDS, BLEND_KEYS, TWIN } from "../pen.js";

const SAMPLE = {
  x: 5,
  y: -2,
  z: 30,
  v: 90,
  delta: 1e-3,
  eps: 1e-6,
  dwell: 0.7,
  press: 0.4,
};

test("the composed attributes equal the formula applied by hand", () => {
  // Pinned against the inline expression this replaced, so the extraction is
  // provably numeric-identical rather than merely plausible.
  const cfg = { field: "lobe", palette: "ember", blend: "filament", calligraphic: true };
  const got = attrsFor(cfg)(SAMPLE, 0.5);
  const blend = BLENDS.filament;

  assert.deepEqual(got.rgb, colorFor(SAMPLE, "lobe", "ember").rgb);
  assert.equal(got.width, widthMult(SAMPLE.press) * BASE_WIDTH * blend.widthScale);
  assert.equal(got.alpha, 0.5 * blend.alpha * alphaMult(SAMPLE.press));
});

test("outside calligraphy mode, width comes from phase speed and ink is unscaled", () => {
  const got = attrsFor({
    field: "lobe",
    palette: "ember",
    blend: "filament",
    calligraphic: false,
  })(SAMPLE, 1);
  assert.equal(got.width, widthFor(SAMPLE.v) * BLENDS.filament.widthScale);
  assert.equal(got.alpha, BLENDS.filament.alpha, "no brush, no 飛白 multiplier");
});

test("the twin is subordinate in weight only, never in color", () => {
  const base = { field: "lobe", palette: "ember", blend: "filament", calligraphic: true };
  const ref = attrsFor(base)(SAMPLE, 1);
  const twin = attrsFor({ ...base, dim: true })(SAMPLE, 1);

  assert.deepEqual(twin.rgb, ref.rgb, "the twin must share the color formula exactly");
  assert.ok(Math.abs(twin.width - ref.width * TWIN.width) < 1e-12);
  assert.ok(Math.abs(twin.alpha - ref.alpha * TWIN.ink) < 1e-12);
  assert.ok(twin.width < ref.width && twin.alpha < ref.alpha);
});

test("the trail's fade multiplies in last, so nothing can override the cutoff", () => {
  for (const blend of BLEND_KEYS) {
    for (const calligraphic of [true, false]) {
      const attrs = attrsFor({ field: "speed", palette: "ice", blend, calligraphic });
      assert.equal(attrs(SAMPLE, 0).alpha, 0, `${blend}: a dead vertex must be invisible`);
      // And alpha is linear in fade — no blend or brush can bend the curve.
      const half = attrs(SAMPLE, 0.5).alpha;
      const full = attrs(SAMPLE, 1).alpha;
      assert.ok(Math.abs(half * 2 - full) < 1e-12, `${blend}: fade is not linear`);
    }
  }
});

test("density lays down far less ink per segment than filament", () => {
  // The two blends are separate modes precisely because additive compositing
  // needs a very low per-segment alpha; if these ever converge, the density
  // mode blows out to white.
  const of = (blend) =>
    attrsFor({ field: "lobe", palette: "ember", blend, calligraphic: false })(SAMPLE, 1)
      .alpha;
  assert.ok(of("density") < of("filament") / 5);
});

test("attrsFor is total over every field, palette and blend", () => {
  const attrs = attrsFor({ field: "nope", palette: "nope", blend: "nope" });
  const out = attrs(SAMPLE, 1);
  assert.ok(out.rgb && Number.isFinite(out.width) && Number.isFinite(out.alpha));
  assert.equal(
    out.alpha,
    attrsFor({ field: "lobe", palette: "ember", blend: "filament" })(SAMPLE, 1).alpha,
    "an unknown blend must fall back to filament, not to nothing",
  );
});

test("a degenerate sample yields finite ink rather than an invisible stroke", () => {
  // A NaN reaching the color pipeline produces rgba(NaN,…), which canvas
  // silently discards — the failure mode is a line that vanishes with no error.
  const bad = { ...SAMPLE, v: NaN, press: NaN, delta: NaN };
  for (const calligraphic of [true, false]) {
    const out = attrsFor({
      field: "speed",
      palette: "ember",
      blend: "filament",
      calligraphic,
    })(bad, 1);
    for (const c of [out.rgb.r, out.rgb.g, out.rgb.b, out.width, out.alpha]) {
      assert.ok(Number.isFinite(c), `NaN leaked through: ${JSON.stringify(out)}`);
    }
  }
});
