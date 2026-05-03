const KILLS_PER_SEC_WINDOW_MS = 5000;
const BREACH_DISTANCE_M = 2;
const ARC_AREA_BUCKETS = 12;

export function newScoreState() {
  return {
    advance: {
      kills: 0,
      killsByTier: { light: 0, medium: 0, heavy: 0, boss: 0 },
      totalSpawnedSoFar: 0,
      fractionCleared: 1,
      killsPerSec: 0,
      areaCleared01: 1,
    },
    survival: {
      closestEnemyM: Infinity,
      breachedAt: null,
      timeSurvivedMs: 0,
    },
    history: [],
    _killEvents: [],
  };
}

export function update(prev, state) {
  const next = {
    advance: { ...prev.advance, killsByTier: { ...(prev.advance.killsByTier ?? { light: 0, medium: 0, heavy: 0, boss: 0 }) } },
    survival: { ...prev.survival },
    history: prev.history,
    _killEvents: prev._killEvents,
  };

  let newDeaths = 0;
  let aliveEnemies = 0;
  let closestM = Infinity;
  const arcOccupied = new Array(ARC_AREA_BUCKETS).fill(false);

  for (const e of state.enemies.values()) {
    if (e.alive) {
      aliveEnemies++;
      const dx = e.position.x - state.player.x;
      const dy = e.position.y - state.player.y;
      const d = Math.hypot(dx, dy);
      if (d < closestM) closestM = d;
      const bucket = Math.min(ARC_AREA_BUCKETS - 1, Math.floor(d / (80 / ARC_AREA_BUCKETS)));
      arcOccupied[bucket] = true;
    } else if (!prev._killSeen?.has(e.id)) {
      newDeaths++;
      const tier = e.threatTier ?? "light";
      if (next.advance.killsByTier[tier] !== undefined) {
        next.advance.killsByTier[tier]++;
      }
    }
  }

  // Track which enemy ids have been counted as deaths (avoid double-counting if removed from map later).
  const killSeen = prev._killSeen ? new Set(prev._killSeen) : new Set();
  for (const e of state.enemies.values()) {
    if (!e.alive && !killSeen.has(e.id)) killSeen.add(e.id);
  }
  next._killSeen = killSeen;

  next.advance.kills = prev.advance.kills + newDeaths;
  if (state.scenario?.totalSpawns) {
    next.advance.totalSpawnedSoFar = state.scenario.totalSpawns;
  } else {
    next.advance.totalSpawnedSoFar = Math.max(
      prev.advance.totalSpawnedSoFar,
      killSeen.size + aliveEnemies,
    );
  }
  next.advance.fractionCleared = next.advance.totalSpawnedSoFar > 0
    ? next.advance.kills / next.advance.totalSpawnedSoFar
    : 1;

  for (let i = 0; i < newDeaths; i++) prev._killEvents.push(state.t);
  const cutoff = state.t - KILLS_PER_SEC_WINDOW_MS;
  while (prev._killEvents.length && prev._killEvents[0] < cutoff) prev._killEvents.shift();
  next._killEvents = prev._killEvents;
  next.advance.killsPerSec = prev._killEvents.length / (KILLS_PER_SEC_WINDOW_MS / 1000);

  const occupiedCount = arcOccupied.filter(Boolean).length;
  next.advance.areaCleared01 = 1 - occupiedCount / ARC_AREA_BUCKETS;

  next.survival.closestEnemyM = closestM;
  next.survival.timeSurvivedMs = state.t;
  if (next.survival.breachedAt === null && closestM <= BREACH_DISTANCE_M) {
    next.survival.breachedAt = state.t;
  }

  if (state.tickN % 5 === 0) {
    next.history = prev.history.concat([{
      t: state.t,
      advance: next.advance.fractionCleared,
      survival: closestM === Infinity ? 80 : closestM,
    }]);
  }

  return next;
}
