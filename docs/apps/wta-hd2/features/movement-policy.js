// =============================================================================
// FEATURE: movement policy (HOLD / KITE / PUSH)
// =============================================================================
//
// Per-tick mode classifier + position update for the diver. Reinterpreted
// per the 2026-05-03 player-intent clarification:
//
//   PUSH — free time. Arc is empty (no live threats). Advance toward the
//          next contact along facing.
//   HOLD — it's close, we're managing. At least one threat is alive but
//          our build's *sustained* DPS will kill it before it reaches us.
//          Default for one-man-army builds in a balanced engagement.
//   KITE — we can't keep up. After accounting for reload + cooldown
//          uptime, our sustained DPS-vs-incoming-pressure can't finish
//          the nearest threat before it makes contact. Back off to buy
//          distance/time. KITE is a *failure-leaning* signal — if a
//          golden run is KITE-dominant, the build is under-gunned.
//
// Crucial: KITE is NOT triggered by "this tick's weapon is reloading."
// Per the user, "you're not kiting — you're reloading." We measure
// sustained DPS that *includes* reload/cooldown overhead, not the
// instantaneous shots-this-tick number. A weapon mid-reload still
// contributes to sustained DPS on the next reload-cycle horizon, so
// the build doesn't kite while it's reloading; it kites when even the
// reload-amortized DPS can't keep up.
//
// COMPOSE
//   import { updateMovement } from "./features/movement-policy.js";
//   // each tick, after assignments resolve:
//   updateMovement(state, targets, cfg);
//
// HOW TO REMOVE
//   1. Delete this file.
//   2. In engine.js, drop the import + the per-tick call. The diver
//      becomes stationary again.
//   3. Snapshot fields `player.{vx, vy, mode}` continue to carry whatever
//      values the simpler logic sets (or remove from the snapshot shape).
//
// SEE ALSO
//   notes/wta-hd2/2026_05_03_player_intent_and_build_archetypes.md
// =============================================================================

const KITE_SPEED_MPS = 3.0;
const PUSH_SPEED_MPS = 1.5;
const SAFETY_MARGIN_SECS = 0.5;
const WORLD_BOUND = 50;

/**
 * Classify the current diver mode without mutating state. Pure: takes
 * snapshot-shaped inputs, returns a string.
 *
 * @param {object} args
 * @param {Array}  args.aliveThreats        — threats currently in arc/range
 * @param {Map}    args.enemies             — id → entity (for hp lookup)
 * @param {number} args.sustainedDpsByTarget(t) — fn returning DPS-vs-target
 * @param {object} args.player              — { x, y } position
 * @returns {"PUSH" | "HOLD" | "KITE"}
 */
export function classifyMode({ aliveThreats, enemies, sustainedDpsByTarget, player }) {
  if (aliveThreats.length === 0) return "PUSH";

  let anyUnsafe = false;
  for (const t of aliveThreats) {
    const dx = (t.position?.x ?? 0) - (player?.x ?? 0);
    const dy = (t.position?.y ?? 0) - (player?.y ?? 0);
    const d = Math.hypot(dx, dy);
    const speed = Math.hypot(t.velocity?.dx ?? 0, t.velocity?.dy ?? 0);
    const ttp = speed > 0.01 ? d / speed : Infinity;
    const dps = sustainedDpsByTarget(t) || 0;
    const ttkill = dps > 0 ? ((enemies.get(t.id)?.hp ?? 0) / dps) : Infinity;
    if (ttkill > ttp - SAFETY_MARGIN_SECS) { anyUnsafe = true; break; }
  }
  return anyUnsafe ? "KITE" : "HOLD";
}

/**
 * Per-weapon sustained-DPS estimator: damage-per-shot × shots/sec, where
 * shots/sec amortizes reload/cooldown. Ignores current `reloadingUntil` —
 * by design, a reloading weapon still contributes its long-run DPS.
 *
 * @param {object} weapon - sim weapon record (state.weapons.get) or stratagem
 * @param {number} damagePerShot
 * @returns {number} damage / second sustained
 */
export function sustainedWeaponDps(weapon, damagePerShot) {
  // Stratagem path: damage × uses / cooldown horizon.
  if (weapon?.cooldownSecsOwn != null || weapon?.cooldownUntil != null) {
    const cd = weapon?.cooldownSecsOwn ?? 60;
    const uses = weapon?.usesMax ?? weapon?.usesRemaining ?? 1;
    if (cd <= 0) return 0;
    return (damagePerShot * uses) / cd;
  }
  // Direct-fire: shots-per-second includes reload time over a full cycle.
  const fireRate = (weapon?.fireRateRpm ?? 0) / 60;
  if (fireRate <= 0) return 0;
  const mag = weapon?.magazine ?? weapon?.ammoInMag ?? 1;
  const reload = weapon?.reloadSecs ?? 0;
  const cycleSecs = (mag / fireRate) + reload;
  if (cycleSecs <= 0) return 0;
  return (damagePerShot * mag) / cycleSecs;
}

/**
 * Update `state.player` in place: classify mode, then move along facing
 * at the mode-appropriate speed.
 *
 * Three top-level cases, all in one place so the call site is a single call:
 *
 *   1. cfg.scenario.playerMovement !== true → diver is a stationary turret.
 *      Pin to mode=HOLD so the analytics chip / battlefield arrow read
 *      cleanly. This is the app's default — opt-in via the diver-movement
 *      toggle in the config UI.
 *   2. Some loadout weapon is mid-reload AND roots the diver during
 *      reload (RR/Spear/EAT/Quasar/AC/etc.) → mode=RELOAD, no movement.
 *      Caller passes `isRooted(weapon)` to identify those weapons.
 *   3. Otherwise → classifyMode + scalar movement along facing.
 *
 * @param {object} state — sim state (mutated: state.player)
 * @param {Array}  targets — visibleEnemyView output for this tick
 * @param {object} cfg — engine cfg (uses cfg.tickMs, cfg.scenario.playerMovement)
 * @param {(weapon, target, dist) => number} damagePerShotFn — solver-equivalent damage estimator
 * @param {(weapon) => boolean} [isRooted] — predicate: does this weapon root during reload?
 */
export function updateMovement(state, targets, cfg, damagePerShotFn, isRooted = () => false) {
  // Case 1: movement off → stationary turret.
  if (cfg?.scenario?.playerMovement !== true) {
    state.player = { ...state.player, vx: 0, vy: 0, mode: "HOLD" };
    return;
  }
  // Case 2: rooted by a heavy-weapon reload.
  for (const w of state.weapons.values()) {
    if (w.reloadingUntil != null && w.reloadingUntil > state.t && isRooted(w)) {
      state.player = { ...state.player, vx: 0, vy: 0, mode: "RELOAD" };
      return;
    }
  }
  const tickSecs = (cfg?.tickMs ?? 100) / 1000;
  const aliveThreats = targets.filter((t) => state.enemies.get(t.id)?.alive);

  // Sustained DPS-vs-target across the whole loadout (not just this tick's
  // assignments). Includes reload/cooldown amortization so reloading
  // weapons don't artificially inflate ttkill.
  const sustainedDpsByTarget = (target) => {
    let total = 0;
    for (const w of state.weapons.values()) {
      const dmg = damagePerShotFn(w, target, distanceFromPlayer(target, state.player));
      total += sustainedWeaponDps(w, dmg);
    }
    for (const s of state.stratagems.values()) {
      const dmg = damagePerShotFn(s, target, 0);
      total += sustainedWeaponDps(s, dmg);
    }
    return total;
  };

  const mode = classifyMode({
    aliveThreats,
    enemies: state.enemies,
    sustainedDpsByTarget,
    player: state.player,
  });

  let speed = 0;
  if (mode === "KITE") speed = -KITE_SPEED_MPS;
  else if (mode === "PUSH") speed = +PUSH_SPEED_MPS;
  const facing = state.player.facingRad ?? Math.PI / 2;
  const vx = Math.cos(facing) * speed;
  const vy = Math.sin(facing) * speed;
  const nx = clampWorld((state.player.x ?? 0) + vx * tickSecs);
  const ny = clampWorld((state.player.y ?? 0) + vy * tickSecs);
  state.player = { ...state.player, x: nx, y: ny, vx, vy, mode };
}

function clampWorld(v) {
  if (v < -WORLD_BOUND) return -WORLD_BOUND;
  if (v > WORLD_BOUND)  return WORLD_BOUND;
  return v;
}

function distanceFromPlayer(target, player) {
  const dx = (target.position?.x ?? 0) - (player?.x ?? 0);
  const dy = (target.position?.y ?? 0) - (player?.y ?? 0);
  return Math.hypot(dx, dy);
}
