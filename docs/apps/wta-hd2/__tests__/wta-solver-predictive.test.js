import { test } from "node:test";
import assert from "node:assert/strict";
import { assign } from "../wta-solver.js";

// Test fixture: a charger approaching the player from 100m at 6 m/s heading
// straight in (vector pointing toward origin). 380mm barrage with 8s call-in
// + 30m AoE radius. Without prediction the charger is "too far" (100m > 80m
// or beyond AoE if landing now). With prediction the charger will be at
// 100 - 6*8 = 52m by landing, well within reach.

const APPROACHING_CHARGER = {
  id: "ch1",
  archetypeId: "charger",
  threatTier: "heavy",
  hp: 750,
  parts: [
    { name: "head", ac: 4, hpFraction: 0.2, isWeakPoint: true, weakPointMultiplier: 3 },
    { name: "body", ac: 5, hpFraction: 0.8, isWeakPoint: false, weakPointMultiplier: 1 },
  ],
  position: { x: 0, y: 100 },
  velocity: { dx: 0, dy: -6 },  // approaching origin at 6 m/s
  distanceM: 100,
  timeToReachPlayerSecs: 100 / 6,
  meleeDps: 60,
  rangedDps: 0,
};

const STATIC_DISTANT_TARGET = {
  ...APPROACHING_CHARGER,
  id: "static",
  velocity: { dx: 0, dy: 0 },  // not moving
};

const ORBITAL_380 = {
  id: "strat-1",
  slot: "strat-1",
  damage: 800,
  durableDamage: 800,
  armorPen: 6,
  shotsAvailableThisTick: 1,
  aoeRadiusM: 30,
  weakPointHitRateBase: 0,
  maxRangeM: 80,
  isStratagem: true,
  callInSecs: 8,
};

const EAGLE_500 = {
  ...ORBITAL_380,
  id: "strat-2",
  slot: "strat-2",
  damage: 2000,
  armorPen: 6,
  callInSecs: 0.5,  // negligible call-in — Eagle is fast
};

test("predictive: 380 with 8s call-in engages an approaching charger now beyond range", () => {
  // Charger is at 100m (outside 80m maxRange). Without prediction, no assignment.
  // With prediction (8s × 6 m/s = 48m closer → projected 52m), it's in range and AoE-killable.
  const out = assign({
    weapons: [ORBITAL_380],
    targets: [APPROACHING_CHARGER],
    effects: [], alpha: 0.5, reserves: {}, tickMs: 100,
  });
  assert.equal(out.length, 1, "expected 1 assignment");
  assert.equal(out[0].weaponId, "strat-1");
  assert.equal(out[0].targetId, "ch1");
});

test("predictive: 380 does NOT engage a static target beyond conventional range", () => {
  // Static target at 100m, well beyond maxRange even with 8s call-in (it doesn't move).
  const out = assign({
    weapons: [ORBITAL_380],
    targets: [STATIC_DISTANT_TARGET],
    effects: [], alpha: 0.5, reserves: {}, tickMs: 100,
  });
  assert.equal(out.length, 0, "static target stays out of range");
});

test("predictive: short-call-in weapon (Eagle 0.5s) doesn't get range extension", () => {
  // Eagle has only 0.5s call-in. Charger projected: 100 - 6*0.5 = 97m, still > 80m.
  const out = assign({
    weapons: [EAGLE_500],
    targets: [APPROACHING_CHARGER],
    effects: [], alpha: 0.5, reserves: {}, tickMs: 100,
  });
  assert.equal(out.length, 0, "0.5s call-in shouldn't reach 100m approaching target");
});

test("predictive: 380 AoE membership uses projected positions", () => {
  // Two enemies approaching together; projected positions should be within 30m AoE.
  const targets = [
    { ...APPROACHING_CHARGER, id: "ch1", position: { x: 0, y: 100 } },
    { ...APPROACHING_CHARGER, id: "ch2", position: { x: 25, y: 100 }, distanceM: Math.hypot(25, 100) },
  ];
  const out = assign({
    weapons: [ORBITAL_380],
    targets,
    effects: [], alpha: 0.5, reserves: {}, tickMs: 100,
  });
  assert.equal(out.length, 1, "single 380 throw expected");
  // Both should be considered (one assigned, the other AoE-collateral'd)
});

test("predictive: weapon without callInSecs behaves identically to before (no regression)", () => {
  // Backward compat: a normal AC at 30m vs charger should still assign as before.
  const ac = {
    id: "primary", slot: "primary", damage: 260, durableDamage: 260, armorPen: 4,
    shotsAvailableThisTick: 4, aoeRadiusM: 0, weakPointHitRateBase: 0.4, maxRangeM: 80,
    isStratagem: false,
  };
  const t = { ...APPROACHING_CHARGER, position: { x: 0, y: 30 }, distanceM: 30 };
  const out = assign({
    weapons: [ac], targets: [t],
    effects: [], alpha: 0.5, reserves: {}, tickMs: 100,
  });
  assert.equal(out.length, 1);
});

test("predictive: target moving AWAY from player is projected farther, may fall out of range", () => {
  // A fleeing target at 50m moving away at 10 m/s. After 8s call-in it's at 50+80=130m, out of range.
  const fleeing = {
    ...APPROACHING_CHARGER,
    id: "fleeing",
    position: { x: 0, y: 50 },
    velocity: { dx: 0, dy: 10 },  // moving away
    distanceM: 50,
  };
  const out = assign({
    weapons: [ORBITAL_380], targets: [fleeing],
    effects: [], alpha: 0.5, reserves: {}, tickMs: 100,
  });
  assert.equal(out.length, 0, "fleeing target should escape predicted strike range");
});
