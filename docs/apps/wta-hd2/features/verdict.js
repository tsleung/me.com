// =============================================================================
// FEATURE: encounter verdict
// =============================================================================
//
// Collapses a simulation run into a terminal outcome string. Lethality-focused
// per the 2026-05-03 player-intent note: the tool measures whether a build
// sustains a sustained engagement, not whether the diver completes objectives.
//
// Verdicts:
//
//   "in-progress" — the run hasn't satisfied any terminal condition yet.
//   "clear"       — no alive enemies AND no scheduled spawns within
//                   `clearHorizonMs`. The build won the engagement.
//   "wipe"        — the diver's hp hit zero. "Overwhelm" collapses into this:
//                   if you can't kill them faster than they kill you (even
//                   while kiting at max speed), you die. There is no
//                   intermediate "overwhelmed but alive" verdict.
//   "stalemate"   — the run hit `maxTicks` with neither side resolving
//                   (used by goldens / batch runs to bound a sweep).
//
// PURE function — no internal state, no side effects. Compose into the engine
// by calling once per tick (or once at end-of-run) and writing the result to
// `snapshot.verdict`.
//
// HOW TO REMOVE
//   1. Delete this file.
//   2. Drop the import + the call in engine.js.
//   3. Drop `verdict` from the snapshot shape (one line).
// Nothing else depends on it.
//
// SEE ALSO
//   notes/wta-hd2/2026_05_03_player_intent_and_build_archetypes.md
// =============================================================================

/**
 * @param {object} snapshot - engine snapshot (must have t, tickN, enemies, player)
 * @param {object} [params]
 * @param {number} [params.clearHorizonMs=5000] - "no incoming spawns within this window" before declaring clear
 * @param {number} [params.maxTicks=Infinity]   - tick budget; exceeded → stalemate
 * @returns {"in-progress" | "clear" | "wipe" | "stalemate"}
 */
export function classifyOutcome(snapshot, params = {}) {
  const clearHorizonMs = params.clearHorizonMs ?? 5000;
  const maxTicks = params.maxTicks ?? Infinity;

  // Wipe takes priority — a run that ended in death is never "clear" even
  // if the last tick happened to leave no enemies on the field.
  if (snapshot?.player?.hp != null && snapshot.player.hp <= 0) return "wipe";

  const aliveCount = (snapshot?.enemies ?? []).filter((e) => e.alive).length;
  const t = snapshot?.t ?? 0;
  const nextSpawn = snapshot?.nextSpawnT;
  const noIncoming = nextSpawn == null || (nextSpawn - t) > clearHorizonMs;
  if (aliveCount === 0 && noIncoming) return "clear";

  if ((snapshot?.tickN ?? 0) >= maxTicks) return "stalemate";

  return "in-progress";
}
