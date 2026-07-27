// drawTrail is the only real branching logic in render.js: run batching, the
// past-the-cutoff branch, and the gap-break that stops a vertex being joined
// to one on the far side of a hole. It is pure apart from its ctx calls, so a
// recording fake is enough to test all of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCamera, project, drawTrail } from "../render.js";

/** Minimal canvas 2D stand-in that records the calls we care about. */
function fakeCtx() {
  const calls = [];
  return {
    calls,
    strokes: () => calls.filter((c) => c[0] === "stroke").length,
    lineTos: () => calls.filter((c) => c[0] === "lineTo"),
    moveTos: () => calls.filter((c) => c[0] === "moveTo"),
    widths: () => calls.filter((c) => c[0] === "lineWidth").map((c) => c[1]),
    set strokeStyle(v) {
      calls.push(["strokeStyle", v]);
    },
    set lineWidth(v) {
      calls.push(["lineWidth", v]);
    },
    beginPath() {
      calls.push(["beginPath"]);
    },
    moveTo(x, y) {
      calls.push(["moveTo", x, y]);
    },
    lineTo(x, y) {
      calls.push(["lineTo", x, y]);
    },
    stroke() {
      calls.push(["stroke"]);
    },
  };
}

const cam = makeCamera(800, 600);
const uniform = () => ({ rgb: { r: 200, g: 100, b: 50 }, width: 2, alpha: 1 });

/** n samples on a line, one per unit of simulated time, ending at t = n-1. */
const ramp = (n) =>
  Array.from({ length: n }, (_, i) => ({ x: i, y: 0, z: 25 + i, t: i }));

test("nothing to draw is not an error", () => {
  for (const [samples, span] of [
    [[], 10],
    [[{ x: 0, y: 0, z: 0, t: 0 }], 10],
    [ramp(10), 0],
    [ramp(10), -1],
  ]) {
    const ctx = fakeCtx();
    assert.equal(drawTrail(ctx, cam, samples, 10, span, uniform), 0);
    assert.equal(ctx.strokes(), 0);
  }
});

test("a trail of constant pen state is drawn as ONE path", () => {
  // This is the entire performance argument for redrawing: quantized runs.
  const ctx = fakeCtx();
  const samples = ramp(50);
  const strokes = drawTrail(ctx, cam, samples, 49, 1000, uniform);

  assert.equal(strokes, 1, "constant attributes must not start a new path");
  assert.equal(ctx.strokes(), 1);
  assert.equal(ctx.moveTos().length, 1);
  assert.equal(ctx.lineTos().length, 49, "one lineTo per segment");
});

test("a change in pen state starts a new path, and only then", () => {
  const ctx = fakeCtx();
  const samples = ramp(20);
  // Width jumps once, at the halfway point.
  const attrs = (s) => ({
    rgb: { r: 200, g: 100, b: 50 },
    width: s.t < 10 ? 1 : 8,
    alpha: 1,
  });
  const strokes = drawTrail(ctx, cam, samples, 19, 1000, attrs);

  assert.equal(strokes, 2, "one run each side of the change");
  assert.deepEqual(ctx.widths(), [1, 8], "each run sets its own width once");
});

test("imperceptible drift does not fragment the trail", () => {
  const ctx = fakeCtx();
  const samples = ramp(60);
  // Attributes creep by a hair per vertex — below the quantization step.
  const attrs = (s) => ({
    rgb: { r: 200 + (s.t % 2), g: 100, b: 50 },
    width: 2 + s.t * 1e-4,
    alpha: 1 - s.t * 1e-5,
  });
  const strokes = drawTrail(ctx, cam, samples, 59, 1000, attrs);
  assert.ok(strokes <= 3, `sub-threshold drift fragmented into ${strokes} paths`);
});

test("ink past the cutoff is not drawn at all", () => {
  const ctx = fakeCtx();
  const samples = ramp(21); // t = 0..20
  // tNow = 20, span = 5 → only t > 15 survives (u < 1).
  drawTrail(ctx, cam, samples, 20, 5, uniform);

  const visible = samples.filter((s) => (20 - s.t) / 5 < 1);
  assert.equal(visible.length, 5, "sanity: t = 16..20");
  assert.equal(ctx.lineTos().length, visible.length - 1, "only live segments drawn");

  // And nothing drawn should sit where a cut vertex was.
  const cutX = project(samples[0], cam).sx;
  assert.ok(
    !ctx.lineTos().some((c) => Math.abs(c[1] - cutX) < 1e-9),
    "a vertex past the cutoff was still drawn",
  );
});

test("a gap in the trail is not bridged", () => {
  // Two clusters of vertices with a stale hole between them. The renderer must
  // not draw a segment across the hole — that would be a straight line through
  // the middle of the attractor, which is exactly the artifact the cutoff
  // branch exists to prevent.
  const ctx = fakeCtx();
  const samples = [
    { x: 0, y: 0, z: 25, t: 0 },
    { x: 1, y: 0, z: 25, t: 1 },
    // ... long stale gap: these are past the cutoff at tNow = 20, span = 5 ...
    { x: 40, y: 0, z: 25, t: 18 },
    { x: 41, y: 0, z: 25, t: 19 },
    { x: 42, y: 0, z: 25, t: 20 },
  ];
  drawTrail(ctx, cam, samples, 20, 5, uniform);

  assert.equal(ctx.lineTos().length, 2, "only the two live segments");
  assert.equal(ctx.moveTos().length, 1, "the live run starts with a fresh moveTo");

  const startX = project(samples[0], cam).sx;
  assert.ok(
    !ctx.moveTos().some((c) => Math.abs(c[1] - startX) < 1e-9),
    "the live run was anchored to a vertex from before the gap",
  );
});

test("the reported stroke count matches what was actually issued", () => {
  // The return value is the number worth watching if this gets slow, so it had
  // better be true.
  const ctx = fakeCtx();
  const samples = ramp(40);
  const attrs = (s) => ({
    rgb: { r: 200, g: 100, b: 50 },
    width: 1 + Math.floor(s.t / 5) * 3,
    alpha: 1,
  });
  const reported = drawTrail(ctx, cam, samples, 39, 1000, attrs);
  assert.equal(reported, ctx.strokes());
  assert.ok(reported > 1 && reported < 40, `got ${reported} runs from 40 vertices`);
});

test("the fade passed to attrs decreases with age", () => {
  const seen = [];
  const ctx = fakeCtx();
  drawTrail(ctx, cam, ramp(11), 10, 20, (s, fade) => {
    seen.push({ t: s.t, fade });
    return uniform();
  });
  assert.equal(seen.length, 11);
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].fade > seen[i - 1].fade, "newer ink must be more opaque");
  }
  assert.ok(seen.at(-1).fade === 1, "the newest vertex is fully opaque");
});
