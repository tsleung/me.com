import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOutcome } from "../../features/verdict.js";

test("verdict: empty arc + no incoming → clear", () => {
  const snap = { t: 30000, tickN: 300, player: { hp: 1 }, enemies: [], nextSpawnT: null };
  assert.equal(classifyOutcome(snap), "clear");
});

test("verdict: empty arc but incoming spawn within 5s → in-progress", () => {
  const snap = { t: 30000, tickN: 300, player: { hp: 1 }, enemies: [], nextSpawnT: 32000 };
  assert.equal(classifyOutcome(snap), "in-progress");
});

test("verdict: empty arc with incoming spawn beyond horizon → clear", () => {
  const snap = { t: 30000, tickN: 300, player: { hp: 1 }, enemies: [], nextSpawnT: 60000 };
  assert.equal(classifyOutcome(snap), "clear");
});

test("verdict: diver hp=0 → wipe (overrides everything else)", () => {
  const snap = { t: 30000, tickN: 300, player: { hp: 0 }, enemies: [], nextSpawnT: null };
  assert.equal(classifyOutcome(snap), "wipe");
});

test("verdict: alive enemies → in-progress", () => {
  const snap = { t: 30000, tickN: 300, player: { hp: 1 }, enemies: [{ alive: true }], nextSpawnT: null };
  assert.equal(classifyOutcome(snap), "in-progress");
});

test("verdict: stalemate when maxTicks reached with both alive", () => {
  const snap = { t: 30000, tickN: 300, player: { hp: 1 }, enemies: [{ alive: true }], nextSpawnT: null };
  assert.equal(classifyOutcome(snap, { maxTicks: 300 }), "stalemate");
});

test("verdict: clearHorizonMs override extends the 'no incoming' window", () => {
  const snap = { t: 30000, tickN: 300, player: { hp: 1 }, enemies: [], nextSpawnT: 35000 };
  assert.equal(classifyOutcome(snap, { clearHorizonMs: 10000 }), "in-progress");
  assert.equal(classifyOutcome(snap, { clearHorizonMs: 4000 }),  "clear");
});

test("verdict: dead enemies don't keep the engagement open", () => {
  const snap = {
    t: 30000, tickN: 300, player: { hp: 1 },
    enemies: [{ alive: false }, { alive: false }], nextSpawnT: null,
  };
  assert.equal(classifyOutcome(snap), "clear");
});
