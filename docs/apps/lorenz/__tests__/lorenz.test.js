import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLASSIC,
  DT,
  field,
  rk4,
  advance,
  phaseSpeed,
  fixedPoints,
  contraction,
  separation,
  perturb,
  seed,
} from "../lorenz.js";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ~${b}, got ${a}`);

test("field vanishes at every fixed point", () => {
  for (const fp of fixedPoints(CLASSIC)) {
    const v = field(fp, CLASSIC);
    near(Math.hypot(v.x, v.y, v.z), 0, 1e-9, "|field| at fixed point");
  }
});

test("fixed points: three above rho=1, only the origin below", () => {
  assert.equal(fixedPoints(CLASSIC).length, 3);
  assert.equal(fixedPoints({ ...CLASSIC, rho: 0.5 }).length, 1);

  // C± sit at (±sqrt(beta(rho-1)), same, rho-1).
  const r = Math.sqrt(CLASSIC.beta * (CLASSIC.rho - 1));
  const [, plus, minus] = fixedPoints(CLASSIC);
  near(plus.x, r, 1e-12);
  near(plus.z, CLASSIC.rho - 1, 1e-12);
  near(minus.x, -r, 1e-12);
});

test("divergence of the field is the constant -(sigma+1+beta)", () => {
  // Confirm the closed form against a numeric Jacobian trace at random states.
  const h = 1e-5;
  for (const s of [
    { x: 1, y: 2, z: 3 },
    { x: -8, y: 4, z: 27 },
    { x: 12.5, y: -3.25, z: 41 },
  ]) {
    const dx =
      (field({ ...s, x: s.x + h }, CLASSIC).x - field({ ...s, x: s.x - h }, CLASSIC).x) /
      (2 * h);
    const dy =
      (field({ ...s, y: s.y + h }, CLASSIC).y - field({ ...s, y: s.y - h }, CLASSIC).y) /
      (2 * h);
    const dz =
      (field({ ...s, z: s.z + h }, CLASSIC).z - field({ ...s, z: s.z - h }, CLASSIC).z) /
      (2 * h);
    near(dx + dy + dz, contraction(CLASSIC), 1e-6, "trace of Jacobian");
  }
  near(contraction(CLASSIC), -(10 + 1 + 8 / 3), 1e-12);
});

test("rk4 converges at fourth order", () => {
  const start = { x: 1, y: 1, z: 1 };
  const T = 0.5;
  const at = (dt) => advance(start, CLASSIC, Math.round(T / dt), dt);
  const ref = at(1e-4);

  const e1 = separation(at(0.02), ref);
  const e2 = separation(at(0.01), ref);
  // Halving dt should cut the error by ~16. Allow generous slack for the
  // reference not being exact; anything above 8 rules out lower order.
  assert.ok(e2 > 0, "error should be measurable");
  assert.ok(e1 / e2 > 8, `order ratio ${e1 / e2} — expected ~16`);

  // The claim that actually matters: at the step size the app ships, error over
  // half a time unit is orders of magnitude below one screen pixel (the stage
  // is ~20 px per state unit).
  assert.ok(
    separation(at(DT), ref) < 1e-4,
    `error at the shipped dt=${DT} is ${separation(at(DT), ref)}`,
  );
});

test("integration is deterministic and stays bounded", () => {
  const s0 = seed(CLASSIC);
  const a = advance(s0, CLASSIC, 20000);
  const b = advance(s0, CLASSIC, 20000);
  assert.deepEqual(a, b, "same input must give a bit-identical trajectory");

  let s = s0;
  for (let i = 0; i < 60000; i++) {
    s = rk4(s, CLASSIC, DT);
    assert.ok(Number.isFinite(s.x + s.y + s.z), "trajectory went non-finite");
    assert.ok(Math.abs(s.x) < 40 && Math.abs(s.y) < 60, "x/y left the attractor");
    assert.ok(s.z > -1 && s.z < 80, "z left the attractor");
  }
});

test("seed lands on the attractor, not near the origin", () => {
  const s = seed(CLASSIC);
  assert.ok(s.z > 1 && s.z < 60, `z=${s.z} not on the attractor`);
  assert.ok(Math.abs(s.x) > 0.5, "burn-in should have left the origin");
});

test("the butterfly effect: a 1e-9 nudge becomes order-1 within ~30 time units", () => {
  const a0 = seed(CLASSIC);
  const b0 = perturb(a0, 1e-9);
  assert.ok(separation(a0, b0) < 2e-9, "fork starts tiny");

  const steps = Math.round(30 / DT);
  const a = advance(a0, CLASSIC, steps);
  const b = advance(b0, CLASSIC, steps);
  assert.ok(
    separation(a, b) > 1,
    `separation only reached ${separation(a, b)} after 30 time units`,
  );
});

test("speed is the magnitude of the field, and is zero only at fixed points", () => {
  const s = { x: 3, y: -4, z: 12 };
  const v = field(s, CLASSIC);
  near(phaseSpeed(s, CLASSIC), Math.hypot(v.x, v.y, v.z), 1e-12);
  near(phaseSpeed(fixedPoints(CLASSIC)[1], CLASSIC), 0, 1e-9);
  assert.ok(phaseSpeed(seed(CLASSIC), CLASSIC) > 1);
});
