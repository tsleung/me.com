import { mulberry32, hashString } from "./rng.js";
import { newScoreState, update as updateScore } from "./scoring.js";

const DEFAULT_CFG = {
  tickMs: 100,
  arcRadians: (120 * Math.PI) / 180,
  maxRangeM: 80,
};

// Aggro radius: enemies within this distance of the diver retarget their
// velocity each tick toward the player. Outside this radius they keep their
// spawn vector — preserves "leaker" intents from scenario authors while
// stopping close-in enemies from straight-lining past a kiting diver.
const AGGRO_RANGE_M = 40;
// Melee contact radius. At this distance, enemies drain player.hp at meleeDps.
const MELEE_RANGE_M = 1.5;
// HD2 diver baseline (Helldiver Vitality booster off): 150 HP.
const PLAYER_HP_MAX = 150;

export function createInitialState(cfg, data) {
  const seed = cfg.seed ?? hashString(loadoutKey(cfg));
  const rng = mulberry32(seed);
  return {
    t: 0,
    tickN: 0,
    seed,
    rng,
    player: { x: 0, y: 0, hp: PLAYER_HP_MAX, hpMax: PLAYER_HP_MAX, facingRad: Math.PI / 2, vx: 0, vy: 0, mode: "HOLD" },
    enemies: new Map(),
    weapons: initWeapons(cfg.loadout, data),
    stratagems: initStratagems(cfg.loadout, data),
    projectiles: [],
    effects: [],
    scheduled: [],
    scenario: cfg.scenario ?? null,
    scores: newScoreState(),
    log: { entries: [], cap: 200 },
  };
}

export function tick(state, cfg = {}) {
  const c = { ...DEFAULT_CFG, ...cfg };
  const next = shallowClone(state);
  next.t = state.t + c.tickMs;
  next.tickN = state.tickN + 1;

  applyScheduled(next, c);
  spawnEnemies(next, c);
  moveEnemies(next, c);
  resolveMelee(next, c);
  advanceProjectiles(next, c);
  resolveImpacts(next, c);
  tickReloads(next, c);
  tickCooldowns(next, c);
  reapDead(next, c);

  next.scores = updateScore(state.scores, next);
  return next;
}

export function visibleWeaponView(state, cfg = {}) {
  const c = { ...DEFAULT_CFG, ...cfg };
  const out = [];
  for (const w of state.weapons.values()) {
    const shotsAvailableThisTick = computeShotsThisTick(w, c.tickMs, state.t);
    if (shotsAvailableThisTick <= 0) continue;
    out.push({
      id: w.id,
      slot: w.slot,
      damage: w.damage,
      durableDamage: w.durableDamage,
      armorPen: w.armorPen,
      shotsAvailableThisTick,
      aoeRadiusM: w.aoeRadiusM ?? 0,
      weakPointHitRateBase: w.weakPointHitRateBase ?? 0.3,
      maxRangeM: w.maxRangeM ?? c.maxRangeM,
      isStratagem: false,
    });
  }
  for (const s of state.stratagems.values()) {
    if (s.cooldownUntil > state.t) continue;
    if (s.usesRemaining !== null && s.usesRemaining <= 0) continue;
    out.push({
      id: s.id,
      slot: s.id,
      damage: s.damage ?? 0,
      durableDamage: s.durableDamage ?? 0,
      armorPen: s.armorPen ?? 0,
      shotsAvailableThisTick: 1,
      aoeRadiusM: s.aoeRadiusM ?? 0,
      weakPointHitRateBase: 0,
      maxRangeM: c.maxRangeM,
      isStratagem: true,
      stratagemType: s.type,
      callInSecs: s.callInSecs ?? 0,
      reserveCfg: s.reserveCfg,
    });
  }
  return out;
}

export function visibleEnemyView(state, cfg = {}) {
  const c = { ...DEFAULT_CFG, ...cfg };
  const out = [];
  const halfArc = c.arcRadians / 2;
  // Extended sight for predictive throws — long-call-in stratagems can engage
  // approaching enemies beyond conventional weapon range. Solver gates per-weapon.
  const extendedRange = (c.maxRangeM ?? 80) + 80;
  for (const e of state.enemies.values()) {
    if (!e.alive) continue;
    const dx = e.position.x - state.player.x;
    const dy = e.position.y - state.player.y;
    const d = Math.hypot(dx, dy);
    if (d > extendedRange) continue;
    // Arc check: anything within 5m always counts (atan2 is unstable near origin
    // and a stationary player should always engage close threats).
    if (d > 5) {
      const ang = Math.atan2(dy, dx);
      const facingDelta = Math.abs(normalizeAngle(ang - state.player.facingRad));
      if (facingDelta > halfArc) continue;
    }
    const ttp = e.velocity ? d / Math.max(0.01, Math.hypot(e.velocity.dx, e.velocity.dy)) : Infinity;
    out.push({
      id: e.id,
      archetypeId: e.archetypeId,
      threatTier: e.threatTier,
      hp: e.hp,
      parts: e.parts ?? [],
      position: { x: e.position.x, y: e.position.y },
      velocity: e.velocity ? { dx: e.velocity.dx, dy: e.velocity.dy } : { dx: 0, dy: 0 },
      distanceM: d,
      timeToReachPlayerSecs: ttp,
      meleeDps: e.meleeDps ?? 0,
      rangedDps: e.rangedDps ?? 0,
    });
  }
  return out;
}

export function effectView(state) {
  return state.effects.map((e) => ({
    kind: e.kind,
    position: { x: e.x, y: e.y },
    radiusM: e.radiusM,
    dpsAtTier: e.dpsAtTier ?? {},
  }));
}

// --- internals ---

function shallowClone(state) {
  return {
    ...state,
    enemies: new Map(state.enemies),
    weapons: new Map(state.weapons),
    stratagems: new Map(state.stratagems),
    projectiles: state.projectiles.slice(),
    effects: state.effects.slice(),
    scheduled: state.scheduled.slice(),
  };
}

function loadoutKey(cfg) {
  const l = cfg.loadout ?? {};
  const s = cfg.scenario ?? {};
  return [
    s.faction, s.subfaction, s.encounter, s.difficulty,
    ...(l.stratagems ?? []), l.primary, l.secondary, l.grenade, l.armor, l.booster,
  ].join("|");
}

function initWeapons(loadout = {}, data = {}) {
  const m = new Map();
  const weapons = data.weapons ?? { primaries: [], secondaries: [], grenades: [] };
  const find = (list, id) => (list ?? []).find((w) => w.id === id);
  const slots = [
    ["primary",   find(weapons.primaries,   loadout.primary)],
    ["secondary", find(weapons.secondaries, loadout.secondary)],
    ["grenade",   find(weapons.grenades,    loadout.grenade)],
  ];
  for (const [slot, def] of slots) {
    if (!def) continue;
    m.set(slot, {
      id: slot,
      slot,
      defId: def.id,
      damage: def.damage ?? 0,
      durableDamage: def.durableDamage ?? 0,
      armorPen: def.armorPen ?? def.ap ?? 0,
      fireRateRpm: def.fireRateRpm ?? 600,
      magazine: def.magazine ?? 30,
      reloadSecs: def.reloadSecs ?? 2,
      ammoReserve: def.ammoReserve ?? 0,
      // Captured at init so a resupply can restore the original full reserve
      // even after the weapon has burned through everything.
      ammoReserveMax: def.ammoReserve ?? 0,
      ammoInMag: def.magazine ?? 30,
      reloadingUntil: null,
      lastFireT: -Infinity,
      aoeRadiusM: def.aoeRadiusM ?? 0,
      weakPointHitRateBase: def.weakPointHitRateBase ?? 0.3,
      maxRangeM: def.maxRangeM ?? 80,
    });
  }
  return m;
}

function initStratagems(loadout = {}, data = {}) {
  const m = new Map();
  const all = Array.isArray(data.stratagems) ? data.stratagems : (data.stratagems?.stratagems ?? []);
  const ids = loadout.stratagems ?? [];
  for (let i = 0; i < ids.length; i++) {
    const def = all.find((s) => s.id === ids[i]);
    if (!def) continue;
    const slot = `strat-${i + 1}`;
    m.set(slot, instantiateStratagem(slot, def));
  }
  // Resupply is universally available in HD2 — every helldiver can call it
  // regardless of loadout. Inject it as an implicit slot under its own id so
  // the loadout panel surfaces the cooldown alongside the four chosen
  // stratagems and `maybeAutoCallResupply` always has something to find.
  // Skip if the loadout already contains it (don't double-render).
  if (!ids.includes("resupply")) {
    const resupplyDef = all.find((s) => s.id === "resupply");
    if (resupplyDef) m.set("resupply", instantiateStratagem("resupply", resupplyDef));
  }
  return m;
}

function instantiateStratagem(slot, def) {
  return {
    id: slot,
    defId: def.id,
    name: def.name ?? def.id,
    type: def.type,
    cooldownUntil: 0,
    // cooldownStartT lets the snapshot compute progress against the actual
    // cooldown duration instead of a hard-coded 60s denominator (which was
    // wrong for everything except 60s stratagems).
    cooldownStartT: 0,
    cooldownSecsOwn: def.cooldownSecs ?? 60,
    callInSecs: def.callInSecs ?? 0,
    usesRemaining: def.uses,
    // Captured at init so eagle rearm and resupply-style refills know what
    // "full" looks like.
    usesMax: def.uses,
    callInActive: null,
    damage: def.effects?.[0]?.damage ?? 0,
    armorPen: def.effects?.[0]?.ap ?? 0,
    aoeRadiusM: def.effects?.[0]?.aoeRadiusM ?? 0,
    effects: def.effects ?? [],
  };
}

function computeShotsThisTick(w, tickMs, _t) {
  if (w.reloadingUntil !== null && w.reloadingUntil > _t) return 0;
  if (w.ammoInMag <= 0) return 0;
  const perSec = w.fireRateRpm / 60;
  const max = Math.floor(perSec * (tickMs / 1000));
  return Math.max(1, Math.min(w.ammoInMag, max));
}

function applyScheduled(state, _cfg) {
  // Filter-rebuild dequeue — robust under mid-tick mutations from the engine
  // (stratagem landing events get pushed by applyAssignments after this runs;
  // wave-loop events get pushed by maybeQueueNextWave). Sort defensively in
  // case events were appended out of order. O(n) per tick is fine at our
  // scale (~100 events). The cursor optimization was bit-exact in isolation
  // but races with mid-tick sorts/inserts; we trade a tiny perf cost for
  // bulletproof behavior.
  state.scheduled.sort((a, b) => a.t - b.t);
  const remaining = [];
  for (const ev of state.scheduled) {
    if (ev.t <= state.t) {
      ev.fn?.(state);
    } else {
      remaining.push(ev);
    }
  }
  state.scheduled = remaining;
}

function spawnEnemies(state, _cfg) {
  // Placeholder until scenarios.js lands. Engine integration test will exercise this.
}

function moveEnemies(state, cfg) {
  const dt = cfg.tickMs / 1000;
  const px = state.player?.x ?? 0;
  const py = state.player?.y ?? 0;
  for (const e of state.enemies.values()) {
    if (!e.alive) continue;
    if (!e.velocity) continue;
    // Within aggro radius, retarget toward the player at the spawn-vector
    // magnitude so kiting actually shakes pursuers. Outside the radius keep
    // the spawn vector — long-range "leaker" intents survive.
    const dx = px - e.position.x;
    const dy = py - e.position.y;
    const d = Math.hypot(dx, dy);
    if (d > 0.01 && d <= AGGRO_RANGE_M) {
      const speed = Math.hypot(e.velocity.dx, e.velocity.dy);
      if (speed > 0.01) {
        e.velocity.dx = (dx / d) * speed;
        e.velocity.dy = (dy / d) * speed;
      }
    }
    e.position.x += e.velocity.dx * dt;
    e.position.y += e.velocity.dy * dt;
  }
}

// Closes the loop on PUSH/HOLD/KITE: any enemy whose body overlaps the
// diver drains player.hp at its meleeDps. Without this the mode chip is
// decorative — kiting has no analytical consequence.
function resolveMelee(state, cfg) {
  if (!state.player) return;
  const dt = cfg.tickMs / 1000;
  const px = state.player.x ?? 0;
  const py = state.player.y ?? 0;
  let drained = 0;
  for (const e of state.enemies.values()) {
    if (!e.alive) continue;
    if (!e.meleeDps) continue;
    const dx = e.position.x - px;
    const dy = e.position.y - py;
    if (Math.hypot(dx, dy) > MELEE_RANGE_M) continue;
    drained += e.meleeDps * dt;
  }
  if (drained > 0) {
    state.player.hp = Math.max(0, (state.player.hp ?? 0) - drained);
  }
}

function advanceProjectiles(state, cfg) {
  const dt = cfg.tickMs / 1000;
  const next = [];
  for (const p of state.projectiles) {
    p.x += (p.vx ?? 0) * dt;
    p.y += (p.vy ?? 0) * dt;
    if (p.expiresAt !== undefined && state.t >= p.expiresAt) continue;
    next.push(p);
  }
  state.projectiles = next;
}

function resolveImpacts(_state, _cfg) {
  // Solver assignments + impact resolution wired in engine.js after wta-solver locks.
}

function tickReloads(state, _cfg) {
  for (const w of state.weapons.values()) {
    if (w.reloadingUntil !== null && w.reloadingUntil <= state.t) {
      const refill = Math.min(w.magazine, w.ammoReserve + w.ammoInMag);
      const consumed = refill - w.ammoInMag;
      w.ammoInMag = refill;
      w.ammoReserve = Math.max(0, w.ammoReserve - consumed);
      w.reloadingUntil = null;
    }
  }
}

function tickCooldowns(_state, _cfg) {
  // Stratagem cooldowns advance with state.t passively (we compare s.cooldownUntil > state.t).
}

function reapDead(state, _cfg) {
  for (const [id, e] of state.enemies) {
    if (!e.alive) {
      // keep for one tick so scoring can detect transition; remove next tick
      if (e._reapAt === undefined) e._reapAt = state.t + 200;
      else if (state.t >= e._reapAt) state.enemies.delete(id);
    }
  }
}

function normalizeAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
