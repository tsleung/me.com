import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isScarceAmmo,
  preferredRangeM,
  ammoConservationFactor,
} from "../../features/ammo-conservation.js";

// ---- isScarceAmmo ----

test("isScarceAmmo: stratagem-class is scarce", () => {
  assert.equal(isScarceAmmo({ isStratagem: true }), true);
  assert.equal(isScarceAmmo({ cooldownSecsOwn: 70 }), true);
  assert.equal(isScarceAmmo({ callInSecs: 4 }), true);
});

test("isScarceAmmo: full-auto rifle is NOT scarce", () => {
  const lib = { magazine: 30, reloadSecs: 2, fireRateRpm: 600 };
  assert.equal(isScarceAmmo(lib), false);
});

test("isScarceAmmo: small-mag slow-reload (rocket-class) qualifies", () => {
  // Spear-shape: 1-mag, 5s reload.
  const spear = { magazine: 1, reloadSecs: 5 };
  assert.equal(isScarceAmmo(spear), true);
});

test("isScarceAmmo: medium mag (~10) doesn't qualify even with slow reload", () => {
  const dmr = { magazine: 10, reloadSecs: 4 };
  assert.equal(isScarceAmmo(dmr), false);
});

test("isScarceAmmo: deployed EAT-shape (1 mag + 1 reserve, fast reload) IS scarce", () => {
  // Post-deploy EAT: mag=1, reserve=1, reloadSecs=0. The mag-and-reload
  // rule misses this, but the support-weapon-with-tiny-backpack rule
  // catches it.
  const eat = {
    isSupportWeapon: true, magazine: 1, ammoInMag: 1,
    ammoReserveMax: 1, ammoReserve: 1, reloadSecs: 0,
  };
  assert.equal(isScarceAmmo(eat), true);
});

test("isScarceAmmo: deployed Stalwart (huge backpack) is NOT scarce", () => {
  const stalwart = {
    isSupportWeapon: true, magazine: 250, ammoInMag: 250,
    ammoReserveMax: 750, ammoReserve: 750, reloadSecs: 4,
  };
  assert.equal(isScarceAmmo(stalwart), false);
});

test("isScarceAmmo: deployed HMG (75 + 300) is NOT scarce", () => {
  const hmg = {
    isSupportWeapon: true, magazine: 75, ammoInMag: 75,
    ammoReserveMax: 300, ammoReserve: 300, reloadSecs: 7,
  };
  assert.equal(isScarceAmmo(hmg), false);
});

// ---- preferredRangeM ----

test("preferredRangeM: defaults to half maxRangeM", () => {
  assert.equal(preferredRangeM({ maxRangeM: 80 }), 40);
});

test("preferredRangeM: explicit override passes through", () => {
  assert.equal(preferredRangeM({ maxRangeM: 80, preferredRangeM: 25 }), 25);
});

test("preferredRangeM: floor at 10m for very short-range weapons", () => {
  assert.equal(preferredRangeM({ maxRangeM: 5 }), 10);
});

// ---- ammoConservationFactor ----

test("ammoConservationFactor: non-scarce weapon → 1.0 always", () => {
  const lib = { magazine: 30, reloadSecs: 2, fireRateRpm: 600, maxRangeM: 80 };
  assert.equal(ammoConservationFactor(lib, 5), 1.0);
  assert.equal(ammoConservationFactor(lib, 75), 1.0);
});

test("ammoConservationFactor: scarce weapon at preferred range → 1.0", () => {
  const eat = { isStratagem: true, callInSecs: 4, maxRangeM: 100 };
  // preferred = 50m. At 30m, well inside → full value.
  assert.equal(ammoConservationFactor(eat, 30), 1.0);
});

test("ammoConservationFactor: scarce weapon past preferred range → quadratic decay", () => {
  const eat = { isStratagem: true, callInSecs: 4, maxRangeM: 100 };
  // preferred = 50m. At 100m, ratio = 2 → factor = 1/4.
  const f = ammoConservationFactor(eat, 100);
  assert.ok(Math.abs(f - 0.25) < 1e-9, `got ${f}`);
});

test("ammoConservationFactor: bottoms out at floor (no zero)", () => {
  const eat = { isStratagem: true, callInSecs: 4, maxRangeM: 100 };
  // preferred = 50m. At 1000m, ratio² = 400 → 1/400 < 0.1 → clamped to 0.1.
  const f = ammoConservationFactor(eat, 1000);
  assert.ok(f >= 0.1, `floor should hold at 0.1, got ${f}`);
});

test("ammoConservationFactor: closer = higher value (monotonic in range)", () => {
  const eat = { isStratagem: true, callInSecs: 4, maxRangeM: 100 };
  const fNear = ammoConservationFactor(eat, 60);
  const fMid  = ammoConservationFactor(eat, 80);
  const fFar  = ammoConservationFactor(eat, 100);
  assert.ok(fNear > fMid && fMid > fFar);
});
