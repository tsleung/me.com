import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASSIC } from "../lorenz.js";
import { FIELD_KEYS, PALETTE_KEYS } from "../color.js";
import { MODES } from "../director.js";
import { BLEND_KEYS } from "../pen.js";
import { fmt, READOUT_IDS, STATIC_IDS, readoutText, staticText, expiredIsLive } from "../hud.js";

const VIEW = {
  t: 12.34,
  sinceFork: 5.5,
  delta: 1.5e-3,
  dNorm: 0.42,
  v: 88.8,
  effSpeed: 3.25,
  effTrail: 5,
  u: 0.5,
  lambdaLive: 0.9012,
  expiredAt: null,
  prevExpiredAt: null,
};

const STATIC_VIEW = {
  lambda: 0.9056,
  eps: 1.27e-4,
  params: CLASSIC,
  field: "lobe",
  palette: "ember",
  blend: "filament",
  mode: "calligraphy",
  tolerance: 1,
  manualSpeed: 3,
  manualTrail: 5,
  period: 30,
  yaw: 0,
};

test("fmt renders absent and non-finite values as a dash, never as NaN", () => {
  for (const bad of [null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(fmt(bad), "—", `fmt(${bad})`);
  }
  assert.equal(fmt(1.239, 2), "1.24");
  assert.equal(fmt(0), "0.00");
  assert.equal(fmt(-0.5, 1), "-0.5");
});

test("the readout map covers exactly the declared ids", () => {
  assert.deepEqual(Object.keys(readoutText(VIEW)).sort(), [...READOUT_IDS].sort());
  assert.deepEqual(Object.keys(staticText(STATIC_VIEW).text).sort(), [...STATIC_IDS].sort());
});

test("every readout is a string, for any plausible or degenerate view", () => {
  const views = [
    VIEW,
    { ...VIEW, delta: 0, dNorm: 0, v: 0, u: null, lambdaLive: null },
    { ...VIEW, delta: NaN, dNorm: NaN, v: NaN, effSpeed: NaN, lambdaLive: NaN },
    { ...VIEW, expiredAt: 18.2 },
    { ...VIEW, expiredAt: null, prevExpiredAt: 9.9 },
  ];
  for (const v of views) {
    for (const [id, text] of Object.entries(readoutText(v))) {
      assert.equal(typeof text, "string", `${id} is not a string`);
      assert.ok(!text.includes("NaN"), `${id} leaked NaN: ${text}`);
      assert.ok(!text.includes("undefined"), `${id} leaked undefined: ${text}`);
    }
  }
});

test("the measured horizon reads as live, memory, or promise — in that order", () => {
  // Three-way, and the ordering matters: a fork that has died shows its own
  // number even if a previous one also died.
  assert.equal(readoutText({ ...VIEW, expiredAt: 18.25 })["r-expired"], "18.3");
  assert.equal(
    readoutText({ ...VIEW, expiredAt: 18.25, prevExpiredAt: 4 })["r-expired"],
    "18.3",
    "the current fork wins over the remembered one",
  );
  assert.equal(
    readoutText({ ...VIEW, expiredAt: null, prevExpiredAt: 4.44 })["r-expired"],
    "(last: 4.4)",
  );
  assert.equal(readoutText(VIEW)["r-expired"], "still good");

  assert.equal(expiredIsLive({ expiredAt: 1 }), true);
  assert.equal(expiredIsLive({ expiredAt: null }), false);
});

test("delta uses exponential notation, and zero is plain", () => {
  assert.equal(readoutText({ ...VIEW, delta: 1.5e-3 })["r-delta"], "1.50e-3");
  assert.equal(readoutText({ ...VIEW, delta: 0 })["r-delta"], "0");
  assert.equal(readoutText({ ...VIEW, delta: -1 })["r-delta"], "0", "negative is impossible");
});

test("the normalized divergence reads as a whole percent", () => {
  assert.equal(readoutText({ ...VIEW, dNorm: 0 })["r-dnorm"], "0%");
  assert.equal(readoutText({ ...VIEW, dNorm: 1 })["r-dnorm"], "100%");
  assert.equal(readoutText({ ...VIEW, dNorm: 0.426 })["r-dnorm"], "43%");
  assert.equal(readoutText({ ...VIEW, dNorm: NaN })["r-dnorm"], "0%", "NaN is not a percent");
});

test("static text is total over every field, palette, blend and mode", () => {
  for (const field of FIELD_KEYS) {
    for (const palette of PALETTE_KEYS) {
      for (const blend of BLEND_KEYS) {
        for (const mode of MODES) {
          const out = staticText({ ...STATIC_VIEW, field, palette, blend, mode });
          for (const [id, text] of Object.entries(out.text)) {
            assert.equal(typeof text, "string", `${id} for ${field}/${palette}/${blend}/${mode}`);
            assert.ok(text.length > 0, `${id} is empty`);
          }
          assert.match(out.legendGradient, /^linear-gradient\(90deg, rgb\(/);
          assert.equal(out.showTourRow, mode === "tour");
          assert.equal(out.manualOverridden, mode !== "off");
        }
      }
    }
  }
});

test("an unmeasured lambda dashes the whole derived row rather than guessing", () => {
  const out = staticText({ ...STATIC_VIEW, lambda: null }).text;
  assert.equal(out["r-lambda"], "—");
  assert.equal(out["r-horizon"], "—", "no lambda means no horizon");
  assert.equal(out["r-decade"], "—", "no lambda means no gain-per-decade");
  // Contraction does not depend on lambda and must still be shown.
  assert.equal(out["r-contract"], "-13.667");
});

test("only the loud palette is flagged", () => {
  for (const palette of PALETTE_KEYS) {
    const loud = staticText({ ...STATIC_VIEW, palette }).paletteIsLoud;
    assert.equal(loud, palette === "spectrum", `${palette} flagged ${loud}`);
  }
});
