import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../engine.js";

const DATA = {
  factions: { terminids: { name: "Terminids", subfactions: [{ id: "standard", name: "standard" }] } },
  enemies: [
    { id: "scavenger", faction: "terminids", threatTier: "light", hp: 50,
      parts: [{name:"body",ac:1,hpFraction:1,isWeakPoint:false,weakPointMultiplier:1}],
      speedMps: 4, meleeDps: 8 },
  ],
  weapons: {
    primaries: [{ id: "lib", damage: 60, armorPen: 2, fireRateRpm: 600, magazine: 30, reloadSecs: 2, ammoReserve: 240, weakPointHitRateBase: 0.3, maxRangeM: 80 }],
    secondaries: [{ id: "pm", damage: 60, armorPen: 2, fireRateRpm: 360, magazine: 15, reloadSecs: 1.5, ammoReserve: 60 }],
    grenades: [{ id: "frag", damage: 400, armorPen: 2, magazine: 1, reloadSecs: 0, ammoReserve: 4, aoeRadiusM: 7 }],
  },
  stratagems: [{ id: "ac", type: "support", cooldownSecs: 480, uses: null, effects: [{ kind: "damage", damage: 260, ap: 4 }] }],
  armor: [], boosters: [], spawnTables: [],
};

const BASE_CFG = {
  seed: 1,
  scenario: { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 5 },
  loadout: { primary: "lib", secondary: "pm", grenade: "frag", stratagems: ["ac","ac","ac","ac"] },
  solver: { alpha: 0.5, reserves: {} },
};

test("compare-mode: three lanes (patrol/breach/drop) advance independently", () => {
  const lanes = ["patrol", "breach", "drop"].map((enc) => {
    const cfg = { ...BASE_CFG, seed: BASE_CFG.seed * 7919 + enc.length, scenario: { ...BASE_CFG.scenario, encounter: enc } };
    const engine = createEngine(cfg, DATA);
    return { encounter: enc, engine, state: engine.initialState };
  });

  for (let i = 0; i < 200; i++) {
    for (const lane of lanes) lane.state = lane.engine.tick(lane.state);
  }

  assert.equal(lanes.length, 3);
  for (const lane of lanes) {
    assert.equal(lane.state.t, 20000, `${lane.encounter} should have advanced 200 ticks`);
  }

  // Lanes carry their own engine instances and advance independently.
  for (const lane of lanes) {
    assert.ok(lane.state.scores, `${lane.encounter} should have a scores object`);
    assert.ok(typeof lane.state.scores.advance.fractionCleared === "number");
  }
  // Lane states are independent objects (mutating one doesn't affect another).
  assert.notEqual(lanes[0].state, lanes[1].state);
  assert.notEqual(lanes[1].state, lanes[2].state);
});

test("compare-mode: same lane re-built with same seed reproduces identical state", () => {
  const enc = "breach";
  const seed = BASE_CFG.seed * 7919 + enc.length;
  const cfg = { ...BASE_CFG, seed, scenario: { ...BASE_CFG.scenario, encounter: enc } };
  const a = createEngine(cfg, DATA);
  const b = createEngine(cfg, DATA);
  let sa = a.initialState, sb = b.initialState;
  for (let i = 0; i < 100; i++) {
    sa = a.tick(sa);
    sb = b.tick(sb);
  }
  assert.equal(sa.scores.advance.kills, sb.scores.advance.kills);
  assert.equal(sa.scores.survival.closestEnemyM, sb.scores.survival.closestEnemyM);
});
