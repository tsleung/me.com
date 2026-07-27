import { test } from "node:test";
import assert from "node:assert/strict";
import { TRACK, SLIDERS, EPS_LIMITS, fromSlider, toSlider } from "../controls.js";
import { SPEED_LIMITS, TRAIL_LIMITS } from "../director.js";

const NAMES = Object.keys(SLIDERS);

test("every slider round-trips exactly", () => {
  for (const name of NAMES) {
    const range = SLIDERS[name];
    for (let raw = TRACK.min; raw <= TRACK.max; raw += 50) {
      const back = toSlider(fromSlider(raw, range), range);
      assert.ok(Math.abs(back - raw) < 1e-9, `${name}: ${raw} → ${back}`);
    }
  }
});

test("the ends of the track are the ends of the range", () => {
  for (const name of NAMES) {
    const { min, max } = SLIDERS[name];
    assert.ok(Math.abs(fromSlider(TRACK.min, SLIDERS[name]) - min) < 1e-15, `${name} min`);
    assert.ok(Math.abs(fromSlider(TRACK.max, SLIDERS[name]) / max - 1) < 1e-12, `${name} max`);
    assert.equal(toSlider(min, SLIDERS[name]), TRACK.min);
    assert.ok(Math.abs(toSlider(max, SLIDERS[name]) - TRACK.max) < 1e-9);
  }
});

test("the mapping is geometric: the track midpoint is the geometric mean", () => {
  // Equal travel gives equal RATIO, which is the point — these are all ratio
  // quantities, and a linear slider would spend most of its length at the top.
  for (const name of NAMES) {
    const { min, max } = SLIDERS[name];
    const mid = fromSlider(TRACK.max / 2, SLIDERS[name]);
    assert.ok(
      Math.abs(mid / Math.sqrt(min * max) - 1) < 1e-12,
      `${name}: midpoint ${mid} is not the geometric mean`,
    );
  }
});

test("out-of-range input clamps rather than escaping the range", () => {
  for (const name of NAMES) {
    const { min, max } = SLIDERS[name];
    assert.ok(fromSlider(-500, SLIDERS[name]) >= min);
    assert.ok(fromSlider(99999, SLIDERS[name]) <= max * (1 + 1e-12));
    assert.equal(toSlider(min / 1e6, SLIDERS[name]), TRACK.min);
    assert.ok(Math.abs(toSlider(max * 1e6, SLIDERS[name]) - TRACK.max) < 1e-9);
  }
});

test("the ranges are the ones the rest of the app believes in", () => {
  // These were duplicated at call sites before this module existed; pinning
  // them here is what stops them drifting apart again.
  assert.equal(SLIDERS.speed, SPEED_LIMITS);
  assert.equal(SLIDERS.trail, TRAIL_LIMITS);
  assert.deepEqual(EPS_LIMITS, { min: 1e-12, max: 1e-1 });
});

test("the rounding Lorenz typed sits inside the eps track", () => {
  // 1.27e-4 is the preset button's value. If the range ever moved past it the
  // button would park the thumb at a clamped end and quietly lie.
  const LORENZ_ROUNDING = 1.27e-4;
  assert.ok(LORENZ_ROUNDING > EPS_LIMITS.min && LORENZ_ROUNDING < EPS_LIMITS.max);
  const raw = toSlider(LORENZ_ROUNDING, EPS_LIMITS);
  assert.ok(raw > TRACK.min && raw < TRACK.max, `thumb parked at ${raw}`);
  assert.ok(Math.abs(fromSlider(raw, EPS_LIMITS) / LORENZ_ROUNDING - 1) < 1e-12);
});
