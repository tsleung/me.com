import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDataSync } from "../data-loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_DATA_DIR = path.join(__dirname, "..", "data");

function makeTempDir() {
  return mkdtempSync(path.join(tmpdir(), "wta-hd2-loader-"));
}

function copyAllFrom(srcDir, dstDir) {
  for (const f of readdirSync(srcDir)) copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
}

function writeJSON(dir, name, value) {
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value));
}

function minimalNonStubBundle() {
  // A meta.json without `stub:true` so validation errors are fatal,
  // plus the smallest valid set of files. Used for failure-path tests.
  const meta = { schemaVersion: 1, builtAt: "2026-05-03T00:00:00Z" };
  const factions = { terminids: { name: "Terminids", subfactions: [{ id: "standard", name: "standard" }] } };
  const weapons = {
    primaries: [validWeapon("liberator")],
    secondaries: [validWeapon("peacemaker")],
    grenades: [validWeapon("frag")],
  };
  const stratagems = [validStratagem("eagle-airstrike")];
  const armor = [{ id: "extra-padding", name: "Extra Padding", effect: "+1 armor rating" }];
  const boosters = [{ id: "vitality", name: "Vitality", effect: "+20% HP" }];
  return { meta, factions, weapons, stratagems, armor, boosters };
}

function validWeapon(id) {
  return {
    id, name: id, slot: "primary",
    damage: 50, durableDamage: 25, armorPen: 2, fireRateRpm: 600,
    magazine: 30, reloadSecs: 2, ammoReserve: 90, aoeRadiusM: 0,
    falloffStartM: 30, maxRangeM: 80, weakPointHitRateBase: 0.3, ammoType: "kinetic",
  };
}

function validStratagem(id) {
  return {
    id, name: id, type: "eagle",
    callInSecs: 3, cooldownSecs: 8, uses: 2, effects: [],
  };
}

function writeMinimalNonStub(dir, overrides = {}) {
  const b = { ...minimalNonStubBundle(), ...overrides };
  writeJSON(dir, "meta", b.meta);
  writeJSON(dir, "factions", b.factions);
  writeJSON(dir, "weapons", b.weapons);
  writeJSON(dir, "stratagems", b.stratagems);
  writeJSON(dir, "armor", b.armor);
  writeJSON(dir, "boosters", b.boosters);
  return dir;
}

// ---------------------------------------------------------------------------

test("loadDataSync: happy path on real stub data dir", async () => {
  const warns = [];
  const bundle = await loadDataSync(REAL_DATA_DIR, { onWarn: (m) => warns.push(m) });

  assert.ok(bundle.meta && typeof bundle.meta === "object");
  assert.ok(bundle.factions && typeof bundle.factions === "object");
  assert.ok(Array.isArray(bundle.enemies));
  assert.ok(bundle.weapons && Array.isArray(bundle.weapons.primaries));
  assert.ok(bundle.weapons.primaries.length > 0, "primaries non-empty");
  assert.ok(Array.isArray(bundle.weapons.secondaries));
  assert.ok(Array.isArray(bundle.weapons.grenades));
  assert.ok(Array.isArray(bundle.stratagems), "stratagems is plain array");
  assert.ok(bundle.stratagems.length > 0);
  assert.ok(Array.isArray(bundle.armor));
  assert.ok(Array.isArray(bundle.boosters));
  assert.ok(Array.isArray(bundle.spawnTables));

  // _stub keys stripped at file level
  assert.equal(bundle.meta._stub, undefined);
  assert.equal(bundle.meta.stub, true, "meta.stub flag preserved (not underscore-prefixed)");
});

test("loadDataSync: missing optional file warns + defaults to []", async () => {
  const dir = writeMinimalNonStub(makeTempDir());
  try {
    const warns = [];
    const bundle = await loadDataSync(dir, { onWarn: (m) => warns.push(m) });
    assert.deepEqual(bundle.enemies, []);
    assert.deepEqual(bundle.spawnTables, []);
    assert.ok(warns.some((w) => w.includes("enemies.json")), `warn for enemies (got ${JSON.stringify(warns)})`);
    assert.ok(warns.some((w) => w.includes("spawn-tables.json")), `warn for spawn-tables`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDataSync: validation failure surfaces with file path + specific error", async () => {
  const dir = makeTempDir();
  try {
    const bad = minimalNonStubBundle();
    bad.weapons.primaries[0].armorPen = 99;  // out of [1,9]
    writeMinimalNonStub(dir, bad);

    let caught = null;
    try { await loadDataSync(dir); } catch (e) { caught = e; }
    assert.ok(caught, "expected rejection");
    const msg = aggregateMessages(caught);
    assert.ok(msg.includes("weapons.json"), `error mentions file path; got: ${msg}`);
    assert.ok(msg.includes("armorPen"), `error mentions specific field; got: ${msg}`);
    assert.ok(msg.includes("99"), `error mentions bad value; got: ${msg}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDataSync: missing required file rejects", async () => {
  const dir = writeMinimalNonStub(makeTempDir());
  try {
    rmSync(path.join(dir, "weapons.json"));
    let caught = null;
    try { await loadDataSync(dir); } catch (e) { caught = e; }
    assert.ok(caught, "expected rejection for missing required file");
    const msg = aggregateMessages(caught);
    assert.ok(msg.includes("weapons.json"), `mentions missing file; got: ${msg}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDataSync: returned bundle is JSON-serializable", async () => {
  const bundle = await loadDataSync(REAL_DATA_DIR, { onWarn: () => {} });
  const round = JSON.parse(JSON.stringify(bundle));
  assert.deepEqual(round, bundle);
});

test("loadDataSync: normalization unwraps {stratagems:[...]} AND accepts raw array", async () => {
  // Wrapped form (today's stub).
  const dirA = writeMinimalNonStub(makeTempDir());
  // Raw-array form (what M2 build script will produce).
  const dirB = writeMinimalNonStub(makeTempDir());
  try {
    writeJSON(dirA, "stratagems", { stratagems: [validStratagem("eagle-airstrike")] });
    const a = await loadDataSync(dirA);
    assert.ok(Array.isArray(a.stratagems));
    assert.equal(a.stratagems.length, 1);
    assert.equal(a.stratagems[0].id, "eagle-airstrike");

    writeJSON(dirB, "stratagems", [validStratagem("eagle-cluster"), validStratagem("orbital-laser")]);
    // override the eagle-cluster/orbital-laser default callInSecs etc — already valid
    // Need orbital type for second:
    writeJSON(dirB, "stratagems", [
      validStratagem("eagle-cluster"),
      { ...validStratagem("orbital-laser"), type: "orbital" },
    ]);
    const b = await loadDataSync(dirB);
    assert.ok(Array.isArray(b.stratagems));
    assert.equal(b.stratagems.length, 2);
    assert.equal(b.stratagems[0].id, "eagle-cluster");
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("loadDataSync: armor/boosters wrapped + raw both unwrap", async () => {
  const dir = writeMinimalNonStub(makeTempDir());
  try {
    writeJSON(dir, "armor", { passives: [{ id: "ep", name: "EP", effect: "x" }] });
    writeJSON(dir, "boosters", [{ id: "v", name: "V", effect: "y" }]);
    const bundle = await loadDataSync(dir);
    assert.ok(Array.isArray(bundle.armor));
    assert.equal(bundle.armor[0].id, "ep");
    assert.ok(Array.isArray(bundle.boosters));
    assert.equal(bundle.boosters[0].id, "v");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

function aggregateMessages(err) {
  const parts = [err.message ?? String(err)];
  if (Array.isArray(err.errors)) for (const e of err.errors) parts.push(e.message ?? String(e));
  return parts.join(" | ");
}
