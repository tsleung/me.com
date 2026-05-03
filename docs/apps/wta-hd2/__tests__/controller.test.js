import { test } from "node:test";
import assert from "node:assert/strict";
import { createController } from "../controller.js";

function fakeEngine() {
  let tickN = 0;
  const init = { tickN: 0, t: 0 };
  return {
    initialState: init,
    tick(s) {
      tickN++;
      return { tickN, t: tickN * 100 };
    },
    view(s) { return { ...s, _viewedAt: Date.now() }; },
  };
}

function fakeSchedule() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    perfNow: () => now,
    advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        now = next[1].at;
        const fn = next[1].fn;
        timers.delete(next[0]);
        fn();
      }
      now = target;
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    activeCount: () => timers.size,
  };
}

test("createController initializes from engine factory", () => {
  let factoryCalls = 0;
  const c = createController({
    engineFactory: () => { factoryCalls++; return fakeEngine(); },
    initialCfg: { seed: 1 },
    schedule: fakeSchedule(),
  });
  assert.equal(factoryCalls, 1);
  assert.equal(c.getCfg().seed, 1);
  assert.equal(c.getSnapshot().tickN, 0);
  assert.equal(c.isPlaying(), false);
});

test("subscribe receives current snapshot immediately + future emissions", () => {
  const s = fakeSchedule();
  const c = createController({ engineFactory: fakeEngine, initialCfg: {}, schedule: s });
  const seen = [];
  c.subscribe((snap) => seen.push(snap.tickN));
  c.dispatch({ type: "STEP" });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], 0);
  assert.equal(seen[1], 1);
});

test("STEP runs exactly one tick and pauses", () => {
  const s = fakeSchedule();
  const c = createController({ engineFactory: fakeEngine, initialCfg: {}, schedule: s });
  c.dispatch({ type: "STEP" });
  assert.equal(c.getSnapshot().tickN, 1);
  c.dispatch({ type: "STEP" });
  assert.equal(c.getSnapshot().tickN, 2);
  assert.equal(c.isPlaying(), false);
});

test("PLAY then real-time advance produces ticks", () => {
  const s = fakeSchedule();
  const c = createController({ engineFactory: fakeEngine, initialCfg: {}, schedule: s });
  c.dispatch({ type: "PLAY" });
  s.advance(1000); // 1 real second @ speed 1 = ~10 ticks
  const tickN = c.getSnapshot().tickN;
  assert.ok(tickN >= 8 && tickN <= 12, `expected ~10 ticks, got ${tickN}`);
});

test("PAUSE stops the loop", () => {
  const s = fakeSchedule();
  const c = createController({ engineFactory: fakeEngine, initialCfg: {}, schedule: s });
  c.dispatch({ type: "PLAY" });
  s.advance(500);
  c.dispatch({ type: "PAUSE" });
  const tickAtPause = c.getSnapshot().tickN;
  s.advance(1000);
  assert.equal(c.getSnapshot().tickN, tickAtPause);
  assert.equal(c.isPlaying(), false);
});

test("SET_SPEED 4x produces ~4x more ticks per real second", () => {
  const s = fakeSchedule();
  const c = createController({ engineFactory: fakeEngine, initialCfg: {}, schedule: s });
  c.dispatch({ type: "SET_SPEED", speed: 4 });
  c.dispatch({ type: "PLAY" });
  s.advance(1000);
  const tickN = c.getSnapshot().tickN;
  assert.ok(tickN >= 30 && tickN <= 50, `expected ~40 ticks at 4x, got ${tickN}`);
});

test("RESTART rebuilds engine with same cfg", () => {
  let calls = 0;
  const s = fakeSchedule();
  const c = createController({
    engineFactory: () => { calls++; return fakeEngine(); },
    initialCfg: { seed: 5 },
    schedule: s,
  });
  c.dispatch({ type: "STEP" });
  c.dispatch({ type: "STEP" });
  assert.equal(c.getSnapshot().tickN, 2);
  c.dispatch({ type: "RESTART" });
  assert.equal(calls, 2);
  assert.equal(c.getSnapshot().tickN, 0);
});

test("SET_LOADOUT updates cfg and restarts engine", () => {
  let lastCfg = null;
  let calls = 0;
  const s = fakeSchedule();
  const c = createController({
    engineFactory: (cfg) => { calls++; lastCfg = cfg; return fakeEngine(); },
    initialCfg: { seed: 1, loadout: { primary: "lib" } },
    schedule: s,
  });
  c.dispatch({ type: "SET_LOADOUT", loadout: { primary: "diligence" } });
  assert.equal(calls, 2);
  assert.equal(lastCfg.loadout.primary, "diligence");
  assert.equal(lastCfg.seed, 1, "non-loadout cfg preserved");
});

test("SET_SCENARIO updates cfg and restarts", () => {
  let lastCfg = null;
  const s = fakeSchedule();
  const c = createController({
    engineFactory: (cfg) => { lastCfg = cfg; return fakeEngine(); },
    initialCfg: { scenario: { difficulty: 5 } },
    schedule: s,
  });
  c.dispatch({ type: "SET_SCENARIO", scenario: { difficulty: 9 } });
  assert.equal(lastCfg.scenario.difficulty, 9);
});

test("SET_ALPHA updates solver.alpha", () => {
  let lastCfg = null;
  const s = fakeSchedule();
  const c = createController({
    engineFactory: (cfg) => { lastCfg = cfg; return fakeEngine(); },
    initialCfg: { solver: { alpha: 0.5 } },
    schedule: s,
  });
  c.dispatch({ type: "SET_ALPHA", alpha: 0.8 });
  assert.equal(lastCfg.solver.alpha, 0.8);
});

test("SET_GAMMA updates solver.gamma", () => {
  let lastCfg = null;
  const s = fakeSchedule();
  const c = createController({
    engineFactory: (cfg) => { lastCfg = cfg; return fakeEngine(); },
    initialCfg: { solver: { alpha: 0.5, gamma: 0.3 } },
    schedule: s,
  });
  c.dispatch({ type: "SET_GAMMA", gamma: 0.7 });
  assert.equal(lastCfg.solver.gamma, 0.7);
});

test("SET_RESERVE merges into solver.reserves keyed by slot", () => {
  let lastCfg = null;
  const s = fakeSchedule();
  const c = createController({
    engineFactory: (cfg) => { lastCfg = cfg; return fakeEngine(); },
    initialCfg: { solver: { alpha: 0.5, reserves: { "strat-1": { enabled: true } } } },
    schedule: s,
  });
  c.dispatch({ type: "SET_RESERVE", stratagemSlot: "strat-2", reserve: { enabled: true, minStockBeforeUseOnTier: { light: 99 } } });
  assert.deepEqual(lastCfg.solver.reserves["strat-1"], { enabled: true });
  assert.equal(lastCfg.solver.reserves["strat-2"].enabled, true);
});

test("unsubscribe stops further notifications", () => {
  const s = fakeSchedule();
  const c = createController({ engineFactory: fakeEngine, initialCfg: {}, schedule: s });
  const seen = [];
  const off = c.subscribe((snap) => seen.push(snap.tickN));
  c.dispatch({ type: "STEP" });
  off();
  c.dispatch({ type: "STEP" });
  assert.equal(seen.length, 2, `expected 2 (initial + 1 step), got ${seen.length}`);
});

test("unknown action throws", () => {
  const c = createController({ engineFactory: fakeEngine, initialCfg: {}, schedule: fakeSchedule() });
  assert.throws(() => c.dispatch({ type: "BOGUS" }), /unknown action/);
});

test("missing engineFactory throws at construction", () => {
  assert.throws(() => createController({ initialCfg: {} }), /engineFactory required/);
});

test("controller with real engine + L1 wires through end-to-end", async () => {
  const { createEngine } = await import("../engine.js");
  const data = {
    factions: { terminids: { name: "Terminids", subfactions: [{ id: "standard", name: "standard" }] } },
    enemies: [{ id: "scavenger", faction: "terminids", threatTier: "light", hp: 50, parts: [{name:"body",ac:1,hpFraction:1,isWeakPoint:false,weakPointMultiplier:1}], speedMps: 4, meleeDps: 8 }],
    weapons: { primaries: [{ id: "lib", damage: 60, armorPen: 2, fireRateRpm: 600, magazine: 30, reloadSecs: 2, ammoReserve: 240, weakPointHitRateBase: 0.3, maxRangeM: 80 }], secondaries: [{ id: "pm", damage: 60, armorPen: 2, fireRateRpm: 360, magazine: 15, reloadSecs: 1.5, ammoReserve: 60 }], grenades: [{ id: "frag", damage: 400, armorPen: 2, magazine: 1, reloadSecs: 0, ammoReserve: 4, aoeRadiusM: 7 }] },
    stratagems: [{ id: "ac", type: "support", cooldownSecs: 480, uses: null, effects: [{ kind: "damage", damage: 260, ap: 4 }] }],
    armor: [], boosters: [], spawnTables: [],
  };
  const cfg = { seed: 42, scenario: { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 3 }, loadout: { primary: "lib", secondary: "pm", grenade: "frag", stratagems: ["ac","ac","ac","ac"] }, solver: { alpha: 0.5, reserves: {} } };
  const s = fakeSchedule();
  const c = createController({ engineFactory: createEngine, initialCfg: cfg, data, schedule: s });
  const seen = [];
  c.subscribe((snap) => seen.push(snap.tickN));
  c.dispatch({ type: "PLAY" });
  s.advance(2000);
  c.dispatch({ type: "PAUSE" });
  assert.ok(seen.length > 5, `should have streamed snapshots, got ${seen.length}`);
  assert.ok(c.getSnapshot().tickN > 10, `should have advanced sim time, got ${c.getSnapshot().tickN}`);
});
