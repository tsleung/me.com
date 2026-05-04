// =============================================================================
// FEATURE: heat / heat-sink management
// =============================================================================
//
// PROBLEM
//   Sickle, Scythe, Las Cannon, and similar laser weapons aren't ammo-driven
//   — they're heat-driven. Today the sim approximates Sickle as a 999-round
//   mag with a 3s "reload" and 6 reserves; that lets it fire 999 rounds at
//   sustained RPM with no overheat penalty, then swap a sink. Real HD2: the
//   Sickle overheats after ~50 rounds of sustained fire and forces a sink
//   swap (or a forced cooldown for Scythe / Las Cannon, which don't carry
//   sinks).
//
// MODEL
//   Each heat-bearing weapon tracks a `heatLevel` in [0, 1]. Each shot adds
//   `heatPerShot`. Each tick, heat passively decays at `coolingRatePerSec`.
//   When `heatLevel >= 1`:
//     - If `sinksRemaining > 0`: trigger a sink swap → `reloadingUntil = t +
//       sinkSwapSecs * 1000`, `heatLevel = 0`, `sinksRemaining -= 1`. The
//       existing reload UI shows the swap as a reload (correct for the
//       Sickle / sink-bearing class).
//     - If `sinksRemaining === 0` (bone-dry, or no sinks like Scythe):
//       force a passive cooldown — `reloadingUntil = t + capCooldownSecs`.
//
//   Cooling is ALWAYS active (even during fire). For a sustained-fire
//   weapon that's tuned correctly, the per-shot gain exceeds the cooling
//   rate, so heat still builds up. When fire stops, heat decays.
//
// COMPOSE
//   import { addHeatForShots, tickHeat, isHeatLocked, refillSinks } from
//     "./features/heat-mgmt.js";
//
//   sim.js:initWeapons       — copy def.heat block onto the weapon record
//   sim.js:computeShotsThisTick — gate firing when isHeatLocked
//   sim.js:tick              — call tickHeat(state) once per tick
//   engine.js:applyAssignments  — addHeatForShots(w, shots) + maybe-trip
//   engine.js:triggerResupply   — call refillSinks(state) inside the
//                                 resupply landing handler
//
// HOW TO REMOVE
//   1. Delete this file.
//   2. Drop the imports + 4 call sites in sim.js + engine.js.
//   3. Strip `heat` blocks from data/weapons.json. Without the gate,
//      heat-bearing weapons revert to mag/reserve approximations.
//
// SEE ALSO
//   notes/wta-hd2/2026_05_03_player_intent_and_build_archetypes.md
// =============================================================================

/**
 * True if the weapon has a heat block configured. Used to short-circuit
 * the model for non-heat weapons (the vast majority).
 */
export function hasHeat(weapon) {
  return weapon != null && weapon.heat != null;
}

/**
 * Initial heat-state fields to attach to a weapon record at init. Keeps
 * `def.heat` (block from data) attached so other code can read parameters
 * without a separate lookup.
 *
 * @param {object} def - data def with optional `heat` block
 */
export function initHeatState(def) {
  if (!def?.heat) return null;
  const sinks = def.heat.sinkCount ?? 0;
  return {
    heat: { ...def.heat },              // params (perShot, coolingRatePerSec, etc.)
    heatLevel: 0,                       // [0, 1]
    sinksRemaining: sinks,
    sinksMax: sinks,
  };
}

/**
 * Increment heat for `shots` rounds fired this tick. Saturates at 1.0.
 * Caller should follow up with maybeTripSink to start a swap if the
 * weapon just hit cap.
 */
export function addHeatForShots(weapon, shots) {
  if (!hasHeat(weapon)) return;
  const perShot = weapon.heat.perShot ?? 0;
  weapon.heatLevel = Math.min(1, (weapon.heatLevel ?? 0) + perShot * (shots ?? 0));
}

/**
 * Per-tick passive cooling. Always active — sustained-fire weapons are
 * tuned so heat-gain > cooling-rate during fire, but heat decays once
 * fire stops. Pure-ish (mutates weapon.heatLevel).
 */
export function tickHeat(weapon, deltaSecs) {
  if (!hasHeat(weapon)) return;
  if ((weapon.heatLevel ?? 0) <= 0) return;
  const cool = weapon.heat.coolingRatePerSec ?? 0;
  if (cool <= 0) return;
  weapon.heatLevel = Math.max(0, weapon.heatLevel - cool * (deltaSecs ?? 0));
}

/**
 * If the weapon just hit heat cap, start a sink swap (or a forced passive
 * cooldown if no sinks). Updates `reloadingUntil` so the existing reload
 * UI renders the swap correctly. Idempotent — safe to call every tick.
 *
 * @param {object} weapon
 * @param {number} t - current sim time (ms)
 */
export function maybeTripSink(weapon, t) {
  if (!hasHeat(weapon)) return;
  if ((weapon.heatLevel ?? 0) < 1) return;
  // Already mid-swap? leave it.
  if (weapon.reloadingUntil != null && weapon.reloadingUntil > t) return;

  const sinkSwapSecs = weapon.heat.sinkSwapSecs ?? 2.5;
  const capCooldownSecs = weapon.heat.capCooldownSecs ?? 4;
  if ((weapon.sinksRemaining ?? 0) > 0) {
    weapon.reloadingUntil = t + sinkSwapSecs * 1000;
    weapon.sinksRemaining = Math.max(0, weapon.sinksRemaining - 1);
    weapon.heatLevel = 0;
  } else {
    // No sinks — force a passive cooldown (Scythe / Las Cannon shape).
    weapon.reloadingUntil = t + capCooldownSecs * 1000;
    weapon.heatLevel = 0;
  }
}

/**
 * Caller-facing gate predicate. The weapon's `computeShotsThisTick`
 * already checks reloadingUntil, so this is just the "heat already at
 * cap before any swap triggers" early-out — useful when callers don't
 * want to call maybeTripSink themselves.
 */
export function isHeatLocked(weapon, t) {
  if (!hasHeat(weapon)) return false;
  if (weapon.reloadingUntil != null && weapon.reloadingUntil > t) return true;
  return (weapon.heatLevel ?? 0) >= 1;
}

/**
 * Resupply restocks heat sinks too. Iterate state.weapons and refill any
 * heat-bearing weapon's sinks to its captured `sinksMax`.
 *
 * @returns number of weapons restocked
 */
export function refillSinks(state) {
  if (!state?.weapons) return 0;
  let n = 0;
  for (const w of state.weapons.values()) {
    if (!hasHeat(w)) continue;
    if ((w.sinksRemaining ?? 0) < (w.sinksMax ?? 0)) {
      w.sinksRemaining = w.sinksMax ?? 0;
      n++;
    }
  }
  return n;
}
