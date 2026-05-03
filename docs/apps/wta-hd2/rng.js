export function mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a 32-bit. Stable across runs and platforms; good enough for seed derivation.
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function pick(rng, arr) {
  if (arr.length === 0) throw new Error("pick: empty array");
  return arr[Math.floor(rng() * arr.length)];
}

// Box-Muller. Caches the second value to avoid waste.
let _gaussCache = null;
let _gaussCacheRng = null;
export function gaussian(rng, mean = 0, std = 1) {
  if (_gaussCache !== null && _gaussCacheRng === rng) {
    const v = _gaussCache;
    _gaussCache = null;
    _gaussCacheRng = null;
    return mean + std * v;
  }
  let u1 = rng();
  if (u1 < 1e-12) u1 = 1e-12;
  const u2 = rng();
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  _gaussCache = r * Math.sin(theta);
  _gaussCacheRng = rng;
  return mean + std * (r * Math.cos(theta));
}
