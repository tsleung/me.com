import { gaussian } from "./rng.js";

export function buildScenario(data, cfg, rng) {
  const multiplier = clamp(cfg.spawnRateMultiplier ?? 1.0, 0.25, 4.0);
  const encounter = pickEncounter(data, cfg);
  const scaled = applyMultiplier(encounter, multiplier);
  const archetypes = collectArchetypes(data, scaled);
  const spawnIntents = generateSpawnIntents(scaled, rng);
  const totalSpawns = spawnIntents.length;
  return { encounter: scaled, archetypes, spawnIntents, totalSpawns, spawnRateMultiplier: multiplier };
}

// Apply multiplier — scales count.mean linearly, scales spawnTimeSecs inversely
// (so a denser run also lasts proportionally less time, preserving "shape").
// Multiplier=1 is identity.
function applyMultiplier(encounter, multiplier) {
  if (multiplier === 1) return encounter;
  const composition = (encounter.composition ?? []).map((c) => ({
    ...c,
    count: c.count
      ? { ...c.count,
          mean: Math.max(0, c.count.mean * multiplier),
          ...(c.count.max != null ? { max: Math.max(1, Math.round(c.count.max * multiplier)) } : {}) }
      : c.count,
    spawnTimeSecs: (c.spawnTimeSecs ?? 0) / multiplier,
  }));
  return {
    ...encounter,
    composition,
    spreadSecs: encounter.spreadSecs != null ? encounter.spreadSecs / multiplier : undefined,
    maxConcurrent: encounter.maxConcurrent != null
      ? Math.max(1, Math.round(encounter.maxConcurrent * multiplier))
      : encounter.maxConcurrent,
  };
}

function pickEncounter(data, cfg) {
  const tables = data.spawnTables ?? [];
  const exact = tables.find(
    (e) =>
      e.faction === cfg.faction &&
      e.subfaction === cfg.subfaction &&
      e.type === cfg.encounter &&
      e.difficulty === cfg.difficulty,
  );
  if (exact) return exact;

  const sameType = tables.find(
    (e) =>
      e.faction === cfg.faction &&
      e.type === cfg.encounter &&
      e.difficulty === cfg.difficulty,
  );
  if (sameType) return { ...sameType, subfaction: cfg.subfaction };

  return synthesizeEncounter(data, cfg);
}

function synthesizeEncounter(data, cfg) {
  const enemies = (data.enemies ?? []).filter((e) => e.faction === cfg.faction);
  const diff = clamp(cfg.difficulty ?? 5, 1, 10);
  const baseSpawns = encounterShape(cfg.encounter ?? "patrol", diff);
  const composition = [];

  if (enemies.length === 0) {
    composition.push(stubComposition(cfg.faction, baseSpawns, diff));
  } else {
    const tierWeights = difficultyTierWeights(diff);
    for (const tier of ["light", "medium", "heavy", "boss"]) {
      const weight = tierWeights[tier];
      if (weight <= 0) continue;
      const pool = enemies.filter((e) => e.threatTier === tier);
      if (pool.length === 0) continue;
      const target = Math.round(baseSpawns.total * weight);
      if (target === 0) continue;
      const perEnemy = Math.max(1, Math.floor(target / pool.length));
      for (const ene of pool) {
        const idx = composition.length;
        composition.push({
          enemyId: ene.id,
          count: { dist: "fixed", mean: perEnemy },
          spawnTimeSecs: idx * baseSpawns.spreadSecs / Math.max(1, baseSpawns.totalEntries * 1.5),
          spawnArc: { minDeg: -50, maxDeg: 50, distanceM: 70 },
        });
      }
    }
  }

  return {
    faction: cfg.faction,
    subfaction: cfg.subfaction ?? "standard",
    type: cfg.encounter ?? "patrol",
    difficulty: diff,
    composition,
    maxConcurrent: encounterMaxConcurrent(cfg.encounter ?? "patrol", diff),
    _synthesized: true,
  };
}

function stubComposition(faction, baseSpawns, _diff) {
  const stubId = `${faction}-stub`;
  return {
    enemyId: stubId,
    count: { dist: "fixed", mean: baseSpawns.total },
    spawnTimeSecs: 0,
    spawnArc: { minDeg: -50, maxDeg: 50, distanceM: 70 },
  };
}

function encounterShape(type, diff) {
  const total = Math.round({
    patrol: 6 + diff * 2,
    breach: 12 + diff * 4,
    drop: 8 + diff * 3,
  }[type] ?? 10);
  const spreadSecs = {
    patrol: 30,   // slow trickle
    breach: 8,    // front-loaded surge
    drop: 14,     // staggered dropship arrival
  }[type] ?? 20;
  return { total, spreadSecs, totalEntries: 4 };
}

function encounterMaxConcurrent(type, diff) {
  return Math.round({
    patrol: 4 + diff,
    breach: 8 + diff * 2,
    drop: 6 + diff,
  }[type] ?? 8);
}

function difficultyTierWeights(diff) {
  // Light ↓ as diff ↑; heavy/boss ↑.
  const t = (diff - 1) / 9; // 0..1
  return {
    light:  Math.max(0.1, 0.7 - t * 0.5),
    medium: 0.25 + t * 0.15,
    heavy:  Math.max(0, t * 0.3),
    boss:   diff >= 7 ? 0.05 + (t - 0.66) * 0.1 : 0,
  };
}

function collectArchetypes(data, encounter) {
  const ids = new Set(encounter.composition.map((c) => c.enemyId));
  const out = [];
  for (const id of ids) {
    const ene = (data.enemies ?? []).find((e) => e.id === id);
    if (ene) out.push(ene);
    else out.push({ id, _stubArchetype: true, threatTier: "light" });
  }
  return out;
}

function generateSpawnIntents(encounter, rng) {
  const out = [];
  for (const c of encounter.composition) {
    const n = drawCount(c.count, rng);
    for (let i = 0; i < n; i++) {
      const tJitter = gaussian(rng, 0, 0.3);
      const angle = degToRad(
        c.spawnArc.minDeg + rng() * (c.spawnArc.maxDeg - c.spawnArc.minDeg),
      );
      const r = c.spawnArc.distanceM;
      const x = r * Math.cos(angle + Math.PI / 2);
      const y = r * Math.sin(angle + Math.PI / 2);
      const speed = 3 + rng() * 1.5;
      const norm = Math.hypot(x, y) || 1;
      out.push({
        t: Math.max(0, (c.spawnTimeSecs + tJitter)) * 1000,
        enemyId: c.enemyId,
        position: { x, y },
        vector: { dx: -x / norm * speed, dy: -y / norm * speed },
      });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function drawCount(count, rng) {
  if (!count) return 1;
  if (count.dist === "fixed") return Math.max(0, count.mean);
  if (count.dist === "poisson") {
    const L = Math.exp(-count.mean);
    let k = 0;
    let p = 1;
    while (true) {
      p *= rng();
      if (p < L) break;
      k++;
      if (k > 10000) break;
    }
    return count.max ? Math.min(k, count.max) : k;
  }
  return 1;
}

// Wiki-derived patrol cadence: ~90s between patrols at diff 1, ~30s at diff 10
// (notes/wta-hd2/2026_05_03_patrol_compositions_and_spawn_rates.md). Linear in
// difficulty. Used as the default for the infinite-wave loop.
export function defaultWaveCadenceSecs(diff) {
  const d = clamp(Number(diff) || 5, 1, 10);
  return Math.round(90 - (d - 1) * (60 / 9));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function degToRad(d) { return (d * Math.PI) / 180; }
