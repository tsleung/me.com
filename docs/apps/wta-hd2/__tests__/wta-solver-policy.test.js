import { test } from "node:test";
import assert from "node:assert/strict";
import { assign, policyDenies } from "../wta-solver.js";

// ---------- fixtures (deliberately tiny — policy tests don't need realism) ----

function w(id, over = {}) {
  // Convention in this file: ids beginning with "strat-" represent
  // stratagems (so they bypass the diver's one-held-weapon-per-tick gate).
  // Override `isStratagem` explicitly via `over` if needed.
  const isStrat = id.startsWith("strat-");
  return {
    id,
    slot: isStrat ? id : "primary",
    damage: 100,
    armorPen: 9,
    shotsAvailableThisTick: 1,
    aoeRadiusM: 0,
    weakPointHitRateBase: 0,
    maxRangeM: 100,
    isStratagem: isStrat,
    ...over,
  };
}

function t(id, tier, over = {}) {
  return {
    id,
    archetypeId: tier,
    threatTier: tier,
    hp: 50,
    parts: [{ ac: 1, hpFraction: 1, isWeakPoint: false, weakPointMultiplier: 1 }],
    position: { x: 0, y: 30 },
    distanceM: 30,
    timeToReachPlayerSecs: 10,
    meleeDps: 10,
    rangedDps: 0,
    attackRangeM: 2,
    ...over,
  };
}

// ---------- policyDenies ----------

test("policyDenies: missing policy → allow", () => {
  assert.equal(policyDenies(null, "primary", "heavy"), false);
  assert.equal(policyDenies({}, "primary", "heavy"), false);
});

test("policyDenies: cell set to deny → true", () => {
  assert.equal(policyDenies({ primary: { heavy: "deny" } }, "primary", "heavy"), true);
});

test("policyDenies: row exists but tier missing → allow", () => {
  assert.equal(policyDenies({ primary: { light: "deny" } }, "primary", "heavy"), false);
});

// ---------- deny prevents assignment under normal conditions ----------

test("deny prevents the denied weapon from firing when an alternative exists", () => {
  const wA = w("primary");        // denied for heavy
  const wB = w("strat-1");        // permitted
  const tH = t("tH", "heavy");
  const out = assign({
    weapons: [wA, wB],
    targets: [tH],
    alpha: 0.5,
    policy: { primary: { heavy: "deny" } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].weaponId, "strat-1", "denied weapon must not be chosen when an alternative is available");
});

test("deny lets the permitted weapon take a different tier without interference", () => {
  const wA = w("primary");
  const wB = w("strat-1");
  const tL = t("tL", "light");
  const tH = t("tH", "heavy");
  const out = assign({
    weapons: [wA, wB],
    targets: [tL, tH],
    alpha: 0.5,
    policy: { primary: { heavy: "deny" } },
  });
  // Both targets get covered; the primary takes the light, strat-1 takes the heavy.
  const byTarget = Object.fromEntries(out.map((a) => [a.targetId, a.weaponId]));
  assert.equal(byTarget.tL, "primary");
  assert.equal(byTarget.tH, "strat-1");
});

// ---------- fallback fires when every weapon would be denied ----------

test("fallback: when every weapon is denied for a target, deny is lifted for that target", () => {
  // Both weapons denied on heavy → solver should still engage the heavy
  // rather than leaving it un-shot. This is the "no permitted shooter" rule.
  const wA = w("primary");
  const wB = w("strat-1");
  const tH = t("tH", "heavy");
  const out = assign({
    weapons: [wA, wB],
    targets: [tH],
    alpha: 0.5,
    policy: {
      primary:   { heavy: "deny" },
      "strat-1": { heavy: "deny" },
    },
  });
  assert.equal(out.length, 1, "fallback must allow some assignment to fire");
  assert.equal(out[0].targetId, "tH");
});

test("fallback is per-target, not global: deny holds for tiers that have a permitted shooter", () => {
  // Two heavy targets, two weapons. primary denied on heavy; strat-1 permitted.
  // The first greedy pick must respect the policy: primary cannot take the
  // first heavy because strat-1 is a permitted alternative.
  const wA = w("primary",   { shotsAvailableThisTick: 1 });
  const wB = w("strat-1",   { shotsAvailableThisTick: 1 });
  const out = assign({
    weapons: [wA, wB],
    targets: [t("tH1", "heavy"), t("tH2", "heavy")],
    alpha: 0.5,
    policy: { primary: { heavy: "deny" } },
  });
  // strat-1 must take one of the heavies first; primary may then fall back
  // onto the second heavy (no remaining permitted shooter), but the FIRST
  // pick is the property under test.
  const firstByHeavy = out.find((a) => a.weaponId === "strat-1");
  assert.ok(firstByHeavy, "strat-1 (the only permitted shooter for heavy) must fire");
});

// ---------- deny + reserves are independent ----------

test("a denied + reserve-blocked weapon stays excluded; deny doesn't override reserves", () => {
  const wA = w("primary");
  const wB = w("strat-1", {
    reserveCfg: { enabled: true, minStockBeforeUseOnTier: { heavy: 999 } },
  });
  const tH = t("tH", "heavy");
  // primary denied for heavy, strat-1 reserve-blocked for heavy.
  // Fallback considers reserve-blocked weapons ineligible (they're reserved
  // for a future emergency); primary should fire via the policy fallback.
  const out = assign({
    weapons: [wA, wB],
    targets: [tH],
    alpha: 0.5,
    policy: { primary: { heavy: "deny" } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].weaponId, "primary",
    "primary should fire via policy fallback; reserve-blocked strat-1 is not an alternative");
});
