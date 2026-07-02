// Pure math for the bayes app. No DOM, no state — everything here is
// unit-tested by __tests__/math.test.js and imported by the demo modules.

// --- demo 1: base rates ---------------------------------------------------

// P(actually positive | tested positive) for a test with the given
// sensitivity (true-positive rate) and specificity (true-negative rate)
// applied to a population with the given base rate.
export const posterior = (baseRate, sensitivity, specificity) => {
  const tp = sensitivity * baseRate;
  const fp = (1 - specificity) * (1 - baseRate);
  const flagged = tp + fp;
  return flagged === 0 ? 0 : tp / flagged;
};

// Round fractional cell counts to integers that sum exactly to `total`
// (largest-remainder method; ties broken by index for determinism).
export const largestRemainder = (weights, total) => {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) =>
    sum === 0 ? total / weights.length : (w / sum) * total,
  );
  const floors = exact.map(Math.floor);
  let leftover = total - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ frac: x - floors[i], i }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = [...floors];
  for (const { i } of order) {
    if (leftover <= 0) break;
    out[i] += 1;
    leftover -= 1;
  }
  return out;
};

// Expected confusion counts for a population of n, as integers summing to n.
export const confusionCounts = (n, baseRate, sensitivity, specificity) => {
  const [tp, fn, fp, tn] = largestRemainder(
    [
      baseRate * sensitivity,
      baseRate * (1 - sensitivity),
      (1 - baseRate) * (1 - specificity),
      (1 - baseRate) * specificity,
    ],
    n,
  );
  return { tp, fn, fp, tn };
};

// --- demo 2: Gott / Copernican principle ----------------------------------

// If the present moment is a uniform random point in a thing's lifetime,
// then with confidence c its future lifetime lies in this interval.
export const gottInterval = (age, c) => ({
  low: (age * (1 - c)) / (1 + c),
  high: (age * (1 + c)) / (1 - c),
});

// Median estimate of total lifetime: double the observed age.
export const gottMedianTotal = (age) => 2 * age;

// --- demo 3: German tank problem ------------------------------------------

// Minimum-variance unbiased estimate of N from k serials with max m.
export const tankEstimate = (m, k) => m + m / k - 1;

// Deterministic PRNG (mulberry32) so simulations are reproducible in tests.
export const makeRng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// k distinct serials drawn uniformly from 1..n (partial Fisher-Yates).
export const sampleSerials = (n, k, rng) => {
  const pool = Array.from({ length: n }, (_, i) => i + 1);
  for (let i = 0; i < k; i += 1) {
    const j = i + Math.floor(rng() * (n - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, k);
};

// Distribution of the estimator over repeated sampling.
export const simulateEstimates = (n, k, trials, rng) =>
  Array.from({ length: trials }, () =>
    tankEstimate(Math.max(...sampleSerials(n, k, rng)), k),
  );

// Histogram counts for values over [lo, hi) split into `bins` equal bins;
// values outside the range clamp into the edge bins.
export const binCounts = (values, lo, hi, bins) => {
  const counts = new Array(bins).fill(0);
  const width = (hi - lo) / bins;
  for (const v of values) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / width)));
    counts[i] += 1;
  }
  return counts;
};
