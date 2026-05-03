import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACTIONS,
  THREAT_TIERS,
  WEAPON_SLOTS,
  STRATAGEM_TYPES,
  ENCOUNTER_TYPES,
  validateEnemy,
  validateWeapon,
  validateStratagem,
  validateEncounter,
  validateArmor,
  validateBooster,
  validateDataBundle,
} from "../data-schema.js";

// --- minimal valid fixtures (factory functions for easy mutation) -----------

function makeEnemy(overrides = {}) {
  return {
    id: "scavenger",
    name: "Scavenger",
    faction: "terminids",
    subfactionTags: ["standard"],
    threatTier: "light",
    hp: 50,
    parts: [
      { name: "body", ac: 1, hpFraction: 0.7, isWeakPoint: false, weakPointMultiplier: 1 },
      { name: "head", ac: 1, hpFraction: 0.3, isWeakPoint: true, weakPointMultiplier: 2 },
    ],
    speedMps: 4,
    attackRangeM: 2,
    meleeDps: 10,
    rangedDps: 0,
    ...overrides,
  };
}

function makeWeapon(overrides = {}) {
  return {
    id: "liberator",
    name: "AR-23 Liberator",
    slot: "primary",
    damage: 60,
    durableDamage: 12,
    armorPen: 2,
    fireRateRpm: 640,
    magazine: 45,
    reloadSecs: 2.5,
    ammoReserve: 270,
    aoeRadiusM: 0,
    falloffStartM: 50,
    maxRangeM: 100,
    weakPointHitRateBase: 0.6,
    ammoType: "medium",
    ...overrides,
  };
}

function makeStratagem(overrides = {}) {
  return {
    id: "eagle-airstrike",
    name: "Eagle Airstrike",
    type: "eagle",
    callInSecs: 2,
    cooldownSecs: 8,
    uses: 2,
    effects: [{ kind: "damage", damage: 800, ap: 5, aoeRadiusM: 12 }],
    ...overrides,
  };
}

function makeEncounter(overrides = {}) {
  return {
    faction: "terminids",
    subfaction: "standard",
    type: "patrol",
    difficulty: 5,
    composition: [
      {
        enemyId: "scavenger",
        count: { dist: "poisson", mean: 6 },
        spawnTimeSecs: 0,
        spawnArc: { minDeg: -60, maxDeg: 60, distanceM: 70 },
      },
    ],
    maxConcurrent: 12,
    ...overrides,
  };
}

function makeArmor(overrides = {}) {
  return { id: "extra-padding", name: "Extra Padding", effect: "+1 armor rating", ...overrides };
}

function makeBooster(overrides = {}) {
  return { id: "vitality", name: "Vitality Enhancement", effect: "+20% max HP", ...overrides };
}

function makeBundle(overrides = {}) {
  return {
    meta: { version: 1 },
    factions: { terminids: { name: "Terminids", subfactions: [{ id: "standard", name: "standard" }] } },
    enemies: [makeEnemy()],
    weapons: {
      primaries: [makeWeapon()],
      secondaries: [makeWeapon({ id: "peacemaker", name: "P-2 Peacemaker", slot: "secondary" })],
      grenades: [makeWeapon({ id: "frag", name: "G-12 Frag", slot: "grenade", aoeRadiusM: 6 })],
    },
    stratagems: [makeStratagem()],
    armor: [makeArmor()],
    boosters: [makeBooster()],
    spawnTables: [makeEncounter()],
    ...overrides,
  };
}

// --- enum exports -----------------------------------------------------------

test("enums are exported as the documented sets", () => {
  assert.deepEqual(FACTIONS, ["terminids", "automatons", "illuminate"]);
  assert.deepEqual(THREAT_TIERS, ["light", "medium", "heavy", "boss"]);
  assert.deepEqual(WEAPON_SLOTS, ["primary", "secondary", "grenade", "support"]);
  assert.deepEqual(STRATAGEM_TYPES, ["orbital", "eagle", "sentry", "support", "backpack", "emplacement"]);
  assert.deepEqual(ENCOUNTER_TYPES, ["patrol", "breach", "drop"]);
});

// --- validateEnemy ----------------------------------------------------------

test("validateEnemy accepts a minimal valid enemy", () => {
  const r = validateEnemy(makeEnemy());
  assert.equal(r.ok, true, r.errors.join("\n"));
  assert.deepEqual(r.errors, []);
});

test("validateEnemy: missing id fails", () => {
  const e = makeEnemy();
  delete e.id;
  const r = validateEnemy(e);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("id") && m.includes("missing")));
});

test("validateEnemy: bad faction enum fails", () => {
  const r = validateEnemy(makeEnemy({ faction: "cyborgs" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("faction")));
});

test("validateEnemy: hp wrong type fails", () => {
  const r = validateEnemy(makeEnemy({ hp: "fifty" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("hp")));
});

test("validateEnemy: part ac out of range fails", () => {
  const r = validateEnemy(makeEnemy({
    parts: [
      { name: "body", ac: 10, hpFraction: 0.7, isWeakPoint: false, weakPointMultiplier: 1 },
      { name: "head", ac: 1, hpFraction: 0.3, isWeakPoint: true, weakPointMultiplier: 2 },
    ],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("ac")));
});

test("validateEnemy: bad threatTier fails", () => {
  const r = validateEnemy(makeEnemy({ threatTier: "ultra" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("threatTier")));
});

test("validateEnemy: hpFraction sum 0.5 fails", () => {
  const r = validateEnemy(makeEnemy({
    parts: [
      { name: "body", ac: 1, hpFraction: 0.3, isWeakPoint: false, weakPointMultiplier: 1 },
      { name: "head", ac: 1, hpFraction: 0.2, isWeakPoint: true, weakPointMultiplier: 2 },
    ],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("hpFraction sum")));
});

test("validateEnemy: hpFraction sum exactly 1.0 passes", () => {
  const r = validateEnemy(makeEnemy({
    parts: [
      { name: "a", ac: 1, hpFraction: 0.5, isWeakPoint: false, weakPointMultiplier: 1 },
      { name: "b", ac: 1, hpFraction: 0.5, isWeakPoint: false, weakPointMultiplier: 1 },
    ],
  }));
  assert.equal(r.ok, true, r.errors.join("\n"));
});

test("validateEnemy: hpFraction sum 1.005 passes (within tolerance)", () => {
  const r = validateEnemy(makeEnemy({
    parts: [
      { name: "a", ac: 1, hpFraction: 0.505, isWeakPoint: false, weakPointMultiplier: 1 },
      { name: "b", ac: 1, hpFraction: 0.5, isWeakPoint: false, weakPointMultiplier: 1 },
    ],
  }));
  assert.equal(r.ok, true, r.errors.join("\n"));
});

test("validateEnemy: hpFraction sum 1.5 fails", () => {
  const r = validateEnemy(makeEnemy({
    parts: [
      { name: "a", ac: 1, hpFraction: 0.75, isWeakPoint: false, weakPointMultiplier: 1 },
      { name: "b", ac: 1, hpFraction: 0.75, isWeakPoint: false, weakPointMultiplier: 1 },
    ],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("hpFraction sum")));
});

test("validateEnemy(null) returns ok=false without throwing", () => {
  const r = validateEnemy(null);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test("validateEnemy(undefined) returns ok=false without throwing", () => {
  const r = validateEnemy(undefined);
  assert.equal(r.ok, false);
});

test("validateEnemy(string) returns ok=false without throwing", () => {
  const r = validateEnemy("hello");
  assert.equal(r.ok, false);
});

// --- validateWeapon ---------------------------------------------------------

test("validateWeapon accepts a minimal valid weapon", () => {
  const r = validateWeapon(makeWeapon());
  assert.equal(r.ok, true, r.errors.join("\n"));
});

test("validateWeapon: missing slot fails", () => {
  const w = makeWeapon();
  delete w.slot;
  const r = validateWeapon(w);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("slot")));
});

test("validateWeapon: bad slot enum fails", () => {
  const r = validateWeapon(makeWeapon({ slot: "melee" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("slot")));
});

test("validateWeapon: armorPen 0 fails", () => {
  const r = validateWeapon(makeWeapon({ armorPen: 0 }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("armorPen")));
});

test("validateWeapon: armorPen 10 fails", () => {
  const r = validateWeapon(makeWeapon({ armorPen: 10 }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("armorPen")));
});

test("validateWeapon: armorPen 1 passes", () => {
  assert.equal(validateWeapon(makeWeapon({ armorPen: 1 })).ok, true);
});

test("validateWeapon: armorPen 9 passes", () => {
  assert.equal(validateWeapon(makeWeapon({ armorPen: 9 })).ok, true);
});

test("validateWeapon: damage wrong type fails", () => {
  const r = validateWeapon(makeWeapon({ damage: "hi" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("damage")));
});

test("validateWeapon: weakPointHitRateBase > 1 fails", () => {
  const r = validateWeapon(makeWeapon({ weakPointHitRateBase: 1.5 }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("weakPointHitRateBase")));
});

test("validateWeapon(null) does not throw", () => {
  assert.equal(validateWeapon(null).ok, false);
});

// --- validateStratagem ------------------------------------------------------

test("validateStratagem accepts a minimal valid stratagem", () => {
  const r = validateStratagem(makeStratagem());
  assert.equal(r.ok, true, r.errors.join("\n"));
});

test("validateStratagem accepts uses=null", () => {
  const r = validateStratagem(makeStratagem({ uses: null }));
  assert.equal(r.ok, true, r.errors.join("\n"));
});

test("validateStratagem accepts empty effects array", () => {
  const r = validateStratagem(makeStratagem({ effects: [] }));
  assert.equal(r.ok, true, r.errors.join("\n"));
});

test("validateStratagem: missing effects fails", () => {
  const s = makeStratagem();
  delete s.effects;
  const r = validateStratagem(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("effects")));
});

test("validateStratagem: bad type enum fails", () => {
  const r = validateStratagem(makeStratagem({ type: "exosuit" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("type")));
});

test("validateStratagem: effect with bad kind fails", () => {
  const r = validateStratagem(makeStratagem({ effects: [{ kind: "heal" }] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("kind")));
});

test("validateStratagem: cooldownSecs negative fails", () => {
  const r = validateStratagem(makeStratagem({ cooldownSecs: -1 }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("cooldownSecs")));
});

test("validateStratagem(null) does not throw", () => {
  assert.equal(validateStratagem(null).ok, false);
});

// --- validateEncounter ------------------------------------------------------

test("validateEncounter accepts a minimal valid encounter", () => {
  const r = validateEncounter(makeEncounter());
  assert.equal(r.ok, true, r.errors.join("\n"));
});

test("validateEncounter: difficulty 0 fails", () => {
  const r = validateEncounter(makeEncounter({ difficulty: 0 }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("difficulty")));
});

test("validateEncounter: difficulty 11 fails", () => {
  const r = validateEncounter(makeEncounter({ difficulty: 11 }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("difficulty")));
});

test("validateEncounter: difficulty 1 passes", () => {
  assert.equal(validateEncounter(makeEncounter({ difficulty: 1 })).ok, true);
});

test("validateEncounter: difficulty 10 passes", () => {
  assert.equal(validateEncounter(makeEncounter({ difficulty: 10 })).ok, true);
});

test("validateEncounter: bad type enum fails", () => {
  const r = validateEncounter(makeEncounter({ type: "ambush" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("type")));
});

test("validateEncounter: composition entry with bad count.dist fails", () => {
  const r = validateEncounter(makeEncounter({
    composition: [{
      enemyId: "scavenger",
      count: { dist: "uniform", mean: 6 },
      spawnTimeSecs: 0,
      spawnArc: { minDeg: 0, maxDeg: 90, distanceM: 60 },
    }],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("dist")));
});

test("validateEncounter: missing maxConcurrent fails", () => {
  const e = makeEncounter();
  delete e.maxConcurrent;
  const r = validateEncounter(e);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("maxConcurrent")));
});

test("validateEncounter(null) does not throw", () => {
  assert.equal(validateEncounter(null).ok, false);
});

// --- validateArmor / validateBooster ----------------------------------------

test("validateArmor accepts a minimal valid armor", () => {
  assert.equal(validateArmor(makeArmor()).ok, true);
});

test("validateArmor: missing name fails", () => {
  const a = makeArmor();
  delete a.name;
  const r = validateArmor(a);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("name")));
});

test("validateArmor: id wrong type fails", () => {
  const r = validateArmor(makeArmor({ id: 123 }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("id")));
});

test("validateArmor(null) does not throw", () => {
  assert.equal(validateArmor(null).ok, false);
});

test("validateBooster accepts a minimal valid booster", () => {
  assert.equal(validateBooster(makeBooster()).ok, true);
});

test("validateBooster: missing effect fails", () => {
  const b = makeBooster();
  delete b.effect;
  const r = validateBooster(b);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("effect")));
});

test("validateBooster(null) does not throw", () => {
  assert.equal(validateBooster(null).ok, false);
});

// --- validateDataBundle -----------------------------------------------------

test("validateDataBundle accepts a minimal valid bundle", () => {
  const r = validateDataBundle(makeBundle());
  assert.equal(r.ok, true, r.errors.join("\n"));
});

test("validateDataBundle: missing meta/factions fails", () => {
  const r = validateDataBundle(makeBundle({ meta: null, factions: null }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("meta")));
  assert.ok(r.errors.some((m) => m.includes("factions")));
});

test("validateDataBundle: bad enemy is reported with index and id", () => {
  const bundle = makeBundle({
    enemies: [makeEnemy(), makeEnemy({ id: "broken", faction: "cyborgs" })],
  });
  const r = validateDataBundle(bundle);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("bundle.enemies[1]") && m.includes("broken") && m.includes("faction")));
});

test("validateDataBundle: bad weapon in secondaries is reported with sub-path", () => {
  const bundle = makeBundle();
  bundle.weapons.secondaries[0] = makeWeapon({ id: "bad", slot: "melee" });
  const r = validateDataBundle(bundle);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("bundle.weapons.secondaries[0]") && m.includes("bad") && m.includes("slot")));
});

test("validateDataBundle: weapons not an object fails", () => {
  const r = validateDataBundle(makeBundle({ weapons: [] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("weapons")));
});

test("validateDataBundle: accumulates errors across categories", () => {
  const bundle = makeBundle({
    enemies: [makeEnemy({ faction: "x" })],
    stratagems: [makeStratagem({ type: "y" })],
    spawnTables: [makeEncounter({ difficulty: 0 })],
  });
  const r = validateDataBundle(bundle);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("enemies")));
  assert.ok(r.errors.some((m) => m.includes("stratagems")));
  assert.ok(r.errors.some((m) => m.includes("spawnTables")));
});

test("validateDataBundle(null) does not throw", () => {
  assert.equal(validateDataBundle(null).ok, false);
});
