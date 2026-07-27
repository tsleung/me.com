import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASSIC, DT, field, rk4, seed, fixedPoints } from "../lorenz.js";
import {
  BRUSH,
  smoothToward,
  KAPPA_RANGE,
  jacobian,
  curvature,
  kappaNorm,
  entryWeight,
  pressure,
  widthMult,
  alphaMult,
  brush,
} from "../calligraphy.js";

test("the Jacobian matches a numeric derivative of the field", () => {
  const h = 1e-6;
  for (const s of [
    { x: 1, y: 2, z: 3 },
    { x: -9, y: 5, z: 30 },
  ]) {
    const J = jacobian(s, CLASSIC);
    const axes = ["x", "y", "z"];
    axes.forEach((col, j) => {
      const up = field({ ...s, [col]: s[col] + h }, CLASSIC);
      const dn = field({ ...s, [col]: s[col] - h }, CLASSIC);
      axes.forEach((row, i) => {
        const numeric = (up[row] - dn[row]) / (2 * h);
        assert.ok(
          Math.abs(J[i][j] - numeric) < 1e-4,
          `J[${i}][${j}] = ${J[i][j]}, numeric ${numeric}`,
        );
      });
    });
  }
});

test("curvature matches a finite-difference estimate along a trajectory", () => {
  // κ = |v × a|/|v|³ with a computed exactly; cross-check a by stepping.
  let s = seed(CLASSIC);
  for (let i = 0; i < 500; i++) {
    s = rk4(s, CLASSIC, DT);
    if (i % 137) continue;
    const v0 = field(s, CLASSIC);
    const v1 = field(rk4(s, CLASSIC, 1e-5), CLASSIC);
    const a = { x: (v1.x - v0.x) / 1e-5, y: (v1.y - v0.y) / 1e-5, z: (v1.z - v0.z) / 1e-5 };
    const cx = v0.y * a.z - v0.z * a.y;
    const cy = v0.z * a.x - v0.x * a.z;
    const cz = v0.x * a.y - v0.y * a.x;
    const sp = Math.hypot(v0.x, v0.y, v0.z);
    const numeric = Math.hypot(cx, cy, cz) / sp ** 3;
    const exact = curvature(s, CLASSIC, field);
    assert.ok(
      Math.abs(exact - numeric) / Math.max(numeric, 1e-9) < 1e-3,
      `curvature ${exact} vs numeric ${numeric}`,
    );
  }
});

test("curvature is finite everywhere the trajectory goes, including at rest", () => {
  assert.equal(curvature({ x: 0, y: 0, z: 0 }, CLASSIC, field), 0, "no field, no curve");
  for (const fp of fixedPoints(CLASSIC)) {
    const k = curvature(fp, CLASSIC, field);
    assert.ok(Number.isFinite(k) && k >= 0, `κ=${k} at a fixed point`);
  }

  let s = seed(CLASSIC);
  for (let i = 0; i < 40000; i++) {
    s = rk4(s, CLASSIC, DT);
    const k = curvature(s, CLASSIC, field);
    assert.ok(Number.isFinite(k) && k >= 0, `κ went bad: ${k}`);
  }
});

test("the calibrated κ range actually spans what the attractor does", () => {
  // The whole model rests on this: if the range is wrong, press saturates and
  // the brush stops responding. Sample the attractor and check the spread.
  let s = seed(CLASSIC);
  const norms = [];
  for (let i = 0; i < 120000; i++) {
    s = rk4(s, CLASSIC, DT);
    if (i % 20 === 0) norms.push(kappaNorm(curvature(s, CLASSIC, field)));
  }
  norms.sort((a, b) => a - b);
  const q = (f) => norms[Math.floor(f * (norms.length - 1))];
  assert.ok(q(0.05) < 0.25, `5th percentile press is ${q(0.05)} — range starts too low`);
  assert.ok(q(0.95) > 0.6, `95th percentile press is ${q(0.95)} — range ends too high`);
  assert.ok(q(0.5) > 0.1 && q(0.5) < 0.9, `median press ${q(0.5)} is not mid-range`);
});

test("kappaNorm is clamped, monotone, and anchored to its range", () => {
  assert.equal(kappaNorm(KAPPA_RANGE.lo), 0);
  assert.ok(Math.abs(kappaNorm(KAPPA_RANGE.hi) - 1) < 1e-12);
  assert.equal(kappaNorm(KAPPA_RANGE.lo / 100), 0, "clamped below");
  assert.equal(kappaNorm(KAPPA_RANGE.hi * 100), 1, "clamped above");
  assert.equal(kappaNorm(0), 0);
  assert.equal(kappaNorm(-1), 0);

  let prev = -1;
  for (let k = 0.01; k < 1; k *= 1.2) {
    const n = kappaNorm(k);
    assert.ok(n >= prev, "must be monotone in κ");
    prev = n;
  }
});

test("起筆: the entry stays pressed just after a stroke begins, then releases", () => {
  assert.equal(entryWeight(0), 1, "a stroke begins fully pressed");
  assert.ok(entryWeight(BRUSH.entryTau) < 0.4, "and releases within a stroke length");
  assert.ok(entryWeight(10) < 0.001, "long into a stroke there is no entry left");
  assert.equal(entryWeight(-5), 1, "negative time is treated as the instant of the flip");
  assert.equal(entryWeight(1, { ...BRUSH, entryTau: 0 }), 0, "no entry configured, no entry");
});

test("pressure takes whichever reason to press is stronger", () => {
  assert.equal(pressure(0, 0), 0);
  assert.equal(pressure(0.8, 0.2), 0.8, "a sharp turn presses even mid-stroke");
  assert.equal(pressure(0.1, 0.9), 0.9, "a stroke entry presses even on a straight run");
  assert.equal(pressure(5, -2), 1, "clamped");
});

test("提按: pressed is thick and inked, lifted is thin and dry", () => {
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-12, `${msg}: ${a} vs ${b}`);
  assert.ok(widthMult(1) > widthMult(0), "pressing must thicken the stroke");
  near(widthMult(0), BRUSH.widthLift, "fully lifted");
  near(widthMult(1), BRUSH.widthPress, "fully pressed");
  near(widthMult(-1), BRUSH.widthLift, "clamped below");
  near(widthMult(9), BRUSH.widthPress, "clamped above");

  assert.ok(alphaMult(1) > alphaMult(0), "飛白: the fast traverse must go translucent");
  assert.equal(alphaMult(1), 1, "fully pressed lays down full ink");
  assert.ok(alphaMult(0) > 0.2, "even the driest stroke stays visible");
});

test("width and ink are monotone in press, so the two never disagree", () => {
  let pw = -1;
  let pa = -1;
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const w = widthMult(p);
    const a = alphaMult(p);
    assert.ok(w >= pw && a >= pa, `non-monotone at press=${p}`);
    pw = w;
    pa = a;
  }
});

test("smoothToward converges, never overshoots, and is speed-invariant", () => {
  assert.equal(smoothToward(0, 1, 0, 0.15), 1, "no elapsed time, no lag to apply");
  assert.equal(smoothToward(0, 1, 0.01, 0), 1, "no time constant, no lag");
  assert.equal(smoothToward(0.4, 0.4, 0.01, 0.15), 0.4, "already there, stays");

  let v = 0;
  for (let i = 0; i < 10000; i++) v = smoothToward(v, 1, 0.004, 0.15);
  assert.ok(Math.abs(v - 1) < 1e-9, "must converge on the target");

  // Never past the target, from either side.
  for (const [from, to] of [
    [0, 1],
    [1, 0],
    [0.3, 0.9],
  ]) {
    const next = smoothToward(from, to, 0.5, 0.15);
    assert.ok(next >= Math.min(from, to) && next <= Math.max(from, to), "overshoot");
  }

  // Same simulated time must give the same result regardless of how it is
  // subdivided — this is what makes the brush feel identical at any playback
  // speed, and it is why the lag is in sim time rather than wall clock.
  const oneBigStep = smoothToward(0, 1, 0.2, 0.15);
  let manySmall = 0;
  for (let i = 0; i < 50; i++) manySmall = smoothToward(manySmall, 1, 0.2 / 50, 0.15);
  assert.ok(Math.abs(oneBigStep - manySmall) < 1e-12, "lag must be step-size invariant");
});

// NOTE: the "drawn width never steps" test moved to sim.test.js. It used to
// re-implement app.js's stepping loop here in order to reach it, which pinned a
// copy of the code rather than a contract. Now that step() is a real function,
// the test drives it directly.

test("brush() returns a usable stroke everywhere on the attractor", () => {
  let s = seed(CLASSIC);
  let sawPressed = false;
  let sawLifted = false;
  for (let i = 0; i < 60000; i++) {
    s = rk4(s, CLASSIC, DT);
    const b = brush(s, CLASSIC, 3, field);
    assert.ok(b.press >= 0 && b.press <= 1, `press out of range: ${b.press}`);
    assert.ok(Number.isFinite(b.kappa) && b.kappa >= 0);
    // Width and alpha are deliberately NOT returned here — they belong to the
    // smoothed press, not the raw target. See the note on brush().
    assert.equal(b.width, undefined, "brush() must not tempt callers with a width");
    assert.equal(b.alpha, undefined, "brush() must not tempt callers with an alpha");
    if (b.press > 0.75) sawPressed = true;
    if (b.press < 0.25) sawLifted = true;
  }
  // A brush that never changes weight is a plotter.
  assert.ok(sawPressed, "the brush never pressed — the model is doing nothing");
  assert.ok(sawLifted, "the brush never lifted — the model is doing nothing");
});
