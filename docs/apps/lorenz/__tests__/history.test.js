import { test } from "node:test";
import assert from "node:assert/strict";
import { ringBuffer, sampler } from "../history.js";

test("ring buffer fills, then overwrites oldest-first", () => {
  const rb = ringBuffer(4);
  assert.equal(rb.size, 0);
  assert.equal(rb.last(), undefined);
  assert.equal(rb.first(), undefined);
  assert.deepEqual(rb.toArray(), []);

  for (const v of [1, 2, 3]) rb.push(v);
  assert.equal(rb.size, 3);
  assert.deepEqual(rb.toArray(), [1, 2, 3]);
  assert.equal(rb.first(), 1);
  assert.equal(rb.last(), 3);

  for (const v of [4, 5, 6]) rb.push(v);
  assert.equal(rb.size, 4, "size caps at capacity");
  assert.deepEqual(rb.toArray(), [3, 4, 5, 6], "oldest-first, oldest dropped");
  assert.equal(rb.first(), 3);
  assert.equal(rb.last(), 6);
});

test("ring buffer survives many wraps and reports capacity", () => {
  const rb = ringBuffer(50);
  for (let i = 0; i < 5000; i++) rb.push(i);
  assert.equal(rb.capacity, 50);
  assert.equal(rb.size, 50);
  const arr = rb.toArray();
  assert.equal(arr[0], 4950);
  assert.equal(arr.at(-1), 4999);
  for (let i = 1; i < arr.length; i++) {
    assert.equal(arr[i] - arr[i - 1], 1, "order must be preserved across the wrap");
  }
});

test("clear empties the buffer and it is reusable afterwards", () => {
  const rb = ringBuffer(3);
  rb.push("a");
  rb.push("b");
  rb.clear();
  assert.equal(rb.size, 0);
  assert.deepEqual(rb.toArray(), []);
  rb.push("c");
  assert.deepEqual(rb.toArray(), ["c"]);
});

test("sampler gates on simulated time, not call count", () => {
  const s = sampler(0.5);
  assert.equal(s.due(0), true, "first call is always due");
  assert.equal(s.due(0.1), false);
  assert.equal(s.due(0.49), false);
  assert.equal(s.due(0.5), true);
  assert.equal(s.due(0.6), false);
  assert.equal(s.due(1.0), true);
});

test("sampler catches up rather than back-filling after a long jump", () => {
  const s = sampler(0.1);
  s.due(0);
  // A big simulated jump (fast playback) yields exactly one sample, not many.
  assert.equal(s.due(10), true);
  assert.equal(s.due(10.05), false);
  assert.equal(s.due(10.1), true);
});

test("sampler reset makes the next call due", () => {
  const s = sampler(1);
  s.due(0);
  assert.equal(s.due(0.5), false);
  s.reset();
  assert.equal(s.due(0.5), true);
});
