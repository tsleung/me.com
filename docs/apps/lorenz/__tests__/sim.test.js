// The simulation loop used to live inside requestAnimationFrame, where no test
// could reach it. These are the characterization tests for what it does — the
// behaviours that had no coverage at all while they were trapped in the shell.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASSIC, DT, rk4, field, separation, phaseSpeed } from "../lorenz.js";
import { brush, widthMult, BRUSH } from "../calligraphy.js";
import { makeSim, refork, step, vertex, sinceFork, dwellOf } from "../sim.js";

const EPS = 1.27e-4;

test("a fresh sim starts on the attractor with the twin eps away", () => {
  const s = makeSim(CLASSIC, EPS);
  assert.equal(s.t, 0);
  assert.equal(s.forkT, 0);
  assert.equal(s.eps, EPS);
  assert.ok(Math.abs(separation(s.a, s.b) - EPS) < 1e-12, "twin is exactly eps away");
  assert.ok(s.a.z > 1 && s.a.z < 60, "reference is on the attractor, not at the seed");
  assert.equal(s.penA.lobeSign, Math.sign(s.a.x));
});

test("both pens start settled, not ramping up from nothing", () => {
  // A pen starting at press=0 would open every reseed with a spurious width
  // swell as the lag climbed to where it should already have been.
  const s = makeSim(CLASSIC, EPS);
  for (const pen of [s.penA, s.penB]) {
    assert.ok(pen.press >= 0 && pen.press <= 1);
  }
  const settled = brush(s.a, CLASSIC, 1e3, field).press;
  assert.ok(Math.abs(s.penA.press - settled) < 1e-12, "pen A did not start settled");
});

test("step does not mutate its input", () => {
  const s = makeSim(CLASSIC, EPS);
  const before = structuredClone(s);
  const next = step(s, CLASSIC);
  assert.deepEqual(s, before, "step mutated the sim it was given");
  assert.notEqual(next, s, "step must return a new object");
});

test("step is deterministic and matches a plain rk4 walk exactly", () => {
  const a0 = makeSim(CLASSIC, EPS);
  let x = a0;
  let y = a0;
  for (let i = 0; i < 5000; i++) {
    x = step(x, CLASSIC);
    y = step(y, CLASSIC);
  }
  assert.deepEqual(x, y, "same input must give a bit-identical run");

  // The trajectories themselves must be untouched by all the pen bookkeeping.
  let ref = a0.a;
  for (let i = 0; i < 5000; i++) ref = rk4(ref, CLASSIC, DT);
  assert.deepEqual(x.a, ref, "the reference drifted from a plain rk4 walk");
});

test("the clock advances by exactly DT per step", () => {
  let s = makeSim(CLASSIC, EPS);
  for (let i = 1; i <= 100; i++) {
    s = step(s, CLASSIC);
    assert.ok(Math.abs(s.t - i * DT) < 1e-12, `t drifted at step ${i}`);
  }
});

test("lastFlipT is set on exactly the step that crosses between wings", () => {
  // This is the highest-leverage line in the app: it feeds dwell, which feeds
  // the brush entry, which feeds both stroke weight and playback speed.
  let s = makeSim(CLASSIC, EPS);
  let crossings = 0;
  for (let i = 0; i < 40000; i++) {
    const prev = s;
    s = step(s, CLASSIC);
    const crossed = Math.sign(s.a.x) !== 0 && Math.sign(s.a.x) !== prev.penA.lobeSign;
    if (crossed) {
      crossings++;
      assert.equal(s.penA.lastFlipT, s.t, "a crossing must stamp the current time");
      assert.equal(dwellOf(s, s.penA), 0, "dwell must be zero on the crossing step");
    } else {
      assert.equal(s.penA.lastFlipT, prev.penA.lastFlipT, "lastFlipT moved without a crossing");
    }
  }
  assert.ok(crossings > 10, `only ${crossings} crossings — not a real sample`);
});

test("each trajectory carries its OWN pen", () => {
  // Regression: dwell and press were computed from the reference and written
  // onto both trails. Once the twins separate, the twin was colored by the
  // reference's time-since-crossing and pressed into turns it was not taking.
  let s = makeSim(CLASSIC, 1e-3);
  let sawDifferentDwell = false;
  let sawDifferentPress = false;

  for (let i = 0; i < 60000; i++) {
    s = step(s, CLASSIC);
    if (s.penA.lastFlipT !== s.penB.lastFlipT) sawDifferentDwell = true;
    if (Math.abs(s.penA.press - s.penB.press) > 0.05) sawDifferentPress = true;
    if (sawDifferentDwell && sawDifferentPress) break;
  }

  assert.ok(sawDifferentDwell, "the twins never disagreed about the last crossing");
  assert.ok(sawDifferentPress, "the twins never disagreed about brush pressure");
});

test("a vertex reports its own trajectory's pen, not the other one's", () => {
  let s = makeSim(CLASSIC, 1e-3);
  for (let i = 0; i < 20000; i++) s = step(s, CLASSIC);
  const d = separation(s.a, s.b);

  const va = vertex(s, CLASSIC, "a", d);
  const vb = vertex(s, CLASSIC, "b", d);

  assert.deepEqual([va.x, va.y, va.z], [s.a.x, s.a.y, s.a.z]);
  assert.deepEqual([vb.x, vb.y, vb.z], [s.b.x, s.b.y, s.b.z]);
  assert.equal(va.press, s.penA.press);
  assert.equal(vb.press, s.penB.press);
  assert.equal(va.dwell, dwellOf(s, s.penA));
  assert.equal(vb.dwell, dwellOf(s, s.penB));
  assert.equal(va.v, phaseSpeed(s.a, CLASSIC));
  assert.equal(vb.v, phaseSpeed(s.b, CLASSIC));
  // Pairwise quantities ARE shared — those two were never the bug.
  assert.equal(va.delta, vb.delta);
  assert.equal(va.eps, vb.eps);
});

test("refork puts the twin back on the reference and restarts the fork clock", () => {
  let s = makeSim(CLASSIC, EPS);
  for (let i = 0; i < 8000; i++) s = step(s, CLASSIC);
  assert.ok(sinceFork(s) > 30, "sanity: the fork has been running");
  assert.ok(separation(s.a, s.b) > EPS * 100, "sanity: the twins have separated");

  const r = refork(s, 1e-9);
  assert.deepEqual(r.a, s.a, "the reference must not move");
  assert.ok(Math.abs(separation(r.a, r.b) - 1e-9) < 1e-15, "twin re-forked at the new eps");
  assert.equal(r.eps, 1e-9);
  assert.equal(r.forkT, s.t);
  assert.equal(sinceFork(r), 0);
  // The twin IS the reference now, so it inherits the reference's pen rather
  // than keeping the weight of a trajectory it no longer has.
  assert.deepEqual(r.penB, r.penA);
  assert.notEqual(r.penB, r.penA, "and must be a copy, not a shared reference");
});

test("params are passed in, never captured — changing them takes effect at once", () => {
  const s = makeSim(CLASSIC, EPS);
  const hot = step(s, CLASSIC);
  const cold = step(s, { ...CLASSIC, rho: 12 });
  assert.notDeepEqual(hot.a, cold.a, "a different rho must produce a different step");
});

test("the drawn width never steps — now driving the shipped stepper", () => {
  // This test used to re-implement app.js's loop by hand, which meant it was
  // pinning a COPY of the code under test: change the ordering in the app and
  // the test kept passing against its own duplicate. It now drives step().
  const range = BRUSH.widthPress - BRUSH.widthLift;
  let s = makeSim(CLASSIC, EPS);

  let worstSmoothed = 0;
  let worstRaw = 0;
  let prevW = widthMult(s.penA.press);
  let prevRawW = prevW;
  let crossings = 0;

  for (let i = 0; i < 200000; i++) {
    const prevFlip = s.penA.lastFlipT;
    s = step(s, CLASSIC);
    if (s.penA.lastFlipT !== prevFlip) crossings++;

    const w = widthMult(s.penA.press);
    worstSmoothed = Math.max(worstSmoothed, Math.abs(w - prevW));
    prevW = w;

    const target = brush(s.a, CLASSIC, dwellOf(s, s.penA), field).press;
    const rawW = widthMult(target);
    worstRaw = Math.max(worstRaw, Math.abs(rawW - prevRawW));
    prevRawW = rawW;
  }

  assert.ok(crossings > 20, `only ${crossings} wing crossings — not a real sample`);

  const bound = (1 - Math.exp(-DT / BRUSH.inertiaTau)) * range;
  assert.ok(
    worstSmoothed <= bound * 1.001,
    `width moved ${worstSmoothed.toFixed(4)} in one step, above the lag's bound ${bound.toFixed(4)}`,
  );
  assert.ok(bound * 1.5 < 0.12, `${(bound * 1.5).toFixed(3)}px per segment is visible`);

  // Anti-vacuity: the unfiltered signal must still jump, or the assertion above
  // is proving nothing.
  assert.ok(
    worstRaw > range * 0.3,
    `unfiltered width only moved ${worstRaw.toFixed(3)} per step — is the entry snap gone?`,
  );
});
