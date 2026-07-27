import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeRng,
  drawReds,
  shuffledDeck,
  freshShoe,
  shuffle,
} from "../deck.js";

test("makeRng: same seed → same stream (reproducible sims)", () => {
  const a = makeRng(42);
  const b = makeRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
});

test("makeRng: floats stay in [0, 1)", () => {
  const rng = makeRng(7);
  for (let i = 0; i < 1000; i++) {
    const x = rng();
    assert.ok(x >= 0 && x < 1, `out of range: ${x}`);
  }
});

test("drawReds: count is bounded by draws and by reds available", () => {
  const rng = makeRng(1);
  for (let i = 0; i < 500; i++) {
    const reds = drawReds(rng, 26, 52, 10);
    assert.ok(reds >= 0 && reds <= 10);
  }
});

test("drawReds: drawing the whole deck returns exactly all the reds", () => {
  const rng = makeRng(3);
  assert.equal(drawReds(rng, 26, 52, 52), 26);
  assert.equal(drawReds(rng, 13, 52, 52), 13);
});

test("drawReds: never exceeds reds when they are scarce", () => {
  const rng = makeRng(9);
  for (let i = 0; i < 500; i++) {
    assert.ok(drawReds(rng, 3, 52, 40) <= 3);
  }
});

test("drawReds: sample mean tracks the hypergeometric mean n·K/total", () => {
  const rng = makeRng(2024);
  const n = 8;
  let sum = 0;
  const trials = 40000;
  for (let i = 0; i < trials; i++) sum += drawReds(rng, 26, 52, n);
  const avg = sum / trials;
  assert.ok(Math.abs(avg - (n * 26) / 52) < 0.05, `avg=${avg}`);
});

test("shuffledDeck: is a permutation with the right composition", () => {
  const rng = makeRng(5);
  const deck = shuffledDeck(rng, 26, 52);
  assert.equal(deck.length, 52);
  assert.equal(deck.filter(Boolean).length, 26);
});

test("freshShoe: 52 cards, 26 red, 13 per suit, 4 per rank", () => {
  const shoe = freshShoe();
  assert.equal(shoe.length, 52);
  assert.equal(shoe.filter((c) => c.red).length, 26);
  for (const glyph of ["♠", "♥", "♦", "♣"]) {
    assert.equal(shoe.filter((c) => c.suit === glyph).length, 13);
  }
  for (const rank of ["A", "7", "K"]) {
    assert.equal(shoe.filter((c) => c.rank === rank).length, 4);
  }
});

test("shuffle: deterministic under a seed and preserves the multiset", () => {
  const a = shuffle(makeRng(5), freshShoe());
  const b = shuffle(makeRng(5), freshShoe());
  assert.deepEqual(
    a.map((c) => c.id),
    b.map((c) => c.id),
  );
  // every card id 0..51 still present exactly once
  const ids = new Set(a.map((c) => c.id));
  assert.equal(ids.size, 52);
});
