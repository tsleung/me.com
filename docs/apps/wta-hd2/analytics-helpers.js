// Pure helpers for render-analytics.js. No D3, no DOM, no controller.
// Every function is `function of inputs` — same args, same output. Safe to
// unit-test under node:test.
//
// PROXY NOTE — pKill aggregation:
//   The solver computes per-pair pKill internally but does NOT expose it on
//   the snapshot. Assignments only carry `{weaponId, targetId, shots}`. We
//   approximate the kill-credit weight per (weapon → enemy) as
//     shots(weapon, target) / Σ shots over all weapons targeting `target`.
//   This is a proportional credit proxy: if two weapons together commit
//   enough shots to kill an enemy, each is credited proportionally to its
//   own shot share. It is bounded in [0,1] per (weapon, enemy) pair and
//   sums to 1.0 across weapons for a given target. The heatmap then sums
//   that proxy across all enemies of an archetype, normalized 0..1 in the
//   render layer.
//
// LIMITATION — per-tier kills:
//   `scores.advance.kills` is a single counter; per-tier breakdown is not
//   tracked in scoring.js today. The wave-summary "killed" stack therefore
//   collapses to a single segment until scoring.js grows per-tier kill
//   buckets. See process.md (2026-05-03 render-analytics entry).

/**
 * Aggregate per-(weapon, archetype) pKill credit from last-tick assignments.
 * Returns Map<weaponId, Map<archetypeId, totalCredit>>.
 *
 * @param {Array<{weaponId:string, targetId:string, shots:number}>} assignments
 * @param {Array<{id:string, archetypeId:string, alive?:boolean}>} enemies
 * @returns {Map<string, Map<string, number>>}
 */
export function aggregatePKillByArchetype(assignments, enemies) {
  const enemyById = new Map();
  for (const e of enemies) enemyById.set(e.id, e);

  // Σ shots per target across all weapons (denominator for proxy).
  const shotsPerTarget = new Map();
  for (const a of assignments) {
    shotsPerTarget.set(a.targetId, (shotsPerTarget.get(a.targetId) || 0) + a.shots);
  }

  /** @type {Map<string, Map<string, number>>} */
  const out = new Map();
  for (const a of assignments) {
    const enemy = enemyById.get(a.targetId);
    if (!enemy || !enemy.archetypeId) continue; // target reaped or has no archetype; skip credit.
    const denom = Math.max(1, shotsPerTarget.get(a.targetId) || 0);
    const credit = a.shots / denom;
    let row = out.get(a.weaponId);
    if (!row) {
      row = new Map();
      out.set(a.weaponId, row);
    }
    row.set(enemy.archetypeId, (row.get(enemy.archetypeId) || 0) + credit);
  }
  return out;
}

/**
 * Fold this tick's per-(weapon, archetype) credits into a running cumulative
 * map. `requirements.md` calls for "sum pKill on that pair" — i.e. summed
 * over the whole run, not just the last tick. `state.lastTickN` flips the
 * cumulative back to empty when the run restarts (tickN drops).
 *
 * Mutates `state` in place and returns it. Pure with respect to inputs.
 *
 * @param {{cum:Map<string,Map<string,number>>, lastTickN:number}} state
 * @param {{tickN:number, assignments:any[], enemies:any[]}} snapshot
 */
export function foldHeatmapCredits(state, snapshot) {
  if (!state.cum) state.cum = new Map();
  const tickN = snapshot?.tickN ?? 0;
  if (tickN <= (state.lastTickN ?? -1)) state.cum.clear();
  state.lastTickN = tickN;
  const tick = aggregatePKillByArchetype(
    snapshot?.assignments ?? [],
    snapshot?.enemies ?? [],
  );
  for (const [wid, row] of tick) {
    let cumRow = state.cum.get(wid);
    if (!cumRow) { cumRow = new Map(); state.cum.set(wid, cumRow); }
    for (const [aid, v] of row) cumRow.set(aid, (cumRow.get(aid) || 0) + v);
  }
  return state;
}

/**
 * Strip the faction-prefix segment of an archetype id ("terminid-warrior" →
 * "warrior") and truncate to fit a column header. Without this, every column
 * label collapses to "terminid-…".
 *
 * @param {string} id
 */
export function shortArchLabel(id) {
  if (typeof id !== "string" || id.length === 0) return "";
  const i = id.indexOf("-");
  const s = i >= 0 ? id.slice(i + 1) : id;
  return s.length > 10 ? s.slice(0, 9) + "…" : s;
}

/**
 * Map<archetypeId, archetypeObject> from a scenario.
 * @param {{archetypes?: Array<{id:string}>}} scenario
 */
export function archetypesById(scenario) {
  const m = new Map();
  if (!scenario || !Array.isArray(scenario.archetypes)) return m;
  for (const a of scenario.archetypes) {
    if (a && a.id) m.set(a.id, a);
  }
  return m;
}

/**
 * Counts of alive enemies bucketed by threatTier.
 * @param {Array<{alive:boolean, threatTier:string}>} enemies
 */
export function aliveCountsByTier(enemies) {
  const counts = { light: 0, medium: 0, heavy: 0, boss: 0 };
  if (!Array.isArray(enemies)) return counts;
  for (const e of enemies) {
    if (!e || !e.alive) continue;
    if (counts[e.threatTier] !== undefined) counts[e.threatTier]++;
  }
  return counts;
}

/**
 * Bounds for the score-over-time chart axes.
 * @param {Array<{t:number, advance:{fractionCleared:number}, survival:{closestEnemyM:number}}>} history
 */
export function historyAxisBounds(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      tMin: 0, tMax: 1,
      advanceMin: 0, advanceMax: 1,
      // Survival y is INVERTED in the renderer; the helper returns raw
      // bounds and lets the renderer do the inversion via scale range.
      survivalMin: 0, survivalMax: 80,
    };
  }
  let tMin = Infinity, tMax = -Infinity;
  let advMin = Infinity, advMax = -Infinity;
  let survMin = Infinity, survMax = -Infinity;
  for (const h of history) {
    if (!Number.isFinite(h?.t)) continue;
    if (h.t < tMin) tMin = h.t;
    if (h.t > tMax) tMax = h.t;
    // history entries store advance + survival as plain numbers (per scoring.js).
    const adv = Number.isFinite(h.advance) ? h.advance : 0;
    if (adv < advMin) advMin = adv;
    if (adv > advMax) advMax = adv;
    const survCapped = Number.isFinite(h.survival) ? h.survival : 80;
    if (survCapped < survMin) survMin = survCapped;
    if (survCapped > survMax) survMax = survCapped;
  }
  if (!Number.isFinite(tMin)) { tMin = 0; tMax = 1; }
  // Pin advance to [0,1] for legibility; pin survival to [0,80].
  return {
    tMin,
    tMax: tMax === tMin ? tMin + 1 : tMax,
    advanceMin: 0,
    advanceMax: 1,
    survivalMin: 0,
    survivalMax: 80,
  };
}

/**
 * Format sim ms as "12.3s".
 */
export function fmtSeconds(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "0.0s";
  return (ms / 1000).toFixed(1) + "s";
}

/**
 * Stroke-dasharray + dashoffset values for a cooldown ring.
 * Returns the dash pair "<filled> <gap>" plus the circumference.
 * `pct` is fraction REMAINING (1 = full cooldown bar shown).
 *
 * @param {number} pct  0..1 — fraction of the ring to render filled
 * @param {number} radius
 */
export function cooldownDashArray(pct, radius) {
  const r = Math.max(0, radius);
  const C = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
  const filled = C * clamped;
  const gap = Math.max(0, C - filled);
  return { dashArray: `${filled} ${gap}`, circumference: C, filled, gap };
}
