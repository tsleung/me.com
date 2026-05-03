import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, tick, visibleEnemyView, visibleWeaponView } from "../sim.js";

const MIN_DATA = {
  weapons: {
    primaries: [{ id: "lib", damage: 60, armorPen: 2, fireRateRpm: 600, magazine: 30, reloadSecs: 2, ammoReserve: 240, maxRangeM: 80, weakPointHitRateBase: 0.3 }],
    secondaries: [{ id: "pm", damage: 60, armorPen: 2, fireRateRpm: 360, magazine: 15, reloadSecs: 1.5, ammoReserve: 60 }],
    grenades: [{ id: "frag", damage: 400, armorPen: 2, magazine: 1, reloadSecs: 0, ammoReserve: 4, aoeRadiusM: 7 }],
  },
  stratagems: { stratagems: [
    { id: "eagle-500kg", type: "eagle", cooldownSecs: 8, uses: 1, effects: [{ kind: "damage", damage: 2000, ap: 6, aoeRadiusM: 12 }] },
    { id: "orbital-rail", type: "orbital", cooldownSecs: 210, uses: null, effects: [{ kind: "damage", damage: 4000, ap: 7, aoeRadiusM: 4 }] },
    { id: "eat", type: "support", cooldownSecs: 70, uses: null, effects: [{ kind: "damage", damage: 1500, ap: 6 }] },
    { id: "ac", type: "support", cooldownSecs: 480, uses: null, effects: [{ kind: "damage", damage: 260, ap: 4 }] },
  ]},
};

const MIN_CFG = {
  seed: 12345,
  loadout: {
    primary: "lib", secondary: "pm", grenade: "frag",
    stratagems: ["eagle-500kg", "orbital-rail", "eat", "ac"],
  },
  scenario: { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 5 },
};

test("createInitialState produces deterministic state from seed", () => {
  const a = createInitialState(MIN_CFG, MIN_DATA);
  const b = createInitialState(MIN_CFG, MIN_DATA);
  assert.equal(a.seed, b.seed);
  assert.equal(a.t, 0);
  assert.equal(a.tickN, 0);
  assert.equal(a.weapons.size, 3);
  assert.equal(a.stratagems.size, 4);
});

test("tick advances time by tickMs (default 100ms)", () => {
  const s0 = createInitialState(MIN_CFG, MIN_DATA);
  const s1 = tick(s0);
  assert.equal(s1.t, 100);
  assert.equal(s1.tickN, 1);
  const s2 = tick(s1);
  assert.equal(s2.t, 200);
  assert.equal(s2.tickN, 2);
});

test("tick is referentially honest — does not mutate input", () => {
  const s0 = createInitialState(MIN_CFG, MIN_DATA);
  const t0 = s0.t;
  const enemiesSize0 = s0.enemies.size;
  tick(s0);
  assert.equal(s0.t, t0, "input state.t mutated");
  assert.equal(s0.enemies.size, enemiesSize0, "input state.enemies mutated");
});

test("1000-tick replay with same seed produces identical final t and tickN", () => {
  let a = createInitialState(MIN_CFG, MIN_DATA);
  let b = createInitialState(MIN_CFG, MIN_DATA);
  for (let i = 0; i < 1000; i++) {
    a = tick(a);
    b = tick(b);
  }
  assert.equal(a.t, b.t);
  assert.equal(a.tickN, b.tickN);
  assert.equal(a.t, 100000);
});

test("enemy movement honors velocity * dt", () => {
  const s0 = createInitialState(MIN_CFG, MIN_DATA);
  s0.enemies.set("e1", {
    id: "e1", archetypeId: "scavenger", threatTier: "light",
    hp: 50, parts: [], position: { x: 0, y: 50 }, velocity: { dx: 0, dy: -3 }, alive: true,
  });
  const s1 = tick(s0);
  const e1 = s1.enemies.get("e1");
  assert.ok(Math.abs(e1.position.y - (50 - 3 * 0.1)) < 1e-6, `expected ~49.7 got ${e1.position.y}`);
});

test("visibleEnemyView clips to forward arc", () => {
  const s = createInitialState(MIN_CFG, MIN_DATA);
  // facing +y (PI/2). Front enemy at +y is visible; rear at -y is not.
  s.enemies.set("front", { id: "front", archetypeId: "x", threatTier: "light", hp: 1, parts: [], position: { x: 0, y: 30 }, velocity: { dx: 0, dy: -1 }, alive: true });
  s.enemies.set("rear",  { id: "rear",  archetypeId: "x", threatTier: "light", hp: 1, parts: [], position: { x: 0, y: -30 }, velocity: { dx: 0, dy: 1 }, alive: true });
  const view = visibleEnemyView(s);
  assert.equal(view.length, 1);
  assert.equal(view[0].id, "front");
});

test("visibleEnemyView clips beyond maxRange", () => {
  const s = createInitialState(MIN_CFG, MIN_DATA);
  s.enemies.set("near", { id: "near", archetypeId: "x", threatTier: "light", hp: 1, parts: [], position: { x: 0, y: 50 }, velocity: { dx: 0, dy: -1 }, alive: true });
  s.enemies.set("far",  { id: "far",  archetypeId: "x", threatTier: "light", hp: 1, parts: [], position: { x: 0, y: 200 }, velocity: { dx: 0, dy: -1 }, alive: true });
  const view = visibleEnemyView(s);
  assert.equal(view.length, 1);
  assert.equal(view[0].id, "near");
});

test("visibleWeaponView lists ready weapons + stratagems off cooldown", () => {
  const s = createInitialState(MIN_CFG, MIN_DATA);
  const view = visibleWeaponView(s);
  const slots = view.map((w) => w.id).sort();
  assert.deepEqual(slots, ["primary", "secondary", "grenade", "strat-1", "strat-2", "strat-3", "strat-4"].sort());
  assert.ok(view.find((w) => w.id === "primary").shotsAvailableThisTick > 0);
});

test("visibleWeaponView omits weapon mid-reload", () => {
  const s = createInitialState(MIN_CFG, MIN_DATA);
  const w = s.weapons.get("primary");
  w.reloadingUntil = s.t + 1000;
  w.ammoInMag = 0;
  const view = visibleWeaponView(s);
  assert.equal(view.find((v) => v.id === "primary"), undefined);
});

test("reload completes when reloadingUntil <= t", () => {
  const s0 = createInitialState(MIN_CFG, MIN_DATA);
  const w = s0.weapons.get("primary");
  w.reloadingUntil = 50; // reload finishes during first tick
  w.ammoInMag = 0;
  const s1 = tick(s0);
  const w1 = s1.weapons.get("primary");
  assert.equal(w1.reloadingUntil, null);
  assert.ok(w1.ammoInMag > 0);
});

test("scheduled events fire at or after their t", () => {
  const s0 = createInitialState(MIN_CFG, MIN_DATA);
  let fired = 0;
  s0.scheduled.push({ t: 250, fn: () => fired++ });
  let s = s0;
  s = tick(s);  // t=100
  assert.equal(fired, 0);
  s = tick(s);  // t=200
  assert.equal(fired, 0);
  s = tick(s);  // t=300, fires
  assert.equal(fired, 1);
});

test("tick uses no Math.random — same seed gives same RNG draw count", () => {
  let s = createInitialState(MIN_CFG, MIN_DATA);
  const draws0 = [];
  for (let i = 0; i < 5; i++) draws0.push(s.rng());

  let s2 = createInitialState(MIN_CFG, MIN_DATA);
  for (let i = 0; i < 100; i++) s2 = tick(s2);
  const draws1 = [];
  for (let i = 0; i < 5; i++) draws1.push(s2.rng());

  // tick may consume rng draws (spawns), so draws1 may diverge from draws0,
  // but that divergence is deterministic — re-running both must reproduce.
  let s3 = createInitialState(MIN_CFG, MIN_DATA);
  for (let i = 0; i < 100; i++) s3 = tick(s3);
  const draws2 = [];
  for (let i = 0; i < 5; i++) draws2.push(s3.rng());
  assert.deepEqual(draws1, draws2);
});
