import { test } from "node:test";
import assert from "node:assert/strict";
import { mulberry32 } from "../rng.js";
import { buildScenario } from "../scenarios.js";

const EMPTY_DATA = { enemies: [], spawnTables: [] };

const SOME_ENEMIES = {
  enemies: [
    { id: "scavenger",   faction: "terminids", threatTier: "light",  hp: 50,   parts: [], speedMps: 4 },
    { id: "hunter",      faction: "terminids", threatTier: "light",  hp: 80,   parts: [], speedMps: 5 },
    { id: "warrior",     faction: "terminids", threatTier: "medium", hp: 250,  parts: [], speedMps: 3 },
    { id: "bile-spewer", faction: "terminids", threatTier: "medium", hp: 350,  parts: [], speedMps: 2 },
    { id: "charger",     faction: "terminids", threatTier: "heavy",  hp: 750,  parts: [], speedMps: 6 },
    { id: "bile-titan",  faction: "terminids", threatTier: "boss",   hp: 6000, parts: [], speedMps: 2 },
  ],
  spawnTables: [],
};

test("buildScenario returns required keys", () => {
  const r = mulberry32(1);
  const sc = buildScenario(EMPTY_DATA, { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 5 }, r);
  assert.ok(sc.encounter);
  assert.ok(Array.isArray(sc.archetypes));
  assert.ok(Array.isArray(sc.spawnIntents));
  assert.equal(typeof sc.totalSpawns, "number");
});

test("synthesized encounter when no spawn tables — empty enemy data falls back to stub", () => {
  const r = mulberry32(2);
  const sc = buildScenario(EMPTY_DATA, { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 5 }, r);
  assert.equal(sc.encounter._synthesized, true);
  assert.ok(sc.totalSpawns > 0);
  // each spawn has a stub-archetype id when enemy data unavailable
  assert.ok(sc.spawnIntents[0].enemyId.includes("stub"));
});

test("difficulty scales total spawn count up", () => {
  const r1 = mulberry32(3);
  const r2 = mulberry32(3);
  const sc1 = buildScenario(SOME_ENEMIES, { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 1 }, r1);
  const sc2 = buildScenario(SOME_ENEMIES, { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 10 }, r2);
  assert.ok(sc2.totalSpawns >= sc1.totalSpawns, `diff10 ${sc2.totalSpawns} should be >= diff1 ${sc1.totalSpawns}`);
});

test("breach front-loads spawns vs patrol's slow trickle", () => {
  const r1 = mulberry32(4);
  const r2 = mulberry32(4);
  const breach = buildScenario(SOME_ENEMIES, { faction: "terminids", subfaction: "standard", encounter: "breach", difficulty: 7 }, r1);
  const patrol = buildScenario(SOME_ENEMIES, { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 7 }, r2);
  const breachLast = breach.spawnIntents[breach.spawnIntents.length - 1].t;
  const patrolLast = patrol.spawnIntents[patrol.spawnIntents.length - 1].t;
  assert.ok(breachLast < patrolLast, `breach ${breachLast}ms should finish before patrol ${patrolLast}ms`);
});

test("higher difficulty yields more heavy-tier spawns when enemy data present", () => {
  const r1 = mulberry32(5);
  const r2 = mulberry32(5);
  const low = buildScenario(SOME_ENEMIES, { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 2 }, r1);
  const high = buildScenario(SOME_ENEMIES, { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 10 }, r2);
  const heavyIds = new Set(SOME_ENEMIES.enemies.filter((e) => e.threatTier === "heavy" || e.threatTier === "boss").map((e) => e.id));
  const lowHeavy = low.spawnIntents.filter((s) => heavyIds.has(s.enemyId)).length;
  const highHeavy = high.spawnIntents.filter((s) => heavyIds.has(s.enemyId)).length;
  assert.ok(highHeavy > lowHeavy, `heavies should grow with difficulty: low=${lowHeavy} high=${highHeavy}`);
});

test("archetypes lists each unique enemy in composition exactly once", () => {
  const r = mulberry32(6);
  const sc = buildScenario(SOME_ENEMIES, { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 7 }, r);
  const ids = sc.archetypes.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "duplicates in archetypes");
});

test("buildScenario with same rng seed is deterministic", () => {
  const a = buildScenario(SOME_ENEMIES, { faction: "terminids", subfaction: "standard", encounter: "breach", difficulty: 8 }, mulberry32(42));
  const b = buildScenario(SOME_ENEMIES, { faction: "terminids", subfaction: "standard", encounter: "breach", difficulty: 8 }, mulberry32(42));
  assert.equal(a.totalSpawns, b.totalSpawns);
  for (let i = 0; i < a.spawnIntents.length; i++) {
    assert.equal(a.spawnIntents[i].t, b.spawnIntents[i].t);
    assert.equal(a.spawnIntents[i].enemyId, b.spawnIntents[i].enemyId);
    assert.equal(a.spawnIntents[i].position.x, b.spawnIntents[i].position.x);
  }
});

test("spawn intents are sorted by time ascending", () => {
  const r = mulberry32(7);
  const sc = buildScenario(SOME_ENEMIES, { faction: "terminids", subfaction: "standard", encounter: "drop", difficulty: 6 }, r);
  for (let i = 1; i < sc.spawnIntents.length; i++) {
    assert.ok(sc.spawnIntents[i].t >= sc.spawnIntents[i - 1].t, `unsorted at ${i}`);
  }
});

test("spawn positions are inside the arc and at the spawn distance", () => {
  const r = mulberry32(8);
  const sc = buildScenario(SOME_ENEMIES, { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 5 }, r);
  for (const s of sc.spawnIntents) {
    const d = Math.hypot(s.position.x, s.position.y);
    assert.ok(d > 60 && d < 80, `distance ${d} out of expected band`);
    // y should be positive (forward arc)
    assert.ok(s.position.y > 0, `position y should be forward, got ${s.position.y}`);
  }
});

test("vectors point toward player (origin)", () => {
  const r = mulberry32(9);
  const sc = buildScenario(SOME_ENEMIES, { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 5 }, r);
  for (const s of sc.spawnIntents) {
    // dot product of position and vector should be negative (vector points back toward origin)
    const dot = s.position.x * s.vector.dx + s.position.y * s.vector.dy;
    assert.ok(dot < 0, `vector should point toward player; dot=${dot}`);
  }
});

test("explicit spawn table is preferred over synthesis", () => {
  const r = mulberry32(10);
  const explicitTable = {
    faction: "terminids", subfaction: "standard", type: "patrol", difficulty: 5,
    composition: [
      { enemyId: "scavenger", count: { dist: "fixed", mean: 3 }, spawnTimeSecs: 0,
        spawnArc: { minDeg: -10, maxDeg: 10, distanceM: 70 } },
    ],
    maxConcurrent: 4,
  };
  const data = { ...SOME_ENEMIES, spawnTables: [explicitTable] };
  const sc = buildScenario(data, { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 5 }, r);
  assert.equal(sc.encounter._synthesized, undefined);
  assert.equal(sc.totalSpawns, 3);
  assert.equal(sc.spawnIntents.every((s) => s.enemyId === "scavenger"), true);
});
