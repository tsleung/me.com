// Golden-run harness for wta-hd2.
//
// Runs the engine + WTA solver end-to-end (no UI, no DOM, no D3) for a
// deterministic seed × scenario × loadout, then collapses the trace to a
// stable summary that we commit as a JSON fixture.
//
// The summary deliberately captures *policy signal*, not the full trace:
//   - kills by tier and total assignments / shots
//   - heatmap top-3 (weapon, archetype) pairs by cumulative pKill credit
//   - per-weapon shot-share of the run
//   - movement-mode histogram (HOLD/KITE/PUSH counts)
//   - score endpoints (advance.fractionCleared, survival.closestEnemyM)
//
// Anything that's a raw float gets rounded to 4 decimals so we don't trip on
// rounding drift across CPUs / Node minor versions. Integer counts pass
// through unrounded.

import { createEngine } from "../engine.js";
import { foldHeatmapCredits } from "../analytics-helpers.js";

export function runGoldenScenario(data, cfg, ticks) {
  const engine = createEngine(cfg, data);
  let s = engine.initialState;

  const heat = { cum: new Map(), lastTickN: -1 };
  const modeHistogram = { HOLD: 0, KITE: 0, PUSH: 0 };
  const shotsByWeapon = new Map();
  let totalAssignments = 0;
  let totalShots = 0;
  let lastSnap = engine.view(s);

  // Track kills by reading delta of `scores.advance.kills` (single counter)
  // alongside a per-tick alive-by-tier delta on the snapshot enemies. The
  // tier breakdown isn't in scoring.js (yet); we approximate by recording
  // tier of any enemy that flips alive=true → alive=false between snapshots.
  const aliveTierByEnemyId = new Map(); // id -> tier (only while alive)
  const killsByTier = { light: 0, medium: 0, heavy: 0, boss: 0 };

  for (let i = 0; i < ticks; i++) {
    s = engine.tick(s);
    const snap = engine.view(s);

    // Mode histogram.
    const mode = snap.player?.mode ?? "HOLD";
    if (mode in modeHistogram) modeHistogram[mode]++;

    // Assignments + shots.
    for (const a of snap.assignments) {
      totalAssignments++;
      totalShots += a.shots;
      shotsByWeapon.set(a.weaponId, (shotsByWeapon.get(a.weaponId) || 0) + a.shots);
    }

    // Heatmap accumulator (cumulative pKill credit).
    foldHeatmapCredits(heat, snap);

    // Kills-by-tier delta.
    const seenAlive = new Set();
    for (const e of snap.enemies) {
      if (e.alive) {
        seenAlive.add(e.id);
        if (!aliveTierByEnemyId.has(e.id)) aliveTierByEnemyId.set(e.id, e.threatTier);
      }
    }
    for (const [id, tier] of aliveTierByEnemyId) {
      if (!seenAlive.has(id)) {
        // Was alive last tick, no longer alive (or reaped) this tick → killed.
        if (tier in killsByTier) killsByTier[tier]++;
        aliveTierByEnemyId.delete(id);
      }
    }
    lastSnap = snap;
  }

  // Top-3 heatmap pairs by cumulative credit.
  const flatPairs = [];
  for (const [weaponId, row] of heat.cum) {
    for (const [archetypeId, credit] of row) {
      flatPairs.push({ weapon: weaponId, archetype: archetypeId, credit });
    }
  }
  flatPairs.sort((a, b) => b.credit - a.credit || cmp(a.weapon, b.weapon) || cmp(a.archetype, b.archetype));
  const heatmapTop3 = flatPairs.slice(0, 3).map((p) => ({
    weapon: p.weapon, archetype: p.archetype, credit: round4(p.credit),
  }));

  // Per-weapon shot share.
  const shotShare = {};
  if (totalShots > 0) {
    for (const [w, n] of [...shotsByWeapon.entries()].sort()) {
      shotShare[w] = round4(n / totalShots);
    }
  }

  return {
    cfgKey: cfgKey(cfg),
    ticks,
    finalT: lastSnap.t,
    finalTickN: lastSnap.tickN,
    scores: {
      advance: {
        kills: lastSnap.scores?.advance?.kills ?? 0,
        fractionCleared: round4(lastSnap.scores?.advance?.fractionCleared ?? 0),
      },
      survival: {
        closestEnemyM: round4(finiteOr(lastSnap.scores?.survival?.closestEnemyM, 9999)),
      },
    },
    killsByTier,
    totalAssignments,
    totalShots,
    modeHistogram,
    heatmapTop3,
    shotShare,
    finalAlive: lastSnap.enemies.filter((e) => e.alive).length,
  };
}

function cfgKey(cfg) {
  const s = cfg.scenario ?? {};
  const l = cfg.loadout ?? {};
  const sv = cfg.solver ?? {};
  return [
    s.faction, s.subfaction, s.encounter, `d${s.difficulty}`,
    `seed${cfg.seed}`,
    `α${sv.alpha ?? 0.5}`,
    `γ${sv.gamma ?? 0}`,
    l.primary, l.secondary, l.grenade,
    (l.stratagems ?? []).join(","),
  ].join("/");
}

function round4(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return v;
  return Math.round(v * 10000) / 10000;
}

function finiteOr(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
