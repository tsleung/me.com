import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDiverAction } from "../render-diver-profile.js";

// Minimal snapshot factory: only the fields deriveDiverAction reads.
function snap({ t = 0, weapons = [], stratagems = [], assignments = [] } = {}) {
  return { t, weapons, stratagems, assignments };
}

test("deriveDiverAction: empty snapshot is idle", () => {
  const { action } = deriveDiverAction(snap());
  assert.equal(action.kind, "idle");
});

test("deriveDiverAction: primary firing surfaces fire-primary with family", () => {
  const s = snap({
    weapons: [{ id: "primary", defId: "liberator", reloadingPct: 1, rootsPlayer: false }],
    assignments: [{ weaponId: "primary", targetId: "e1", shots: 1 }],
  });
  const { action } = deriveDiverAction(s);
  assert.equal(action.kind, "fire-primary");
  assert.equal(action.defId, "liberator");
  assert.equal(action.family, "bullet");
});

test("deriveDiverAction: laser primary maps to laser family", () => {
  const s = snap({
    weapons: [{ id: "primary", defId: "sickle", reloadingPct: 1, rootsPlayer: false }],
    assignments: [{ weaponId: "primary", targetId: "e1", shots: 1 }],
  });
  const { action } = deriveDiverAction(s);
  assert.equal(action.family, "laser");
});

test("deriveDiverAction: secondary beats nothing", () => {
  const s = snap({
    weapons: [{ id: "secondary", defId: "redeemer", reloadingPct: 1, rootsPlayer: false }],
    assignments: [{ weaponId: "secondary", targetId: "e1", shots: 1 }],
  });
  const { action } = deriveDiverAction(s);
  assert.equal(action.kind, "fire-secondary");
});

test("deriveDiverAction: rooting reload outranks firing primary in same tick", () => {
  // rare but possible if a queued shot resolves while reload countdown ticks
  const s = snap({
    weapons: [
      { id: "primary", defId: "liberator", reloadingPct: 1, rootsPlayer: false },
      { id: "strat-1", defId: "recoilless", reloadingPct: 0.4, rootsPlayer: true, reloadSecs: 6 },
    ],
    assignments: [{ weaponId: "primary", targetId: "e1", shots: 1 }],
  });
  const { action } = deriveDiverAction(s);
  assert.equal(action.kind, "reload-heavy");
  assert.equal(action.defId, "recoilless");
  assert.ok(Math.abs(action.secsRemaining - 0.6 * 6) < 1e-9, `secsRemaining=${action.secsRemaining}`);
});

test("deriveDiverAction: light reload chosen when no heavy active and not firing primary", () => {
  const s = snap({
    weapons: [{ id: "primary", defId: "liberator", reloadingPct: 0.3, rootsPlayer: false, reloadSecs: 2 }],
  });
  const { action } = deriveDiverAction(s);
  assert.equal(action.kind, "reload-light");
  assert.equal(action.slot, "primary");
});

test("deriveDiverAction: support stratagem fired through assignments → fire-heavy when rocket-class", () => {
  const s = snap({
    weapons: [],
    stratagems: [{ id: "strat-1", defId: "recoilless", type: "support", callInPct: null }],
    assignments: [{ weaponId: "strat-1", targetId: "e1", shots: 1 }],
  });
  const { action } = deriveDiverAction(s);
  assert.equal(action.kind, "fire-heavy");
  assert.equal(action.defId, "recoilless");
});

test("deriveDiverAction: support stratagem flamethrower → fire-stratagem (not heavy)", () => {
  const s = snap({
    stratagems: [{ id: "strat-2", defId: "flamethrower", type: "support", callInPct: null }],
    assignments: [{ weaponId: "strat-2", targetId: "e1", shots: 1 }],
  });
  const { action } = deriveDiverAction(s);
  assert.equal(action.kind, "fire-stratagem");
  assert.equal(action.family, "flame");
});

test("deriveDiverAction: throw is sticky for ~700ms after a stratagem first becomes active", () => {
  // Tick 0: nothing in flight
  let m;
  ({ memory: m } = deriveDiverAction(snap({ t: 0, stratagems: [] })));

  // Tick 1: stratagem just thrown — callInPct now non-null
  const r1 = deriveDiverAction(
    snap({ t: 100, stratagems: [{ id: "strat-1", defId: "eagle-airstrike", type: "eagle", callInPct: 0.05 }] }),
    m,
  );
  assert.equal(r1.action.kind, "throw");
  assert.equal(r1.action.defId, "eagle-airstrike");

  // Tick 2: 600ms in, still in throw window
  const r2 = deriveDiverAction(
    snap({ t: 600, stratagems: [{ id: "strat-1", defId: "eagle-airstrike", type: "eagle", callInPct: 0.4 }] }),
    r1.memory,
  );
  assert.equal(r2.action.kind, "throw");

  // Tick 3: past throw window — should fall back to idle even though call-in still active
  const r3 = deriveDiverAction(
    snap({ t: 900, stratagems: [{ id: "strat-1", defId: "eagle-airstrike", type: "eagle", callInPct: 0.7 }] }),
    r2.memory,
  );
  assert.equal(r3.action.kind, "idle");
});

test("deriveDiverAction: a second stratagem thrown later restarts the throw window", () => {
  const m0 = { activeCallIns: new Set(["strat-1"]), throwUntilT: 0, throwingDefId: "eagle-airstrike" };
  // strat-2 newly appears in call-in
  const r = deriveDiverAction(
    snap({
      t: 5000,
      stratagems: [
        { id: "strat-1", defId: "eagle-airstrike", type: "eagle", callInPct: 0.9 },
        { id: "strat-2", defId: "orbital-precision", type: "orbital", callInPct: 0.05 },
      ],
    }),
    m0,
  );
  assert.equal(r.action.kind, "throw");
  assert.equal(r.action.defId, "orbital-precision");
});

test("deriveDiverAction: grenade fired surfaces throw-grenade", () => {
  const s = snap({
    weapons: [{ id: "grenade", defId: "frag", reloadingPct: 1, rootsPlayer: false }],
    assignments: [{ weaponId: "grenade", targetId: "e1", shots: 1 }],
  });
  const { action } = deriveDiverAction(s);
  assert.equal(action.kind, "throw-grenade");
});
