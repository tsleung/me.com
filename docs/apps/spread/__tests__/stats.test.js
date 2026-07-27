import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hyperMean,
  hyperVar,
  binomVar,
  mean,
  std,
  geomMean,
  quantileSorted,
  histogram,
} from "../stats.js";

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

test("hyperMean: 26/52 draws averages half red", () => {
  approx(hyperMean(52, 26, 26), 13);
  approx(hyperMean(52, 26, 1), 0.5);
});

test("hyperVar < binomVar for n>1: the without-replacement bonus", () => {
  // 26 draws of a 52-card deck: without-replacement variance is meaningfully
  // below the independent (with-replacement) variance.
  assert.ok(hyperVar(52, 26, 26) < binomVar(26, 0.5));
  approx(hyperVar(52, 26, 26), 26 * 0.25 * (26 / 51), 1e-9);
});

test("hyperVar: drawing the whole deck has zero variance (riskless)", () => {
  approx(hyperVar(52, 26, 52), 0);
});

test("hyperVar == binomVar at n=1 (one draw can't diversify)", () => {
  approx(hyperVar(52, 26, 1), binomVar(1, 0.5));
});

test("mean / std basics", () => {
  approx(mean([1, 2, 3, 4]), 2.5);
  approx(std([2, 2, 2]), 0);
  approx(std([1, 3]), 1);
});

test("geomMean of ×2 and ÷2 is exactly 1 (the knife-edge)", () => {
  approx(geomMean([2, 0.5]), 1);
});

test("geomMean is dragged below the arithmetic mean by spread", () => {
  // +50% / −50% has arithmetic mean 1 but geometric mean √0.75 < 1.
  approx(geomMean([1.5, 0.5]), Math.sqrt(0.75));
  assert.ok(geomMean([1.5, 0.5]) < mean([1.5, 0.5]));
});

test("geomMean: any ruin pins the product at 0", () => {
  approx(geomMean([2, 2, 0, 2]), 0);
});

test("quantileSorted: median and interpolation", () => {
  approx(quantileSorted([1, 2, 3], 0.5), 2);
  approx(quantileSorted([0, 10], 0.5), 5);
  approx(quantileSorted([0, 10], 0.1), 1);
});

test("histogram: counts land in the right bins; max is inclusive", () => {
  const counts = histogram([0, 0.4, 0.6, 1], 0, 1, 2);
  assert.deepEqual(counts, [2, 2]);
});
