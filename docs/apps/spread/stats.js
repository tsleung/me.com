// Pure statistics for the spread app. No DOM, no state.
// Unit-tested by __tests__/stats.test.js.

// Hypergeometric: draw n WITHOUT replacement from `total` cards of which K are
// the target color. Mean and variance of the target count.
export const hyperMean = (total, K, n) => (n * K) / total;

export const hyperVar = (total, K, n) =>
  total <= 1
    ? 0
    : n * (K / total) * (1 - K / total) * ((total - n) / (total - 1));

// Binomial variance — the WITH-replacement (independent-draws) comparison.
// For the same n and p this is strictly larger than hyperVar when n > 1: the
// deck's finite-population correction (total − n)/(total − 1) is the
// diversification bonus you get for free from drawing without replacement.
export const binomVar = (n, p) => n * p * (1 - p);

export const mean = (xs) =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export const variance = (xs) => {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) * (x - m)));
};

export const std = (xs) => Math.sqrt(variance(xs));

// Geometric mean of per-round wealth multipliers = the realized time-average
// growth factor. Computed in log space; a single non-positive multiplier
// (total ruin) pins the whole product at 0.
export const geomMean = (multipliers) => {
  if (multipliers.length === 0) return 1;
  let s = 0;
  for (const m of multipliers) {
    if (m <= 0) return 0;
    s += Math.log(m);
  }
  return Math.exp(s / multipliers.length);
};

// q-quantile (0..1) of an already-sorted ascending array, linear interp.
export const quantileSorted = (sorted, q) => {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

// Histogram: counts of `values` across `bins` equal-width buckets on
// [min, max]. Values exactly at max land in the last bin; out-of-range are
// dropped. Returns an integer count array of length `bins`.
export const histogram = (values, min, max, bins) => {
  const counts = new Array(bins).fill(0);
  if (max <= min || bins <= 0) return counts;
  const w = (max - min) / bins;
  for (const v of values) {
    if (v < min || v > max) continue;
    let idx = Math.floor((v - min) / w);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    counts[idx] += 1;
  }
  return counts;
};
