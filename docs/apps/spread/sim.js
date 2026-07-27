// Pure simulation core for the spread app. No DOM, no state.
// Unit-tested by __tests__/sim.test.js.

import { drawReds } from "./deck.js";
import { mean, quantileSorted } from "./stats.js";

// A payoff is { g, l }: a matching card multiplies its sub-stake by (1 + g),
// a miss by (1 − l). We pin the win at g = 1 (+100%) and dial the loss:
//   l = 1   → even money, no house edge (ensemble-fair; drag comes from f).
//   l = 0.5 → win ×2 / lose ÷2, the ergodic knife-edge (ensemble +25%·f,
//             time-average flat at f = 1).
export const EVEN_MONEY = { g: 1, l: 1 };
export const KNIFE_EDGE = { g: 1, l: 0.5 };

// Wealth multiplier for one round. You stake fraction `f` of wealth, split
// equally across `nHands` cards (all betting one fixed color); `wins` of them
// match. The per-hand payoffs collapse to a function of the win-fraction
// p = wins / nHands:
//     m = 1 + f · ((g + l)·p − l)
// Diversification lives entirely in the spread of p: one hand makes p a coin
// flip {0, 1}; many hands concentrate it near ½, shrinking the spread of m.
export const roundMultiplier = (wins, nHands, f, payoff) => {
  const p = wins / nHands;
  return 1 + f * ((payoff.g + payoff.l) * p - payoff.l);
};

// The ensemble (arithmetic-mean) growth factor per round, in closed form.
// E[p] = ½ for a fair deck, so E[m] = 1 + f·(g − l)/2. Even money → 1.
export const ensembleGrowth = (f, payoff) => 1 + (f * (payoff.g - payoff.l)) / 2;

// Simulate one round from a fresh deck: deal nHands cards, count matches
// (a single fixed color, so wins = reds drawn), return the multiplier.
export const simulateRound = (rng, { reds, total, nHands, f, payoff }) => {
  const wins = drawReds(rng, reds, total, nHands);
  return roundMultiplier(wins, nHands, f, payoff);
};

// One wealth path over `rounds` reshuffled rounds. Each round: bet, apply the
// multiplier, then inject fresh capital. Returns wealth after each round —
// length rounds + 1, index 0 is the starting balance.
export const simulatePath = (rng, opts) => {
  const { rounds, initial, injection, reds, total, nHands, f, payoff } = opts;
  const path = new Array(rounds + 1);
  path[0] = initial;
  let w = initial;
  for (let r = 1; r <= rounds; r++) {
    const m = simulateRound(rng, { reds, total, nHands, f, payoff });
    w = Math.max(0, w * m) + injection;
    path[r] = w;
  }
  return path;
};

// Run `paths` wealth paths and reduce to per-round summary bands for the fan
// chart. `qs` are quantile levels (0..1). Returns { qs, bands, means } where
// bands[i] and means are arrays of length rounds + 1.
export const fanBands = (rng, opts, paths, qs) => {
  const { rounds } = opts;
  const cols = Array.from({ length: rounds + 1 }, () => new Array(paths));
  for (let p = 0; p < paths; p++) {
    const path = simulatePath(rng, opts);
    for (let r = 0; r <= rounds; r++) cols[r][p] = path[r];
  }
  const bands = qs.map(() => new Array(rounds + 1));
  const means = new Array(rounds + 1);
  for (let r = 0; r <= rounds; r++) {
    const col = cols[r];
    col.sort((a, b) => a - b);
    qs.forEach((q, qi) => (bands[qi][r] = quantileSorted(col, q)));
    means[r] = mean(col);
  }
  return { qs, bands, means };
};
