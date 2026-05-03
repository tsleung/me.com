import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeHash, decodeHash } from "../url-hash.js";

const CFG = {
  scenario: { faction: "terminids", subfaction: "predator-strain", encounter: "patrol", difficulty: 10 },
  loadout: {
    stratagems: ["eagle-500kg", "eat", "ac", "orbital-rail"],
    primary: "lib", secondary: "pm", grenade: "frag",
    armor: "fortified", booster: "vitality",
  },
  solver: { alpha: 0.7, reserves: {} },
  seed: 42,
};

test("encodeHash returns kv pairs", () => {
  const h = encodeHash(CFG);
  assert.ok(h.includes("fac=terminids"));
  assert.ok(h.includes("sub=predator-strain"));
  assert.ok(h.includes("diff=10"));
  assert.ok(h.includes("strats=eagle-500kg,eat,ac,orbital-rail"));
  assert.ok(h.includes("alpha=0.7"));
  assert.ok(h.includes("seed=42"));
});

test("encode→decode round-trips scenario", () => {
  const h = encodeHash(CFG);
  const d = decodeHash(`#${h}`);
  assert.equal(d.scenario.faction, "terminids");
  assert.equal(d.scenario.subfaction, "predator-strain");
  assert.equal(d.scenario.encounter, "patrol");
  assert.equal(d.scenario.difficulty, 10);
});

test("encode→decode round-trips loadout including stratagems array", () => {
  const h = encodeHash(CFG);
  const d = decodeHash(h);
  assert.deepEqual(d.loadout.stratagems, ["eagle-500kg", "eat", "ac", "orbital-rail"]);
  assert.equal(d.loadout.primary, "lib");
  assert.equal(d.loadout.armor, "fortified");
});

test("encode→decode round-trips solver and seed with type fidelity", () => {
  const d = decodeHash(encodeHash(CFG));
  assert.equal(typeof d.solver.alpha, "number");
  assert.equal(d.solver.alpha, 0.7);
  assert.equal(typeof d.seed, "number");
  assert.equal(d.seed, 42);
});

test("decodeHash on empty / null returns null", () => {
  assert.equal(decodeHash(""), null);
  assert.equal(decodeHash(null), null);
  assert.equal(decodeHash("#"), null);
});

test("decodeHash skips unknown keys", () => {
  const d = decodeHash("#bogus=foo&fac=automatons&unknown=bar");
  assert.equal(d.scenario.faction, "automatons");
});

test("decodeHash with partial fields produces partial cfg", () => {
  const d = decodeHash("#fac=illuminate&diff=8");
  assert.equal(d.scenario.faction, "illuminate");
  assert.equal(d.scenario.difficulty, 8);
  assert.equal(d.scenario.subfaction, undefined);
  assert.equal(d.loadout.primary, undefined);
});

test("encodeHash handles missing fields without throwing", () => {
  const partial = { scenario: { faction: "automatons" } };
  const h = encodeHash(partial);
  assert.ok(h.includes("fac=automatons"));
});

test("encodeHash properly escapes special chars in subfaction", () => {
  const cfg = { scenario: { faction: "terminids", subfaction: "test value & more", encounter: "patrol", difficulty: 5 } };
  const h = encodeHash(cfg);
  const d = decodeHash(h);
  assert.equal(d.scenario.subfaction, "test value & more");
});

test("missing strats key results in null stratagems entries", () => {
  const d = decodeHash("#fac=terminids");
  assert.deepEqual(d.loadout.stratagems, [null, null, null, null]);
});

test("strats with empty slot preserved as null", () => {
  const d = decodeHash("#strats=eat,,ac,");
  assert.deepEqual(d.loadout.stratagems, ["eat", null, "ac", null]);
});
