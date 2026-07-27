import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASSIC, ATTRACTOR_DIAMETER } from "../lorenz.js";
import {
  lyapunovBenettin,
  horizon,
  horizonGainPerDecade,
  divergenceNorm,
  fitGrowthRate,
} from "../fork.js";

test("Benettin lambda for the classic parameters is ~0.905", () => {
  const { lambda } = lyapunovBenettin(CLASSIC, { total: 220, burnIn: 20 });
  // Measured 0.8933 against a literature value of ~0.9056. The bar is tight
  // enough that a real estimator regression shows up, loose enough to absorb
  // where on the attractor the burn-in happens to land.
  assert.ok(
    Math.abs(lambda - 0.905) < 0.06,
    `lambda=${lambda}, expected within 0.06 of 0.905`,
  );
});

test("lambda is negative where the system is not chaotic", () => {
  // rho well below the onset of chaos: trajectories settle onto C+ or C-.
  const { lambda } = lyapunovBenettin({ ...CLASSIC, rho: 10 }, { total: 120, burnIn: 40 });
  // The bar sits well below zero on purpose. It used to be `< 0.05`, which is
  // on the WRONG SIDE of zero — a lambda of +0.04 would have passed a test
  // whose whole claim is that the exponent is negative. The measured value is
  // about -0.60, so this has ample room and still fails on a sign error.
  assert.ok(lambda < -0.2, `lambda=${lambda} should be clearly negative at rho=10`);
});

test("Benettin is stable across starting points", () => {
  const a = lyapunovBenettin(CLASSIC, { total: 160, start: { x: 1, y: 1, z: 1 } });
  const b = lyapunovBenettin(CLASSIC, { total: 160, start: { x: -6, y: 2, z: 20 } });
  assert.ok(
    Math.abs(a.lambda - b.lambda) < 0.12,
    `starts disagree: ${a.lambda} vs ${b.lambda}`,
  );
});

test("horizon is (1/lambda)ln(tol/eps), and refuses nonsense", () => {
  const lambda = 0.9056;
  const got = horizon(lambda, 1e-6, 1);
  assert.ok(Math.abs(got - Math.log(1e6) / lambda) < 1e-9);

  // Ten times smaller eps buys a fixed increment, not a multiple.
  const tighter = horizon(lambda, 1e-7, 1);
  assert.ok(
    Math.abs(tighter - got - Math.LN10 / lambda) < 1e-9,
    "a decade of precision must add a constant",
  );

  assert.equal(horizon(0, 1e-6, 1), null);
  assert.equal(horizon(-0.5, 1e-6, 1), null);
  assert.equal(horizon(lambda, 1e-6, 0), null, "tolerance below eps is meaningless");
  assert.equal(horizon(lambda, 0, 1), null);
});

test("horizonGainPerDecade is ln(10)/lambda", () => {
  assert.ok(Math.abs(horizonGainPerDecade(0.9056) - 2.5426) < 1e-3);
  assert.equal(horizonGainPerDecade(0), null);
});

test("divergenceNorm spans [0,1] from eps to attractor diameter", () => {
  const eps = 1e-6;
  assert.equal(divergenceNorm(eps, eps), 0);
  assert.ok(Math.abs(divergenceNorm(ATTRACTOR_DIAMETER, eps) - 1) < 1e-12);
  assert.equal(divergenceNorm(ATTRACTOR_DIAMETER * 10, eps), 1, "clamped above");
  assert.equal(divergenceNorm(eps / 100, eps), 0, "clamped below");
  assert.equal(divergenceNorm(0, eps), 0);

  let prev = -1;
  for (let e = -6; e <= 1; e++) {
    const v = divergenceNorm(Math.pow(10, e), eps);
    assert.ok(v >= prev, "must be monotone in delta");
    prev = v;
  }
});

test("fitGrowthRate recovers a known exponential rate", () => {
  const eps = 1e-8;
  const lambda = 0.9;
  const samples = [];
  for (let t = 0; t <= 30; t += 0.05) samples.push({ t, d: eps * Math.exp(lambda * t) });

  const fit = fitGrowthRate(samples, eps);
  assert.ok(fit, "should find enough of the band to fit");
  assert.ok(Math.abs(fit.lambda - lambda) < 1e-6, `got ${fit.lambda}`);
  // The fit must have spanned most of the exponential band, not two points at
  // one end of it — the band here runs from 1e-7 to 4.5, i.e. ln(4.5e7)/0.9
  // ~ 19.7 time units.
  assert.ok(fit.tSpan > 15, `fit spanned only ${fit.tSpan} time units`);
  assert.ok(fit.n > 300, `fit used only ${fit.n} samples`);
});

test("fitGrowthRate declines to guess without enough of the band", () => {
  const eps = 1e-8;
  assert.equal(fitGrowthRate([], eps), null);
  // All samples still at the noise floor — below 10x eps, so nothing to fit.
  const flat = Array.from({ length: 50 }, (_, i) => ({ t: i * 0.05, d: eps * 1.5 }));
  assert.equal(fitGrowthRate(flat, eps), null);
});

test("fitGrowthRate ignores the saturated tail", () => {
  const eps = 1e-8;
  const lambda = 0.9;
  const samples = [];
  for (let t = 0; t <= 25; t += 0.05) samples.push({ t, d: eps * Math.exp(lambda * t) });
  // Bolt on a long saturated plateau; the fit must not be dragged toward zero.
  for (let t = 25; t <= 80; t += 0.05) samples.push({ t, d: 22 + Math.sin(t) });

  const fit = fitGrowthRate(samples, eps);
  assert.ok(Math.abs(fit.lambda - lambda) < 0.05, `saturation leaked in: ${fit.lambda}`);
});
