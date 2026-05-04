import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDataSync } from "../../data-loader.js";
import { createEngine } from "../../engine.js";
import {
  hasHeat,
  initHeatState,
  addHeatForShots,
  tickHeat,
  maybeTripSink,
  isHeatLocked,
  refillSinks,
} from "../../features/heat-mgmt.js";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");

const SICKLE_DEF = {
  heat: { perShot: 0.06, coolingRatePerSec: 0.5, sinkSwapSecs: 2.5, sinkCount: 6 },
};

// ---- pure helpers ----

test("hasHeat: heat-bearing weapon → true; ammo weapon → false", () => {
  assert.equal(hasHeat({ heat: {} }), true);
  assert.equal(hasHeat({}), false);
  assert.equal(hasHeat(null), false);
});

test("initHeatState: builds heatLevel + sinks from def", () => {
  const s = initHeatState(SICKLE_DEF);
  assert.equal(s.heatLevel, 0);
  assert.equal(s.sinksRemaining, 6);
  assert.equal(s.sinksMax, 6);
  assert.equal(s.heat.perShot, 0.06);
});

test("initHeatState: returns null for non-heat defs (no allocation)", () => {
  assert.equal(initHeatState({}), null);
});

test("addHeatForShots: accumulates and saturates at 1.0", () => {
  const w = { ...initHeatState(SICKLE_DEF) };
  addHeatForShots(w, 10);
  // 10 × 0.06 = 0.6
  assert.ok(Math.abs(w.heatLevel - 0.6) < 1e-9, `got ${w.heatLevel}`);
  addHeatForShots(w, 100);
  assert.equal(w.heatLevel, 1, "should saturate at 1.0");
});

test("addHeatForShots: no-op on weapons without heat (e.g. Liberator)", () => {
  const w = { ammoInMag: 30 };
  addHeatForShots(w, 10);
  assert.equal(w.heatLevel, undefined);
});

test("tickHeat: passive cooling decays heatLevel toward 0", () => {
  const w = { ...initHeatState(SICKLE_DEF), heatLevel: 0.8 };
  tickHeat(w, 1.0); // 1 second
  // 0.8 - 0.5 = 0.3
  assert.ok(Math.abs(w.heatLevel - 0.3) < 1e-9, `got ${w.heatLevel}`);
});

test("tickHeat: floors at 0", () => {
  const w = { ...initHeatState(SICKLE_DEF), heatLevel: 0.2 };
  tickHeat(w, 5.0);
  assert.equal(w.heatLevel, 0);
});

// ---- sink-swap trip ----

test("maybeTripSink: at cap with sinks → reload window starts, heat→0, sinks-1", () => {
  const w = { ...initHeatState(SICKLE_DEF), heatLevel: 1.0 };
  maybeTripSink(w, 5000);
  assert.equal(w.heatLevel, 0);
  assert.equal(w.sinksRemaining, 5);
  assert.equal(w.reloadingUntil, 5000 + 2500);
});

test("maybeTripSink: bone-dry sinks → forced cooldown, heat→0", () => {
  const w = { ...initHeatState(SICKLE_DEF), heatLevel: 1.0, sinksRemaining: 0 };
  maybeTripSink(w, 5000);
  assert.equal(w.heatLevel, 0);
  assert.equal(w.sinksRemaining, 0);
  // capCooldownSecs default = 4 * 1000
  assert.equal(w.reloadingUntil, 5000 + 4000);
});

test("maybeTripSink: idempotent during an in-flight swap", () => {
  const w = { ...initHeatState(SICKLE_DEF), heatLevel: 1.0 };
  maybeTripSink(w, 5000); // sinks 6 → 5
  maybeTripSink(w, 5500); // mid-swap: shouldn't burn another sink
  assert.equal(w.sinksRemaining, 5);
});

// ---- gating ----

test("isHeatLocked: at cap → true; mid-swap → true; cool → false", () => {
  const w = { ...initHeatState(SICKLE_DEF), heatLevel: 1.0 };
  assert.equal(isHeatLocked(w, 5000), true);
  // After tripping, mid-swap.
  maybeTripSink(w, 5000);
  assert.equal(isHeatLocked(w, 5500), true);
  // Past swap window with heat=0.
  assert.equal(isHeatLocked(w, 8000), false);
});

test("isHeatLocked: no-op for non-heat weapons", () => {
  assert.equal(isHeatLocked({}, 5000), false);
});

// ---- refillSinks ----

test("refillSinks: only restocks heat-bearing weapons", () => {
  const state = { weapons: new Map() };
  state.weapons.set("primary", { ammoInMag: 30 });           // no heat
  state.weapons.set("secondary", {                           // heat, partial
    heat: SICKLE_DEF.heat, heatLevel: 0, sinksRemaining: 2, sinksMax: 6,
  });
  state.weapons.set("strat-1", {                             // heat, full
    heat: SICKLE_DEF.heat, heatLevel: 0, sinksRemaining: 6, sinksMax: 6,
  });
  const n = refillSinks(state);
  assert.equal(n, 1);
  assert.equal(state.weapons.get("secondary").sinksRemaining, 6);
});

// ---- engine integration: Sickle overheats, swaps, and runs out of sinks ----

test("Sickle deployed via primary slot overheats during sustained fire", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const cfg = {
    seed: 7,
    scenario: { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 9, infiniteWaves: false },
    loadout: {
      primary: "sickle", secondary: "peacemaker", grenade: "frag",
      stratagems: [null, null, null, null],
    },
    solver: { alpha: 0.4, gamma: 0.3, reserves: {} },
  };
  const engine = createEngine(cfg, data);
  let s = engine.initialState;
  let everOverheated = false;
  let everSwapped = false;
  for (let i = 0; i < 200; i++) {
    s = engine.tick(s);
    const sk = s.weapons.get("primary");
    if (!sk) continue;
    if ((sk.heatLevel ?? 0) > 0.95) everOverheated = true;
    if ((sk.sinksRemaining ?? 6) < 6) everSwapped = true;
  }
  // Headline regression: sustained fire should build heat to cap and burn
  // at least one sink.
  assert.ok(everOverheated, "Sickle should reach overheat during sustained fire");
  assert.ok(everSwapped, "Sickle should burn at least one sink swap");
});
