import { test } from "node:test";
import assert from "node:assert/strict";
import {
  posterior,
  largestRemainder,
  confusionCounts,
  gottInterval,
  gottMedianTotal,
  tankEstimate,
  makeRng,
  sampleSerials,
  simulateEstimates,
  binCounts,
} from "../math.js";

const approx = (actual, expected, eps = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} ≈ ${expected}`,
  );

test("posterior: the headline example — 90% accurate test, 10% cheaters → 50%", () => {
  approx(posterior(0.1, 0.9, 0.9), 0.5);
});

test("posterior: rarer condition drags the answer down further", () => {
  // 1% base rate, 90% accurate: 0.009 / (0.009 + 0.099) ≈ 8.3%
  approx(posterior(0.01, 0.9, 0.9), 0.009 / (0.009 + 0.099));
  assert.ok(posterior(0.01, 0.9, 0.9) < 0.1);
});

test("posterior: perfect specificity means every flag is real", () => {
  approx(posterior(0.1, 0.9, 1.0), 1.0);
});

test("posterior: zero base rate means no flag is ever real", () => {
  approx(posterior(0, 0.9, 0.9), 0);
});

test("posterior: asymmetric sensitivity/specificity", () => {
  // sens .8, spec .95, base .1 → .08 / (.08 + .045)
  approx(posterior(0.1, 0.8, 0.95), 0.08 / (0.08 + 0.045));
});

test("largestRemainder: sums exactly to total", () => {
  const out = largestRemainder([1, 1, 1], 100);
  assert.equal(
    out.reduce((a, b) => a + b, 0),
    100,
  );
  assert.deepEqual(largestRemainder([0.5, 0.25, 0.25], 4), [2, 1, 1]);
});

test("largestRemainder: all-zero weights fall back to an even split", () => {
  assert.deepEqual(largestRemainder([0, 0], 10), [5, 5]);
});

test("confusionCounts: headline example at n=1000 → 90 TP, 90 FP", () => {
  const c = confusionCounts(1000, 0.1, 0.9, 0.9);
  assert.deepEqual(c, { tp: 90, fn: 10, fp: 90, tn: 810 });
  assert.equal(c.tp + c.fn + c.fp + c.tn, 1000);
});

test("confusionCounts: always sums to n even at awkward rates", () => {
  for (const [n, p, se, sp] of [
    [1000, 0.137, 0.83, 0.91],
    [997, 0.01, 0.999, 0.5],
    [200, 0.33, 0.66, 0.66],
  ]) {
    const { tp, fn, fp, tn } = confusionCounts(n, p, se, sp);
    assert.equal(tp + fn + fp + tn, n);
  }
});

test("gottInterval: Berlin Wall at age 8, 50% confidence → 2⅔ to 24 more years", () => {
  const { low, high } = gottInterval(8, 0.5);
  approx(low, 8 / 3);
  approx(high, 24);
});

test("gottInterval: 95% confidence → age/39 to 39×age", () => {
  const { low, high } = gottInterval(8, 0.95);
  approx(low, 8 / 39, 1e-6);
  approx(high, 8 * 39, 1e-6);
});

test("gottMedianTotal: double what you see", () => {
  assert.equal(gottMedianTotal(8), 16);
});

test("tankEstimate: classic textbook sample {19,40,42,60} → 74", () => {
  approx(tankEstimate(60, 4), 74);
});

test("tankEstimate: single observation is double-it (2m − 1)", () => {
  assert.equal(tankEstimate(50, 1), 99);
  assert.equal(tankEstimate(1, 1), 1);
});

test("makeRng: deterministic and in [0, 1)", () => {
  const a = makeRng(42);
  const b = makeRng(42);
  for (let i = 0; i < 100; i += 1) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test("sampleSerials: k distinct values within 1..n, reproducible by seed", () => {
  const s = sampleSerials(300, 10, makeRng(7));
  assert.equal(s.length, 10);
  assert.equal(new Set(s).size, 10);
  assert.ok(s.every((x) => x >= 1 && x <= 300));
  assert.deepEqual(s, sampleSerials(300, 10, makeRng(7)));
});

test("sampleSerials: k = n returns every serial once", () => {
  const s = sampleSerials(12, 12, makeRng(1));
  assert.deepEqual(
    [...s].sort((x, y) => x - y),
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
});

test("simulateEstimates: unbiased — mean of estimates lands near true N", () => {
  const est = simulateEstimates(300, 5, 4000, makeRng(3));
  const mean = est.reduce((a, b) => a + b, 0) / est.length;
  assert.ok(Math.abs(mean - 300) < 5, `mean ${mean} should be near 300`);
});

test("binCounts: totals preserved, out-of-range clamps to edges", () => {
  const counts = binCounts([0, 5, 10, 15, 99], 0, 20, 4);
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    5,
  );
  assert.deepEqual(counts, [1, 1, 1, 2]); // 99 clamps into the last bin
});
