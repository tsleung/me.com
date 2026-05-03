import { test } from "node:test";
import assert from "node:assert/strict";
import { mulberry32 } from "../rng.js";
import { buildScenario } from "../scenarios.js";

const DATA = {
  enemies: [
    { id: "scav", faction: "terminids", threatTier: "light", hp: 50, parts: [], speedMps: 6 },
    { id: "war",  faction: "terminids", threatTier: "medium", hp: 250, parts: [], speedMps: 4 },
  ],
  spawnTables: [
    { faction: "terminids", subfaction: "standard", type: "patrol", difficulty: 5,
      maxConcurrent: 10, spreadSecs: 30,
      composition: [
        { enemyId: "scav", count: { dist: "fixed", mean: 6 }, spawnTimeSecs: 0,
          spawnArc: { minDeg: -50, maxDeg: 50, distanceM: 70 } },
        { enemyId: "war", count: { dist: "fixed", mean: 4 }, spawnTimeSecs: 8,
          spawnArc: { minDeg: -40, maxDeg: 40, distanceM: 70 } },
      ] },
  ],
};

const BASE_CFG = { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 5 };

test("multiplier 1.0 produces unchanged spawn count vs no multiplier", () => {
  const a = buildScenario(DATA, BASE_CFG, mulberry32(1));
  const b = buildScenario(DATA, { ...BASE_CFG, spawnRateMultiplier: 1.0 }, mulberry32(1));
  assert.equal(a.totalSpawns, b.totalSpawns);
});

test("multiplier 2.0 doubles spawn count", () => {
  const r1 = mulberry32(7);
  const r2 = mulberry32(7);
  const a = buildScenario(DATA, BASE_CFG, r1);
  const b = buildScenario(DATA, { ...BASE_CFG, spawnRateMultiplier: 2.0 }, r2);
  assert.ok(b.totalSpawns >= a.totalSpawns * 1.8 && b.totalSpawns <= a.totalSpawns * 2.2,
    `expected ~2x spawns, got ${b.totalSpawns} vs ${a.totalSpawns}`);
});

test("multiplier 0.5 halves spawn count", () => {
  const r1 = mulberry32(11);
  const r2 = mulberry32(11);
  const a = buildScenario(DATA, BASE_CFG, r1);
  const b = buildScenario(DATA, { ...BASE_CFG, spawnRateMultiplier: 0.5 }, r2);
  assert.ok(b.totalSpawns <= a.totalSpawns * 0.6 && b.totalSpawns >= a.totalSpawns * 0.4,
    `expected ~half spawns, got ${b.totalSpawns} vs ${a.totalSpawns}`);
});

test("multiplier 2.0 inversely scales spawn time (faster wave)", () => {
  const a = buildScenario(DATA, BASE_CFG, mulberry32(13));
  const b = buildScenario(DATA, { ...BASE_CFG, spawnRateMultiplier: 2.0 }, mulberry32(13));
  const aLast = a.spawnIntents[a.spawnIntents.length - 1].t;
  const bLast = b.spawnIntents[b.spawnIntents.length - 1].t;
  assert.ok(bLast < aLast, `denser wave should finish sooner (${bLast}ms vs ${aLast}ms)`);
});

test("multiplier is clamped to [0.25, 4.0]", () => {
  const a = buildScenario(DATA, { ...BASE_CFG, spawnRateMultiplier: 0.01 }, mulberry32(1));
  const b = buildScenario(DATA, { ...BASE_CFG, spawnRateMultiplier: 100 }, mulberry32(1));
  assert.equal(a.spawnRateMultiplier, 0.25);
  assert.equal(b.spawnRateMultiplier, 4.0);
});

test("(seed, multiplier) determinism — same inputs yield identical intent list", () => {
  const a = buildScenario(DATA, { ...BASE_CFG, spawnRateMultiplier: 1.5 }, mulberry32(42));
  const b = buildScenario(DATA, { ...BASE_CFG, spawnRateMultiplier: 1.5 }, mulberry32(42));
  assert.equal(a.totalSpawns, b.totalSpawns);
  for (let i = 0; i < a.spawnIntents.length; i++) {
    assert.equal(a.spawnIntents[i].t, b.spawnIntents[i].t);
    assert.equal(a.spawnIntents[i].enemyId, b.spawnIntents[i].enemyId);
  }
});

test("buildScenario returns scaled encounter with spawnRateMultiplier echoed", () => {
  const sc = buildScenario(DATA, { ...BASE_CFG, spawnRateMultiplier: 1.5 }, mulberry32(2));
  assert.equal(sc.spawnRateMultiplier, 1.5);
});
