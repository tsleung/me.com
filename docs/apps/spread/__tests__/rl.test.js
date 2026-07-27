import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRng } from "../deck.js";
import { KNIFE_EDGE, EVEN_MONEY } from "../sim.js";
import {
  hyperPmf,
  sampleReds,
  solveClosed,
  solveOpen,
  createAgent,
  evaluatePolicy,
  reachableStates,
} from "../rl.js";

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

test("hyperPmf: sums to 1 and matches a known value", () => {
  let s = 0;
  for (let k = 0; k <= 2; k++) s += hyperPmf(26, 26, 2, k);
  approx(s, 1, 1e-12);
  // P(2 reds in 2 draws from 26/26) = C(26,2)/C(52,2) = 325/1326
  approx(hyperPmf(26, 26, 2, 2), 325 / 1326, 1e-12);
});

test("sampleReds: mean tracks n·r/(r+b)", () => {
  const rng = makeRng(3);
  let sum = 0;
  const trials = 40000;
  for (let i = 0; i < trials; i++) sum += sampleReds(rng, 26, 26, 4);
  assert.ok(Math.abs(sum / trials - 2) < 0.03);
});

test("solveClosed: Kelly at the balanced start is 0.5 for the ×2/÷2 edge", () => {
  // With log utility the optimal bet is myopic per-state Kelly; at 26/26,
  // one hand, knife-edge, that's exactly f = 0.5.
  const sol = solveClosed({ payoff: KNIFE_EDGE, nHands: 1 });
  approx(sol.fraction(26, 26), 0.5);
  assert.ok(sol.value > 0);
});

test("solveClosed: no house edge on a balanced deck → bet nothing", () => {
  const sol = solveClosed({ payoff: EVEN_MONEY, nHands: 1 });
  approx(sol.fraction(26, 26), 0);
});

test("solveClosed: a one-color deck is a sure thing → bet the max", () => {
  // Even at even money, if only red cards remain, betting red always wins.
  const sol = solveClosed({ payoff: EVEN_MONEY, nHands: 1 });
  approx(sol.fraction(10, 0), 1);
});

test("closed policy is at least as good as open (information has value)", () => {
  const closed = solveClosed({ payoff: EVEN_MONEY, nHands: 1 });
  const open = solveOpen({ payoff: EVEN_MONEY, nHands: 1 });
  // no house edge: the non-counter can only bet 0 → zero growth; the counter
  // extracts a positive edge from the depleting deck.
  approx(open.value, 0, 1e-9);
  assert.ok(closed.value > open.value + 1e-6);
});

test("reachableStates: start present, all balanced, counts consistent", () => {
  const states = reachableStates({ nHands: 1 });
  assert.ok(states.some((s) => s.r === 26 && s.b === 26));
  for (const s of states) {
    assert.equal(s.count, s.r - s.b);
    assert.equal(s.cards, s.r + s.b);
    assert.ok(s.r >= 0 && s.b >= 0 && s.r <= 26 && s.b <= 26);
  }
});

test("MC control converges toward the exact optimum (realized growth)", () => {
  const cfg = { payoff: KNIFE_EDGE, nHands: 1, counts: true };
  const exact = solveClosed(cfg);
  const open = solveOpen(cfg);
  const agent = createAgent({ ...cfg, alpha: 0.02, epsilon: 0.15, optimistic: 1 });
  const rng = makeRng(2024);
  for (let i = 0; i < 80000; i++) agent.trainEpisode(rng);

  // the learned greedy policy realizes growth close to the exact optimum
  // (the ceiling is ~0.9 — rarely-visited extreme counts stay undertrained)...
  const learned = evaluatePolicy(makeRng(9), agent.policy(), cfg, 6000);
  assert.ok(
    learned > exact.value * 0.85,
    `learned=${learned} exact=${exact.value}`,
  );
  // ...and beats the non-counting open policy (information has value).
  assert.ok(learned > open.value, `learned=${learned} open=${open.value}`);
});

test("agent re-adapts after a config change without a reset", () => {
  // learn under even money, then flip to the knife-edge and keep training —
  // realized growth should climb as the table re-adapts online.
  const cfgEven = { payoff: EVEN_MONEY, nHands: 1, counts: true };
  const cfgKnife = { payoff: KNIFE_EDGE, nHands: 1, counts: true };
  const agent = createAgent({ ...cfgEven, alpha: 0.05, epsilon: 0.1, optimistic: 1 });
  const rng = makeRng(7);
  for (let i = 0; i < 15000; i++) agent.trainEpisode(rng);
  const before = evaluatePolicy(makeRng(5), agent.policy(), cfgEven, 4000);
  agent.reconfigure({ payoff: KNIFE_EDGE });
  for (let i = 0; i < 25000; i++) agent.trainEpisode(rng);
  const after = evaluatePolicy(makeRng(5), agent.policy(), cfgKnife, 4000);
  assert.ok(after > before + 0.1, `before=${before} after=${after}`);
});
