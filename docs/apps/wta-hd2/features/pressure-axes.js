// =============================================================================
// FEATURE: pressure axes (encounter demand × build capacity)
// =============================================================================
//
// Closed-form math, no simulation required. Both functions return a record
// keyed by axis: { antiHeavy, crowd, standoff, burst }.
//
//   antiHeavy  — heavies (heavy/boss tier) per minute  vs.  the build's
//                heavies-killable per minute given cooldowns/uses/reload.
//   crowd      — light + medium body count per minute   vs.  the build's
//                crowd-clear throughput.
//   standoff   — ranged enemies per minute              vs.  the build's
//                long-reach DPS (weapons with maxRangeM ≥ 60m).
//   burst      — peak heavies in any 5-second window    vs.  the build's
//                immediate-damage budget (sum of stratagem AoE dmg × uses).
//
// The *gap* (capacity − demand) per axis tells you where the build breaks.
// Negative on any axis = under-gunned for that engagement profile.
//
// Today this module is DIAGNOSTIC ONLY — it's not wired into the UI or the
// simulation. Per the 2026-05-03 player-intent clarification, the visual
// "you're being overrun" signal is the headline; raw axes are nice-to-have
// for future tooling (build comparator, slot ablation summaries).
//
// PURE — no state. Cheap to recompute on scenario or loadout changes.
//
// HOW TO REMOVE
//   1. Delete this file.
//   2. Drop any imports (none today).
// Nothing else depends on it.
//
// SEE ALSO
//   notes/wta-hd2/2026_05_03_player_intent_and_build_archetypes.md
// =============================================================================

const HEAVY_TIERS = new Set(["heavy", "boss"]);
const CROWD_TIERS = new Set(["light", "medium"]);

/**
 * Encounter pressure demand vector. Reads scenario.spawnIntents +
 * scenario.archetypes, normalizes counts to per-minute over the horizon.
 *
 * @param {object} scenario - { spawnIntents, archetypes } from buildScenario
 * @param {object} [opts]
 * @param {number} [opts.horizonMs=60000]
 * @returns {{ antiHeavy:number, crowd:number, standoff:number, burst:number }}
 */
export function encounterDemand(scenario, opts = {}) {
  const horizonMs = opts.horizonMs ?? 60000;
  const intents = (scenario?.spawnIntents ?? []).filter((i) => i.t <= horizonMs);
  const archById = new Map();
  for (const a of scenario?.archetypes ?? []) archById.set(a.id, a);

  let antiHeavy = 0;
  let crowd = 0;
  let standoff = 0;

  // Burst: max number of heavies in any contiguous 5-second window.
  const heavies = [];
  for (const intent of intents) {
    const arch = archById.get(intent.enemyId);
    if (!arch) continue;
    if (HEAVY_TIERS.has(arch.threatTier)) { antiHeavy++; heavies.push(intent.t); }
    if (CROWD_TIERS.has(arch.threatTier)) crowd++;
    if ((arch.rangedDps ?? 0) > 0) standoff++;
  }
  heavies.sort((a, b) => a - b);
  let burst = 0;
  for (let i = 0; i < heavies.length; i++) {
    let n = 1;
    for (let j = i + 1; j < heavies.length && heavies[j] - heavies[i] <= 5000; j++) n++;
    if (n > burst) burst = n;
  }

  const minutes = horizonMs / 60000;
  return {
    antiHeavy: antiHeavy / minutes,
    crowd:     crowd / minutes,
    standoff:  standoff / minutes,
    burst,
  };
}

/**
 * Build capacity vector. Closed-form: per-weapon throughput summed across
 * the loadout. Coarse approximations — the headline signal is "is this
 * positive or negative?" not "is it 1.34 or 1.39."
 *
 * @param {object} loadout - { primary, secondary, grenade, stratagems[] }
 * @param {object} data - data bundle (data.weapons.*, data.stratagems)
 * @returns {{ antiHeavy:number, crowd:number, standoff:number, burst:number }}
 */
export function buildCapacity(loadout, data) {
  let antiHeavy = 0;
  let crowd = 0;
  let standoff = 0;
  let burst = 0;

  for (const w of collectWeaponDefs(loadout, data)) {
    const ap = w.armorPen ?? w.ap ?? 0;
    const dmg = w.damage ?? w.effects?.[0]?.damage ?? 0;
    const aoe = w.aoeRadiusM ?? w.effects?.[0]?.aoeRadiusM ?? 0;
    const range = w.maxRangeM ?? 0;
    const isStratagem = w.cooldownSecs != null || w.uses !== undefined && w.cooldownSecs !== undefined;

    if (isStratagem || w.cooldownSecs != null) {
      const cooldown = Math.max(1, w.cooldownSecs ?? 60);
      const uses = w.uses == null ? Infinity : w.uses;
      const usesPerMin = uses === Infinity ? (60 / cooldown) : Math.min(60 / cooldown, uses);
      // Anti-heavy: AP ≥ 4 + damage ≥ 1000 = "bona-fide heavy killer."
      if (ap >= 4 && dmg >= 1000) antiHeavy += usesPerMin;
      // Crowd: AoE ≥ 5m × 4 estimated kills/drop.
      if (aoe >= 5) crowd += usesPerMin * 4;
      // Burst: instantaneous damage available right now (1 use × full damage).
      burst += dmg * Math.min(uses === Infinity ? 1 : uses, 1);
    } else {
      const fireRate = w.fireRateRpm ?? 0;
      const shotsPerMin = fireRate;
      // Rough heavy throughput: only counts if AP ≥ 4. ~100 hits per heavy
      // is a generous floor; better defaults will come from real per-archetype
      // shots-to-kill once that's wired in.
      if (ap >= 4) antiHeavy += shotsPerMin / 100;
      crowd += shotsPerMin / 5;
      if (range >= 60) standoff += shotsPerMin;
    }
  }

  return { antiHeavy, crowd, standoff, burst };
}

/**
 * Capacity − demand on every axis. Negative ⇒ under-gunned on that axis.
 * Useful for "where does this build break?" displays.
 */
export function gapVector(demand, capacity) {
  return {
    antiHeavy: capacity.antiHeavy - demand.antiHeavy,
    crowd:     capacity.crowd     - demand.crowd,
    standoff:  capacity.standoff  - demand.standoff,
    burst:     capacity.burst     - demand.burst,
  };
}

function collectWeaponDefs(loadout, data) {
  const out = [];
  const lookup = (list, id) => (list ?? []).find((x) => x.id === id);
  if (loadout?.primary)   { const w = lookup(data?.weapons?.primaries,   loadout.primary);   if (w) out.push(w); }
  if (loadout?.secondary) { const w = lookup(data?.weapons?.secondaries, loadout.secondary); if (w) out.push(w); }
  if (loadout?.grenade)   { const w = lookup(data?.weapons?.grenades,    loadout.grenade);   if (w) out.push(w); }
  const strats = Array.isArray(data?.stratagems) ? data.stratagems : (data?.stratagems?.stratagems ?? []);
  for (const id of loadout?.stratagems ?? []) {
    if (!id) continue;
    const w = strats.find((s) => s.id === id);
    if (w) out.push(w);
  }
  return out;
}
