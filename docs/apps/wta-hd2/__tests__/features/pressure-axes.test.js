import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encounterDemand,
  buildCapacity,
  gapVector,
} from "../../features/pressure-axes.js";

// ---- encounterDemand ----

test("encounterDemand: heavy intents normalize to per-minute", () => {
  const scenario = {
    archetypes: [{ id: "charger", threatTier: "heavy" }],
    spawnIntents: [
      { t: 0, enemyId: "charger" },
      { t: 30000, enemyId: "charger" },
    ],
  };
  const d = encounterDemand(scenario, { horizonMs: 60000 });
  assert.equal(d.antiHeavy, 2); // 2 heavies in 60s = 2/min
  assert.equal(d.crowd, 0);
});

test("encounterDemand: burst counts heavies in a 5s window", () => {
  const scenario = {
    archetypes: [{ id: "charger", threatTier: "heavy" }],
    spawnIntents: [
      { t: 0,    enemyId: "charger" },
      { t: 1000, enemyId: "charger" },
      { t: 2000, enemyId: "charger" },
      { t: 30000, enemyId: "charger" },
    ],
  };
  const d = encounterDemand(scenario);
  assert.equal(d.burst, 3); // 3 heavies inside the first 5s
});

test("encounterDemand: standoff counts ranged enemies", () => {
  const scenario = {
    archetypes: [
      { id: "warrior", threatTier: "medium", rangedDps: 0 },
      { id: "devastator", threatTier: "medium", rangedDps: 30 },
    ],
    spawnIntents: [
      { t: 0, enemyId: "warrior" },
      { t: 0, enemyId: "devastator" },
      { t: 0, enemyId: "devastator" },
    ],
  };
  const d = encounterDemand(scenario);
  assert.equal(d.standoff, 2);
});

// ---- buildCapacity ----

test("buildCapacity: anti-heavy stratagem contributes to antiHeavy axis", () => {
  const loadout = { stratagems: ["eat"] };
  const data = { stratagems: [{ id: "eat", cooldownSecs: 70, uses: null, effects: [{ damage: 1500, ap: 6 }], armorPen: 6, damage: 1500 }] };
  const c = buildCapacity(loadout, data);
  // 60/70 ≈ 0.86 uses/min on anti-heavy axis
  assert.ok(c.antiHeavy > 0.5 && c.antiHeavy < 1);
});

test("buildCapacity: AoE eagle contributes to crowd axis", () => {
  const loadout = { stratagems: ["airstrike"] };
  const data = { stratagems: [{ id: "airstrike", cooldownSecs: 60, uses: 4, effects: [{ damage: 800, aoeRadiusM: 8 }], aoeRadiusM: 8, damage: 800 }] };
  const c = buildCapacity(loadout, data);
  assert.ok(c.crowd > 0);
});

test("buildCapacity: long-range primary contributes to standoff", () => {
  const loadout = { primary: "diligence" };
  const data = { weapons: { primaries: [{ id: "diligence", damage: 125, armorPen: 3, fireRateRpm: 330, maxRangeM: 100 }] } };
  const c = buildCapacity(loadout, data);
  assert.ok(c.standoff > 0);
});

test("buildCapacity: short-range primary does not contribute to standoff", () => {
  const loadout = { primary: "smg" };
  const data = { weapons: { primaries: [{ id: "smg", damage: 50, armorPen: 2, fireRateRpm: 700, maxRangeM: 30 }] } };
  const c = buildCapacity(loadout, data);
  assert.equal(c.standoff, 0);
});

// ---- gapVector ----

test("gapVector: capacity − demand on every axis", () => {
  const demand   = { antiHeavy: 2, crowd: 50, standoff: 1, burst: 3 };
  const capacity = { antiHeavy: 0.86, crowd: 100, standoff: 5, burst: 2000 };
  const gap = gapVector(demand, capacity);
  assert.ok(gap.antiHeavy < 0, "under-spec on heavies");
  assert.ok(gap.crowd > 0, "over-spec on crowd");
  assert.ok(gap.standoff > 0);
  assert.ok(gap.burst > 0);
});
