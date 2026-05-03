import {
  createInitialState,
  tick as simTick,
  visibleWeaponView,
  visibleEnemyView,
  effectView,
} from "./sim.js";
import { assign as solverAssign } from "./wta-solver.js";
import { buildScenario, defaultWaveCadenceSecs } from "./scenarios.js";
import { mulberry32, hashString } from "./rng.js";

const DEFAULT_CFG = {
  tickMs: 100,
  arcRadians: (120 * Math.PI) / 180,
  maxRangeM: 80,
  // Eagle rearm: when every eagle stratagem in the loadout has spent its last
  // charge, the eagle flies home and rearms. After this many seconds, all
  // eagles refill to their max uses. HD2 baseline ~120s (without ship modules).
  eagleRearmSecs: 120,
};

export function createEngine(cfg, data) {
  const c = mergeCfg(cfg);
  const seed = c.seed ?? hashString(loadoutKey(c));
  const rng = mulberry32(seed);
  const scenario = buildScenario(data, c.scenario, rng);

  const cfgWithScenario = { ...c, seed };
  const init = createInitialState(cfgWithScenario, data);
  init.scenario = scenario;
  init.rng = rng;
  hydrateSpawnSchedule(init, scenario);
  init._lastAssignments = [];

  const tick = (state) => {
    const next = simTick(state, c);
    if (!next._fxFlashes) next._fxFlashes = [];
    tickEagleRearm(next, c);
    tickEffects(next, c);
    if (c.scenario?.infiniteWaves !== false) {
      const cadenceSecs = resolveWaveCadence(c.scenario);
      maybeQueueNextWave(next, scenario, cadenceSecs);
    }
    const weapons = visibleWeaponView(next, c);
    const targets = visibleEnemyView(next, c);
    const effects = effectView(next);
    const assignments = solverAssign({
      weapons,
      targets,
      effects,
      alpha: c.solver?.alpha ?? 0.5,
      gamma: c.solver?.gamma ?? 0.3,
      reserves: c.solver?.reserves ?? {},
      rng: next.rng,
      tickMs: c.tickMs,
    });
    applyAssignments(next, assignments, c);
    // Resupply has no damage, so the WTA solver will never pick it. Trigger it
    // out-of-band when any weapon is bone-dry and resupply is off cooldown.
    maybeAutoCallResupply(next, c);
    next._lastAssignments = assignments;
    updatePlayerMovement(next, targets, assignments, c);
    return next;
  };

  const view = (state) => snapshot(state, data, c);

  return { initialState: init, tick, view };
}

function mergeCfg(cfg) {
  return {
    ...DEFAULT_CFG,
    ...cfg,
    solver: { alpha: 0.5, reserves: {}, ...(cfg.solver ?? {}) },
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

function hydrateSpawnSchedule(state, scenario) {
  let id = 0;
  for (const intent of scenario.spawnIntents) {
    state.scheduled.push({
      t: intent.t,
      fn: (st) => {
        const archetype = scenario.archetypes.find((a) => a.id === intent.enemyId);
        const enemyId = `e${++id}-${intent.enemyId}`;
        st.enemies.set(enemyId, {
          id: enemyId,
          archetypeId: intent.enemyId,
          threatTier: archetype?.threatTier ?? "light",
          hp: archetype?.hp ?? 100,
          parts: archetype?.parts ?? [],
          position: { x: intent.position.x, y: intent.position.y },
          velocity: { dx: intent.vector.dx, dy: intent.vector.dy },
          alive: true,
          meleeDps: archetype?.meleeDps ?? 10,
          rangedDps: archetype?.rangedDps ?? 0,
        });
      },
    });
  }
}

function applyAssignments(state, assignments, cfg) {
  state._fxFlashes = [];
  for (const a of assignments) {
    const target = state.enemies.get(a.targetId);
    if (!target || !target.alive) continue;
    const weapon = state.weapons.get(a.weaponId) ?? state.stratagems.get(a.weaponId);
    if (!weapon) continue;

    if (state.weapons.has(a.weaponId)) {
      // Direct-fire weapon: damage applies immediately.
      const dmgPerShot = computeDamage(weapon, target);
      const totalDmg = dmgPerShot * a.shots;
      target.hp = Math.max(0, target.hp - totalDmg);
      const died = target.hp <= 0;
      if (died) target.alive = false;
      state._fxFlashes.push({
        kind: fxKindForWeapon(weapon, state),
        x: target.position.x, y: target.position.y,
        r: weapon.aoeRadiusM ?? (died ? 3 : 1.5),
        bornT: state.t, durMs: died ? 700 : 350, isKill: died,
      });
      weapon.ammoInMag = Math.max(0, weapon.ammoInMag - a.shots);
      weapon.lastFireT = state.t;
      if (weapon.ammoInMag === 0 && weapon.ammoReserve > 0) {
        weapon.reloadingUntil = state.t + (weapon.reloadSecs ?? 2) * 1000;
      }
    } else if (state.stratagems.has(a.weaponId)) {
      // Stratagem: throw + call-in. Damage deferred until landing.
      const def = state.stratagems.get(a.weaponId);
      const callInSecs = Math.max(0, weapon.callInSecs ?? 0);
      // Project where the target will be at landing — same model as the solver.
      const dx = (target.velocity?.dx ?? 0) * callInSecs;
      const dy = (target.velocity?.dy ?? 0) * callInSecs;
      const beaconX = target.position.x + dx;
      const beaconY = target.position.y + dy;
      const resolveAt = state.t + callInSecs * 1000;
      const fxKind = fxKindForWeapon(weapon, state);
      const aoeR = weapon.aoeRadiusM ?? 5;

      // Cooldown + uses tick down at throw time.
      const cdSecs = def.cooldownSecsOwn ?? cfg.stratagemCooldownsSecs ?? 60;
      def.cooldownStartT = state.t;
      def.cooldownUntil = state.t + cdSecs * 1000;
      if (def.usesRemaining !== null) def.usesRemaining = Math.max(0, def.usesRemaining - 1);
      def.callInActive = { resolveAt, beaconXY: { x: beaconX, y: beaconY }, weaponId: a.weaponId };

      // Throw arc fx — visible immediately, fades over call-in window.
      state._fxFlashes.push({
        kind: "throw",
        x: beaconX, y: beaconY,
        r: aoeR,
        bornT: state.t,
        durMs: callInSecs * 1000,
        weaponId: a.weaponId,
        weaponSlot: a.weaponId,
        playerX: state.player.x, playerY: state.player.y,
        resolveAt,
      });

      // Beacon effect rendered each frame until resolution — the target marker.
      state.effects.push({
        kind: "callin",
        x: beaconX, y: beaconY,
        radiusM: aoeR,
        resolveAt,
        weaponId: a.weaponId,
        fxKind,
        bornT: state.t,
        playerX: state.player.x, playerY: state.player.y,
      });

      // Schedule the actual landing event at resolveAt. What it installs depends
      // on the stratagem type: sentries become persistent actors; support pickups
      // (EAT) drop a visible 2-rocket pile next to the player; eagles/orbitals/dot
      // weapons apply their effect (instant AoE or persistent dot cloud).
      const stratType = weapon.stratagemType ?? "support";
      const defId = weapon.defId ?? "";
      const isSentry = stratType === "sentry";
      const isPickup = stratType === "support" && (defId === "eat" || /eat|launcher/.test(defId));
      // Persistent damage cloud — gas/fire(napalm/incendiary/flame)/laser pools
      // linger on the field. Without this, napalm and flamethrower call-ins
      // would just flash once and leave nothing visible.
      const dotDuration = (weapon.aoeRadiusM ?? 0) > 0 && /gas|fire|laser/.test(fxKind) ? 8 : 0;

      // Beacon lingers 1200ms past resolveAt so the user sees the impact
      // moment, not just the instant-disappear at landing time. Mark the
      // beacon as `landedAt` here; the renderer can fade it. A separate
      // event 1200ms later actually removes it.
      const beaconLingerMs = 1200;
      state.scheduled.push({
        t: resolveAt + beaconLingerMs,
        fn: (st) => {
          st.effects = st.effects.filter((e) => !(e.kind === "callin" && e.resolveAt === resolveAt && e.weaponId === a.weaponId));
        },
      });

      state.scheduled.push({
        t: resolveAt,
        fn: (st) => {
          // Mark beacon as landed for visual fade; removal happens after lingerMs.
          for (const e of st.effects) {
            if (e.kind === "callin" && e.resolveAt === resolveAt && e.weaponId === a.weaponId) {
              e.landedAt = st.t;
            }
          }
          if (!st._fxFlashes) st._fxFlashes = [];

          if (isSentry) {
            // Install persistent sentry actor — fires at nearest enemy each tick.
            st.effects.push({
              kind: "sentry",
              defId: weapon.defId,
              x: beaconX, y: beaconY,
              radiusM: 1.5,
              bornT: st.t,
              until: st.t + 120 * 1000, // 120s lifetime
              weaponDef: { damage: weapon.damage ?? 80, armorPen: weapon.armorPen ?? 3, weakPointHitRateBase: 0.4, aoeRadiusM: 0 },
              fireRateRpm: 600,
              lastShotT: 0,
              maxRangeM: 60,
            });
            st._fxFlashes.push({ kind: "spark", x: beaconX, y: beaconY, r: 4, bornT: st.t, durMs: 500, isKill: false });
            return;
          }
          if (isPickup) {
            // EAT pickup — 2 rockets dropped next to player. Visible until used.
            const px = (st.player?.x ?? 0) + 2;
            const py = (st.player?.y ?? 0) + 2;
            st.effects.push({
              kind: "pickup",
              x: px, y: py, radiusM: 1,
              bornT: st.t,
              until: st.t + 30 * 1000,
              usesLeft: 2,
              weaponName: defId,
            });
            // Single immediate AoE on landing simulates the first rocket fired
            // at the projected target; the second sits in the pickup until reused.
            const r2 = aoeR * aoeR;
            for (const e of st.enemies.values()) {
              if (!e.alive) continue;
              const ex = e.position.x - beaconX;
              const ey = e.position.y - beaconY;
              if (ex * ex + ey * ey > r2) continue;
              const dmg = computeDamage(weapon, e);
              e.hp = Math.max(0, e.hp - dmg);
              if (e.hp <= 0) e.alive = false;
            }
            st._fxFlashes.push({ kind: fxKind, x: beaconX, y: beaconY, r: aoeR, bornT: st.t, durMs: 700, isKill: true });
            return;
          }
          if (dotDuration > 0) {
            // Persistent damage cloud (gas / napalm).
            st.effects.push({
              kind: "dot", subKind: fxKind,
              x: beaconX, y: beaconY,
              radiusM: aoeR,
              bornT: st.t,
              until: st.t + dotDuration * 1000,
              damagePerTick: (weapon.damage ?? 50) / 4,
              armorPen: weapon.armorPen ?? 2,
              tickIntervalMs: 250,
              lastTickT: 0,
            });
          }
          // Instant AoE damage (eagles, orbital strikes).
          const r2 = aoeR * aoeR;
          for (const e of st.enemies.values()) {
            if (!e.alive) continue;
            const ex = e.position.x - beaconX;
            const ey = e.position.y - beaconY;
            if (ex * ex + ey * ey > r2) continue;
            const dmg = computeDamage(weapon, e);
            e.hp = Math.max(0, e.hp - dmg);
            if (e.hp <= 0) e.alive = false;
          }
          st._fxFlashes.push({ kind: fxKind, x: beaconX, y: beaconY, r: aoeR, bornT: st.t, durMs: 800, isKill: true });
        },
      });
      // applyScheduled (next tick) re-sorts defensively + filter-rebuilds, so
      // no cursor maintenance needed here.
    }
  }
}

function fxKindForWeapon(weapon, _state) {
  const id = weapon.defId || "";
  if (weapon.type === "eagle") {
    if (id.includes("napalm") || id.includes("incendiary") || id.includes("flame")) return "fire";
    return "explosion";
  }
  if (weapon.type === "orbital") {
    if (id.includes("gas")) return "gas";
    if (id.includes("laser")) return "laser";
    if (id.includes("napalm") || id.includes("incendiary") || id.includes("flame")) return "fire";
    return "explosion";
  }
  if (weapon.type === "support" || weapon.isStratagem) {
    if (id.includes("arc")) return "electric";
    if (id.includes("flame") || id.includes("napalm") || id.includes("incendiary")) return "fire";
    if (id.includes("laser") || id.includes("quasar")) return "laser";
    return "explosion";
  }
  // Primary/secondary/grenade
  const aoe = weapon.aoeRadiusM ?? 0;
  if (aoe >= 5) return "explosion";
  if (aoe >= 2) return "spark";
  return "muzzle";
}

function computeDamage(weapon, target) {
  const ap = weapon.armorPen ?? 0;
  const part = bestPart(target.parts ?? [], ap);
  const ac = part?.ac ?? 0;
  const armorMult = ap >= ac + 1 ? 1.0 : ap === ac ? 0.5 : 0.1;
  const wMult = part?.isWeakPoint ? part.weakPointMultiplier ?? 1 : 1;
  return (weapon.damage ?? 0) * armorMult * wMult;
}

function bestPart(parts, ap) {
  if (!parts || parts.length === 0) return null;
  let best = null;
  let bestScore = -1;
  for (const p of parts) {
    const accessible = ap >= (p.ac ?? 0);
    const score = (accessible ? 100 : 0) + (p.isWeakPoint ? p.weakPointMultiplier ?? 1 : 0.5);
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

function snapshot(state, data, cfg) {
  return {
    t: state.t,
    tickN: state.tickN,
    player: {
      x: state.player.x, y: state.player.y, facingRad: state.player.facingRad,
      vx: state.player.vx ?? 0, vy: state.player.vy ?? 0,
      mode: state.player.mode ?? "HOLD",
    },
    enemies: [...state.enemies.values()].map((e) => ({
      id: e.id,
      archetypeId: e.archetypeId,
      threatTier: e.threatTier,
      x: e.position.x,
      y: e.position.y,
      hp: e.hp,
      hpMax: archetypeHp(state.scenario, e.archetypeId),
      alive: e.alive,
    })),
    projectiles: state.projectiles.slice(),
    effects: state.effects.slice(),
    weapons: [...state.weapons.values()].map((w) => ({
      id: w.id, defId: w.defId,
      ammoInMag: w.ammoInMag, magCap: w.magazine,
      ammoReserve: w.ammoReserve,
      reloadingPct: w.reloadingUntil
        ? Math.max(0, 1 - (w.reloadingUntil - state.t) / (w.reloadSecs * 1000))
        : 1,
    })),
    stratagems: [...state.stratagems.values()].map((s) => {
      const cdSpan = Math.max(1, (s.cooldownUntil ?? 0) - (s.cooldownStartT ?? 0));
      const cdPct = s.cooldownUntil > state.t
        ? Math.max(0, Math.min(1, (state.t - (s.cooldownStartT ?? 0)) / cdSpan))
        : 1;
      // Eagles share a single rearm timer once the loadout is fully spent.
      // Surface it as a 0..1 fill that the loadout panel can render.
      const rearming = s.type === "eagle" && state.eagleRearmingUntil != null;
      const rearmingPct = rearming
        ? Math.max(0, Math.min(1, (state.t - (state.eagleRearmStartT ?? 0)) /
            Math.max(1, (state.eagleRearmingUntil ?? 0) - (state.eagleRearmStartT ?? 0))))
        : null;
      return {
        id: s.id, defId: s.defId, type: s.type,
        cooldownPct: cdPct,
        usesRemaining: s.usesRemaining,
        usesMax: s.usesMax ?? null,
        rearmingPct,
        callInPct: s.callInActive ? 1 - Math.max(0, (s.callInActive.resolveAt - state.t) / 4000) : null,
      };
    }),
    eagleRearm: state.eagleRearmingUntil != null
      ? {
          active: true,
          secsRemaining: Math.max(0, (state.eagleRearmingUntil - state.t) / 1000),
          pct: Math.max(0, Math.min(1, (state.t - (state.eagleRearmStartT ?? 0)) /
            Math.max(1, (state.eagleRearmingUntil ?? 0) - (state.eagleRearmStartT ?? 0)))),
        }
      : { active: false, secsRemaining: 0, pct: 1 },
    assignments: state._lastAssignments ?? [],
    fxFlashes: state._fxFlashes ?? [],
    nextSpawnT: nextScheduledT(state),
    totalSpawns: state.scenario?.totalSpawns ?? 0,
    scores: state.scores,
    scenario: {
      faction: cfg.scenario?.faction,
      subfaction: cfg.scenario?.subfaction,
      encounter: cfg.scenario?.encounter,
      difficulty: cfg.scenario?.difficulty,
      archetypes: state.scenario?.archetypes ?? [],
    },
  };
}

function archetypeHp(scenario, id) {
  const a = scenario?.archetypes?.find((x) => x.id === id);
  return a?.hp ?? 100;
}

function nextScheduledT(state) {
  // Cursor is no longer maintained — applyScheduled uses filter-rebuild.
  // Scan all scheduled events for the smallest t > state.t.
  const list = state.scheduled ?? [];
  let minT = Infinity;
  for (const ev of list) {
    if (ev.t > state.t && ev.t < minT) minT = ev.t;
  }
  return Number.isFinite(minT) ? minT : null;
}

// Advance persistent effects (sentries, dot clouds, pickups). Mutates state.
// Sentries fire at nearest enemy in range. DoT clouds damage enemies in radius.
// Expired effects are dropped.
function tickEffects(state, _cfg) {
  const remaining = [];
  for (const eff of state.effects ?? []) {
    if (eff.until != null && state.t >= eff.until) continue;
    if (eff.kind === "sentry") {
      const fireIntervalMs = 60000 / Math.max(60, eff.fireRateRpm ?? 600);
      if ((state.t - (eff.lastShotT ?? 0)) >= fireIntervalMs) {
        let best = null, bestD = Infinity;
        for (const e of state.enemies.values()) {
          if (!e.alive) continue;
          const dx = e.position.x - eff.x;
          const dy = e.position.y - eff.y;
          const d = Math.hypot(dx, dy);
          if (d < bestD && d < (eff.maxRangeM ?? 60)) { best = e; bestD = d; }
        }
        if (best) {
          const dmg = computeDamage(eff.weaponDef, best);
          best.hp = Math.max(0, best.hp - dmg);
          const died = best.hp <= 0;
          if (died) best.alive = false;
          eff.lastShotT = state.t;
          // Tracer fx from sentry → target, brief flash. defId carries weapon
          // family (rocket, autocannon, mg, gatling) for the renderer to style.
          state._fxFlashes.push({
            kind: "sentry-tracer",
            defId: eff.defId,
            fromX: eff.x, fromY: eff.y,
            x: best.position.x, y: best.position.y,
            r: 1, bornT: state.t, durMs: 120, isKill: died,
          });
        }
      }
    } else if (eff.kind === "dot") {
      if ((state.t - (eff.lastTickT ?? 0)) >= (eff.tickIntervalMs ?? 250)) {
        const r2 = eff.radiusM * eff.radiusM;
        const fakeWeapon = { damage: eff.damagePerTick, armorPen: eff.armorPen ?? 2 };
        for (const e of state.enemies.values()) {
          if (!e.alive) continue;
          const ex = e.position.x - eff.x;
          const ey = e.position.y - eff.y;
          if (ex * ex + ey * ey > r2) continue;
          const dmg = computeDamage(fakeWeapon, e);
          e.hp = Math.max(0, e.hp - dmg);
          if (e.hp <= 0) e.alive = false;
        }
        eff.lastTickT = state.t;
      }
    }
    // pickup: passive marker, no per-tick action; expires via `until`.
    remaining.push(eff);
  }
  state.effects = remaining;
}

// Resolve the wave-loop cadence in seconds: explicit user override if set,
// otherwise the wiki-derived default for the configured difficulty.
function resolveWaveCadence(scenario) {
  const explicit = Number(scenario?.waveCadenceSecs);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(5, Math.min(600, explicit));
  }
  return defaultWaveCadenceSecs(scenario?.difficulty);
}

// Infinite-wave loop. If the scheduled-spawn cursor is exhausted AND no enemies
// remain alive, queue a fresh wave at `state.t + cadenceSecs * 1000`. The
// caller supplies the cadence so users can override the wiki default. The new
// wave reuses the original scenario.spawnIntents shape with fresh ids.
function maybeQueueNextWave(state, scenario, cadenceSecs) {
  if (state._waveQueued) return; // a wave already pending
  const queueTail = (state.scheduled?.length ?? 0);
  if (queueTail > 0) return; // current wave still firing/pending
  // Wait until current wave is fully resolved (no alive enemies).
  for (const e of state.enemies.values()) {
    if (e.alive) return;
  }
  const startAt = state.t + cadenceSecs * 1000;
  let id = state._waveCounter ?? 1;
  for (const intent of scenario.spawnIntents) {
    state.scheduled.push({
      t: startAt + intent.t,
      fn: ((intent, waveN) => (st) => {
        const archetype = scenario.archetypes.find((a) => a.id === intent.enemyId);
        const enemyId = `w${waveN}-e${++id}-${intent.enemyId}`;
        st.enemies.set(enemyId, {
          id: enemyId,
          archetypeId: intent.enemyId,
          threatTier: archetype?.threatTier ?? "light",
          hp: archetype?.hp ?? 100,
          parts: archetype?.parts ?? [],
          position: { x: intent.position.x, y: intent.position.y },
          velocity: { dx: intent.vector.dx, dy: intent.vector.dy },
          alive: true,
          meleeDps: archetype?.meleeDps ?? 10,
          rangedDps: archetype?.rangedDps ?? 0,
        });
      })(intent, (state._waveCounter ?? 1) + 1),
    });
  }
  state._waveCounter = (state._waveCounter ?? 1) + 1;
  state._waveQueued = true;
  // Schedule a noop event at startAt-1ms whose fn flips _waveQueued back so the
  // next-wave check resumes after this wave begins firing. applyScheduled
  // re-sorts defensively, so no cursor maintenance here.
  state.scheduled.push({
    t: startAt - 1,
    fn: (st) => { st._waveQueued = false; },
  });
}

// Eagle rearm: shared timer across the whole eagle module of the loadout.
// While any eagle still has uses left, none rearms — eagles only fly home
// once the player has burned through every eagle charge they brought. Once
// rearm completes, all eagles refill to their max uses simultaneously.
function tickEagleRearm(state, cfg) {
  const eagles = [];
  for (const s of state.stratagems.values()) {
    if (s.type === "eagle") eagles.push(s);
  }
  if (eagles.length === 0) return;

  if (state.eagleRearmingUntil != null && state.t >= state.eagleRearmingUntil) {
    for (const s of eagles) {
      if (s.usesMax != null) s.usesRemaining = s.usesMax;
      // Clear any per-eagle cooldown that was masking the rearm bar.
      if ((s.cooldownUntil ?? 0) <= state.eagleRearmingUntil) {
        s.cooldownUntil = state.t;
        s.cooldownStartT = state.t;
      }
    }
    state.eagleRearmingUntil = null;
    state.eagleRearmStartT = null;
    return;
  }

  if (state.eagleRearmingUntil != null) return; // already rearming

  // Fully spent? Every eagle that tracks uses must be at 0; eagles with
  // usesRemaining=null (none in stock data, but allowed by schema) are skipped.
  let allSpent = true;
  let anyTracksUses = false;
  for (const s of eagles) {
    if (s.usesRemaining == null) continue;
    anyTracksUses = true;
    if (s.usesRemaining > 0) { allSpent = false; break; }
  }
  if (!anyTracksUses || !allSpent) return;

  const rearmMs = (cfg?.eagleRearmSecs ?? 120) * 1000;
  state.eagleRearmStartT = state.t;
  state.eagleRearmingUntil = state.t + rearmMs;
  // Hide the analytics "spent" label by routing the spent eagles through
  // their cooldown bar — same channel the loadout panel already renders.
  for (const s of eagles) {
    s.cooldownStartT = state.t;
    s.cooldownUntil = state.eagleRearmingUntil;
  }
}

// Resupply: when any weapon is bone-dry (mag=0 AND reserve=0) and a resupply
// stratagem is available, throw it. Bypasses the WTA solver because the
// solver only sees damage-producing options. The landing event refills every
// weapon's reserve to its starting capacity and tops up the magazine.
function maybeAutoCallResupply(state, cfg) {
  let dryWeapon = false;
  for (const w of state.weapons.values()) {
    const reserve = w.ammoReserve ?? 0;
    const mag = w.ammoInMag ?? 0;
    if (mag <= 0 && reserve <= 0) { dryWeapon = true; break; }
  }
  if (!dryWeapon) return;

  let resupply = null;
  for (const s of state.stratagems.values()) {
    if (s.defId !== "resupply") continue;
    if (s.callInActive && s.callInActive.resolveAt > state.t) return; // already inbound
    if ((s.cooldownUntil ?? 0) > state.t) continue;
    if (s.usesRemaining != null && s.usesRemaining <= 0) continue;
    resupply = s; break;
  }
  if (!resupply) return;

  triggerResupply(state, resupply, cfg);
}

function triggerResupply(state, resupply, cfg) {
  const callInSecs = Math.max(0, resupply.callInSecs ?? 1.5);
  const cdSecs = resupply.cooldownSecsOwn ?? cfg?.stratagemCooldownsSecs ?? 270;
  const resolveAt = state.t + callInSecs * 1000;
  // Drop next to the player — same convention the EAT pickup uses.
  const beaconX = (state.player?.x ?? 0) + 2;
  const beaconY = (state.player?.y ?? 0) + 2;

  resupply.cooldownStartT = state.t;
  resupply.cooldownUntil = state.t + cdSecs * 1000;
  if (resupply.usesRemaining !== null && resupply.usesRemaining !== undefined) {
    resupply.usesRemaining = Math.max(0, resupply.usesRemaining - 1);
  }
  resupply.callInActive = { resolveAt, beaconXY: { x: beaconX, y: beaconY }, weaponId: resupply.id };

  if (!state._fxFlashes) state._fxFlashes = [];
  state._fxFlashes.push({
    kind: "throw",
    x: beaconX, y: beaconY,
    r: 2,
    bornT: state.t,
    durMs: callInSecs * 1000,
    weaponId: resupply.id,
    weaponSlot: resupply.id,
    playerX: state.player?.x ?? 0, playerY: state.player?.y ?? 0,
    resolveAt,
  });

  state.effects.push({
    kind: "callin",
    x: beaconX, y: beaconY,
    radiusM: 2,
    resolveAt,
    weaponId: resupply.id,
    fxKind: "spark",
    bornT: state.t,
    playerX: state.player?.x ?? 0, playerY: state.player?.y ?? 0,
  });

  const stratId = resupply.id;
  state.scheduled.push({
    t: resolveAt,
    fn: (st) => {
      st.effects = st.effects.filter((e) => !(e.kind === "callin" && e.resolveAt === resolveAt && e.weaponId === stratId));
      // Refill every weapon: reserve back to starting cap, mag topped up.
      for (const w of st.weapons.values()) {
        const max = w.ammoReserveMax ?? w.ammoReserve ?? 0;
        w.ammoReserve = max;
        if ((w.ammoInMag ?? 0) < (w.magazine ?? 0)) {
          const need = (w.magazine ?? 0) - (w.ammoInMag ?? 0);
          const taken = Math.min(need, w.ammoReserve);
          w.ammoInMag = (w.ammoInMag ?? 0) + taken;
          w.ammoReserve = Math.max(0, w.ammoReserve - taken);
        }
        // Clear any in-flight reload so the freshly-stocked mag fires immediately.
        w.reloadingUntil = null;
      }
      // Marker effect on the supply box so the renderer can show "I'm here".
      st.effects.push({
        kind: "pickup",
        x: beaconX, y: beaconY, radiusM: 1.2,
        bornT: st.t,
        until: st.t + 30 * 1000,
        usesLeft: 4, // resupply box drops 4 supply pickups in HD2
        weaponName: "resupply",
      });
      if (!st._fxFlashes) st._fxFlashes = [];
      st._fxFlashes.push({ kind: "spark", x: beaconX, y: beaconY, r: 4, bornT: st.t, durMs: 600, isKill: false });
    },
  });

}

// --- player movement: HOLD / KITE / PUSH ---
//
// Mode is derived AFTER assignment so we can ask "given what we just decided
// to fire, will the threats reach me before I kill them?"
//
// HOLD: every visible threat is killable before it closes to melee, given the
//       current assignment's expected DPS contributions.
// KITE: at least one threat will arrive before the weapon assigned to it is
//       ready (reload/cooldown), so we back away to buy time.
// PUSH: arc is empty, or all threats already in the kill window.
//
// Movement integrates at fixed `tickMs`. Speeds are intentionally small —
// the engagement geometry shouldn't whiplash per tick.
const KITE_SPEED_MPS = 3.0;
const PUSH_SPEED_MPS = 1.5;
const SAFETY_MARGIN_SECS = 0.5;
const WORLD_LATERAL = 50;

function updatePlayerMovement(state, targets, assignments, cfg) {
  const tickSecs = (cfg.tickMs ?? 100) / 1000;
  const aliveThreats = targets.filter((t) => {
    const e = state.enemies.get(t.id);
    return e && e.alive;
  });

  let mode = "PUSH";
  let kiteFromX = 0, kiteFromY = 0;

  if (aliveThreats.length > 0) {
    // ttkill per target = hp / Σ_assigned (expectedDamagePerSec from that weapon).
    const damagePerSecPerWeapon = (a, target) => {
      const w = state.weapons.get(a.weaponId) ?? state.stratagems.get(a.weaponId);
      if (!w) return 0;
      const dmg = computeDamage(w, target);
      const fireRate = w.fireRateRpm ? w.fireRateRpm / 60 : 1; // rounds/sec
      return dmg * fireRate;
    };
    const dpsPerTarget = new Map();
    for (const a of assignments) {
      const tgt = state.enemies.get(a.targetId);
      if (!tgt || !tgt.alive) continue;
      const dps = damagePerSecPerWeapon(a, tgt);
      dpsPerTarget.set(a.targetId, (dpsPerTarget.get(a.targetId) || 0) + dps);
    }

    let anyUnsafe = false;
    let nearest = null, nearestD = Infinity;
    for (const t of aliveThreats) {
      const dx = t.position.x - state.player.x;
      const dy = t.position.y - state.player.y;
      const d = Math.hypot(dx, dy);
      if (d < nearestD) { nearestD = d; nearest = { dx, dy, d }; }
      const speed = Math.hypot(t.velocity?.dx ?? 0, t.velocity?.dy ?? 0);
      const ttp = speed > 0.01 ? d / speed : Infinity;
      const dps = dpsPerTarget.get(t.id) || 0;
      const ttkill = dps > 0 ? (state.enemies.get(t.id)?.hp ?? 0) / dps : Infinity;
      if (ttkill > ttp - SAFETY_MARGIN_SECS) { anyUnsafe = true; }
    }

    if (anyUnsafe && nearest) {
      mode = "KITE";
      const norm = nearest.d || 1;
      kiteFromX = -nearest.dx / norm;
      kiteFromY = -nearest.dy / norm;
    } else {
      mode = "HOLD";
    }
  }

  let vx = 0, vy = 0;
  if (mode === "KITE") {
    vx = kiteFromX * KITE_SPEED_MPS;
    vy = kiteFromY * KITE_SPEED_MPS;
  } else if (mode === "PUSH") {
    // Push along facing.
    vx = Math.cos(state.player.facingRad) * PUSH_SPEED_MPS;
    vy = Math.sin(state.player.facingRad) * PUSH_SPEED_MPS;
  }

  const nx = clampWorld(state.player.x + vx * tickSecs);
  const ny = clampWorldForward(state.player.y + vy * tickSecs);
  state.player = {
    ...state.player,
    x: nx,
    y: ny,
    vx,
    vy,
    mode,
  };
}

function clampWorld(v) {
  if (v < -WORLD_LATERAL) return -WORLD_LATERAL;
  if (v > WORLD_LATERAL) return WORLD_LATERAL;
  return v;
}

function clampWorldForward(v) {
  // Allow some forward drift but no infinite march; let kiting go negative.
  if (v < -WORLD_LATERAL) return -WORLD_LATERAL;
  if (v > WORLD_LATERAL) return WORLD_LATERAL;
  return v;
}
