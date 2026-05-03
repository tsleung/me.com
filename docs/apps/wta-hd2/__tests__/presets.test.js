import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDataSync } from "../data-loader.js";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

test("presets.json loads and is non-empty", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  assert.ok(Array.isArray(data.presets), "presets must be array");
  assert.ok(data.presets.length >= 5, `expected ≥5 presets, got ${data.presets.length}`);
});

test("every preset has required keys", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  for (const p of data.presets) {
    assert.equal(typeof p.id, "string", `preset missing id`);
    assert.equal(typeof p.name, "string", `${p.id} missing name`);
    assert.ok(p.scenario, `${p.id} missing scenario`);
    assert.ok(p.loadout, `${p.id} missing loadout`);
    assert.equal(typeof p.scenario.faction, "string", `${p.id} scenario.faction missing`);
    assert.ok(["patrol","breach","drop"].includes(p.scenario.encounter), `${p.id} bad encounter`);
    assert.ok(p.scenario.difficulty >= 1 && p.scenario.difficulty <= 10, `${p.id} bad difficulty`);
    assert.ok(Array.isArray(p.loadout.stratagems) && p.loadout.stratagems.length === 4,
      `${p.id} stratagems must be 4-array`);
  }
});

test("every preset id is unique", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const ids = data.presets.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate preset ids");
});

test("every preset references real weapon/stratagem/armor/booster ids", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const primIds  = new Set(data.weapons.primaries.map((w) => w.id));
  const secIds   = new Set(data.weapons.secondaries.map((w) => w.id));
  const grenIds  = new Set(data.weapons.grenades.map((w) => w.id));
  const stratIds = new Set(data.stratagems.map((s) => s.id));
  const armorIds = new Set(data.armor.map((a) => a.id));
  const boosterIds = new Set(data.boosters.map((b) => b.id));
  const facIds = new Set(Object.keys(data.factions));

  for (const p of data.presets) {
    const l = p.loadout;
    assert.ok(primIds.has(l.primary), `${p.id}: unknown primary "${l.primary}"`);
    assert.ok(secIds.has(l.secondary), `${p.id}: unknown secondary "${l.secondary}"`);
    assert.ok(grenIds.has(l.grenade), `${p.id}: unknown grenade "${l.grenade}"`);
    for (const s of l.stratagems) {
      assert.ok(stratIds.has(s), `${p.id}: unknown stratagem "${s}"`);
    }
    assert.ok(armorIds.has(l.armor), `${p.id}: unknown armor "${l.armor}"`);
    assert.ok(boosterIds.has(l.booster), `${p.id}: unknown booster "${l.booster}"`);
    assert.ok(facIds.has(p.scenario.faction), `${p.id}: unknown faction "${p.scenario.faction}"`);
  }
});

test("the five named presets exist", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const names = data.presets.map((p) => p.id);
  for (const required of ["default-helldiver", "infinite-no-reload", "spear-anti-tank", "recoilless-anti-tank", "autocannon-allrounder", "supply-scorcher"]) {
    assert.ok(names.includes(required), `missing preset: ${required}`);
  }
});

test("infinite-no-reload uses Sickle + melee secondary + Quasar + Guard Dog", async () => {
  const data = await loadDataSync(DATA_DIR, { onWarn: () => {} });
  const p = data.presets.find((x) => x.id === "infinite-no-reload");
  assert.ok(p);
  assert.equal(p.loadout.primary, "sickle");
  // melee secondary — id should reference a melee weapon
  const sec = data.weapons.secondaries.find((s) => s.id === p.loadout.secondary);
  assert.ok(sec);
  assert.ok(sec.name.toLowerCase().includes("melee") || sec.id.includes("lance") || sec.id.includes("baton"),
    `expected melee secondary, got ${sec.name}`);
  assert.ok(p.loadout.stratagems.includes("quasar"), "missing quasar");
  assert.ok(p.loadout.stratagems.includes("guard-dog"), "missing guard-dog");
});
