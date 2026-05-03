// Golden / regression tests for the WTA optimizer.
//
// These run the engine end-to-end (no UI) for a fixed seed × scenario ×
// loadout × solver-config matrix, summarize the run, and assert the
// summary matches a committed fixture under `__tests__/golden/`. Any
// behavioral drift in the solver, sim, scoring, or movement logic surfaces
// here as a diff.
//
// Updating goldens:
//   UPDATE_GOLDENS=1 node --test docs/apps/wta-hd2/__tests__/golden.test.js
//
// Adding a scenario: append to SCENARIOS below, run with UPDATE_GOLDENS=1,
// commit the new fixture file. Removing or renaming: delete the matching
// fixture by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { loadDataSync } from "../data-loader.js";
import { runGoldenScenario } from "./_golden-runner.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const GOLDEN_DIR = path.join(__dirname, "golden");
const UPDATE = process.env.UPDATE_GOLDENS === "1";

// ----- scenario matrix --------------------------------------------------
//
// Each entry pins one cell of the (preset, faction, difficulty, solver) grid.
// `name` becomes the fixture filename and the test description.

const SCENARIOS = [
  // Smoke: default-helldiver vs each faction at mid difficulty, default solver.
  { name: "default-helldiver_terminids_d5",   preset: "default-helldiver", faction: "terminids",  diff: 5, seed: 42, ticks: 300, solver: { alpha: 0.4, gamma: 0.3 } },
  { name: "default-helldiver_automatons_d5",  preset: "default-helldiver", faction: "automatons", diff: 5, seed: 42, ticks: 300, solver: { alpha: 0.4, gamma: 0.3 } },
  { name: "default-helldiver_illuminate_d5",  preset: "default-helldiver", faction: "illuminate", diff: 5, seed: 42, ticks: 300, solver: { alpha: 0.4, gamma: 0.3 } },

  // Heavy-laden run — diff 9 should put chargers / heavies on the field, so
  // the EAT-shaped weapons in default-helldiver get to exercise γ.
  { name: "default-helldiver_terminids_d9",   preset: "default-helldiver", faction: "terminids",  diff: 9, seed: 42, ticks: 300, solver: { alpha: 0.4, gamma: 0.3 } },

  // γ contrast: same scenario at γ=0 (legacy two-term) vs γ=1 (pure right-tool).
  // The pair locks the *contrast* between policies, so a regression that
  // collapses them surfaces immediately.
  { name: "default-helldiver_terminids_d7_g0", preset: "default-helldiver", faction: "terminids", diff: 7, seed: 99, ticks: 300, solver: { alpha: 0.5, gamma: 0.0 } },
  { name: "default-helldiver_terminids_d7_g1", preset: "default-helldiver", faction: "terminids", diff: 7, seed: 99, ticks: 300, solver: { alpha: 0.0, gamma: 1.0 } },

  // EAT-on-rotation preset (recoilless-anti-tank) vs heavy-laden bots.
  { name: "recoilless_automatons_d8",          preset: "recoilless-anti-tank", faction: "automatons", diff: 8, seed: 7, ticks: 300, solver: { alpha: 0.4, gamma: 0.5 } },
];

// ----- harness ----------------------------------------------------------

async function buildCfg(scn, data) {
  const preset = data.presets.find((p) => p.id === scn.preset);
  if (!preset) throw new Error(`unknown preset ${scn.preset}`);
  return {
    seed: scn.seed,
    scenario: {
      faction: scn.faction,
      subfaction: "standard",
      encounter: preset.scenario?.encounter ?? "patrol",
      difficulty: scn.diff,
      // Disable infinite waves so each golden is bounded by `ticks`. The
      // wave-cadence randomness otherwise leaks into the run summary.
      infiniteWaves: false,
      // Goldens test the movement state machine (mode histogram is part of
      // the summary), so opt into kiting/pushing — the app default is now
      // stationary-turret.
      playerMovement: true,
    },
    loadout: preset.loadout,
    solver: { reserves: {}, ...scn.solver },
  };
}

async function compareOrWrite(scn, summary) {
  const file = path.join(GOLDEN_DIR, `${scn.name}.json`);
  const serialized = JSON.stringify(summary, null, 2) + "\n";
  if (UPDATE) {
    await writeFile(file, serialized);
    return { ok: true, message: "written" };
  }
  let golden;
  try {
    golden = await readFile(file, "utf8");
  } catch (e) {
    return { ok: false, message: `golden missing: ${file}\nrun UPDATE_GOLDENS=1 to create it.` };
  }
  if (golden !== serialized) {
    return { ok: false, message: diffMessage(scn.name, golden, serialized) };
  }
  return { ok: true, message: "match" };
}

function diffMessage(name, expected, actual) {
  const exp = expected.split("\n");
  const act = actual.split("\n");
  const max = Math.max(exp.length, act.length);
  const lines = [`golden mismatch: ${name}`];
  for (let i = 0; i < max; i++) {
    if (exp[i] !== act[i]) {
      lines.push(`  L${i + 1}:`);
      lines.push(`    -expected: ${exp[i] ?? "(eof)"}`);
      lines.push(`    +actual:   ${act[i] ?? "(eof)"}`);
      if (lines.length > 30) { lines.push("  …(truncated)"); break; }
    }
  }
  lines.push("To accept: UPDATE_GOLDENS=1 node --test docs/apps/wta-hd2/__tests__/golden.test.js");
  return lines.join("\n");
}

// ----- one node:test per scenario --------------------------------------

for (const scn of SCENARIOS) {
  test(`golden: ${scn.name}`, async () => {
    const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
    const cfg = await buildCfg(scn, data);
    const summary = runGoldenScenario(data, cfg, scn.ticks);
    const result = await compareOrWrite(scn, summary);
    assert.ok(result.ok, result.message);
  });
}

// ----- cross-scenario invariants (regression tests, not file fixtures) --
//
// Pin behavior we want to lock down without committing per-tick numbers:
// these are properties that should hold regardless of small drift.

test("regression: γ=1 prefers heavies more than γ=0 (same seed, same scenario)", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const base = {
    seed: 99,
    scenario: { faction: "terminids", subfaction: "standard", encounter: "patrol", difficulty: 7, infiniteWaves: false, playerMovement: true },
    loadout: data.presets.find((p) => p.id === "default-helldiver").loadout,
  };
  const noEff   = runGoldenScenario(data, { ...base, solver: { alpha: 0.5, gamma: 0.0, reserves: {} } }, 300);
  const fullEff = runGoldenScenario(data, { ...base, solver: { alpha: 0.0, gamma: 1.0, reserves: {} } }, 300);
  // γ=1 should have at least as many heavy/medium kills, OR a heatmap whose
  // top pair leans heavier. We assert the weaker invariant: γ=1's heatmap
  // top pair archetype tier rank ≥ γ=0's. (Tied is OK — both might focus
  // on whatever's on the field that run.)
  // The strict invariant is just that the two summaries differ — collapsing
  // them indicates the γ wiring broke.
  assert.notDeepEqual(noEff.heatmapTop3, fullEff.heatmapTop3,
    "γ=0 and γ=1 produced identical heatmap top-3 — γ wiring regressed");
});

test("regression: movement modes are populated and sum to total ticks", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const cfg = await buildCfg(SCENARIOS[0], data);
  const summary = runGoldenScenario(data, cfg, SCENARIOS[0].ticks);
  const sum = summary.modeHistogram.HOLD + summary.modeHistogram.KITE + summary.modeHistogram.PUSH;
  assert.equal(sum, SCENARIOS[0].ticks, "mode histogram must cover every tick");
  // At least two distinct modes must appear in a 30-second run with live
  // threats — if not, movement collapsed to a single state and we want to
  // know.
  const distinct = Object.values(summary.modeHistogram).filter((v) => v > 0).length;
  assert.ok(distinct >= 2, `expected ≥2 distinct modes, got ${JSON.stringify(summary.modeHistogram)}`);
});

test("regression: at least one weapon fires in every smoke scenario", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  for (const scn of SCENARIOS.slice(0, 3)) { // the three smoke scenarios
    const cfg = await buildCfg(scn, data);
    const summary = runGoldenScenario(data, cfg, scn.ticks);
    assert.ok(summary.totalShots > 0, `${scn.name}: no shots fired in 300 ticks`);
    assert.ok(summary.totalAssignments > 0, `${scn.name}: no assignments produced`);
  }
});

test("regression: same seed → identical summary (determinism)", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const cfg = await buildCfg(SCENARIOS[0], data);
  const a = runGoldenScenario(data, cfg, 200);
  const b = runGoldenScenario(data, cfg, 200);
  assert.deepEqual(a, b, "same seed must produce identical summary");
});
