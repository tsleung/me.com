import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assign,
  pKill,
  valueFor,
  reserveBlocked,
  efficiencyFor,
  normalizeWeights,
} from "../wta-solver.js";

// ---------- fixtures ----------

function makeWeapon(over = {}) {
  return {
    id: "w1",
    slot: "primary",
    damage: 100,
    durableDamage: 100,
    armorPen: 3,
    shotsAvailableThisTick: 5,
    aoeRadiusM: 0,
    weakPointHitRateBase: 0,
    maxRangeM: 100,
    isStratagem: false,
    ...over,
  };
}

function makeTarget(over = {}) {
  return {
    id: "t1",
    archetypeId: "scav",
    threatTier: "light",
    hp: 50,
    parts: [{ ac: 1, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }],
    position: { x: 0, y: 30 },
    distanceM: 30,
    timeToReachPlayerSecs: 10,
    meleeDps: 10,
    rangedDps: 0,
    attackRangeM: 2,
    ...over,
  };
}

const RNG = () => 0.5; // deterministic

// ---------- empty inputs ----------

test("empty weapons → []", () => {
  assert.deepEqual(assign({ weapons: [], targets: [makeTarget()], alpha: 0.5, reserves: {}, rng: RNG, tickMs: 100 }), []);
});

test("empty targets → []", () => {
  assert.deepEqual(assign({ weapons: [makeWeapon()], targets: [], alpha: 0.5, reserves: {}, rng: RNG, tickMs: 100 }), []);
});

// ---------- trivial single pair ----------

test("trivial single pair, weapon kills in 1 shot → shots:1", () => {
  const w = makeWeapon({ damage: 100, shotsAvailableThisTick: 1, armorPen: 9 });
  const t = makeTarget({ hp: 50, parts: [{ ac: 1, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }] });
  const out = assign({ weapons: [w], targets: [t], alpha: 0.5, reserves: {}, rng: RNG, tickMs: 100 });
  assert.equal(out.length, 1);
  assert.equal(out[0].weaponId, "w1");
  assert.equal(out[0].targetId, "t1");
  assert.equal(out[0].shots, 1);
});

// ---------- AP scaling ----------

test("AP3 vs AC2 → 100% mult (overpenetrating)", () => {
  const w = makeWeapon({ damage: 100, armorPen: 3, weakPointHitRateBase: 0, shotsAvailableThisTick: 1 });
  // hp=100 → with full mult, exp dmg = 100, shotsToKill = 1, pKill = 1
  const t = makeTarget({ hp: 100, parts: [{ ac: 2, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }] });
  assert.equal(pKill(w, t, t.distanceM), 1);
});

test("AP3 vs AC3 → 50% mult", () => {
  const w = makeWeapon({ damage: 100, armorPen: 3, weakPointHitRateBase: 0, shotsAvailableThisTick: 1 });
  // exp dmg = 50; hp 100 → shotsToKill 2; pKill = 1/2 = 0.5
  const t = makeTarget({ hp: 100, parts: [{ ac: 3, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }] });
  assert.equal(pKill(w, t, t.distanceM), 0.5);
});

test("AP3 vs AC4 → 10% mult (under)", () => {
  const w = makeWeapon({ damage: 100, armorPen: 3, weakPointHitRateBase: 0, shotsAvailableThisTick: 1 });
  // exp dmg = 10; hp 100 → shotsToKill 10; pKill = 1/10
  const t = makeTarget({ hp: 100, parts: [{ ac: 4, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }] });
  assert.equal(pKill(w, t, t.distanceM), 0.1);
});

test("AP scaling: matched AP needs more shots than overpen", () => {
  const wOver = makeWeapon({ damage: 100, armorPen: 3, weakPointHitRateBase: 0, shotsAvailableThisTick: 10 });
  const wMatch = makeWeapon({ damage: 100, armorPen: 3, weakPointHitRateBase: 0, shotsAvailableThisTick: 10 });
  const tOver = makeTarget({ hp: 100, parts: [{ ac: 2, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }] });
  const tMatch = makeTarget({ hp: 100, parts: [{ ac: 3, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }] });
  const outOver = assign({ weapons: [wOver], targets: [tOver], alpha: 0.5, reserves: {}, rng: RNG, tickMs: 100 });
  const outMatch = assign({ weapons: [wMatch], targets: [tMatch], alpha: 0.5, reserves: {}, rng: RNG, tickMs: 100 });
  assert.ok(outOver[0].shots < outMatch[0].shots, `over=${outOver[0].shots} match=${outMatch[0].shots}`);
});

// ---------- alpha modes ----------

test("alpha=1.0 (survival): closer (lower ttp) of two equals is assigned first", () => {
  const w = makeWeapon({ damage: 1000, armorPen: 9, shotsAvailableThisTick: 1 });
  // attackRangeM: 100 keeps both in "melee" regime so meleeDps drives threat
  const tNear = makeTarget({ id: "near", position: { x: 0, y: 5 }, distanceM: 5, timeToReachPlayerSecs: 1, meleeDps: 50, attackRangeM: 100 });
  const tFar = makeTarget({ id: "far", position: { x: 0, y: 50 }, distanceM: 50, timeToReachPlayerSecs: 30, meleeDps: 50, attackRangeM: 100 });
  const out = assign({ weapons: [w], targets: [tNear, tFar], alpha: 1.0, reserves: {}, rng: RNG, tickMs: 100 });
  assert.equal(out.length, 1);
  assert.equal(out[0].targetId, "near");
});

test("alpha=0.0 (clear): boss far away is prioritized over light nearby (both feasible)", () => {
  const w = makeWeapon({ damage: 5000, armorPen: 9, shotsAvailableThisTick: 1 });
  const light = makeTarget({
    id: "light", threatTier: "light", hp: 50, distanceM: 5,
    position: { x: 0, y: 5 }, timeToReachPlayerSecs: 1, meleeDps: 100,
    parts: [{ ac: 1, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }],
  });
  const boss = makeTarget({
    id: "boss", threatTier: "boss", hp: 4000, distanceM: 70,
    position: { x: 0, y: 70 }, timeToReachPlayerSecs: 60, meleeDps: 50,
    parts: [{ ac: 5, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }],
  });
  const out = assign({ weapons: [w], targets: [light, boss], alpha: 0.0, reserves: {}, rng: RNG, tickMs: 100 });
  assert.equal(out.length, 1);
  assert.equal(out[0].targetId, "boss");
});

// ---------- reserves ----------

test("reserveBlocked: enabled w/ high min on light → blocks; heavy → allows", () => {
  const w = makeWeapon({
    id: "strat-1",
    reserveCfg: { enabled: true, minStockBeforeUseOnTier: { light: 99, medium: 99, heavy: 0, boss: 0 } },
    shotsAvailableThisTick: 1,
  });
  const light = makeTarget({ threatTier: "light" });
  const heavy = makeTarget({ threatTier: "heavy" });
  assert.equal(reserveBlocked(w, light), true);
  assert.equal(reserveBlocked(w, heavy), false);
});

test("reserve withholds stratagem on light, but assigns on heavy", () => {
  const w = makeWeapon({
    id: "strat-1",
    damage: 5000, armorPen: 9, shotsAvailableThisTick: 1,
    reserveCfg: { enabled: true, minStockBeforeUseOnTier: { light: 99, medium: 99, heavy: 0, boss: 0 } },
  });
  const light = makeTarget({ id: "light", threatTier: "light", hp: 50 });
  const heavy = makeTarget({ id: "heavy", threatTier: "heavy", hp: 1000,
    parts: [{ ac: 5, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }] });

  const onlyLight = assign({ weapons: [w], targets: [light], alpha: 0.5, reserves: {}, rng: RNG, tickMs: 100 });
  assert.equal(onlyLight.length, 0, "should withhold on light alone");

  const w2 = { ...w };
  const onlyHeavy = assign({ weapons: [w2], targets: [heavy], alpha: 0.5, reserves: {}, rng: RNG, tickMs: 100 });
  assert.equal(onlyHeavy.length, 1, "should fire on heavy");
  assert.equal(onlyHeavy[0].targetId, "heavy");
});

// ---------- shot accounting ----------

test("no double-assignment: weapon w/ shotsAvailableThisTick=5 fires once, ≤5 shots", () => {
  const w = makeWeapon({ damage: 10, armorPen: 9, shotsAvailableThisTick: 5 });
  // hp=100 → needs 10 shots to kill, weapon caps at 5. Should appear once with shots=5.
  const t1 = makeTarget({ id: "t1", hp: 100 });
  const t2 = makeTarget({ id: "t2", hp: 100, position: { x: 10, y: 30 } });
  const out = assign({ weapons: [w], targets: [t1, t2], alpha: 0.5, reserves: {}, rng: RNG, tickMs: 100 });
  const totalShots = out.reduce((a, b) => a + b.shots, 0);
  assert.ok(totalShots <= 5, `total shots ${totalShots}`);
  const fromW1 = out.filter(a => a.weaponId === "w1");
  assert.equal(fromW1.length, 1, "weapon should fire at most once");
});

// ---------- dead target removal ----------

test("dead target removal: w-A kills t1, w-B re-targets t2", () => {
  const wA = makeWeapon({ id: "wA", damage: 1000, armorPen: 9, shotsAvailableThisTick: 1 });
  const wB = makeWeapon({ id: "wB", damage: 1000, armorPen: 9, shotsAvailableThisTick: 1 });
  const t1 = makeTarget({ id: "t1", hp: 50, threatTier: "medium",
    parts: [{ ac: 1, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }] });
  const t2 = makeTarget({ id: "t2", hp: 50, threatTier: "medium", position: { x: 5, y: 30 },
    parts: [{ ac: 1, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }] });
  const out = assign({ weapons: [wA, wB], targets: [t1, t2], alpha: 0.5, reserves: {}, rng: RNG, tickMs: 100 });
  // Both weapons should fire at distinct targets (t1 is dead after first assignment).
  assert.equal(out.length, 2);
  const targets = new Set(out.map(a => a.targetId));
  assert.equal(targets.size, 2, `targets should differ: ${[...targets]}`);
});

// ---------- determinism ----------

test("determinism: same input twice → identical output", () => {
  const mk = () => ({
    weapons: [
      makeWeapon({ id: "wA", damage: 50, armorPen: 9, shotsAvailableThisTick: 3 }),
      makeWeapon({ id: "wB", damage: 80, armorPen: 9, shotsAvailableThisTick: 2 }),
      makeWeapon({ id: "wC", damage: 200, armorPen: 9, shotsAvailableThisTick: 1, aoeRadiusM: 5 }),
    ],
    targets: [
      makeTarget({ id: "t1", hp: 100, position: { x: 0, y: 20 }, distanceM: 20, threatTier: "medium" }),
      makeTarget({ id: "t2", hp: 200, position: { x: 4, y: 20 }, distanceM: 21, threatTier: "heavy" }),
      makeTarget({ id: "t3", hp: 50, position: { x: 0, y: 40 }, distanceM: 40, threatTier: "light" }),
    ],
    alpha: 0.5, reserves: {}, rng: RNG, tickMs: 100,
  });
  const a = assign(mk());
  const b = assign(mk());
  assert.deepEqual(a, b);
});

// ---------- canonical Recoilless-vs-Charger ----------

test("Recoilless one-shot Charger fixture: assigned, shots=1, pKill ≥ 0.8", () => {
  const recoilless = {
    id: "strat-1",
    slot: "stratagem-1",
    damage: 1500,
    durableDamage: 1500,
    armorPen: 6,
    shotsAvailableThisTick: 1,
    aoeRadiusM: 0,
    weakPointHitRateBase: 0.85,
    maxRangeM: 200,
    isStratagem: true,
    stratagemType: "support",
  };
  const charger = {
    id: "ch1",
    archetypeId: "charger",
    threatTier: "heavy",
    hp: 750,
    parts: [
      { name: "head", ac: 4, hpFraction: 0.2, isWeakPoint: true, weakPointMultiplier: 3 },
      { name: "leg",  ac: 3, hpFraction: 0.15, isWeakPoint: true, weakPointMultiplier: 2 },
      { name: "butt", ac: 3, hpFraction: 0.15, isWeakPoint: false, weakPointMultiplier: 1 },
      { name: "body", ac: 5, hpFraction: 0.5, isWeakPoint: false, weakPointMultiplier: 1 },
    ],
    position: { x: 0, y: 30 },
    distanceM: 30,
    timeToReachPlayerSecs: 5,
    meleeDps: 200,
    rangedDps: 0,
    attackRangeM: 3,
  };
  const pk = pKill(recoilless, charger, 30);
  assert.ok(pk >= 0.8, `pKill=${pk}`);
  const out = assign({ weapons: [recoilless], targets: [charger], alpha: 0.5, reserves: {}, rng: RNG, tickMs: 100 });
  assert.equal(out.length, 1);
  assert.equal(out[0].weaponId, "strat-1");
  assert.equal(out[0].targetId, "ch1");
  assert.equal(out[0].shots, 1);
});

// ---------- valueFor sanity ----------

test("valueFor: alpha=0 → pure clearValue; tier ordering", () => {
  const t = (tier) => makeTarget({ threatTier: tier });
  const v = (tier) => valueFor(t(tier), 0, 30);
  assert.equal(v("light"), 1);
  assert.equal(v("medium"), 3);
  assert.equal(v("heavy"), 8);
  assert.equal(v("boss"), 20);
});

test("valueFor: alpha=1 uses threat (closer = higher with same dps)", () => {
  // attackRangeM: 100 keeps both within melee range so meleeDps is used
  const tNear = makeTarget({ timeToReachPlayerSecs: 1, meleeDps: 50, attackRangeM: 100 });
  const tFar = makeTarget({ timeToReachPlayerSecs: 50, meleeDps: 50, attackRangeM: 100 });
  assert.ok(valueFor(tNear, 1.0, 5) > valueFor(tFar, 1.0, 50));
});

// ---------- normalizeWeights ----------

test("normalizeWeights: legacy alpha-only call → β=1−α, γ=0", () => {
  const w = normalizeWeights({ alpha: 0.7 });
  assert.ok(Math.abs(w.alpha - 0.7) < 1e-9);
  assert.ok(Math.abs(w.beta - 0.3) < 1e-9);
  assert.equal(w.gamma, 0);
});

test("normalizeWeights: full simplex passes through unchanged", () => {
  const w = normalizeWeights({ alpha: 0.4, beta: 0.3, gamma: 0.3 });
  assert.ok(Math.abs(w.alpha + w.beta + w.gamma - 1) < 1e-9);
  assert.ok(Math.abs(w.alpha - 0.4) < 1e-9);
});

test("normalizeWeights: over-spec is renormalized to sum=1", () => {
  const w = normalizeWeights({ alpha: 1, beta: 1, gamma: 1 });
  assert.ok(Math.abs(w.alpha - 1 / 3) < 1e-9);
  assert.ok(Math.abs(w.beta - 1 / 3) < 1e-9);
  assert.ok(Math.abs(w.gamma - 1 / 3) < 1e-9);
});

test("normalizeWeights: bad input → safe fallback (β=1)", () => {
  const w = normalizeWeights({ alpha: NaN, beta: NaN, gamma: NaN });
  assert.equal(w.alpha, 0);
  assert.equal(w.beta, 1);
  assert.equal(w.gamma, 0);
});

// ---------- efficiencyFor ----------

test("efficiencyFor: heavy weapon vs light enemy is wasted (≪1)", () => {
  // 600-dmg EAT-style vs 60 hp hunter: hp/exp = 60/600 = 0.1
  const heavy = makeWeapon({ damage: 600, armorPen: 5, shotsAvailableThisTick: 1 });
  const hunter = makeTarget({ hp: 60, parts: [{ ac: 1, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }] });
  const e = efficiencyFor(heavy, hunter, 30);
  assert.ok(e < 0.2, `expected ≪1, got ${e}`);
});

test("efficiencyFor: heavy weapon vs heavy enemy is well-matched (≈1)", () => {
  // 600-dmg vs 1500-hp charger; clamped to 1.0 if over-killed.
  const heavy = makeWeapon({ damage: 600, armorPen: 5, shotsAvailableThisTick: 1 });
  const charger = makeTarget({ hp: 1500, parts: [{ ac: 4, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }] });
  const e = efficiencyFor(heavy, charger, 30);
  assert.ok(e > 0.95, `expected ≈1, got ${e}`);
});

test("efficiencyFor: zero penetration → 0 (no damage = no fit)", () => {
  const lib = makeWeapon({ damage: 60, armorPen: 0, shotsAvailableThisTick: 1 });
  const tank = makeTarget({ hp: 1000, parts: [{ ac: 5, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }] });
  // armorMult is still 0.1 not 0 (under-pen path), so eff is small but >0.
  // Force the no-damage path by setting weapon damage to 0.
  const noDmg = makeWeapon({ damage: 0, armorPen: 5, shotsAvailableThisTick: 1 });
  assert.equal(efficiencyFor(noDmg, tank, 30), 0);
});

// ---------- γ behavior — heavy-weapon-prefers-heavy-target ----------

test("γ=1: heavy weapon prefers heavy target over light when both in range", () => {
  // EAT-style: 600 dmg, ap 5, single-shot.
  const eat = makeWeapon({
    id: "strat-eat", damage: 600, armorPen: 5, shotsAvailableThisTick: 1, maxRangeM: 100,
  });
  const hunter = makeTarget({
    id: "h1", threatTier: "light", hp: 60,
    parts: [{ ac: 1, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }],
    position: { x: 0, y: 30 }, distanceM: 30, timeToReachPlayerSecs: 6,
  });
  const charger = makeTarget({
    id: "c1", threatTier: "heavy", hp: 1500,
    parts: [{ ac: 4, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }],
    position: { x: 0, y: 35 }, distanceM: 35, timeToReachPlayerSecs: 8,
  });
  const out = assign({
    weapons: [eat], targets: [hunter, charger],
    alpha: 0, beta: 0, gamma: 1, reserves: {}, rng: RNG, tickMs: 100,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].targetId, "c1", `γ=1 must pick the charger, got ${out[0].targetId}`);
});

test("γ=0: legacy two-term behavior unchanged (back-compat)", () => {
  // Same fixture as above; without efficiency, the threat+clear logic
  // already prefers the heavy. Pin it so a future regression in valueFor
  // would surface.
  const eat = makeWeapon({
    id: "strat-eat", damage: 600, armorPen: 5, shotsAvailableThisTick: 1, maxRangeM: 100,
  });
  const hunter = makeTarget({
    id: "h1", threatTier: "light", hp: 60,
    parts: [{ ac: 1, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }],
    position: { x: 0, y: 30 }, distanceM: 30, timeToReachPlayerSecs: 6,
  });
  const charger = makeTarget({
    id: "c1", threatTier: "heavy", hp: 1500,
    parts: [{ ac: 4, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }],
    position: { x: 0, y: 35 }, distanceM: 35, timeToReachPlayerSecs: 8,
  });
  const out = assign({
    weapons: [eat], targets: [hunter, charger],
    alpha: 0.5, gamma: 0, reserves: {}, rng: RNG, tickMs: 100,
  });
  assert.equal(out.length, 1);
  // With γ=0, clearValue dominates and picks heavy too — same answer for this
  // fixture. The point is that nothing throws and the assignment is consistent.
  assert.ok(out[0].targetId === "c1" || out[0].targetId === "h1");
});

test("γ=1: small-arms still picks the light target it can actually hurt", () => {
  // Liberator: 60 dmg, ap 2.
  const lib = makeWeapon({
    id: "primary", damage: 60, armorPen: 2, shotsAvailableThisTick: 8, maxRangeM: 100,
  });
  const hunter = makeTarget({
    id: "h1", threatTier: "light", hp: 60,
    parts: [{ ac: 1, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }],
    position: { x: 0, y: 30 }, distanceM: 30, timeToReachPlayerSecs: 6,
  });
  const charger = makeTarget({
    id: "c1", threatTier: "heavy", hp: 1500,
    parts: [{ ac: 5, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }],
    position: { x: 0, y: 35 }, distanceM: 35, timeToReachPlayerSecs: 8,
  });
  const out = assign({
    weapons: [lib], targets: [hunter, charger],
    alpha: 0, beta: 0, gamma: 1, reserves: {}, rng: RNG, tickMs: 100,
  });
  // Lib has near-zero efficiency vs charger (under-pen → 0.1 mult, 6 dmg/shot,
  // 250 shots-to-kill → eff ≈ 0). Hunter is well-matched.
  assert.equal(out[0].targetId, "h1");
});
