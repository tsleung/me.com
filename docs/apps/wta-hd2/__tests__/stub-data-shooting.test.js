import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDataSync } from "../data-loader.js";
import { createEngine } from "../engine.js";
import { foldHeatmapCredits } from "../analytics-helpers.js";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

test("default-helldiver loadout against bugs FIRES weapons within 30s", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  assert.ok(helldiver, "default-helldiver preset must exist");

  const cfg = {
    seed: 42,
    scenario: { ...helldiver.scenario, difficulty: 8 },
    loadout: helldiver.loadout,
    solver: { alpha: 0.5, reserves: {} },
  };
  const engine = createEngine(cfg, data);
  let s = engine.initialState;
  let totalAssignments = 0;
  let totalFxFlashes = 0;
  for (let i = 0; i < 300; i++) { // 30s
    s = engine.tick(s);
    totalAssignments += (s._lastAssignments ?? []).length;
    totalFxFlashes += (s._fxFlashes ?? []).length;
  }
  assert.ok(totalAssignments > 0, `expected >0 assignments in 30s, got ${totalAssignments}`);
  assert.ok(totalFxFlashes > 0, `expected >0 fx flashes in 30s, got ${totalFxFlashes}`);
  assert.ok(s.scores.advance.kills > 0, `expected kills, got ${s.scores.advance.kills}`);
});

test("primary ammo IS CONSUMED — Liberator should fire at approaching wave", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  const cfg = {
    seed: 12345,
    scenario: { ...helldiver.scenario, difficulty: 4 },
    loadout: helldiver.loadout,
    solver: { alpha: 0.5, reserves: {} },
  };
  const engine = createEngine(cfg, data);
  let s = engine.initialState;
  const initialPrimaryMag = s.weapons.get("primary").ammoInMag;
  for (let i = 0; i < 200; i++) s = engine.tick(s); // 20 sec
  const finalPrimaryMag = s.weapons.get("primary").ammoInMag;
  const finalPrimaryReserve = s.weapons.get("primary").ammoReserve;
  const totalAmmoConsumed = (initialPrimaryMag - finalPrimaryMag) + (270 - finalPrimaryReserve);
  assert.ok(totalAmmoConsumed > 0, `primary ammo MUST be consumed, but mag=${finalPrimaryMag}/${initialPrimaryMag} reserve=${finalPrimaryReserve}`);
});

test("solver returns assignments when enemies present in default scenario", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  const cfg = {
    seed: 1,
    scenario: { ...helldiver.scenario, difficulty: 4 },
    loadout: helldiver.loadout,
    solver: { alpha: 0.5, reserves: {} },
  };
  const engine = createEngine(cfg, data);
  let s = engine.initialState;
  let assignmentCount = 0;
  for (let i = 0; i < 200; i++) {
    s = engine.tick(s);
    assignmentCount += (s._lastAssignments ?? []).length;
  }
  assert.ok(assignmentCount > 5, `solver must return assignments, got ${assignmentCount} over 20s`);
});

test("assignment heatmap populates by default — multiple cells lit after 30s", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  const cfg = {
    seed: 42,
    scenario: { ...helldiver.scenario, difficulty: 6 },
    loadout: helldiver.loadout,
    solver: { alpha: 0.5, reserves: {} },
  };
  const engine = createEngine(cfg, data);
  let s = engine.initialState;
  const heatState = { cum: new Map(), lastTickN: -1 };
  for (let i = 0; i < 300; i++) {
    s = engine.tick(s);
    foldHeatmapCredits(heatState, engine.view(s));
  }
  // At least one weapon must have credit on at least one archetype.
  let lit = 0;
  let totalCredit = 0;
  for (const row of heatState.cum.values()) {
    for (const v of row.values()) {
      if (v > 0) lit++;
      totalCredit += v;
    }
  }
  assert.ok(lit >= 1, `expected ≥1 lit cell, got ${lit}`);
  assert.ok(totalCredit > 0.5, `expected meaningful cumulative credit, got ${totalCredit}`);
  // The primary should have done at least some of the firing.
  assert.ok(heatState.cum.has("primary"), "primary row must exist after a default run");
});

test("heatmap accumulator resets when tickN drops (engine restart)", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  const cfg = {
    seed: 7,
    scenario: { ...helldiver.scenario, difficulty: 5 },
    loadout: helldiver.loadout,
    solver: { alpha: 0.5, reserves: {} },
  };
  let engine = createEngine(cfg, data);
  let s = engine.initialState;
  const heatState = { cum: new Map(), lastTickN: -1 };
  for (let i = 0; i < 200; i++) {
    s = engine.tick(s);
    foldHeatmapCredits(heatState, engine.view(s));
  }
  const before = [...heatState.cum.values()].reduce(
    (acc, row) => acc + [...row.values()].reduce((a, v) => a + v, 0), 0,
  );
  assert.ok(before > 0, "must have credits before restart");
  // Restart: fresh engine, snapshot starts at tickN=0.
  engine = createEngine(cfg, data);
  foldHeatmapCredits(heatState, engine.view(engine.initialState));
  assert.equal(heatState.cum.size, 0, "cumulative must reset on restart");
});

test("default-helldiver against each faction kills SOMETHING in 30s", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  for (const faction of ["terminids", "automatons", "illuminate"]) {
    const cfg = {
      seed: 42,
      scenario: { faction, subfaction: "standard", encounter: "patrol", difficulty: 8 },
      loadout: helldiver.loadout,
      solver: { alpha: 0.5, reserves: {} },
    };
    const engine = createEngine(cfg, data);
    let s = engine.initialState;
    for (let i = 0; i < 300; i++) s = engine.tick(s);
    assert.ok(s.scores.advance.kills > 0, `${faction}: expected kills, got ${s.scores.advance.kills}`);
  }
});
