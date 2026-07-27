import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INTRO,
  introEase,
  introProgress,
  introSpeed,
  introRevealed,
} from "../intro.js";

test("the ease lingers slow and still lands on both endpoints", () => {
  assert.equal(introEase(0), 0);
  assert.equal(introEase(1), 1);
  assert.ok(introEase(0.5) < 0.5, "the first half must be slower than linear");
  assert.equal(introEase(-3), 0, "clamped below");
  assert.equal(introEase(9), 1, "clamped above");

  let prev = -1;
  for (let u = 0; u <= 1.0001; u += 0.05) {
    const e = introEase(u);
    assert.ok(e >= prev, "ease must be monotone");
    prev = e;
  }
});

test("progress spans the ramp and survives a zero-length ramp", () => {
  assert.equal(introProgress(0), 0);
  assert.equal(introProgress(INTRO.rampSeconds), 1);
  assert.equal(introProgress(1e6), 1);
  assert.equal(introProgress(5, { ...INTRO, rampSeconds: 0 }), 1, "no ramp, no opening");
});

test("the opening starts at a crawl and accelerates to the resting speed", () => {
  const resting = 6;
  const first = introSpeed(0, resting);
  assert.ok(Math.abs(first - INTRO.speedStart) < 1e-9, `started at ${first}`);

  let prev = 0;
  for (let t = 0; t < INTRO.rampSeconds; t += 0.25) {
    const v = introSpeed(t, resting);
    assert.ok(v >= prev - 1e-12, "speed must only increase during the opening");
    assert.ok(v <= resting + 1e-9, "the opening must never overshoot resting speed");
    prev = v;
  }
  assert.ok(prev > resting * 0.8, "should arrive close to resting by the end");
});

test("the opening hands control back by returning null", () => {
  assert.equal(introSpeed(INTRO.rampSeconds, 6), null);
  assert.equal(introSpeed(INTRO.rampSeconds + 100, 6), null);
  assert.ok(introSpeed(INTRO.rampSeconds - 0.01, 6) != null, "still running just before");
});

test("no opening is performed when the resting speed is already slower", () => {
  const resting = 0.1; // below INTRO.speedStart
  for (const t of [0, 2, 8, 15]) {
    assert.ok(
      Math.abs(introSpeed(t, resting) - resting) < 1e-9,
      "must not ramp downward toward a slow resting speed",
    );
  }
});

test("the opening chases a resting speed that moves mid-ramp", () => {
  const early = introSpeed(4, 3);
  const earlyFaster = introSpeed(4, 30);
  assert.ok(earlyFaster > early, "raising the target mid-opening should raise the ramp");
});

test("reveal is a single threshold that lands before the ramp finishes", () => {
  assert.equal(introRevealed(0), false);
  assert.equal(introRevealed(INTRO.revealAt - 0.01), false);
  assert.equal(introRevealed(INTRO.revealAt), true);
  assert.ok(
    INTRO.revealAt < INTRO.rampSeconds,
    "the chrome should arrive while the line is still accelerating, not after",
  );
});
