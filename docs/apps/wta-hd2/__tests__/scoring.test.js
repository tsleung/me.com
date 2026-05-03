import { test } from "node:test";
import assert from "node:assert/strict";
import { newScoreState, update } from "../scoring.js";

function mkState(t, tickN, enemies = [], scenarioTotal = null) {
  return {
    t,
    tickN,
    player: { x: 0, y: 0 },
    enemies: new Map(enemies.map((e) => [e.id, e])),
    scenario: scenarioTotal ? { totalSpawns: scenarioTotal } : null,
  };
}

function alive(id, x, y, tier = "light") { return { id, alive: true, threatTier: tier, position: { x, y } }; }
function dead(id, tier = "light") { return { id, alive: false, threatTier: tier, position: { x: 0, y: 0 } }; }

test("empty wave: advance=1, survival=Infinity (no enemies)", () => {
  const s0 = newScoreState();
  const s1 = update(s0, mkState(0, 0, []));
  assert.equal(s1.advance.fractionCleared, 1);
  assert.equal(s1.survival.closestEnemyM, Infinity);
  assert.equal(s1.survival.breachedAt, null);
});

test("kills accumulate across ticks; not double-counted", () => {
  let s = newScoreState();
  s = update(s, mkState(0, 0, [alive("a", 0, 50), alive("b", 0, 60)]));
  assert.equal(s.advance.kills, 0);

  s = update(s, mkState(100, 1, [dead("a"), alive("b", 0, 60)]));
  assert.equal(s.advance.kills, 1);

  s = update(s, mkState(200, 2, [dead("a"), alive("b", 0, 60)]));
  assert.equal(s.advance.kills, 1, "dead 'a' must not be re-counted");

  s = update(s, mkState(300, 3, [dead("a"), dead("b")]));
  assert.equal(s.advance.kills, 2);
});

test("fractionCleared uses scenario.totalSpawns when provided", () => {
  let s = newScoreState();
  s = update(s, mkState(0, 0, [alive("a", 0, 50)], 10));
  s = update(s, mkState(100, 1, [dead("a")], 10));
  assert.ok(s.advance.fractionCleared > 0 && s.advance.fractionCleared <= 1);
  assert.equal(s.advance.kills, 1);
  assert.equal(s.advance.totalSpawnedSoFar, 10);
  assert.equal(s.advance.fractionCleared, 0.1);
});

test("closest enemy distance tracked each tick", () => {
  let s = newScoreState();
  s = update(s, mkState(0, 0, [alive("a", 0, 30), alive("b", 0, 50)]));
  assert.equal(s.survival.closestEnemyM, 30);

  s = update(s, mkState(100, 1, [alive("a", 0, 20), alive("b", 0, 50)]));
  assert.equal(s.survival.closestEnemyM, 20);
});

test("breach is recorded when an enemy reaches <=2m", () => {
  let s = newScoreState();
  s = update(s, mkState(0, 0, [alive("a", 0, 5)]));
  assert.equal(s.survival.breachedAt, null);

  s = update(s, mkState(500, 5, [alive("a", 0, 1.5)]));
  assert.equal(s.survival.breachedAt, 500);

  s = update(s, mkState(600, 6, [alive("a", 0, 0.5)]));
  assert.equal(s.survival.breachedAt, 500, "breach time is sticky");
});

test("timeSurvivedMs tracks state.t", () => {
  let s = newScoreState();
  s = update(s, mkState(0, 0, []));
  s = update(s, mkState(1234, 12, []));
  assert.equal(s.survival.timeSurvivedMs, 1234);
});

test("killsPerSec rolling window decays", () => {
  let s = newScoreState();
  s = update(s, mkState(0, 0, [alive("a", 0, 50)]));
  s = update(s, mkState(100, 1, [dead("a")]));
  assert.ok(s.advance.killsPerSec > 0);

  for (let i = 2; i < 100; i++) {
    s = update(s, mkState(i * 100, i, [dead("a")]));
  }
  assert.equal(s.advance.killsPerSec, 0, "kill event aged out of 5s window");
});

test("areaCleared01 inverse of arc occupation", () => {
  let s = newScoreState();
  s = update(s, mkState(0, 0, []));
  assert.equal(s.advance.areaCleared01, 1);

  s = update(s, mkState(100, 1, [alive("a", 0, 70), alive("b", 0, 5)]));
  assert.ok(s.advance.areaCleared01 < 1);
});

test("killsByTier accumulates per threat tier", () => {
  let s = newScoreState();
  // Spawn one of each tier
  s = update(s, mkState(0, 0, [
    alive("scav", 0, 50, "light"),
    alive("warrior", 0, 60, "medium"),
    alive("charger", 0, 70, "heavy"),
    alive("titan", 0, 80, "boss"),
  ]));
  assert.deepEqual(s.advance.killsByTier, { light: 0, medium: 0, heavy: 0, boss: 0 });

  // Kill the light first
  s = update(s, mkState(100, 1, [
    dead("scav", "light"),
    alive("warrior", 0, 60, "medium"),
    alive("charger", 0, 70, "heavy"),
    alive("titan", 0, 80, "boss"),
  ]));
  assert.deepEqual(s.advance.killsByTier, { light: 1, medium: 0, heavy: 0, boss: 0 });

  // Kill heavy + boss
  s = update(s, mkState(200, 2, [
    dead("scav", "light"),
    alive("warrior", 0, 60, "medium"),
    dead("charger", "heavy"),
    dead("titan", "boss"),
  ]));
  assert.deepEqual(s.advance.killsByTier, { light: 1, medium: 0, heavy: 1, boss: 1 });
  assert.equal(s.advance.kills, 3, "total kills should match sum of tiers");
});

test("killsByTier doesn't double-count repeat-dead transitions", () => {
  let s = newScoreState();
  s = update(s, mkState(0, 0, [alive("a", 0, 50, "heavy")]));
  s = update(s, mkState(100, 1, [dead("a", "heavy")]));
  s = update(s, mkState(200, 2, [dead("a", "heavy")]));
  assert.equal(s.advance.killsByTier.heavy, 1, "heavy tier should be 1, not 2");
});

test("history sampled every 5 ticks", () => {
  let s = newScoreState();
  for (let i = 0; i < 25; i++) {
    s = update(s, mkState(i * 100, i, [alive("a", 0, 50)]));
  }
  assert.equal(s.history.length, 5);
});
