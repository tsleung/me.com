import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODES,
  MODE_BLURB,
  lerpGeom,
  tourPhase,
  directedParams,
  SPEED_LIMITS,
  TRAIL_LIMITS,
} from "../director.js";

const manual = { speed: 4, trail: 9 };
const sample = { v: 30, divergenceNorm: 0 };

test("every mode has a blurb", () => {
  for (const m of MODES) assert.ok(MODE_BLURB[m], `no blurb for ${m}`);
});

test("lerpGeom hits its endpoints and is geometric in between", () => {
  assert.ok(Math.abs(lerpGeom(1, 100, 0) - 1) < 1e-12);
  assert.ok(Math.abs(lerpGeom(1, 100, 1) - 100) < 1e-12);
  assert.ok(Math.abs(lerpGeom(1, 100, 0.5) - 10) < 1e-12, "midpoint is the geometric mean");
  assert.equal(lerpGeom(1, 100, -5), 1, "clamped below");
  assert.equal(lerpGeom(1, 100, 5), 100, "clamped above");
});

test("tourPhase is bounded, periodic, and turns around smoothly", () => {
  const period = 20;
  assert.ok(Math.abs(tourPhase(0, period)) < 1e-12);
  assert.ok(Math.abs(tourPhase(period / 2, period) - 1) < 1e-12);
  assert.ok(Math.abs(tourPhase(period, period)) < 1e-12, "one full period returns");

  for (let t = -50; t < 120; t += 0.37) {
    const u = tourPhase(t, period);
    assert.ok(u >= 0 && u <= 1, `u=${u} out of range at t=${t}`);
    assert.ok(
      Math.abs(u - tourPhase(t + period, period)) < 1e-9,
      "must be periodic, including for negative t",
    );
  }
  assert.equal(tourPhase(5, 0), 0, "a zero period is inert, not NaN");
});

test("off mode passes the hand controls through untouched", () => {
  const r = directedParams({ mode: "off", t: 12, manual, sample });
  assert.equal(r.speed, manual.speed);
  assert.equal(r.trail, manual.trail);
  assert.equal(r.u, null);
});

test("off mode still clamps hand controls into range", () => {
  const r = directedParams({ mode: "off", manual: { speed: 1e6, trail: -3 }, sample });
  assert.equal(r.speed, SPEED_LIMITS.max);
  assert.equal(r.trail, TRAIL_LIMITS.min);
});

test("tour stays in range and moves speed and trail in opposite directions", () => {
  const period = 30;
  let prev = null;
  for (let t = 0; t <= period / 2; t += 0.25) {
    const r = directedParams({ mode: "tour", t, period, manual, sample });
    assert.ok(r.speed >= SPEED_LIMITS.min && r.speed <= SPEED_LIMITS.max);
    assert.ok(r.trail >= TRAIL_LIMITS.min && r.trail <= TRAIL_LIMITS.max);
    if (prev) {
      // Over the rising half of the tour: speed up, trail down.
      assert.ok(r.speed >= prev.speed - 1e-9, "speed should rise with u");
      assert.ok(r.trail <= prev.trail + 1e-9, "trail should fall as speed rises");
    }
    prev = r;
  }

  const slow = directedParams({ mode: "tour", t: 0, period, manual, sample });
  const fast = directedParams({ mode: "tour", t: period / 2, period, manual, sample });
  assert.ok(fast.speed > slow.speed * 4, "the tour should actually cover ground");
  assert.ok(slow.trail > fast.trail * 4);
});

test("coupled: the pen advances at roughly constant arc length", () => {
  const slowPoint = directedParams({
    mode: "coupled",
    manual,
    sample: { v: 5, divergenceNorm: 0 },
  });
  const fastPoint = directedParams({
    mode: "coupled",
    manual,
    sample: { v: 150, divergenceNorm: 0 },
  });
  assert.ok(
    slowPoint.speed > fastPoint.speed,
    "where the system crawls, playback should push harder",
  );
  // speed x |v| is the arc-length rate; it should be near-constant across the
  // range where neither clamp is binding.
  const arcA = slowPoint.speed * 5;
  const arcB = fastPoint.speed * 150;
  assert.ok(Math.abs(arcA - arcB) < 1e-6, `arc rate drifted: ${arcA} vs ${arcB}`);
});

test("coupled: memory decays with the forecast", () => {
  const fresh = directedParams({
    mode: "coupled",
    manual,
    sample: { v: 30, divergenceNorm: 0 },
  });
  const dead = directedParams({
    mode: "coupled",
    manual,
    sample: { v: 30, divergenceNorm: 1 },
  });
  assert.ok(Math.abs(fresh.trail - manual.trail) < 1e-9, "no divergence, full memory");
  assert.ok(Math.abs(dead.trail - TRAIL_LIMITS.min) < 1e-9, "fully diverged, comet head");
  assert.ok(dead.trail < fresh.trail);
});

test("coupled survives a degenerate sample rather than emitting NaN", () => {
  const r = directedParams({ mode: "coupled", manual, sample: { v: 0, divergenceNorm: 0 } });
  assert.ok(Number.isFinite(r.speed) && Number.isFinite(r.trail));
  assert.equal(r.speed, SPEED_LIMITS.max, "zero speed pins playback at the top clamp");

  const missing = directedParams({ mode: "coupled", manual });
  assert.ok(Number.isFinite(missing.speed) && Number.isFinite(missing.trail));
});

test("calligraphy: pressing slows the pen, lifting speeds it, tempo stays the slider's", () => {
  const lifted = directedParams({ mode: "calligraphy", manual, sample: { press: 0 } });
  const pressed = directedParams({ mode: "calligraphy", manual, sample: { press: 1 } });

  assert.ok(pressed.speed < lifted.speed, "a turn must slow the brush");
  assert.ok(lifted.speed > manual.speed, "a straight run must be faster than the tempo");
  assert.ok(pressed.speed < manual.speed, "a turn must be slower than the tempo");

  // The hand slider is the tempo: doubling it must move both ends together.
  const faster = { speed: manual.speed * 2, trail: manual.trail };
  const liftedFast = directedParams({ mode: "calligraphy", manual: faster, sample: { press: 0 } });
  assert.ok(
    Math.abs(liftedFast.speed / lifted.speed - 2) < 1e-9,
    "the speed control must still set the overall tempo",
  );

  assert.equal(pressed.trail, manual.trail, "the brush model does not touch the trail");
});

test("calligraphy stays in range and survives a missing press", () => {
  for (const press of [0, 0.5, 1]) {
    const r = directedParams({ mode: "calligraphy", manual, sample: { press } });
    assert.ok(r.speed >= SPEED_LIMITS.min && r.speed <= SPEED_LIMITS.max);
    assert.equal(r.u, press, "u should report the press for the readout");
  }
  const bare = directedParams({ mode: "calligraphy", manual });
  assert.ok(Number.isFinite(bare.speed) && bare.speed > 0);
});

test("an unknown mode falls back to the hand controls", () => {
  const r = directedParams({ mode: "banana", manual, sample });
  assert.equal(r.speed, manual.speed);
  assert.equal(r.trail, manual.trail);
});
