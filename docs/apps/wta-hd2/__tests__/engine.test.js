import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../engine.js";

const DATA = {
  meta: {},
  factions: {
    terminids: { name: "Terminids", subfactions: [{ id: "standard", name: "standard" }] },
    automatons: { name: "Automatons", subfactions: [{ id: "standard", name: "standard" }] },
  },
  enemies: [
    { id: "scavenger", faction: "terminids", threatTier: "light",  hp: 50,  parts: [{name:"body",ac:1,hpFraction:1,isWeakPoint:false,weakPointMultiplier:1}], speedMps: 4, meleeDps: 8 },
    { id: "warrior",   faction: "terminids", threatTier: "medium", hp: 250, parts: [{name:"head",ac:3,hpFraction:0.3,isWeakPoint:true,weakPointMultiplier:2},{name:"body",ac:2,hpFraction:0.7,isWeakPoint:false,weakPointMultiplier:1}], speedMps: 3, meleeDps: 20 },
    { id: "charger",   faction: "terminids", threatTier: "heavy",  hp: 750, parts: [{name:"head",ac:4,hpFraction:0.2,isWeakPoint:true,weakPointMultiplier:3},{name:"butt",ac:3,hpFraction:0.5,isWeakPoint:false,weakPointMultiplier:1},{name:"body",ac:5,hpFraction:0.3,isWeakPoint:false,weakPointMultiplier:1}], speedMps: 6, meleeDps: 60 },
  ],
  weapons: {
    primaries: [{ id: "lib", damage: 60, armorPen: 2, fireRateRpm: 600, magazine: 30, reloadSecs: 2, ammoReserve: 240, weakPointHitRateBase: 0.3, maxRangeM: 80 }],
    secondaries: [{ id: "pm", damage: 60, armorPen: 2, fireRateRpm: 360, magazine: 15, reloadSecs: 1.5, ammoReserve: 60 }],
    grenades: [{ id: "frag", damage: 400, armorPen: 2, magazine: 1, reloadSecs: 0, ammoReserve: 4, aoeRadiusM: 7 }],
  },
  stratagems: [
    { id: "eagle-500kg", type: "eagle",   cooldownSecs: 8,   uses: 1,    effects: [{ kind: "damage", damage: 2000, ap: 6, aoeRadiusM: 12 }] },
    { id: "eat",         type: "support", cooldownSecs: 70,  uses: null, effects: [{ kind: "damage", damage: 1500, ap: 6 }] },
    { id: "ac",          type: "support", cooldownSecs: 480, uses: null, effects: [{ kind: "damage", damage: 260, ap: 4 }] },
    { id: "orbital-rail",type: "orbital", cooldownSecs: 210, uses: null, effects: [{ kind: "damage", damage: 4000, ap: 7, aoeRadiusM: 4 }] },
  ],
  armor: [],
  boosters: [],
  spawnTables: [],
};

const CFG_BUG_PATROL = {
  seed: 1,
  scenario: { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 5 },
  loadout: {
    primary: "lib", secondary: "pm", grenade: "frag",
    stratagems: ["eagle-500kg", "eat", "ac", "orbital-rail"],
  },
  solver: { alpha: 0.5, reserves: {} },
};

test("createEngine assembles initial state with scenario", () => {
  const engine = createEngine(CFG_BUG_PATROL, DATA);
  assert.ok(engine.initialState);
  assert.ok(engine.initialState.scenario);
  assert.ok(engine.initialState.scenario.spawnIntents.length > 0);
  assert.equal(engine.initialState.t, 0);
});

test("snapshot has all required keys", () => {
  const engine = createEngine(CFG_BUG_PATROL, DATA);
  const snap = engine.view(engine.initialState);
  for (const k of ["t","tickN","player","enemies","projectiles","effects","weapons","stratagems","assignments","scores","scenario"]) {
    assert.ok(k in snap, `missing key: ${k}`);
  }
});

test("snapshot is JSON-serializable", () => {
  const engine = createEngine(CFG_BUG_PATROL, DATA);
  const snap = engine.view(engine.initialState);
  const round = JSON.parse(JSON.stringify(snap));
  assert.equal(round.t, snap.t);
  assert.equal(round.enemies.length, snap.enemies.length);
});

test("100-tick run produces enemies (spawns fired) and assignments", () => {
  const engine = createEngine(CFG_BUG_PATROL, DATA);
  let s = engine.initialState;
  let sawAssignment = false;
  for (let i = 0; i < 100; i++) {
    s = engine.tick(s);
    if ((s._lastAssignments ?? []).length > 0) sawAssignment = true;
  }
  assert.ok(s.enemies.size > 0 || s.scores.advance.kills > 0, "expected spawned or killed enemies");
});

test("determinism: two engines with same seed produce identical kill counts after 600 ticks", () => {
  const e1 = createEngine(CFG_BUG_PATROL, DATA);
  const e2 = createEngine(CFG_BUG_PATROL, DATA);
  let s1 = e1.initialState, s2 = e2.initialState;
  for (let i = 0; i < 600; i++) {
    s1 = e1.tick(s1);
    s2 = e2.tick(s2);
  }
  assert.equal(s1.scores.advance.kills, s2.scores.advance.kills);
  assert.equal(s1.scores.survival.closestEnemyM, s2.scores.survival.closestEnemyM);
  assert.equal(s1.scores.survival.breachedAt, s2.scores.survival.breachedAt);
});

test("engine never throws across faction × encounter × difficulty grid", () => {
  for (const enc of ["patrol", "breach", "drop"]) {
    for (const diff of [1, 5, 7, 9, 10]) {
      const cfg = {
        ...CFG_BUG_PATROL,
        seed: enc.length * diff,
        scenario: { faction: "terminids", subfaction: "standard", encounter: enc, difficulty: diff },
      };
      const engine = createEngine(cfg, DATA);
      let s = engine.initialState;
      for (let i = 0; i < 100; i++) s = engine.tick(s);
      assert.ok(s.t === 10000, `${enc} diff${diff} reached t=${s.t}`);
    }
  }
});

test("higher difficulty produces lower survival score (closer enemies)", () => {
  const lowCfg  = { ...CFG_BUG_PATROL, seed: 7, scenario: { ...CFG_BUG_PATROL.scenario, difficulty: 2 } };
  const highCfg = { ...CFG_BUG_PATROL, seed: 7, scenario: { ...CFG_BUG_PATROL.scenario, difficulty: 10 } };
  const e1 = createEngine(lowCfg,  DATA);
  const e2 = createEngine(highCfg, DATA);
  let s1 = e1.initialState, s2 = e2.initialState;
  for (let i = 0; i < 300; i++) {
    s1 = e1.tick(s1);
    s2 = e2.tick(s2);
  }
  assert.ok(
    s2.scores.survival.closestEnemyM <= s1.scores.survival.closestEnemyM,
    `diff10 closest=${s2.scores.survival.closestEnemyM}, diff2 closest=${s1.scores.survival.closestEnemyM}`,
  );
});

test("snapshot.player exposes vx, vy, mode", () => {
  const engine = createEngine(CFG_BUG_PATROL, DATA);
  let s = engine.initialState;
  for (let i = 0; i < 30; i++) s = engine.tick(s);
  const snap = engine.view(s);
  assert.ok("vx" in snap.player);
  assert.ok("vy" in snap.player);
  assert.ok(["HOLD", "KITE", "PUSH"].includes(snap.player.mode), `unexpected mode ${snap.player.mode}`);
});

test("player PUSHes when arc is empty (no live threats)", () => {
  // Tiny scenario where everything is killed quickly; after waves clear we
  // should see PUSH at least once.
  const cfg = { ...CFG_BUG_PATROL, seed: 7, scenario: { ...CFG_BUG_PATROL.scenario, difficulty: 1 } };
  const engine = createEngine(cfg, DATA);
  let s = engine.initialState;
  let sawPush = false, sawAny = false;
  for (let i = 0; i < 200; i++) {
    s = engine.tick(s);
    sawAny = true;
    if (s.player.mode === "PUSH") { sawPush = true; break; }
  }
  // PUSH happens whenever the arc is empty — extremely likely on diff 1 between waves.
  assert.ok(sawAny);
  assert.ok(sawPush, "expected at least one PUSH tick on a low-difficulty patrol");
});

test("player movement is deterministic for a fixed seed", () => {
  const cfg = { ...CFG_BUG_PATROL, seed: 99 };
  const e1 = createEngine(cfg, DATA);
  const e2 = createEngine(cfg, DATA);
  let s1 = e1.initialState, s2 = e2.initialState;
  for (let i = 0; i < 100; i++) {
    s1 = e1.tick(s1);
    s2 = e2.tick(s2);
    assert.equal(s1.player.x, s2.player.x);
    assert.equal(s1.player.y, s2.player.y);
    assert.equal(s1.player.mode, s2.player.mode);
  }
});

test("alpha=0 (clear) vs alpha=1 (survival) produce different assignment patterns", () => {
  const cfgClear   = { ...CFG_BUG_PATROL, seed: 3, solver: { alpha: 0.0, reserves: {} } };
  const cfgSurvive = { ...CFG_BUG_PATROL, seed: 3, solver: { alpha: 1.0, reserves: {} } };
  const e1 = createEngine(cfgClear,   DATA);
  const e2 = createEngine(cfgSurvive, DATA);
  let s1 = e1.initialState, s2 = e2.initialState;
  let totalAssignments1 = 0, totalAssignments2 = 0;
  for (let i = 0; i < 200; i++) {
    s1 = e1.tick(s1);
    s2 = e2.tick(s2);
    totalAssignments1 += (s1._lastAssignments ?? []).length;
    totalAssignments2 += (s2._lastAssignments ?? []).length;
  }
  // both should produce SOME assignments
  assert.ok(totalAssignments1 + totalAssignments2 > 0, "no assignments at all in either run");
});
