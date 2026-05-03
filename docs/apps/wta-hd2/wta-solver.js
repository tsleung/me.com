// L1 — pure WTA solver. No DOM, no clock, no Math.random.
// Algorithm: greedy maximum-marginal-return.

const TIER_CLEAR_VALUE = { light: 1, medium: 3, heavy: 8, boss: 20 };

function armorMult(ap, ac) {
  if (ap >= ac + 1) return 1.0;
  if (ap === ac) return 0.5;
  return 0.1;
}

// Default per-weapon dispersion (radians of cone half-angle) when the
// weapon def doesn't specify. Hand-tuned to match HD2 feel:
//   ≥600 RPM (full-auto rifles, SMGs, MGs)  → ~3.5° cone (sustained fire)
//   300-600 RPM (DMRs, pistols)             → ~1.7°
//   <300 RPM (precision/single-shot)        → ~0.3°
//   stratagems / AoE / explosives           → 0 (deterministic; aim is the throw)
export function defaultDispersionRad(weapon) {
  if (weapon.dispersionRad != null) return weapon.dispersionRad;
  if (weapon.isStratagem || weapon.aoeRadiusM > 0) return 0;
  const rpm = weapon.fireRateRpm ?? 0;
  if (rpm >= 600) return 0.06;
  if (rpm >= 300) return 0.03;
  if (rpm > 0)    return 0.005;
  return 0;
}

// Default frontal silhouette width (m) for a part. Real data should
// annotate `frontalWidth` per part; until then, fall back by tier and
// weakpoint-ness so the model is at least directionally correct.
export function defaultFrontalWidth(part, target) {
  if (part?.frontalWidth != null) return part.frontalWidth;
  const tier = target?.threatTier ?? "light";
  const tierBody = { light: 0.5, medium: 0.8, heavy: 1.5, boss: 2.5 }[tier] ?? 0.8;
  // Weakpoints are usually small targets (head, butt, leg-joint).
  if (part?.isWeakPoint) return Math.min(0.4, tierBody * 0.25);
  // Heavily armored non-weak parts (ac >= 4) are typically the hard plate
  // facing the player — large but armored. Use full body width.
  return tierBody;
}

// Per-shot probability of hitting `part` given the weapon's dispersion at
// `distanceM`. Width / (dispersion_m + Σwidths) — the residual is "miss
// entirely" (covered the wrong volume). Width=0 ⇒ part is occluded from the
// front and unhittable.
export function partHitProbability(weapon, target, partIdx, distanceM) {
  const parts = target.parts || [];
  const dispRad = defaultDispersionRad(weapon);
  const dispM = dispRad * Math.max(1, distanceM);
  let sumWidth = 0;
  for (const p of parts) sumWidth += defaultFrontalWidth(p, target);
  const w = defaultFrontalWidth(parts[partIdx], target);
  if (w <= 0 || sumWidth <= 0) return 0;
  return w / (dispM + sumWidth);
}

// Expected damage per shot of weapon vs target at distanceM.
//
// Composed as Σ_part pHit(part) × armorMult(ap, ac) × weakpointMult(if
// penable). Residual probability ("miss entirely") contributes zero.
// Solver and engine.js:computeDamage MUST agree on this formula — last
// time they didn't, a Liberator killed a charger from the front in 4 s.
export function expectedDamagePerShot(weapon, target, distanceM) {
  const parts = target.parts || [];
  if (parts.length === 0) return 0;
  const ap = weapon.armorPen ?? 0;
  // dispersionRad === 0 → deterministic AoE / point-blank; bypass the
  // hit-probability model and apply best-pen-able-part damage. Used for
  // stratagem AoE and any future melee-range mechanic.
  if (defaultDispersionRad(weapon) === 0) {
    return deterministicBestPartDamage(weapon, target, ap);
  }
  const dispM = defaultDispersionRad(weapon) * Math.max(1, distanceM);
  let sumWidth = 0;
  for (const p of parts) sumWidth += defaultFrontalWidth(p, target);
  if (sumWidth <= 0) return 0;
  const denom = dispM + sumWidth;
  let total = 0;
  for (const p of parts) {
    const w = defaultFrontalWidth(p, target);
    if (w <= 0) continue;
    const pHit = w / denom;
    const am = armorMult(ap, p.ac ?? 0);
    const isWeakHit = !!p.isWeakPoint && ap >= (p.ac ?? 0);
    const wMult = isWeakHit ? (p.weakPointMultiplier ?? 1) : 1;
    total += pHit * am * wMult;
  }
  return (weapon.damage ?? 0) * total;
}

function deterministicBestPartDamage(weapon, target, ap) {
  // Mirrors engine's pre-fix bestPart, but with weakpoint multiplier
  // gated on penetration (matches the August 2026 fix).
  const parts = target.parts || [];
  let bestWeak = null;
  let bestNonWeak = null;
  for (const p of parts) {
    if (p.isWeakPoint && ap >= (p.ac ?? 0)) {
      if (bestWeak == null || (p.weakPointMultiplier ?? 1) > (bestWeak.weakPointMultiplier ?? 1)) bestWeak = p;
    } else {
      if (bestNonWeak == null || (p.ac ?? 0) < (bestNonWeak.ac ?? 0)) bestNonWeak = p;
    }
  }
  const chosen = bestWeak || bestNonWeak || parts[0];
  if (!chosen) return 0;
  const am = armorMult(ap, chosen.ac ?? 0);
  const isWeakHit = !!chosen.isWeakPoint && ap >= (chosen.ac ?? 0);
  const wMult = isWeakHit ? (chosen.weakPointMultiplier ?? 1) : 1;
  return (weapon.damage ?? 0) * am * wMult;
}

export function pKill(weapon, target, distanceM) {
  const exp = expectedDamagePerShot(weapon, target, distanceM);
  if (exp <= 0) return 0;
  const shotsToKill = Math.ceil(target.hp / exp);
  if (shotsToKill <= 0) return 1;
  const shots = weapon.shotsAvailableThisTick || 0;
  return Math.max(0, Math.min(1, shots / shotsToKill));
}

export function valueFor(target, alpha, distanceM) {
  const range = target.attackRangeM || 0;
  const dps = distanceM < range ? (target.meleeDps || 0) : (target.rangedDps || 0);
  const ttp = Math.max(1, target.timeToReachPlayerSecs || 0);
  const threat = dps * (1 / ttp);
  const clearValue = TIER_CLEAR_VALUE[target.threatTier] ?? 1;
  return alpha * threat + (1 - alpha) * clearValue;
}

// Efficiency term: how well-matched is this weapon to this target?
// 1.0 = expected damage exactly matches HP (single-shot kill of full-HP).
// → 0  = vast over-kill (e.g. EAT into a 60-HP hunter ≈ 0.1).
// → 0  = no penetration (e.g. Liberator into chargers when ap < ac).
// Used only by the γ-weighted value path; keeps existing α/β math
// untouched so legacy callers and tests are unaffected.
export function efficiencyFor(weapon, target, distanceM) {
  const exp = expectedDamagePerShot(weapon, target, distanceM);
  if (exp <= 0) return 0;
  const hp = Math.max(1, target.hp || 0);
  return Math.max(0, Math.min(1, hp / exp));
}

// Three-term value: α·threat + β·clearValue + γ·efficiency.
// `weights` is auto-clamped to the simplex (non-negative, sums to 1)
// in normalizeWeights below; callers can pass partial objects and we
// fill in defaults.
export function valueForWeighted(weapon, target, weights, distanceM) {
  const range = target.attackRangeM || 0;
  const dps = distanceM < range ? (target.meleeDps || 0) : (target.rangedDps || 0);
  const ttp = Math.max(1, target.timeToReachPlayerSecs || 0);
  const threat = dps * (1 / ttp);
  const clearValue = TIER_CLEAR_VALUE[target.threatTier] ?? 1;
  const eff = weights.gamma > 0 ? efficiencyFor(weapon, target, distanceM) : 0;
  return weights.alpha * threat + weights.beta * clearValue + weights.gamma * eff;
}

// Project a {alpha, gamma} (or {alpha, beta, gamma}) blob onto the
// 2-simplex: non-negative, sums to 1. β defaults to (1−α−γ); if the
// caller over-specifies, we renormalize. Stable for legacy callers
// that only pass `alpha` (β = 1−α, γ = 0 — exactly today's behavior).
export function normalizeWeights(input = {}) {
  const a = clamp01(input.alpha ?? 0.5);
  const g = clamp01(input.gamma ?? 0);
  let b = input.beta != null ? clamp01(input.beta) : Math.max(0, 1 - a - g);
  let sum = a + b + g;
  if (sum <= 0) return { alpha: 0, beta: 1, gamma: 0 };
  return { alpha: a / sum, beta: b / sum, gamma: g / sum };
}

function clamp01(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

export function reserveBlocked(weapon, target, weaponState) {
  const cfg = weapon.reserveCfg;
  if (!cfg || !cfg.enabled) return false;
  const min = cfg.minStockBeforeUseOnTier?.[target.threatTier];
  if (min == null) return false;
  const stock = weaponState?.stock ?? weapon.shotsAvailableThisTick ?? 0;
  return stock < min;
}

function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// Project a target's position to where it will be after `secs` seconds of
// constant-velocity travel. Used for stratagems with non-trivial call-in time
// (380, mines, orbital laser) — the throw lands where the enemy WILL be, not
// where it is now. Without this, long-call-in stratagems are systematically
// undervalued because the target has walked out of the kill radius by the
// time the strike resolves.
function projectedTarget(target, secs) {
  if (!secs || secs <= 0 || !target.velocity) return target;
  const px = target.position.x + (target.velocity.dx || 0) * secs;
  const py = target.position.y + (target.velocity.dy || 0) * secs;
  const distanceM = Math.hypot(px, py);
  return { ...target, position: { x: px, y: py }, distanceM };
}

// For AoE weapons: marginal value sums (pKill_i * value_i) over targets in radius.
// For single-target: pKill * value of the primary.
// For stratagems with callInSecs > 0: project all participants forward to
// predicted landing positions before computing distances + AoE membership.
function pairValue(weapon, primary, targets, weights) {
  const callIn = weapon.callInSecs || 0;
  const projPrimary = projectedTarget(primary, callIn);
  const primaryDist = projPrimary.distanceM;
  const primaryPK = pKill(weapon, projPrimary, primaryDist);
  const primaryVal = valueForWeighted(weapon, projPrimary, weights, primaryDist) * primaryPK;
  const aoe = weapon.aoeRadiusM || 0;
  if (aoe <= 0) return primaryVal;
  const r2 = aoe * aoe;
  let total = primaryVal;
  for (const t of targets) {
    if (t.id === primary.id) continue;
    const projT = projectedTarget(t, callIn);
    if (dist2(projT.position, projPrimary.position) > r2) continue;
    const pk = pKill(weapon, projT, projT.distanceM);
    total += pk * valueForWeighted(weapon, projT, weights, projT.distanceM);
  }
  return total;
}

// Shots needed for a single weapon to kill a target (unbounded by tick capacity).
function shotsToKill(weapon, target) {
  const proj = projectedTarget(target, weapon.callInSecs || 0);
  const exp = expectedDamagePerShot(weapon, proj, proj.distanceM);
  if (exp <= 0) return Infinity;
  return Math.max(1, Math.ceil(target.hp / exp));
}

// Maximum range a weapon can reach this tick.
// For call-in weapons, "reach" means the throw can land on a predicted
// position even if the target's *current* position is beyond conventional
// weapon range. Range gate is applied to the projected position.
function inRange(weapon, target) {
  const range = weapon.maxRangeM || Infinity;
  const callIn = weapon.callInSecs || 0;
  if (callIn <= 0) return target.distanceM <= range;
  const proj = projectedTarget(target, callIn);
  return proj.distanceM <= range;
}

export function assign(input) {
  const { weapons = [], targets = [], alpha = 0.5, beta, gamma = 0, reserves = {} } = input || {};
  const weights = normalizeWeights({ alpha, beta, gamma });
  if (weapons.length === 0 || targets.length === 0) return [];

  // Working copies — we mutate hp and shot capacity locally.
  const tState = new Map();
  for (const t of targets) {
    tState.set(t.id, { ...t, hp: t.hp, alive: true });
  }
  const wState = new Map();
  for (const w of weapons) {
    const cfg = reserves[w.id] || w.reserveCfg;
    wState.set(w.id, {
      ...w,
      reserveCfg: cfg,
      shotsLeft: w.shotsAvailableThisTick || 0,
      fired: false,
    });
  }

  const out = [];

  // Sort weapons and targets for determinism in tie-breaks.
  const weaponOrder = [...wState.keys()].sort();
  const targetOrder = [...tState.keys()].sort();

  // Hoisted alive-target snapshot. Recomputed only when a kill happens
  // (or AoE collateral kills). Saves O(W·T) array rebuilds per assignment;
  // bit-exact because the filter result is identical.
  let aliveTargets = [...tState.values()].filter((x) => x.alive);

  while (true) {
    let bestVal = 0;
    let bestPair = null;

    for (const wid of weaponOrder) {
      const w = wState.get(wid);
      if (w.fired || w.shotsLeft <= 0) continue;
      for (const tid of targetOrder) {
        const t = tState.get(tid);
        if (!t.alive) continue;
        if (!inRange(w, t)) continue;
        if (reserveBlocked(w, t)) continue;
        const v = pairValue(w, t, aliveTargets, weights);
        if (v > bestVal) {
          bestVal = v;
          bestPair = { wid, tid };
        }
      }
    }

    if (!bestPair || bestVal <= 0) break;

    const w = wState.get(bestPair.wid);
    const t = tState.get(bestPair.tid);
    const stk = shotsToKill(w, t);
    const shots = Math.min(w.shotsLeft, stk);

    out.push({ weaponId: w.id, targetId: t.id, shots });

    // Decrement target HP by expected dmg from those shots.
    const callIn = w.callInSecs || 0;
    const projT = projectedTarget(t, callIn);
    const exp = expectedDamagePerShot(w, projT, projT.distanceM);
    t.hp -= shots * exp;
    if (t.hp <= 0) {
      t.alive = false;
      // For AoE, also kill collateral that this assignment would have killed.
      // Use projected positions so call-in collateral matches projected primary.
      if ((w.aoeRadiusM || 0) > 0) {
        const r2 = w.aoeRadiusM * w.aoeRadiusM;
        for (const other of tState.values()) {
          if (!other.alive || other.id === t.id) continue;
          const projO = projectedTarget(other, callIn);
          if (dist2(projO.position, projT.position) > r2) continue;
          const expO = expectedDamagePerShot(w, projO, projO.distanceM);
          other.hp -= shots * expO;
          if (other.hp <= 0) other.alive = false;
        }
      }
    }

    // Weapon is one-shot per tick: spent it.
    w.shotsLeft -= shots;
    w.fired = true;
  }

  return out;
}
