// =============================================================================
// FEATURE: support-weapon deployment + held-weapon state
// =============================================================================
//
// PROBLEM
//   The base sim treats every stratagem as a throw → call-in → instant AoE
//   damage event. That works for orbitals and eagles, but it's wrong for
//   support weapons (recoilless, autocannon, EAT, Spear, Quasar, MG/HMG,
//   stalwart, flamethrower, arc-thrower) — those are *held weapons* that
//   the diver fires repeatedly between stratagem cooldowns. Without this
//   module, calling in a recoilless just makes one rocket explode at the
//   beacon, then the weapon disappears for 480 seconds. Wrong.
//
// MODEL
//   When a stratagem with a `supportWeapon` data block lands, install a
//   held-weapon record into `state.weapons` keyed by the stratagem slot
//   ("strat-1" .. "strat-4"). The held weapon then participates in the
//   solver's per-tick assignment view as a direct-fire weapon — ammo
//   decrements, reload runs, fireRateRpm gates shots, just like a primary.
//
// SLOT NAMING
//   The deployed weapon's slot id is the stratagem slot ("strat-1"). This
//   is intentional — it makes the assignment heatmap's strat-N row light
//   up across the lifetime of the deployed weapon, which is what the user
//   actually wants to see. WEAPON_ROW_IDS in render-analytics.js already
//   includes the strat-* slots.
//
// COOLDOWN SEMANTICS
//   The stratagem's cooldown (480s for most support, 70s for EAT) is
//   independent of the weapon's per-shot reload. Cooldown gates how often
//   you can re-deploy (refresh backpack ammo). Reload gates how fast you
//   fire from the in-hand mag. Resupply (out of band) restocks the
//   backpack `ammoReserve`.
//
// COMPOSE
//   import { isDeployableSupport, deploySupportWeapon } from "./features/support-weapons.js";
//   // in engine.js stratagem call-in handler, branch on isDeployableSupport(weapon):
//   if (isDeployableSupport(weapon)) {
//     deploySupportWeapon(st, slot, weapon, def);
//     return;  // skip the AoE damage path
//   }
//
// HOW TO REMOVE
//   1. Delete this file.
//   2. Drop the import + call in engine.js. Support stratagems revert to
//      the one-shot AoE behavior (the bug we shipped this fix to address).
//   3. Optionally strip `supportWeapon` blocks from data/stratagems.json.
//
// SEE ALSO
//   notes/wta-hd2/2026_05_03_player_intent_and_build_archetypes.md
// =============================================================================

/**
 * True if this stratagem deploys a held weapon (vs. an orbital strike,
 * eagle drop, sentry, or backpack utility).
 *
 * Reads the def's `supportWeapon` block — opt-in via data, so existing
 * stratagems without the block continue to use the legacy AoE-on-land
 * path. Authoring guidance: see data/stratagems.json.
 */
export function isDeployableSupport(weaponOrDef) {
  if (!weaponOrDef) return false;
  // The view exposed to the engine carries `supportWeapon` from the def
  // through sim.js:initStratagems. Check both shapes.
  return !!(weaponOrDef.supportWeapon || weaponOrDef.def?.supportWeapon);
}

/**
 * Install a held-weapon record into `state.weapons` under the given slot.
 * Replaces any existing entry under that slot — re-throwing a recoilless
 * gives you a fresh weapon with full mag + backpack ammo.
 *
 * @param {object} state  — sim state, mutated
 * @param {string} slot   — "strat-1" .. "strat-4"
 * @param {object} sw     — stratagem def's `supportWeapon` block
 * @param {string} defId  — stratagem def id (for fxKindForWeapon, ui labels)
 */
export function deploySupportWeapon(state, slot, sw, defId) {
  if (!state || !slot || !sw) return;
  const mag = sw.magazine ?? 1;
  const reserve = sw.ammoReserve ?? 0;
  state.weapons.set(slot, {
    id: slot,
    slot,
    defId,
    isSupportWeapon: true,
    damage: sw.damage ?? 0,
    durableDamage: sw.durableDamage ?? sw.damage ?? 0,
    armorPen: sw.ap ?? sw.armorPen ?? 0,
    fireRateRpm: sw.fireRateRpm ?? 60,
    magazine: mag,
    ammoInMag: mag,
    ammoReserve: reserve,
    ammoReserveMax: reserve,
    reloadSecs: sw.reloadSecs ?? 3,
    reloadingUntil: null,
    lastFireT: -Infinity,
    aoeRadiusM: sw.aoeRadiusM ?? 0,
    weakPointHitRateBase: sw.weakPointHitRateBase ?? 0.4,
    maxRangeM: sw.maxRangeM ?? 80,
    dispersionRad: sw.dispersionRad,           // optional override
    preferredRangeM: sw.preferredRangeM,       // optional override (ammo-conservation)
    rootsOnReload: !!sw.rootsOnReload,
  });
}

// Resupply restocking: handled by the engine's existing
// triggerResupply loop, which iterates state.weapons and refills
// ammoReserve regardless of whether the entry is a primary or a
// deployed support weapon. No separate helper needed here.
