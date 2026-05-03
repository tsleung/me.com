// Regression tests for snapshot/contract shape — exercises the same surface
// that L3 components consume. Catches bugs like "history entries are numbers
// not objects" (the NaN-path bug) at the contract level.
//
// Layered:
//   L1: scoring history shape, engine snapshot shape, scenario shape
//   L2: controller snapshot is identical to engine view; subscriber receives it
//   L3: analytics-helpers consume shape correctly without producing NaN

import { test } from "node:test";
import assert from "node:assert/strict";
import { newScoreState, update as scoreUpdate } from "../scoring.js";
import { createEngine } from "../engine.js";
import { createController } from "../controller.js";
import {
  aggregatePKillByArchetype,
  aliveCountsByTier,
  historyAxisBounds,
  fmtSeconds,
  cooldownDashArray,
} from "../analytics-helpers.js";
import { loadDataSync } from "../data-loader.js";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

// ---- L1: scoring history contract ----------------------------------------

test("L1 — scoring history entry shape: { t:number, advance:number, survival:number }", () => {
  let s = newScoreState();
  for (let i = 0; i < 25; i++) {
    s = scoreUpdate(s, {
      t: i * 100, tickN: i,
      player: { x: 0, y: 0 },
      enemies: new Map([["e1", { id: "e1", alive: true, threatTier: "light", position: { x: 0, y: 50 } }]]),
    });
  }
  assert.ok(s.history.length > 0);
  for (const h of s.history) {
    assert.equal(typeof h.t, "number", `history.t must be number, got ${typeof h.t}`);
    assert.equal(typeof h.advance, "number", `history.advance must be number (NOT object), got ${typeof h.advance}`);
    assert.equal(typeof h.survival, "number", `history.survival must be number (NOT object), got ${typeof h.survival}`);
    assert.ok(Number.isFinite(h.t));
    assert.ok(Number.isFinite(h.advance));
    assert.ok(Number.isFinite(h.survival), `history.survival must be finite (Infinity → 80 cap)`);
  }
});

// ---- L1: engine snapshot contract ----------------------------------------

test("L1 — engine.view returns snapshot with all required keys", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  const engine = createEngine({
    seed: 1, scenario: helldiver.scenario, loadout: helldiver.loadout,
    solver: { alpha: 0.5, reserves: {} },
  }, data);
  const snap = engine.view(engine.initialState);
  for (const k of [
    "t", "tickN", "player", "enemies", "projectiles", "effects",
    "weapons", "stratagems", "assignments", "fxFlashes",
    "nextSpawnT", "nextWaveT", "totalSpawns", "scores", "scenario",
  ]) {
    assert.ok(k in snap, `snapshot missing required key: ${k}`);
  }
});

test("L1 — snapshot.scores.history entries are { t, advance, survival } numbers (NOT nested objects)", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  const engine = createEngine({
    seed: 1, scenario: helldiver.scenario, loadout: helldiver.loadout,
    solver: { alpha: 0.5, reserves: {} },
  }, data);
  let s = engine.initialState;
  for (let i = 0; i < 100; i++) s = engine.tick(s);
  const snap = engine.view(s);
  assert.ok(snap.scores.history.length > 0);
  for (const h of snap.scores.history) {
    assert.equal(typeof h.advance, "number", `history.advance is ${typeof h.advance} not number — D3 chart will produce NaN`);
    assert.equal(typeof h.survival, "number", `history.survival is ${typeof h.survival} not number — D3 chart will produce NaN`);
  }
});

test("L1 — snapshot.weapons rows have ammoInMag/magCap/ammoReserve/reloadingPct as numbers", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  const engine = createEngine({
    seed: 1, scenario: helldiver.scenario, loadout: helldiver.loadout,
    solver: { alpha: 0.5, reserves: {} },
  }, data);
  const snap = engine.view(engine.initialState);
  for (const w of snap.weapons) {
    assert.equal(typeof w.id, "string");
    assert.equal(typeof w.ammoInMag, "number");
    assert.equal(typeof w.magCap, "number");
    assert.equal(typeof w.ammoReserve, "number");
    assert.equal(typeof w.reloadingPct, "number");
    assert.ok(Number.isFinite(w.reloadingPct));
  }
});

test("L1 — snapshot.stratagems rows have cooldownPct (number, finite) and usesRemaining (number|null)", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  const engine = createEngine({
    seed: 1, scenario: helldiver.scenario, loadout: helldiver.loadout,
    solver: { alpha: 0.5, reserves: {} },
  }, data);
  const snap = engine.view(engine.initialState);
  for (const s of snap.stratagems) {
    assert.equal(typeof s.id, "string");
    assert.equal(typeof s.cooldownPct, "number");
    assert.ok(Number.isFinite(s.cooldownPct));
    assert.ok(s.usesRemaining === null || typeof s.usesRemaining === "number");
  }
});

test("L1 — snapshot.nextSpawnT is null or a finite number > current t", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  const engine = createEngine({
    seed: 1, scenario: helldiver.scenario, loadout: helldiver.loadout,
    solver: { alpha: 0.5, reserves: {} },
  }, data);
  let s = engine.initialState;
  for (let i = 0; i < 5; i++) {
    s = engine.tick(s);
    const snap = engine.view(s);
    if (snap.nextSpawnT !== null) {
      assert.equal(typeof snap.nextSpawnT, "number");
      assert.ok(Number.isFinite(snap.nextSpawnT));
      assert.ok(snap.nextSpawnT > snap.t, `nextSpawnT (${snap.nextSpawnT}) must be > current t (${snap.t})`);
    }
  }
});

// ---- L2: controller surfaces snapshots that match engine.view -----------

test("L2 — controller.subscribe receives snapshot identical to engine.view", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  const cfg = {
    seed: 7, scenario: helldiver.scenario, loadout: helldiver.loadout,
    solver: { alpha: 0.5, reserves: {} },
  };
  const c = createController({
    engineFactory: createEngine,
    initialCfg: cfg,
    data,
    schedule: {
      perfNow: () => 0,
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
  });
  const seen = [];
  c.subscribe((snap) => seen.push(snap));
  c.dispatch({ type: "STEP" });
  assert.ok(seen.length >= 2, "expected initial + step snapshots");
  for (const snap of seen) {
    for (const k of ["t", "tickN", "weapons", "stratagems", "scores", "nextSpawnT"]) {
      assert.ok(k in snap, `controller snapshot missing key: ${k}`);
    }
  }
});

// ---- L3: analytics-helpers handle real snapshot history WITHOUT NaN -----

test("L3 — historyAxisBounds returns FINITE numbers from real snapshot history", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  const engine = createEngine({
    seed: 1, scenario: helldiver.scenario, loadout: helldiver.loadout,
    solver: { alpha: 0.5, reserves: {} },
  }, data);
  let s = engine.initialState;
  for (let i = 0; i < 50; i++) s = engine.tick(s);
  const snap = engine.view(s);
  const bounds = historyAxisBounds(snap.scores.history);
  for (const k of ["tMin", "tMax", "advanceMin", "advanceMax", "survivalMin", "survivalMax"]) {
    assert.equal(typeof bounds[k], "number", `bounds.${k} not a number`);
    assert.ok(Number.isFinite(bounds[k]), `bounds.${k} = ${bounds[k]} (NaN/Infinity → would break D3 path)`);
  }
});

test("L3 — historyAxisBounds with empty/malformed history returns sane defaults", () => {
  const empty = historyAxisBounds([]);
  assert.ok(Number.isFinite(empty.tMin));
  assert.ok(Number.isFinite(empty.tMax));
  assert.ok(empty.tMax > empty.tMin);

  // Malformed entries should not crash and should not produce NaN bounds.
  const messy = historyAxisBounds([
    { t: 0, advance: 0, survival: Infinity },
    { t: 100, advance: 0.5, survival: 80 },
    { t: NaN, advance: NaN, survival: NaN },
    null,
    undefined,
  ]);
  for (const k of ["tMin", "tMax", "advanceMin", "advanceMax", "survivalMin", "survivalMax"]) {
    assert.ok(Number.isFinite(messy[k]), `bounds.${k} = ${messy[k]} from malformed input`);
  }
});

test("L3 — aggregatePKillByArchetype handles empty inputs", () => {
  const r = aggregatePKillByArchetype([], []);
  assert.ok(r instanceof Map);
  assert.equal(r.size, 0);
});

test("L3 — aliveCountsByTier returns all four tiers initialized to 0", () => {
  const r = aliveCountsByTier([]);
  for (const tier of ["light", "medium", "heavy", "boss"]) {
    assert.equal(r[tier], 0, `tier ${tier} should default to 0`);
  }
});

test("L3 — fmtSeconds handles 0, fractional, and large values", () => {
  assert.equal(fmtSeconds(0), "0.0s");
  assert.equal(typeof fmtSeconds(1234), "string");
  assert.equal(typeof fmtSeconds(0), "string");
});

test("L3 — cooldownDashArray returns a string with non-NaN numbers", () => {
  const ready = cooldownDashArray(1, 8);
  const half = cooldownDashArray(0.5, 8);
  const cold = cooldownDashArray(0, 8);
  for (const r of [ready, half, cold]) {
    assert.ok(r);
    const str = typeof r === "string" ? r : (r.dashArray ?? String(r));
    assert.ok(!str.includes("NaN"), `cooldownDashArray returned NaN: ${str}`);
  }
});

// ---- L1+L3 integration: full pipeline never produces NaN in any field --

test("Integration — 100-tick simulated run produces no NaN/Infinity in snapshot or score history", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  const engine = createEngine({
    seed: 999, scenario: helldiver.scenario, loadout: helldiver.loadout,
    solver: { alpha: 0.5, reserves: {} },
  }, data);
  let s = engine.initialState;
  for (let i = 0; i < 100; i++) s = engine.tick(s);
  const snap = engine.view(s);

  function assertNoNaN(obj, path = "snap") {
    if (obj == null) return;
    if (typeof obj === "number") {
      assert.ok(!Number.isNaN(obj), `NaN at ${path}`);
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => assertNoNaN(v, `${path}[${i}]`));
      return;
    }
    if (typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "function") continue;
        if (k.startsWith("_")) continue; // internal scratch fields
        assertNoNaN(v, `${path}.${k}`);
      }
    }
  }
  assertNoNaN(snap);
});
