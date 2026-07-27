import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRng } from "../deck.js";
import { geomMean } from "../stats.js";
import {
  roundMultiplier,
  ensembleGrowth,
  simulateRound,
  simulatePath,
  fanBands,
  EVEN_MONEY,
  KNIFE_EDGE,
} from "../sim.js";

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

test("roundMultiplier: one hand at the knife-edge is ×2 on a win, ÷2 on a loss", () => {
  approx(roundMultiplier(1, 1, 1, KNIFE_EDGE), 2);
  approx(roundMultiplier(0, 1, 1, KNIFE_EDGE), 0.5);
});

test("roundMultiplier: even money, full stake, one hand → ×2 or ×0 (ruin)", () => {
  approx(roundMultiplier(1, 1, 1, EVEN_MONEY), 2);
  approx(roundMultiplier(0, 1, 1, EVEN_MONEY), 0);
});

test("roundMultiplier: splitting a round across hands shrinks the swing", () => {
  // Two hands, one win one loss, knife-edge, full stake: lands exactly on the
  // ensemble growth 1.25 — the swing of the single-hand lottery is gone.
  approx(roundMultiplier(1, 2, 1, KNIFE_EDGE), 1.25);
});

test("roundMultiplier: half of a fair deck (13 of 26 wins) → ensemble growth", () => {
  approx(roundMultiplier(13, 26, 1, KNIFE_EDGE), ensembleGrowth(1, KNIFE_EDGE));
  approx(ensembleGrowth(1, KNIFE_EDGE), 1.25);
  approx(ensembleGrowth(1, EVEN_MONEY), 1);
});

test("knife-edge time-average is flat at full stake, positive when fractional", () => {
  // Full stake: geometric mean of ×2 / ÷2 = 1 (ensemble grows, you don't).
  approx(geomMean([2, 0.5]), 1);
  // Half stake: ×1.5 / ×0.75 → geometric mean > 1 (Kelly territory).
  const win = roundMultiplier(1, 1, 0.5, KNIFE_EDGE);
  const lose = roundMultiplier(0, 1, 0.5, KNIFE_EDGE);
  approx(win, 1.5);
  approx(lose, 0.75);
  assert.ok(geomMean([win, lose]) > 1);
});

test("simulateRound: multiplier stays within [1 − f·l, 1 + f·g]", () => {
  const rng = makeRng(11);
  for (let i = 0; i < 500; i++) {
    const m = simulateRound(rng, {
      reds: 26,
      total: 52,
      nHands: 4,
      f: 0.8,
      payoff: KNIFE_EDGE,
    });
    assert.ok(m >= 1 - 0.8 * 0.5 - 1e-12 && m <= 1 + 0.8 * 1 + 1e-12);
  }
});

test("simulatePath: injection is added every round and length is rounds+1", () => {
  const rng = makeRng(1);
  // f = 0 means no betting: wealth is pure initial + injections.
  const path = simulatePath(rng, {
    rounds: 5,
    initial: 100,
    injection: 100,
    reds: 26,
    total: 52,
    nHands: 1,
    f: 0,
    payoff: KNIFE_EDGE,
  });
  assert.equal(path.length, 6);
  assert.deepEqual(path, [100, 200, 300, 400, 500, 600]);
});

test("simulatePath: reproducible under a fixed seed", () => {
  const opts = {
    rounds: 20,
    initial: 100,
    injection: 100,
    reds: 26,
    total: 52,
    nHands: 3,
    f: 0.5,
    payoff: KNIFE_EDGE,
  };
  const a = simulatePath(makeRng(99), opts);
  const b = simulatePath(makeRng(99), opts);
  assert.deepEqual(a, b);
});

test("fanBands: bands are ordered and shaped rounds+1", () => {
  const opts = {
    rounds: 10,
    initial: 100,
    injection: 100,
    reds: 26,
    total: 52,
    nHands: 2,
    f: 0.6,
    payoff: KNIFE_EDGE,
  };
  const { qs, bands, means } = fanBands(makeRng(7), opts, 400, [0.1, 0.5, 0.9]);
  assert.equal(qs.length, 3);
  assert.equal(bands[0].length, 11);
  assert.equal(means.length, 11);
  for (let r = 0; r <= 10; r++) {
    assert.ok(bands[0][r] <= bands[1][r] + 1e-9);
    assert.ok(bands[1][r] <= bands[2][r] + 1e-9);
  }
});

test("diversifying within a round lifts the realized time-average", () => {
  // Same knife-edge game, full stake, 200 rounds: one hand vs sixteen. More
  // hands → less per-round drag → higher terminal wealth in the median.
  const base = {
    rounds: 200,
    initial: 100,
    injection: 0,
    reds: 26,
    total: 52,
    f: 1,
    payoff: KNIFE_EDGE,
  };
  const one = simulatePath(makeRng(2024), { ...base, nHands: 1 });
  const many = simulatePath(makeRng(2024), { ...base, nHands: 16 });
  assert.ok(many[200] > one[200], `one=${one[200]} many=${many[200]}`);
});
