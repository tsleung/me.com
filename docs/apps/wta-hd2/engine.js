import {
  createInitialState,
  tick as simTick,
  visibleWeaponView,
  visibleEnemyView,
  effectView,
} from "./sim.js";
import { assign as solverAssign, expectedDamagePerShot } from "./wta-solver.js";
import { buildScenario, defaultWaveCadenceSecs } from "./scenarios.js";
import { mulberry32, hashString } from "./rng.js";
// --- composed feature modules (each removable in isolation) ----------------
//
// Each lives under ./features/. Removing one means deleting its file and the
// import + call site here. Snapshot fields (verdict, player.{vx,vy,mode})
// are the only outward leak. See docs at the top of each feature file.
import { updateMovement } from "./features/movement-policy.js";
import { classifyOutcome } from "./features/verdict.js";

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
    const skill = c.solver?.skill ?? 1.0;
    const assignments = solverAssign({
      weapons,
      targets,
      effects,
      alpha: c.solver?.alpha ?? 0.5,
      gamma: c.solver?.gamma ?? 0.3,
      skill,
      // features/ammo-conservation.js — opt-in distance discount for
      // scarce-ammo weapons. Off by default to preserve goldens; flip
      // via cfg.solver.ammoConservation = true.
      ammoConservation: c.solver?.ammoConservation ?? false,
      reserves: c.solver?.reserves ?? {},
      policy: c.solver?.policy ?? null,
      rng: next.rng,
      tickMs: c.tickMs,
    });
    applyAssignments(next, assignments, c, skill);
    // Resupply has no damage, so the WTA solver will never pick it. Trigger it
    // out-of-band when any weapon is bone-dry and resupply is off cooldown.
    maybeAutoCallResupply(next, c);
    next._lastAssignments = assignments;
    // features/movement-policy.js owns HOLD/KITE/PUSH/RELOAD math. The
    // module handles the playerMovement on/off gate internally; we pass
    // damage + rooting predicates so it can compute sustained DPS the
    // same way the solver predicts and recognise rooting reloads.
    const dmgFn = (w, t, dist) => expectedDamagePerShot(w, t, dist, skill);
    updateMovement(next, targets, c, dmgFn, rootsPlayerOnReload);
    return next;
  };

  const view = (state) => snapshot(state, data, c);

  // Manual override: skip the wave-cadence wait and spawn the next wave at
  // state.t, anchored on the player's current position so the arc lands at the
  // expected fixed distance even when the diver has roamed off origin.
  // Mutates state.scheduled in place; the next tick's applyScheduled fires the
  // t<=state.t intents. Independent of any auto-queued wave — if
  // maybeQueueNextWave already queued one, that one still arrives later.
  const triggerNextWave = (state) => {
    const origin = { x: state.player?.x ?? 0, y: state.player?.y ?? 0 };
    pushWaveAtT(state, scenario, state.t, origin);
    state._nextWaveStartAt = null;
    return state;
  };

  return { initialState: init, tick, view, triggerNextWave };
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

function applyAssignments(state, assignments, cfg, skill = 1) {
  state._fxFlashes = [];
  for (const a of assignments) {
    const target = state.enemies.get(a.targetId);
    if (!target || !target.alive) continue;
    const weapon = state.weapons.get(a.weaponId) ?? state.stratagems.get(a.weaponId);
    if (!weapon) continue;

    if (state.weapons.has(a.weaponId)) {
      // Direct-fire weapon: damage applies immediately. Distance feeds the
      // dispersion model — Liberator at 40 m on a hunter has a much lower
      // per-shot expected damage than at 5 m.
      const dxp = (target.position?.x ?? 0) - (state.player?.x ?? 0);
      const dyp = (target.position?.y ?? 0) - (state.player?.y ?? 0);
      const distM = Math.hypot(dxp, dyp);
      const dmgPerShot = computeDamage(weapon, target, distM, skill);
      const totalDmg = dmgPerShot * a.shots;
      target.hp = Math.max(0, target.hp - totalDmg);
      const died = target.hp <= 0;
      if (died) target.alive = false;
      // Heavy rocket weapons (RR/Spear/EAT/Quasar/etc.) get a three-stage
      // visual: back-blast smoke at the player → smoke-trail traveling to
      // the target → delayed explosion. Without this the rare-but-impactful
      // shot looks identical to a Liberator burst. Damage still resolves now;
      // the explosion fx is just delayed by the travel time so the visual
      // matches what the user expects.
      const fires = firesRocket(weapon);
      const ROCKET_TRAVEL_MS = 350;
      if (fires) {
        state._fxFlashes.push({
          kind: "back-blast",
          x: state.player.x, y: state.player.y,
          r: 3,
          bornT: state.t, durMs: 500, isKill: false,
        });
        state._fxFlashes.push({
          kind: "rocket",
          fromX: state.player.x, fromY: state.player.y,
          x: target.position.x, y: target.position.y,
          r: 1.5,
          bornT: state.t, durMs: ROCKET_TRAVEL_MS, isKill: false,
        });
      }
      state._fxFlashes.push({
        kind: fxKindForWeapon(weapon, state),
        x: target.position.x, y: target.position.y,
        r: weapon.aoeRadiusM ?? (died ? 3 : 1.5),
        bornT: state.t + (fires ? ROCKET_TRAVEL_MS : 0),
        durMs: died ? 700 : 350,
        isKill: died,
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
          // Clear the throw indicator on the diver-side call-in strip — once
          // the strat has landed, on-field effects (sentry/pickup/dot/mine/
          // pickup near diver) own the visual; the "CALLED" chip is throw-only.
          const stratDef = st.stratagems.get(a.weaponId);
          if (stratDef) stratDef.callInActive = null;
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
            // EAT pickup — both rockets fire at the projected target on
            // landing (proximity not required), so the on-field marker
            // tracks actual remaining uses. We push it with usesLeft=ROCKETS
            // and decrement as we fire; once it hits 0, the field is bare —
            // a spent EAT shouldn't squat on the battlefield for 30s.
            const px = (st.player?.x ?? 0) + 2;
            const py = (st.player?.y ?? 0) + 2;
            const ROCKETS = 2;
            const pickupEff = {
              kind: "pickup",
              x: px, y: py, radiusM: 1,
              bornT: st.t,
              until: st.t + 30 * 1000,
              usesLeft: ROCKETS,
              weaponName: defId,
            };
            st.effects.push(pickupEff);
            const r2 = aoeR * aoeR;
            for (let r = 0; r < ROCKETS; r++) {
              for (const e of st.enemies.values()) {
                if (!e.alive) continue;
                const ex = e.position.x - beaconX;
                const ey = e.position.y - beaconY;
                if (ex * ex + ey * ey > r2) continue;
                const dmg = computeDamage(weapon, e);
                e.hp = Math.max(0, e.hp - dmg);
                if (e.hp <= 0) e.alive = false;
              }
              pickupEff.usesLeft = Math.max(0, pickupEff.usesLeft - 1);
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

// Heavy rocket-style weapons get the multi-stage firing visual (back-blast
// → trail → delayed explosion). Mirrors render-helpers.js:weaponFiresRocket
// — duplicated as an inline regex because L1 (engine) doesn't import L3
// (render). Kept narrow so eruptor / crossbow stay on the simpler path.
function firesRocket(weapon) {
  const id = String(weapon.defId || weapon.id || "").toLowerCase();
  return /recoilless|spear|(^|[-_])eat([-_]|$)|quasar|autocannon|airburst|commando|rocket|missile/.test(id);
}

// Heavy reloads (anti-tank rockets etc.) root the diver: no movement, no
// firing other weapons. Same regex as firesRocket today, factored out so the
// two can diverge if (e.g.) a future weapon travels but reloads on the move.
function rootsPlayerOnReload(weapon) {
  const id = String(weapon.defId || weapon.id || "").toLowerCase();
  return /recoilless|spear|(^|[-_])eat([-_]|$)|quasar|autocannon|airburst|commando|grenade-launcher|hmg|stalwart-em|railgun/.test(id);
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

// Damage applier — single source of truth for "how much HP does a shot
// remove from this enemy." Now delegates to the solver's
// expectedDamagePerShot so solver predictions and engine outcomes can't
// drift apart. distanceM enables the dispersion model (bigger weapon
// dispersion × smaller part width = lower per-shot expected damage);
// distanceM = 0 falls back to deterministic best-pen-able-part for AoE
// explosions where the strike already landed on the target.
function computeDamage(weapon, target, distanceM = 0, skill = 1) {
  return expectedDamagePerShot(weapon, target, distanceM, skill);
}

function snapshot(state, data, cfg) {
  return {
    t: state.t,
    tickN: state.tickN,
    player: {
      x: state.player.x, y: state.player.y, facingRad: state.player.facingRad,
      vx: state.player.vx ?? 0, vy: state.player.vy ?? 0,
      mode: state.player.mode ?? "HOLD",
      hp: state.player.hp ?? 0,
      hpMax: state.player.hpMax ?? 0,
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
      reloadSecs: w.reloadSecs ?? 2,
      reloadingPct: w.reloadingUntil
        ? Math.max(0, 1 - (w.reloadingUntil - state.t) / (w.reloadSecs * 1000))
        : 1,
      // Heavy reloads root the diver: surface it so the renderer can colour
      // the bar red and the controller can gate movement.
      rootsPlayer: rootsPlayerOnReload(w),
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
        id: s.id, defId: s.defId, name: s.name ?? s.defId, type: s.type,
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
    nextWaveT: (state._nextWaveStartAt != null && state._nextWaveStartAt > state.t)
      ? state._nextWaveStartAt
      : null,
    lastSpawnedWave: state._lastSpawnedWave ?? null,
    totalSpawns: state.scenario?.totalSpawns ?? 0,
    scores: state.scores,
    scenario: {
      faction: cfg.scenario?.faction,
      subfaction: cfg.scenario?.subfaction,
      encounter: cfg.scenario?.encounter,
      difficulty: cfg.scenario?.difficulty,
      archetypes: state.scenario?.archetypes ?? [],
    },
    // features/verdict.js — terminal outcome string, computed each tick
    // from snapshot fields above. "in-progress" until something ends.
    verdict: classifyOutcome({
      t: state.t, tickN: state.tickN,
      player: { hp: state.player.hp ?? 1 },
      enemies: [...state.enemies.values()],
      nextSpawnT: nextScheduledT(state),
    }),
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
    // pickup: passive marker. Drops off the field when its uses are spent;
    // otherwise expires via `until`.
    if (eff.kind === "pickup" && (eff.usesLeft ?? 0) <= 0) continue;
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
  pushWaveAtT(state, scenario, startAt);
  state._waveQueued = true;
  state._nextWaveStartAt = startAt;
  // Schedule a noop event at startAt-1ms whose fn flips _waveQueued back so the
  // next-wave check resumes after this wave begins firing. applyScheduled
  // re-sorts defensively, so no cursor maintenance here.
  state.scheduled.push({
    t: startAt - 1,
    fn: (st) => { st._waveQueued = false; },
  });
}

// Push a fresh wave's spawn intents into state.scheduled, anchored at startAt.
// Bumps _waveCounter so enemy ids stay unique across waves. `origin` translates
// the intent positions: scenario intents are generated around (0,0), but a
// manually-triggered wave should arrive on the arc around the player's current
// position so a roaming diver doesn't get a wave dumped 200m behind them.
// Auto-queued waves pass {x:0,y:0} (legacy behavior).
//
// Also records `state._lastSpawnedWave` so the UI can show "wave N — 12×
// hunter, 4× warrior" without scanning the whole enemy map.
//
// Does NOT touch _waveQueued or _nextWaveStartAt — callers control those.
function pushWaveAtT(state, scenario, startAt, origin = { x: 0, y: 0 }) {
  const waveN = (state._waveCounter ?? 1) + 1;
  let id = state._waveCounter ?? 1;
  const counts = {};
  for (const intent of scenario.spawnIntents) {
    counts[intent.enemyId] = (counts[intent.enemyId] ?? 0) + 1;
    state.scheduled.push({
      t: startAt + intent.t,
      fn: ((intent) => (st) => {
        const archetype = scenario.archetypes.find((a) => a.id === intent.enemyId);
        const enemyId = `w${waveN}-e${++id}-${intent.enemyId}`;
        st.enemies.set(enemyId, {
          id: enemyId,
          archetypeId: intent.enemyId,
          threatTier: archetype?.threatTier ?? "light",
          hp: archetype?.hp ?? 100,
          parts: archetype?.parts ?? [],
          position: { x: intent.position.x + origin.x, y: intent.position.y + origin.y },
          velocity: { dx: intent.vector.dx, dy: intent.vector.dy },
          alive: true,
          meleeDps: archetype?.meleeDps ?? 10,
          rangedDps: archetype?.rangedDps ?? 0,
        });
      })(intent),
    });
  }
  state._waveCounter = waveN;
  state._lastSpawnedWave = {
    waveN,
    counts,
    t: startAt,
    manual: !!(origin.x !== 0 || origin.y !== 0),
  };
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
      const stratDef = st.stratagems.get(stratId);
      if (stratDef) stratDef.callInActive = null;
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
      // Marker effect on the supply box. HD2's resupply drops 4 pickups,
      // one per squadmate; in this single-player sim only the diver can
      // consume, and the refill above already happens on landing — so the
      // box ships with usesLeft=1 and `tickEffects` drops it after the
      // landing tick decrements to 0. Same lifecycle as the EAT pickup.
      const resupplyEff = {
        kind: "pickup",
        x: beaconX, y: beaconY, radiusM: 1.2,
        bornT: st.t,
        until: st.t + 30 * 1000,
        usesLeft: 1,
        weaponName: "resupply",
      };
      st.effects.push(resupplyEff);
      resupplyEff.usesLeft = 0;
      if (!st._fxFlashes) st._fxFlashes = [];
      st._fxFlashes.push({ kind: "spark", x: beaconX, y: beaconY, r: 4, bornT: st.t, durMs: 600, isKill: false });
    },
  });

}

// Player movement (HOLD / KITE / PUSH / RELOAD) lives in
// features/movement-policy.js. See that file's header for the policy
// rules. The engine just calls `updateMovement` once per tick.
