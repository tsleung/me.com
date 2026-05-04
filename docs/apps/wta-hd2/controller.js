const DEFAULT_TICK_MS = 100;

function clonePolicy(p) {
  if (!p) return {};
  const out = {};
  for (const [wid, row] of Object.entries(p)) {
    if (!row) continue;
    const r = {};
    for (const [tier, v] of Object.entries(row)) if (v === "deny") r[tier] = "deny";
    if (Object.keys(r).length > 0) out[wid] = r;
  }
  return out;
}
const MAX_CATCHUP_TICKS = 10;

const DEFAULT_SCHEDULE = {
  setTimeout: globalThis.setTimeout?.bind(globalThis) ?? ((fn, ms) => setTimeout(fn, ms)),
  clearTimeout: globalThis.clearTimeout?.bind(globalThis) ?? ((id) => clearTimeout(id)),
  perfNow: () => (globalThis.performance?.now?.() ?? Date.now()),
};

export function createController({ engineFactory, initialCfg, data, schedule } = {}) {
  if (typeof engineFactory !== "function") throw new Error("createController: engineFactory required");
  const sched = { ...DEFAULT_SCHEDULE, ...(schedule ?? {}) };

  let cfg = initialCfg ?? {};
  let engine = engineFactory(cfg, data);
  let state = engine.initialState;
  let snapshot = engine.view(state);

  const subs = new Set();
  let playing = false;
  let speed = 1;
  let timer = null;
  let lastRealMs = sched.perfNow();
  let accumulatorMs = 0;
  // Death banner: when the diver's hp hits zero, the engine is restarted
  // immediately (no pause), but a "DIVER KIA" notice persists for 3s of real
  // wall time so the user notices the run reset. Cleared in emit() once the
  // wall-time deadline passes.
  let deathBannerUntilMs = 0;

  function emit() {
    const base = engine.view(state);
    const now = sched.perfNow();
    snapshot = (deathBannerUntilMs > now)
      ? { ...base, deathBanner: { active: true, msRemaining: deathBannerUntilMs - now } }
      : base;
    for (const fn of subs) fn(snapshot);
  }

  function rebuildEngine() {
    engine = engineFactory(cfg, data);
    state = engine.initialState;
    accumulatorMs = 0;
    lastRealMs = sched.perfNow();
    emit();
  }

  // Diver-death respawn. Engine restarts in place — playback continues, the
  // banner timestamp is left on the controller so the renderer can flash a
  // notice for 3s without freezing the new run. A trailing emit fires when
  // the banner expires so subscribers clear it even if no further tick lands
  // (e.g. paused after a STEP into death).
  function rebuildOnDeath() {
    const BANNER_MS = 3000;
    deathBannerUntilMs = sched.perfNow() + BANNER_MS;
    engine = engineFactory(cfg, data);
    state = engine.initialState;
    accumulatorMs = 0;
    sched.setTimeout(() => emit(), BANNER_MS + 50);
  }

  function runOneTick() {
    state = engine.tick(state);
    if ((state.player?.hp ?? Infinity) <= 0) {
      rebuildOnDeath();
    }
  }

  function loop() {
    if (!playing) return;
    const now = sched.perfNow();
    const realDelta = now - lastRealMs;
    lastRealMs = now;
    accumulatorMs += realDelta * speed;

    let consumed = 0;
    while (accumulatorMs >= DEFAULT_TICK_MS && consumed < MAX_CATCHUP_TICKS) {
      runOneTick();
      accumulatorMs -= DEFAULT_TICK_MS;
      consumed++;
    }
    if (accumulatorMs > MAX_CATCHUP_TICKS * DEFAULT_TICK_MS) accumulatorMs = 0;

    if (consumed > 0) emit();

    const nextDelay = Math.max(8, DEFAULT_TICK_MS - (accumulatorMs / Math.max(0.5, speed)));
    timer = sched.setTimeout(loop, nextDelay);
  }

  function dispatch(action) {
    switch (action.type) {
      case "PLAY": {
        if (playing) return;
        playing = true;
        lastRealMs = sched.perfNow();
        accumulatorMs = 0;
        timer = sched.setTimeout(loop, DEFAULT_TICK_MS);
        break;
      }
      case "PAUSE": {
        playing = false;
        if (timer != null) { sched.clearTimeout(timer); timer = null; }
        break;
      }
      case "STEP": {
        playing = false;
        if (timer != null) { sched.clearTimeout(timer); timer = null; }
        runOneTick();
        emit();
        break;
      }
      case "RESTART": {
        playing = false;
        if (timer != null) { sched.clearTimeout(timer); timer = null; }
        rebuildEngine();
        break;
      }
      case "SET_SPEED": {
        const s = Number(action.speed);
        if ([0.5, 1, 2, 4].includes(s)) speed = s;
        break;
      }
      case "SET_SEED": {
        cfg = { ...cfg, seed: action.seed };
        rebuildEngine();
        break;
      }
      case "SET_LOADOUT": {
        cfg = { ...cfg, loadout: action.loadout };
        rebuildEngine();
        break;
      }
      case "SET_SCENARIO": {
        cfg = { ...cfg, scenario: action.scenario };
        rebuildEngine();
        break;
      }
      case "SET_ALPHA": {
        cfg = { ...cfg, solver: { ...(cfg.solver ?? {}), alpha: action.alpha } };
        // alpha changes don't require engine rebuild — solver reads it each tick from cfg
        // but our engineFactory captures cfg, so we must rebuild for it to take effect
        rebuildEngine();
        break;
      }
      case "SET_GAMMA": {
        cfg = { ...cfg, solver: { ...(cfg.solver ?? {}), gamma: action.gamma } };
        rebuildEngine();
        break;
      }
      case "SET_SKILL": {
        cfg = { ...cfg, solver: { ...(cfg.solver ?? {}), skill: action.skill } };
        rebuildEngine();
        break;
      }
      case "SET_AMMO_CONSERVATION": {
        cfg = { ...cfg, solver: { ...(cfg.solver ?? {}), ammoConservation: !!action.enabled } };
        rebuildEngine();
        break;
      }
      case "TRIGGER_WAVE": {
        // Manual override: spawn the next wave at the current sim time. Doesn't
        // pause playback or rebuild the engine — events land in scheduled and
        // fire on the next tick. Independent of any auto-queued wave.
        if (typeof engine.triggerNextWave === "function") {
          engine.triggerNextWave(state);
          emit();
        }
        break;
      }
      case "SET_POLICY_CELL": {
        // Toggle a single (weaponId, tier) cell to "allow" | "deny".
        // Stored sparsely: an "allow" cell deletes the row entry, an
        // empty row deletes the row, so the URL hash stays compact.
        const policy = clonePolicy(cfg.solver?.policy);
        const wid = action.weaponId;
        const tier = action.tier;
        const value = action.value;
        if (value === "deny") {
          policy[wid] ??= {};
          policy[wid][tier] = "deny";
        } else if (policy[wid]) {
          delete policy[wid][tier];
          if (Object.keys(policy[wid]).length === 0) delete policy[wid];
        }
        cfg = { ...cfg, solver: { ...(cfg.solver ?? {}), policy } };
        rebuildEngine();
        break;
      }
      case "SET_POLICY": {
        cfg = { ...cfg, solver: { ...(cfg.solver ?? {}), policy: clonePolicy(action.policy) } };
        rebuildEngine();
        break;
      }
      case "REFRESH_WEAPON": {
        // Manual debug action: refill a single weapon's reserve and mag and
        // clear any in-flight reload. No engine rebuild — mutates current state
        // so the user can keep watching the run unfold.
        const w = state.weapons?.get?.(action.weaponId);
        if (w) {
          const max = w.ammoReserveMax ?? w.ammoReserve ?? 0;
          w.ammoReserve = max;
          if ((w.magazine ?? 0) > 0) w.ammoInMag = w.magazine;
          w.reloadingUntil = null;
          emit();
        }
        break;
      }
      case "REFRESH_STRATAGEM": {
        // Manual debug action: clear cooldown, refill uses, clear eagle rearm.
        // Like REFRESH_WEAPON, no rebuild — works mid-run.
        const s = state.stratagems?.get?.(action.stratagemId);
        if (s) {
          s.cooldownStartT = null;
          s.cooldownUntil = null;
          if (s.usesMax != null) s.usesRemaining = s.usesMax;
          if (s.type === "eagle") {
            state.eagleRearmingUntil = null;
            state.eagleRearmStartT = null;
          }
          emit();
        }
        break;
      }
      case "SET_RESERVE": {
        const reserves = { ...(cfg.solver?.reserves ?? {}) };
        reserves[action.stratagemSlot] = action.reserve;
        cfg = { ...cfg, solver: { ...(cfg.solver ?? {}), reserves } };
        rebuildEngine();
        break;
      }
      default:
        throw new Error(`controller: unknown action type "${action?.type}"`);
    }
  }

  function subscribe(fn) {
    subs.add(fn);
    fn(snapshot);
    return () => subs.delete(fn);
  }

  return {
    dispatch,
    subscribe,
    getSnapshot: () => snapshot,
    getCfg: () => cfg,
    isPlaying: () => playing,
    getSpeed: () => speed,
  };
}
