import { test } from "node:test";
import assert from "node:assert/strict";
import { mulberry32, hashString, pick, gaussian } from "../rng.js";

test("mulberry32 is deterministic across calls with same seed", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    assert.equal(a(), b());
  }
});

test("mulberry32 distinct seeds diverge immediately", () => {
  const r1 = mulberry32(1)();
  const r2 = mulberry32(2)();
  const r100 = mulberry32(100)();
  assert.notEqual(r1, r2);
  assert.notEqual(r1, r100);
  assert.notEqual(r2, r100);
});

test("mulberry32 output stays in [0, 1)", () => {
  const r = mulberry32(7);
  for (let i = 0; i < 1000; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test("mulberry32 distribution sanity over 10000 draws", () => {
  const r = mulberry32(123);
  let sum = 0;
  for (let i = 0; i < 10000; i++) sum += r();
  const mean = sum / 10000;
  assert.ok(Math.abs(mean - 0.5) < 0.02, `mean drifted: ${mean}`);
});

test("hashString is stable across calls", () => {
  assert.equal(hashString("abc"), hashString("abc"));
  assert.equal(hashString(""), hashString(""));
  assert.equal(hashString("hello world"), hashString("hello world"));
});

test("hashString distinguishes similar strings (no collisions in small set)", () => {
  const inputs = [
    "abc", "abd", "bcd", "cde", "def", "efg", "fgh", "ghi", "hij", "ijk",
    "loadout-a", "loadout-b", "scenario-1", "scenario-2", "diff-7", "diff-8",
    "predator", "predator-strain", "bot", "bug",
  ];
  const seen = new Set();
  for (const s of inputs) {
    const h = hashString(s);
    assert.ok(!seen.has(h), `collision on "${s}"`);
    seen.add(h);
  }
});

test("hashString returns an unsigned 32-bit integer", () => {
  const h = hashString("anything");
  assert.equal(typeof h, "number");
  assert.ok(Number.isInteger(h), `not integer: ${h}`);
  assert.ok(h >= 0 && h <= 0xffffffff, `out of u32 range: ${h}`);
});

test("pick is deterministic given same rng state and array", () => {
  const arr = ["a", "b", "c", "d", "e"];
  const r1 = mulberry32(99);
  const r2 = mulberry32(99);
  for (let i = 0; i < 50; i++) {
    assert.equal(pick(r1, arr), pick(r2, arr));
  }
});

test("pick covers full range over many draws", () => {
  const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const r = mulberry32(2025);
  const hits = new Set();
  for (let i = 0; i < 1000; i++) hits.add(pick(r, arr));
  assert.equal(hits.size, 10);
});

test("pick throws on empty array", () => {
  assert.throws(() => pick(mulberry32(1), []), /empty/);
});

test("gaussian sample mean and std converge", () => {
  const r = mulberry32(7);
  const n = 10000;
  const samples = new Array(n);
  for (let i = 0; i < n; i++) samples[i] = gaussian(r, 0, 1);
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  assert.ok(Math.abs(mean) < 0.05, `mean drifted: ${mean}`);
  assert.ok(Math.abs(std - 1) < 0.05, `std drifted: ${std}`);
});

test("gaussian honors mean and std parameters", () => {
  const r = mulberry32(42);
  const n = 5000;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += gaussian(r, 10, 3);
  const mean = sum / n;
  assert.ok(Math.abs(mean - 10) < 0.2, `mean off: ${mean}`);
});
