// =============================================================================
// FEATURE: distance-aware ammo conservation
// =============================================================================
//
// Discount the value of firing a scarce-ammo weapon on a *distant* target,
// so the WTA solver naturally defers the shot until the engagement is
// favorable. Captures the player intuition: "an autocannon on a hulk at 70m
// is fine; a recoilless on a hunter at 70m is just wasting a rocket — and
// even a recoilless on a charger at 70m is worth holding for a closer
// shot when something heavier might appear."
//
// COMPOSES WITH GAMMA, DOESN'T REPLACE IT
//   γ (efficiency, in wta-solver.js) is the "right-tool-for-target"
//   axis: don't shoot EAT at hunter regardless of distance.
//   This module is the "right-time" axis: even when the tool fits, prefer
//   a closer shot over a distant one, so we don't burn the cooldown.
//   Solver multiplies pair value by both factors → effects stack.
//
// PURE — no state, no side effects. Returns a multiplier in (0, 1].
//
// HOW TO REMOVE
//   1. Delete this file.
//   2. Drop the import + the multiplier in wta-solver.js:pairValue.
//   3. Drop `cfg.solver.ammoConservation` flag handling in engine + UI.
//
// SEE ALSO
//   notes/wta-hd2/2026_05_03_player_intent_and_build_archetypes.md
// =============================================================================

/**
 * Is this weapon "scarce ammo"?
 *
 * Two flavors qualify:
 *   1. Stratagem-class (cooldown gating). Once thrown, you wait the
 *      cooldown for the next use. Includes rocket support weapons that
 *      are stratagem-deployed in this sim (recoilless, EAT, AC, etc.).
 *   2. Direct-fire rocket weapons (small mag, long reload). Spear-class
 *      ammo where each shot matters even though it's not stratagem-gated.
 *
 * Cheap chaff weapons (Liberator, etc.) are NOT scarce — they have a
 * large reserve and quick reloads. We don't conserve their shots.
 */
export function isScarceAmmo(weapon) {
  if (!weapon) return false;
  if (weapon.isStratagem) return true;
  if (weapon.cooldownSecsOwn != null) return true; // stratagem state record
  if (weapon.callInSecs != null && weapon.callInSecs > 0) return true;
  const mag = weapon.magazine ?? weapon.ammoInMag ?? 0;
  const reload = weapon.reloadSecs ?? 0;
  // Small-mag, slow-reload direct-fire (Spear-shaped) — each shot is
  // basically as costly as a stratagem use.
  return mag > 0 && mag <= 5 && reload >= 3;
}

/**
 * The "preferred" engagement range for a weapon — the distance at or
 * inside which firing this round is full value. Outside this, value
 * decays toward `floor`.
 *
 * Default: half of `maxRangeM`. A weapon with 100m max effective range
 * has a 50m preferred sweet spot; firing at 80m takes a discount.
 *
 * Authors can override per-weapon via `weapon.preferredRangeM` (not
 * yet wired in data, but consumed if present).
 */
export function preferredRangeM(weapon) {
  if (typeof weapon?.preferredRangeM === "number") return weapon.preferredRangeM;
  const max = weapon?.maxRangeM ?? 60;
  return Math.max(10, max * 0.5);
}

/**
 * Multiplier on pair value: 1.0 inside preferred range, decays past it.
 * Bounded at `floor` so the solver still has a tiebreaker for "this
 * scarce weapon is the only thing that can hurt that distant boss" —
 * we'd rather fire at low value than not at all.
 *
 * @param {object} weapon - weapon view (sim.js) or weapon record (state.weapons)
 * @param {number} distanceM
 * @param {object} [opts]
 * @param {number} [opts.floor=0.1] - lower bound on the discount
 * @returns {number} multiplier in [floor, 1]
 */
export function ammoConservationFactor(weapon, distanceM, opts = {}) {
  if (!isScarceAmmo(weapon)) return 1.0;
  const preferred = preferredRangeM(weapon);
  if (preferred <= 0 || distanceM <= preferred) return 1.0;
  const floor = opts.floor ?? 0.1;
  const ratio = distanceM / preferred;
  // Quadratic decay past preferred — at 2× preferred range, value is
  // 1/4. At 3× preferred, value is 1/9 (clamped to floor).
  return Math.max(floor, 1 / (ratio * ratio));
}
