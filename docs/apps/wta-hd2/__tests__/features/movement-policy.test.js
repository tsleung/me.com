import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyMode,
  sustainedWeaponDps,
  updateMovement,
} from "../../features/movement-policy.js";

// ---- classifyMode (pure) ----

test("classifyMode: empty arc → PUSH (free time)", () => {
  const m = classifyMode({
    aliveThreats: [],
    enemies: new Map(),
    sustainedDpsByTarget: () => 0,
    player: { x: 0, y: 0 },
  });
  assert.equal(m, "PUSH");
});

test("classifyMode: threat killable in time → HOLD", () => {
  const t = { id: "t1", position: { x: 0, y: 30 }, velocity: { dx: 0, dy: -3 } };
  const m = classifyMode({
    aliveThreats: [t],
    enemies: new Map([["t1", { hp: 100 }]]),
    sustainedDpsByTarget: () => 100, // 100 DPS → kill in 1s; ttp = 30/3 = 10s
    player: { x: 0, y: 0 },
  });
  assert.equal(m, "HOLD");
});

test("classifyMode: threat closes faster than DPS can kill → KITE", () => {
  const t = { id: "t1", position: { x: 0, y: 5 }, velocity: { dx: 0, dy: -10 } };
  const m = classifyMode({
    aliveThreats: [t],
    enemies: new Map([["t1", { hp: 1000 }]]),
    sustainedDpsByTarget: () => 50, // 50 DPS → 20s to kill; ttp = 0.5s
    player: { x: 0, y: 0 },
  });
  assert.equal(m, "KITE");
});

// ---- sustainedWeaponDps (the "you're not kiting, you're reloading" rule) ----

test("sustainedWeaponDps: full-mag-then-reload cycle correctly amortizes reload", () => {
  // Liberator: 30 mag, 600 RPM (10/s), 2s reload → cycle = 3s + 2s = 5s.
  // 30 shots × 60 dmg / 5s = 360 DPS.
  const lib = { fireRateRpm: 600, magazine: 30, reloadSecs: 2 };
  const dps = sustainedWeaponDps(lib, 60);
  assert.ok(Math.abs(dps - 360) < 1, `expected ~360, got ${dps}`);
});

test("sustainedWeaponDps: stratagem path uses cooldown horizon", () => {
  // EAT: 70s cooldown, 1500 dmg, infinite uses (uses=null treated as 1).
  const eat = { cooldownSecsOwn: 70, usesMax: null, usesRemaining: null };
  const dps = sustainedWeaponDps(eat, 1500);
  // (1500 × 1) / 70 ≈ 21.4 DPS
  assert.ok(dps > 0, `expected >0, got ${dps}`);
  assert.ok(dps < 100, `expected <100 (long cooldown), got ${dps}`);
});

// ---- updateMovement (composed) ----

function makeState(over = {}) {
  return {
    t: 0,
    player: { x: 0, y: 0, hp: 1, facingRad: Math.PI / 2 },
    weapons: new Map(),
    stratagems: new Map(),
    enemies: new Map(),
    ...over,
  };
}

test("updateMovement: playerMovement off → stationary HOLD", () => {
  const state = makeState();
  updateMovement(state, [], { tickMs: 100, scenario: { playerMovement: false } }, () => 0);
  assert.equal(state.player.mode, "HOLD");
  assert.equal(state.player.vx, 0);
  assert.equal(state.player.vy, 0);
});

test("updateMovement: rooting weapon mid-reload → mode RELOAD, no movement", () => {
  const state = makeState({
    t: 1000,
    weapons: new Map([["primary", { reloadingUntil: 3000, defId: "recoilless-rifle" }]]),
  });
  updateMovement(
    state, [],
    { tickMs: 100, scenario: { playerMovement: true } },
    () => 0,
    (w) => /recoilless/.test(w.defId),
  );
  assert.equal(state.player.mode, "RELOAD");
  assert.equal(state.player.vx, 0);
});

test("updateMovement: empty arc + movement on → PUSH along facing", () => {
  const state = makeState();
  updateMovement(state, [], { tickMs: 100, scenario: { playerMovement: true } }, () => 0);
  assert.equal(state.player.mode, "PUSH");
  // facingRad = π/2 → vy > 0
  assert.ok(state.player.vy > 0);
});

test("updateMovement: KITE not triggered when reload-amortized DPS still keeps up", () => {
  // Threat at 30m, closing at 3 m/s → ttp = 10s. Liberator sustained DPS
  // ≈ 360 against a 100-HP target = ttkill 0.28s. Even though the weapon
  // is currently reloading (ammoInMag=0 + reloadingUntil set), KITE
  // shouldn't fire because the long-run kill rate keeps up.
  const state = makeState({
    t: 0,
    weapons: new Map([["primary", {
      id: "primary", defId: "liberator", fireRateRpm: 600, magazine: 30,
      reloadSecs: 2, reloadingUntil: 1500, ammoInMag: 0,
    }]]),
    enemies: new Map([["t1", { id: "t1", hp: 100, alive: true, archetypeId: "scav", threatTier: "light" }]]),
  });
  const target = {
    id: "t1", position: { x: 0, y: 30 }, velocity: { dx: 0, dy: -3 },
    parts: [{ ac: 1, isWeakPoint: false, weakPointMultiplier: 1, frontalWidth: 0.5 }],
    hp: 100, threatTier: "light",
  };
  // damagePerShotFn: pretend a non-trivial per-shot damage so sustained
  // DPS is large.
  const dmgFn = () => 60;
  updateMovement(state, [target], { tickMs: 100, scenario: { playerMovement: true } }, dmgFn);
  assert.notEqual(state.player.mode, "KITE",
    `expected HOLD (reload-amortized DPS keeps up), got ${state.player.mode}`);
});

test("updateMovement: KITE triggers when sustained DPS truly cannot keep up", () => {
  // Tiny weapon, huge HP target — sustained DPS << threat HP / ttp.
  const state = makeState({
    weapons: new Map([["primary", {
      id: "primary", defId: "lib", fireRateRpm: 60, magazine: 1, reloadSecs: 5,
    }]]),
    enemies: new Map([["t1", { id: "t1", hp: 5000, alive: true, threatTier: "heavy" }]]),
  });
  const target = {
    id: "t1", position: { x: 0, y: 8 }, velocity: { dx: 0, dy: -4 },
    parts: [{ ac: 5, isWeakPoint: false, weakPointMultiplier: 1, frontalWidth: 1.5 }],
    hp: 5000, threatTier: "heavy",
  };
  const dmgFn = () => 5; // tiny damage
  updateMovement(state, [target], { tickMs: 100, scenario: { playerMovement: true } }, dmgFn);
  assert.equal(state.player.mode, "KITE",
    `expected KITE (DPS can't keep up), got ${state.player.mode}`);
});
