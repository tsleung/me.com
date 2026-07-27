import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_VERTS, FADE_K, trailAlpha, makeTrail, runKey } from "../trail.js";

test("the fade reaches exactly zero at the cutoff, not asymptotically", () => {
  // This is the entire reason the renderer was rewritten. A per-frame
  // multiplicative fade can only produce exp(-t/tau), which never reaches
  // zero — faint ink lingers for as long as the page is open.
  assert.equal(trailAlpha(1), 0, "ink must be gone at the cutoff");
  assert.equal(trailAlpha(1.0001), 0);
  assert.equal(trailAlpha(50), 0);
  assert.equal(trailAlpha(0), 1, "fresh ink is fully opaque");
  assert.equal(trailAlpha(-1), 1, "a sample from the future is not faded");
});

test("the fade is steeper than the plain exponential it replaced", () => {
  // Same nominal rate, but shifted to hit zero — so it must sit BELOW the
  // unshifted exponential everywhere in between. That gap is the haze that
  // used to fill the attractor.
  for (let u = 0.05; u < 1; u += 0.05) {
    const plain = Math.exp(-FADE_K * u);
    assert.ok(
      trailAlpha(u) < plain,
      `at u=${u.toFixed(2)} the curve (${trailAlpha(u).toFixed(4)}) is not below exp (${plain.toFixed(4)})`,
    );
  }
  // And most of the trail should be genuinely faint, not merely dimmer.
  assert.ok(trailAlpha(0.5) < 0.15, `half-aged ink at ${trailAlpha(0.5)} is still loud`);
});

test("the fade is monotone and stays in [0,1]", () => {
  let prev = Infinity;
  for (let u = 0; u <= 1.2; u += 0.01) {
    const a = trailAlpha(u);
    assert.ok(a >= 0 && a <= 1, `alpha ${a} out of range at u=${u}`);
    assert.ok(a <= prev + 1e-12, `alpha rose at u=${u}`);
    prev = a;
  }
});

test("a degenerate k falls back to linear rather than NaN", () => {
  for (const k of [0, -1, NaN]) {
    for (const u of [0, 0.25, 0.5, 1, 2]) {
      const a = trailAlpha(u, k);
      assert.ok(Number.isFinite(a) && a >= 0 && a <= 1, `k=${k} u=${u} gave ${a}`);
    }
  }
  assert.equal(trailAlpha(0.25, 0), 0.75);
});

test("vertex count is capped no matter how long the trail is", () => {
  // The point of gating emission on trail span: a longer trail is recorded
  // more coarsely, not more expensively. Otherwise the far end of the trail
  // slider quietly turns the app into a slideshow.
  for (const span of [0.4, 5, 40]) {
    const tr = makeTrail(200);
    let t = 0;
    for (let i = 0; i < 100000; i++) {
      t += 0.004;
      tr.record({ t }, t, span);
    }
    assert.ok(tr.size <= 200, `span ${span} stored ${tr.size} vertices`);

    // And the stored window should actually cover the requested span.
    const s = tr.samples();
    const covered = s.at(-1).t - s[0].t;
    assert.ok(
      covered >= span * 0.9,
      `span ${span}: only ${covered.toFixed(2)} of history retained`,
    );
  }
});

test("a short trail still records at full step resolution", () => {
  const tr = makeTrail(MAX_VERTS);
  let t = 0;
  for (let i = 0; i < 300; i++) {
    t += 0.004;
    tr.record({ t }, t, 40);
  }
  // 40 / 1200 = 0.0333 sim units of spacing, so 300 steps of 0.004 (= 1.2 sim
  // units) should yield 1.2 / 0.0333 ≈ 36 vertices. Assert the arithmetic, not
  // a band wide enough to pass on any behaviour at all.
  assert.ok(Math.abs(tr.size - 36) <= 2, `expected ~36 vertices, stored ${tr.size}`);
});

test("clear resets both the buffer and the emission gate", () => {
  const tr = makeTrail(50);
  for (let i = 1; i <= 20; i++) tr.record({ t: i }, i, 100);
  tr.clear();
  assert.equal(tr.size, 0);
  assert.equal(tr.record({ t: 0.001 }, 0.001, 100), true, "next record is due again");
});

test("runKey is stable, distinguishing, and stays a safe integer", () => {
  const a = runKey({ r: 200, g: 100, b: 50 }, 0.5, 2);
  assert.equal(a, runKey({ r: 200, g: 100, b: 50 }, 0.5, 2), "must be deterministic");
  assert.ok(Number.isSafeInteger(a) && a >= 0, `key ${a} is not a safe non-negative int`);

  // Near-identical values must collapse to one run — that is the whole
  // performance argument for redrawing the trail.
  assert.equal(
    runKey({ r: 200, g: 100, b: 50 }, 0.5, 2),
    runKey({ r: 201, g: 101, b: 51 }, 0.501, 2.001),
    "imperceptible differences should share a run",
  );

  // Real differences must not.
  const base = runKey({ r: 0, g: 0, b: 0 }, 0.5, 2);
  assert.notEqual(base, runKey({ r: 255, g: 0, b: 0 }, 0.5, 2), "color ignored");
  assert.notEqual(base, runKey({ r: 0, g: 255, b: 0 }, 0.5, 2), "green ignored");
  assert.notEqual(base, runKey({ r: 0, g: 0, b: 255 }, 0.5, 2), "blue ignored");
  assert.notEqual(base, runKey({ r: 0, g: 0, b: 0 }, 0.9, 2), "alpha ignored");
  assert.notEqual(base, runKey({ r: 0, g: 0, b: 0 }, 0.5, 4), "width ignored");
});

test("runKey clamps rather than aliasing on out-of-range input", () => {
  // A width beyond the packed field must not wrap around and collide with a
  // completely different pen state.
  const huge = runKey({ r: 255, g: 255, b: 255 }, 2, 1000);
  assert.ok(Number.isSafeInteger(huge) && huge >= 0);
  assert.equal(huge, runKey({ r: 255, g: 255, b: 255 }, 5, 9999), "clamped alike");
  assert.notEqual(huge, runKey({ r: 255, g: 255, b: 255 }, 0, 0));
});
