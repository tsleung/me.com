// Regression: stratagem throws must resolve at resolveAt and remove their
// callin beacon from snapshot.effects. The "0ms beacon stuck" bug had beacons
// accumulating because the scheduled landing fn never fired (mid-tick cursor
// reset under sort moved the cursor past the just-pushed event).

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDataSync } from "../data-loader.js";
import { createEngine } from "../engine.js";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

test("stratagem throw → callin beacon → landing fires → beacon removed", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  const engine = createEngine({
    seed: 42,
    scenario: { ...helldiver.scenario, difficulty: 6, infiniteWaves: false },
    loadout: helldiver.loadout,
    solver: { alpha: 0.5, reserves: {} },
  }, data);

  let s = engine.initialState;
  let sawCallin = false;
  let beaconCountAtPeak = 0;

  // Run for 30 simulated seconds.
  for (let i = 0; i < 300; i++) {
    s = engine.tick(s);
    const view = engine.view(s);
    const callinCount = (view.effects ?? []).filter((e) => e.kind === "callin").length;
    if (callinCount > 0) sawCallin = true;
    if (callinCount > beaconCountAtPeak) beaconCountAtPeak = callinCount;
  }

  // We must have seen at least one callin during the run.
  assert.ok(sawCallin, "expected at least one stratagem throw within 30s");

  // After 30s (well past max callInSecs of 3-4s), all callin beacons must be gone.
  const finalView = engine.view(s);
  const finalCallins = (finalView.effects ?? []).filter((e) => e.kind === "callin");
  assert.equal(finalCallins.length, 0,
    `expected 0 callin beacons after 30s, got ${finalCallins.length} (peak was ${beaconCountAtPeak}) — landing fns aren't firing`);
});

test("beacon LINGERS ~1200ms after resolveAt before being removed (impact-visible window)", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  const engine = createEngine({
    seed: 11,
    scenario: { ...helldiver.scenario, difficulty: 6, infiniteWaves: false },
    loadout: helldiver.loadout,
    solver: { alpha: 0.5, reserves: {} },
  }, data);
  let s = engine.initialState;
  let firstResolveAt = null;
  let lingerObservedAtSecs = [];
  for (let i = 0; i < 200; i++) {
    s = engine.tick(s);
    const view = engine.view(s);
    const callins = (view.effects ?? []).filter((e) => e.kind === "callin");
    if (firstResolveAt === null && callins.length > 0) firstResolveAt = callins[0].resolveAt;
    if (firstResolveAt !== null) {
      const stillThere = callins.find((e) => e.resolveAt === firstResolveAt);
      if (stillThere && view.t > firstResolveAt) {
        // beacon present after resolveAt → in linger window
        lingerObservedAtSecs.push((view.t - firstResolveAt) / 1000);
        if (stillThere.landedAt == null) {
          assert.fail(`beacon present post-resolveAt but landedAt not set (t=${view.t}, resolveAt=${firstResolveAt})`);
        }
      }
      if (!stillThere && view.t > firstResolveAt + 1300) {
        // confirmed removed within ~1.3s of resolveAt
        break;
      }
    }
  }
  assert.ok(firstResolveAt !== null, "no beacon ever appeared");
  assert.ok(lingerObservedAtSecs.length > 0,
    "beacon must remain visible for at least one tick after resolveAt");
  // Should observe linger somewhere in [0, 1.2s]; require at least 0.5s of presence.
  const maxLinger = Math.max(...lingerObservedAtSecs);
  assert.ok(maxLinger >= 0.5,
    `expected beacon to linger ≥0.5s post-resolveAt; max observed ${maxLinger.toFixed(2)}s`);
  assert.ok(maxLinger <= 1.3,
    `expected beacon removed within 1.3s post-resolveAt; max observed ${maxLinger.toFixed(2)}s`);
});

test("scheduled landing event fires at resolveAt regardless of mid-tick array growth", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const helldiver = data.presets.find((p) => p.id === "default-helldiver");
  const engine = createEngine({
    seed: 1,
    scenario: { ...helldiver.scenario, difficulty: 5, infiniteWaves: false },
    loadout: helldiver.loadout,
    solver: { alpha: 0.5, reserves: {} },
  }, data);

  let s = engine.initialState;
  // Track a beacon's lifetime — push, see it appear, see it disappear.
  let firstBeaconResolveAt = null;
  let firstBeaconStillPresentAt = null;

  for (let i = 0; i < 200; i++) {
    s = engine.tick(s);
    const view = engine.view(s);
    const callins = (view.effects ?? []).filter((e) => e.kind === "callin");
    if (callins.length > 0 && firstBeaconResolveAt === null) {
      firstBeaconResolveAt = callins[0].resolveAt;
    }
    // Beacon lingers 1200ms past resolveAt for the impact-visible window;
    // it must be gone within 1500ms of resolveAt.
    if (firstBeaconResolveAt != null && view.t >= firstBeaconResolveAt + 1500) {
      firstBeaconStillPresentAt = view.t;
      const stillThere = callins.find((e) => e.resolveAt === firstBeaconResolveAt);
      assert.equal(stillThere, undefined,
        `beacon with resolveAt=${firstBeaconResolveAt}ms still present at t=${view.t}ms (>1500ms past) — removal fn never fired`);
      break;
    }
  }
  assert.ok(firstBeaconResolveAt !== null, "no beacon ever appeared");
});
