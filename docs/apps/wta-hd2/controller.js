const DEFAULT_TICK_MS = 100;
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

  function emit() {
    snapshot = engine.view(state);
    for (const fn of subs) fn(snapshot);
  }

  function rebuildEngine() {
    engine = engineFactory(cfg, data);
    state = engine.initialState;
    accumulatorMs = 0;
    lastRealMs = sched.perfNow();
    emit();
  }

  function runOneTick() {
    state = engine.tick(state);
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
