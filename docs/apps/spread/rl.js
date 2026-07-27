// Reinforcement-learning core for the optimizer chapter. Pure, no DOM.
// Unit-tested by __tests__/rl.test.js.
//
// The MDP. An episode is one shoe played from full (26/26) to reshuffle.
//   state   = the deck composition (reds, blacks) — i.e. the count.
//   action  = a bet fraction f.
//   reward  = log of the round's wealth-multiplier (the Kelly objective).
// Because the reward is log-growth, optimal betting is scale-invariant, so
// bankroll drops out of the state — the table is indexed by the count alone.
//
// A closed (counting) policy sees (reds, blacks): it bets the majority color
// and sizes to the count. An open (non-counting) policy sees nothing: it bets
// a fixed color at a fixed fraction. The value of information is the gap.
//
// A key structural fact drives the learner: the next deal is independent of
// how much you bet, and log-rewards add, so the optimal bet at a state is
// *myopic* Kelly — the best single-round bet for that count. The agent is
// therefore online Monte-Carlo action-value estimation, one bandit over bet
// fractions per count-state: sample the round's log-growth, average it into
// Q(state, bet) from an optimistic start, act greedily. It converges cleanly
// to the exact optimum (which a backward-DP pass gives us as ground truth).

import { roundMultiplier } from "./sim.js";

export const REDS = 26;
export const TOTAL = 52;
const EPS_M = 1e-9; // floor on the multiplier so log() stays finite on ruin

// discretized bet fractions {0, .05, … 1.0}
export const ACTIONS = Array.from({ length: 21 }, (_, i) => i * 0.05);

// --- log-factorial table → stable hypergeometric PMF -----------------------
const LFACT = (() => {
  const t = new Float64Array(TOTAL + 1);
  for (let i = 2; i <= TOTAL; i++) t[i] = t[i - 1] + Math.log(i);
  return t;
})();
const logChoose = (n, k) =>
  k < 0 || k > n ? -Infinity : LFACT[n] - LFACT[k] - LFACT[n - k];

// P(k of the N dealt cards are red | r red, b black remain)
export const hyperPmf = (r, b, N, k) => {
  if (k < 0 || k > N || k > r || N - k > b) return 0;
  return Math.exp(logChoose(r, k) + logChoose(b, N - k) - logChoose(r + b, N));
};

// Sample how many of N cards dealt without replacement are red, from a deck of
// r red / b black. Sequential draw — same distribution as hyperPmf.
export const sampleReds = (rng, r, b, N) => {
  let redsLeft = r;
  let left = r + b;
  let out = 0;
  for (let i = 0; i < N; i++) {
    if (rng() * left < redsLeft) {
      redsLeft -= 1;
      out += 1;
    }
    left -= 1;
  }
  return out;
};

// log wealth-multiplier for a round with `wins` matching cards of `N` hands.
export const logReward = (wins, N, f, payoff) =>
  Math.log(Math.max(EPS_M, roundMultiplier(wins, N, f, payoff)));

// Wins for k reds dealt. A counter bets the majority remaining color; a
// non-counter bets a fixed color (red).
const winsFor = (r, b, k, N, counts) => (counts ? (r >= b ? k : N - k) : k);

// Expected single-round log-reward at state (r,b) for bet f — the myopic
// value that the agent's Q converges to.
const expectedReward = (r, b, N, f, payoff, counts) => {
  const kLo = Math.max(0, N - b);
  const kHi = Math.min(N, r);
  let e = 0;
  for (let k = kLo; k <= kHi; k++) {
    const p = hyperPmf(r, b, N, k);
    if (p) e += p * logReward(winsFor(r, b, k, N, counts), N, f, payoff);
  }
  return e;
};

// --- exact solver (dynamic programming over the count DAG) ------------------
// Closed policy: optimal bet per composition. States form a DAG (cards only
// decrease by N), so one memoized backward pass is exact.
export const solveClosed = ({ payoff, nHands }) => {
  const N = nHands;
  const memo = new Map();
  const rec = (r, b) => {
    if (r + b < N) return { v: 0, f: 0 };
    const key = r * 100 + b;
    const hit = memo.get(key);
    if (hit) return hit;
    let best = -Infinity;
    let bestF = 0;
    const kLo = Math.max(0, N - b);
    const kHi = Math.min(N, r);
    for (const f of ACTIONS) {
      let q = 0;
      for (let k = kLo; k <= kHi; k++) {
        const p = hyperPmf(r, b, N, k);
        if (p === 0) continue;
        q += p * (logReward(winsFor(r, b, k, N, true), N, f, payoff) + rec(r - k, b - (N - k)).v);
      }
      if (q > best) {
        best = q;
        bestF = f;
      }
    }
    const out = { v: best, f: bestF };
    memo.set(key, out);
    return out;
  };
  const start = rec(REDS, TOTAL - REDS);
  return {
    value: start.v,
    fraction: (r, b) => (memo.get(r * 100 + b) || { f: 0 }).f,
  };
};

// Open policy: no count → one fixed fraction, fixed color, for the whole shoe.
export const solveOpen = ({ payoff, nHands }) => {
  const N = nHands;
  let best = -Infinity;
  let bestF = 0;
  for (const f of ACTIONS) {
    const memo = new Map();
    const rec = (r, b) => {
      if (r + b < N) return 0;
      const key = r * 100 + b;
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      let q = 0;
      const kLo = Math.max(0, N - b);
      const kHi = Math.min(N, r);
      for (let k = kLo; k <= kHi; k++) {
        const p = hyperPmf(r, b, N, k);
        if (p === 0) continue;
        q += p * (logReward(winsFor(r, b, k, N, false), N, f, payoff) + rec(r - k, b - (N - k)));
      }
      memo.set(key, q);
      return q;
    };
    const v = rec(REDS, TOTAL - REDS);
    if (v > best) {
      best = v;
      bestF = f;
    }
  }
  return { value: best, fraction: () => bestF };
};

// --- online Monte-Carlo action-value agent ----------------------------------
// `counts` picks the abstraction: true → key on (reds, blacks) and bet the
// majority; false → a single aggregated state and a fixed color. Q is NOT
// cleared on reconfigure — constant-α lets the table re-adapt online.
export const createAgent = ({
  payoff,
  nHands,
  counts = true,
  alpha = 0.05,
  epsilon = 0.05,
  optimistic = 1,
}) => {
  const Q = new Map();
  const cfg = { payoff, nHands, counts, alpha, epsilon, optimistic };

  const keyOf = (r, b) => (cfg.counts ? r * 100 + b : -1);
  const getQ = (key) => {
    let q = Q.get(key);
    if (!q) {
      q = new Float64Array(ACTIONS.length).fill(cfg.optimistic);
      Q.set(key, q);
    }
    return q;
  };
  const argmax = (q, rng) => {
    let best = -Infinity;
    let ties = [];
    for (let i = 0; i < q.length; i++) {
      if (q[i] > best) {
        best = q[i];
        ties = [i];
      } else if (q[i] === best) ties.push(i);
    }
    return ties[Math.floor(rng() * ties.length)];
  };

  // Play one shoe, updating each visited (state, bet) toward the round's
  // sampled log-reward. Returns the realized shoe log-growth.
  const trainEpisode = (rng) => {
    const N = cfg.nHands;
    let r = REDS;
    let b = TOTAL - REDS;
    let growth = 0;
    while (r + b >= N) {
      const q = getQ(keyOf(r, b));
      const a =
        cfg.epsilon > 0 && rng() < cfg.epsilon
          ? Math.floor(rng() * ACTIONS.length)
          : argmax(q, rng);
      const k = sampleReds(rng, r, b, N);
      const reward = logReward(winsFor(r, b, k, N, cfg.counts), N, ACTIONS[a], cfg.payoff);
      q[a] += cfg.alpha * (reward - q[a]);
      growth += reward;
      r -= k;
      b -= N - k;
    }
    return growth;
  };

  return {
    trainEpisode,
    reconfigure(next) {
      Object.assign(cfg, next); // keep Q — re-adapt online
    },
    reset() {
      Q.clear();
    },
    // greedy fraction for a state, or null if never visited (for the heatmap)
    fraction(r, b) {
      const q = Q.get(keyOf(r, b));
      return q ? ACTIONS[argmax(q, () => 0)] : null;
    },
    // best learned single-round value at a state (max over bets), or null
    stateValue(r, b) {
      const q = Q.get(keyOf(r, b));
      return q ? Math.max(...q) : null;
    },
    policy() {
      return (r, b) => {
        const q = Q.get(keyOf(r, b));
        return q ? ACTIONS[argmax(q, () => 0)] : 0;
      };
    },
  };
};

// Average shoe log-growth of a policy (greedy, no exploration), by simulation.
export const evaluatePolicy = (rng, fractionFn, { payoff, nHands, counts }, shoes) => {
  const N = nHands;
  let total = 0;
  for (let s = 0; s < shoes; s++) {
    let r = REDS;
    let b = TOTAL - REDS;
    while (r + b >= N) {
      const f = fractionFn(r, b) ?? 0;
      const k = sampleReds(rng, r, b, N);
      total += logReward(winsFor(r, b, k, N, counts), N, f, payoff);
      r -= k;
      b -= N - k;
    }
  }
  return total / shoes;
};

// The reachable count-states for a given hand size, for drawing the heatmap.
// Each state is { r, b, count: r−b, cards: r+b }.
export const reachableStates = ({ nHands }) => {
  const N = nHands;
  const out = [];
  for (let cards = TOTAL; cards >= N; cards -= N) {
    const rLo = Math.max(0, cards - REDS);
    const rHi = Math.min(REDS, cards);
    for (let r = rLo; r <= rHi; r++) {
      out.push({ r, b: cards - r, count: r - (cards - r), cards });
    }
  }
  return out;
};

// The exact myopic-optimal single-round value at a state — what the agent's
// stateValue converges to (used to score/colour the ground-truth table).
export const exactStateValue = ({ payoff, nHands, counts }, r, b) => {
  let best = -Infinity;
  for (const f of ACTIONS) {
    const e = expectedReward(r, b, nHands, f, payoff, counts);
    if (e > best) best = e;
  }
  return best;
};
