// selftest.js — headless-capable correctness checks for the pure core
// (sim.js + frames.js). Runnable two ways from ONE file:
//   • in the browser: append ?selftest=1 → PASS/FAIL badge (app.js calls
//     runSelftest()).
//   • under node: `node apps/delta-v-sim/selftest.js` (and the __tests__
//     harness imports runSelftest()) — the guard at the bottom runs the suite
//     and exits nonzero on failure. Browser-safe: gated on globalThis.process.
//
// A green badge means the numbers the UI draws are the numbers asserted here,
// including the two corpus checks: Hohmann Earth→Mars departure Δv = 2.945 km/s
// and Earth–Moon L1 ≈ 5.8e4 km from the Moon.

import { mag, sub, rot, wrapPi } from "./vec.js";
import {
  solveKeplerElliptic,
  solveKeplerHyperbolic,
  trueFromEccentric,
  eccentricFromTrue,
} from "./kepler.js";
import { worldAt, elementState, orbitTrace, BODIES, BODY_KEYS, MU_SUN, MU_EARTH, DAY_S, AU_KM, EARTH_MOON_MU } from "./sim.js";
import { orbitFromState, makeCraft, craftStateAt, craftFromCircular } from "./spacecraft.js";
import { hohmannEarthMars } from "./hohmann.js";
import {
  lambert,
  departureDvNow,
  bestTransferNow,
  transferTrajectory,
  transferDvs,
  dvSeries,
  seriesMinima,
  porkchop,
} from "./transfer.js";
import { planEfficientLaunch, planCourse, waypointDv, synodicPeriod, applyLaunchMethod } from "./plan.js";
import { availableMethods, surfaceToOrbitWith, SURFACE_TO_ORBIT } from "./infra.js";
import {
  makeMission,
  missionStateAt,
  craftBudget,
  CRAFT_ARCHETYPES,
  turnaroundKey,
  fleetName,
  MISSION_PRESETS,
  definitionFrom,
  resolveDefinition,
  firstLegKeys,
} from "./mission.js";
import { formatMission } from "./hud.js";
import { DESCRIPTIONS, describe } from "./descriptions.js";
import {
  frameMap,
  frameUnmap,
  synodicState,
  lagrangeHelio,
  lagrangeSynodic,
  earthMoonLagrangeDistances,
  earthMarsGeometry,
  EM_ANCHOR_EARTH,
  EM_ANCHOR_MARS,
  frameForZoom,
  CASCADE_EFFSCALE,
  FRAME_ORDER,
} from "./frames.js";
import { elevatorPayloadCraft } from "./elevator.js";
import {
  frameScaleFactor,
  screenFootprintPx,
  resolvable,
  resolvableHysteretic,
  resolveMarks,
  satelliteEntity,
  GAP_PX,
  HYST_PX,
} from "./visibility.js";
import { Camera, desiredCamera, desiredCameraAt, bboxInFrame } from "./camera.js";
import { INITIAL, reduce, FRAME_IDS, CAMERA_KINDS, WORKSPACES } from "./uiState.js";

const rel = (a, b, frac = 1e-3) => Math.abs(a - b) <= frac * Math.abs(b || 1);
const fmt = (x) => (typeof x === "number" ? (Math.abs(x) >= 1e4 ? x.toExponential(3) : x.toFixed(4)) : String(x));

export function runSelftest() {
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });

  // ===== 1. Kepler solver converges + round-trips =====================
  {
    let worst = 0;
    for (const e of [0, 0.017, 0.0934, 0.3, 0.7, 0.95]) {
      for (let k = 0; k < 24; k++) {
        const M = -Math.PI + (k / 24) * 2 * Math.PI;
        const E = solveKeplerElliptic(M, e);
        const Mback = E - e * Math.sin(E);
        worst = Math.max(worst, Math.abs(wrapPi(Mback - M)));
      }
    }
    check("Kepler elliptic: M → E → M round-trips (all e, all M)", worst < 1e-9, `worst |ΔM| = ${worst.toExponential(2)}`);
  }
  {
    // true-anomaly round-trip: ν → E → ν
    let worst = 0;
    for (const e of [0.017, 0.3, 0.7]) {
      for (let k = 1; k < 24; k++) {
        const nu = -Math.PI + (k / 24) * 2 * Math.PI;
        const E = eccentricFromTrue(nu, e);
        const nu2 = trueFromEccentric(E, e);
        worst = Math.max(worst, Math.abs(wrapPi(nu2 - nu)));
      }
    }
    check("Kepler: ν → E → ν round-trips", worst < 1e-9, `worst |Δν| = ${worst.toExponential(2)}`);
  }
  {
    // hyperbolic solver converges
    let ok = true;
    for (const e of [1.2, 2.0, 3.5]) {
      for (const M of [-3, -1, 0.5, 2, 5]) {
        const H = solveKeplerHyperbolic(M, e);
        if (Math.abs(e * Math.sinh(H) - H - M) > 1e-8) ok = false;
      }
    }
    check("Kepler hyperbolic: M = e·sinh(H) − H solved", ok);
  }

  // ===== 2. Orbit period recovery: propagate one period → back to start =
  {
    const tests = [
      ["earth", BODIES.earth.elem],
      ["mars", BODIES.mars.elem],
      ["moon", BODIES.moon.elem],
    ];
    let worst = 0;
    for (const [, el] of tests) {
      const p0 = elementState(el, 0).pos;
      const p1 = elementState(el, el.period).pos;
      worst = Math.max(worst, mag(sub(p1, p0)) / mag(p0));
    }
    check("period recovery: one full period returns to start (Earth/Mars/Moon)", worst < 1e-9, `worst rel drift = ${worst.toExponential(2)}`);
  }

  // ===== 3. Frame transforms: helio → geocentric → helio is identity ====
  {
    const world = worldAt(37 * DAY_S);
    const toGeo = frameMap("geo", world);
    const fromGeo = frameUnmap("geo", world);
    const p = world.mars.pos;
    const back = fromGeo(toGeo(p));
    check("frame: helio → geocentric → helio is identity", mag(sub(back, p)) < 1e-6, `residual = ${mag(sub(back, p)).toExponential(2)} km`);
    // Earth sits at the geocentric origin.
    const eGeo = toGeo(world.earth.pos);
    check("frame: Earth is at the geocentric origin", mag(eGeo) < 1e-6, `|Earth_geo| = ${mag(eGeo).toExponential(2)} km`);
  }

  // ===== 4. Synodic frame FIXES the pair across time =====================
  {
    // Earth–Moon synodic: Earth at origin, Moon pinned on +x (y≈0), all t.
    let worstEarth = 0;
    let worstMoonY = 0;
    let minMoonX = Infinity;
    for (let d = 0; d < 40; d += 1.3) {
      const world = worldAt(d * DAY_S);
      const map = frameMap("em-syn", world);
      const e = map(world.earth.pos);
      const m = map(world.moon.pos);
      worstEarth = Math.max(worstEarth, mag(e));
      worstMoonY = Math.max(worstMoonY, Math.abs(m[1]));
      minMoonX = Math.min(minMoonX, m[0]);
    }
    check("synodic (Earth–Moon): Earth stays at the origin ∀t", worstEarth < 1e-6, `max |Earth_syn| = ${worstEarth.toExponential(2)} km`);
    check("synodic (Earth–Moon): Moon pinned on the +x axis (y≈0, x>0) ∀t", worstMoonY < 1e-6 && minMoonX > 3.5e5, `max |Moon_y| = ${worstMoonY.toExponential(2)} km, min Moon_x = ${fmt(minMoonX)}`);
  }
  {
    // Sun–Earth synodic: Earth pinned on +x, Sun at origin.
    let worstY = 0;
    let minX = Infinity;
    for (let d = 0; d < 400; d += 17) {
      const world = worldAt(d * DAY_S);
      const map = frameMap("se-syn", world);
      const e = map(world.earth.pos);
      worstY = Math.max(worstY, Math.abs(e[1]));
      minX = Math.min(minX, e[0]);
    }
    check("synodic (Sun–Earth): Earth pinned on the +x axis ∀t", worstY < 1e-6 && minX > 1.4e8, `max |Earth_y| = ${worstY.toExponential(2)} km, min Earth_x = ${fmt(minX)}`);
  }

  // ===== 5. Lagrange points are STATIONARY in the synodic frame =========
  {
    let worst = 0;
    for (let d = 0; d < 40; d += 2.1) {
      const world = worldAt(d * DAY_S);
      const map = frameMap("em-syn", world);
      const Ls = lagrangeHelio(world, "em-syn");
      for (const L of Ls) {
        const disp = map(L.helio); // should equal L.syn (constant) for all t
        worst = Math.max(worst, mag(sub(disp, L.syn)) / mag(L.syn));
      }
    }
    check("Lagrange: all five L-points are stationary in the synodic frame ∀t", worst < 1e-9, `worst rel drift = ${worst.toExponential(2)}`);
  }

  // ===== 6. Earth–Moon L1/L2/L3 match known values ======================
  {
    const d = earthMoonLagrangeDistances(384400);
    // Corpus: L1 ≈ 3.22e5 km from Earth / ~5.8e4 from Moon (Spaceline: 56,315 km
    // from the sub-Earth point + 1,737 km Moon radius ≈ 58,052 from Moon centre).
    check(
      "Lagrange: Earth–Moon L1 ≈ 5.8e4 km from the Moon (corpus)",
      Math.abs(d.L1_fromMoon - 58100) < 2500,
      `L1_fromMoon = ${fmt(d.L1_fromMoon)} km (corpus ≈ 58,052 from Moon centre)`,
    );
    check(
      "Lagrange: Earth–Moon L1 ≈ 3.2e5 km from Earth (corpus)",
      Math.abs(d.L1_fromEarth - 322000) < 8000,
      `L1_fromEarth = ${fmt(d.L1_fromEarth)} km (corpus ≈ 3.22e5)`,
    );
    check(
      "Lagrange: Earth–Moon L2 ≈ 6.45e4 km beyond the Moon",
      Math.abs(d.L2_fromMoon - 64500) < 3000,
      `L2_fromMoon = ${fmt(d.L2_fromMoon)} km (corpus ≈ 64,588 from Moon centre)`,
    );
    check(
      "Lagrange: Earth–Moon L2 ≈ 4.49e5 km from Earth",
      Math.abs(d.L2_fromEarth - 448800) < 6000,
      `L2_fromEarth = ${fmt(d.L2_fromEarth)} km`,
    );
  }
  {
    // L4/L5 are exactly equilateral: equidistant (= sep) from both bodies.
    const sep = 384400;
    const Ls = lagrangeSynodic(sep, EARTH_MOON_MU);
    const L4 = Ls.find((p) => p.name === "L4").syn;
    const dFromEarth = Math.hypot(L4[0], L4[1]);
    const dFromMoon = Math.hypot(L4[0] - sep, L4[1]);
    check("Lagrange: L4 is equilateral (dist to Earth = dist to Moon = separation)", rel(dFromEarth, sep, 1e-9) && rel(dFromMoon, sep, 1e-9), `d_Earth=${fmt(dFromEarth)} d_Moon=${fmt(dFromMoon)} sep=${fmt(sep)}`);
  }

  // ===== 7. Hohmann Earth→Mars departure Δv matches the corpus ==========
  {
    const h = hohmannEarthMars();
    check(
      "Hohmann Earth→Mars: departure Δv = 2.945 km/s (windows-and-transfers.md)",
      Math.abs(h.dv1 - 2.945) < 0.03,
      `Δv1 = ${h.dv1.toFixed(4)} km/s (corpus 2.945)`,
    );
    check(
      "Hohmann Earth→Mars: time of flight ≈ 258.87 d (corpus)",
      Math.abs(h.tofDays - 258.87) < 2,
      `TOF = ${h.tofDays.toFixed(2)} d (corpus 258.87)`,
    );
    check(
      "Hohmann Earth→Mars: arrival Δv ≈ 2.649 km/s (corpus)",
      Math.abs(h.dv2 - 2.649) < 0.05,
      `Δv2 = ${h.dv2.toFixed(4)} km/s (corpus 2.649)`,
    );
  }

  // ===== 8. Spacecraft conic: classification + period round-trip ========
  {
    // Circular LEO-ish orbit around Earth, then propagate one period.
    const rc = 6771; // ~400 km altitude
    const craft = craftFromCircular("earth", rc, 0.7, { prograde: 0, radial: 0 }, 0, MU_EARTH);
    check("craft: a circular burn-free orbit is an ellipse with e≈0", craft.type === "ellipse" && craft.e < 1e-6, `type=${craft.type} e=${craft.e.toExponential(2)}`);
    const s0 = craftStateAt(craft, 0).pos;
    const s1 = craftStateAt(craft, craft.period).pos;
    check("craft: propagating one period returns to start", mag(sub(s1, s0)) / rc < 1e-8, `rel drift = ${(mag(sub(s1, s0)) / rc).toExponential(2)}`);
  }
  {
    // A big prograde kick from LEO → escape hyperbola; v_inf sane.
    const rc = 6771;
    const vCirc = Math.sqrt(MU_EARTH / rc); // ~7.67 km/s
    const craft = craftFromCircular("earth", rc, 0, { prograde: 5, radial: 0 }, 0, MU_EARTH);
    check("craft: a large prograde Δv makes a hyperbola (e>1, v∞>0)", craft.type === "hyperbola" && craft.vinf > 0, `type=${craft.type} e=${craft.e.toFixed(3)} v∞=${craft.vinf.toFixed(3)} (vCirc=${vCirc.toFixed(2)})`);
  }
  {
    // Prograde raise → apoapsis above start, periapsis at burn point.
    const rc = 6771;
    const craft = craftFromCircular("earth", rc, 0, { prograde: 1.0, radial: 0 }, 0, MU_EARTH);
    check("craft: a small prograde Δv raises apoapsis, keeps periapsis at the burn", craft.ra > rc && Math.abs(craft.rp - rc) < 1, `rp=${craft.rp.toFixed(1)} rc=${rc} ra=${craft.ra.toFixed(1)}`);
  }

  // ===== 9. Lunar elevator: released payload → sane bound Earth orbit ====
  {
    const world = worldAt(3 * DAY_S);
    const dRelease = 30000; // 30,000 km up the elevator (below the Moon's orbit)
    const craft = elevatorPayloadCraft(world, dRelease, 3 * DAY_S);
    const releaseRadius = mag(sub(craft.releaseHelio, world.earth.pos));
    // Sub-circular co-rotating speed ⇒ bound ellipse whose apoapsis is the
    // release point and whose periapsis dips toward Earth.
    check(
      "elevator: a payload released below the lunar orbit falls into a bound Earth ellipse",
      craft.type === "ellipse" && craft.energy < 0 && craft.rp < releaseRadius,
      `type=${craft.type} e=${craft.e.toFixed(3)} rp=${fmt(craft.rp)} releaseR=${fmt(releaseRadius)}`,
    );
    check(
      "elevator: apoapsis of the released ellipse ≈ the release radius",
      rel(craft.ra, releaseRadius, 0.02),
      `ra=${fmt(craft.ra)} releaseR=${fmt(releaseRadius)}`,
    );
  }

  // ===== 11. Earth–Mars comparison frame PINS both planets ∀t ===========
  {
    let worstE = 0;
    let worstM = 0;
    for (let d = 0; d < 1600; d += 37) {
      const world = worldAt(d * DAY_S);
      const map = frameMap("earth-mars", world);
      const e = map(world.earth.pos);
      const m = map(world.mars.pos);
      worstE = Math.max(worstE, Math.hypot(e[0] - EM_ANCHOR_EARTH[0], e[1] - EM_ANCHOR_EARTH[1]));
      worstM = Math.max(worstM, Math.hypot(m[0] - EM_ANCHOR_MARS[0], m[1] - EM_ANCHOR_MARS[1]));
    }
    check(
      "compare: Earth pinned to left anchor & Mars to right anchor ∀t (separation normalized)",
      worstE < 1 && worstM < 1,
      `max drift Earth=${worstE.toExponential(2)} Mars=${worstM.toExponential(2)} km`,
    );
  }

  // ===== 12. Sun-arrow direction + distance match TRUE heliocentric geo ==
  {
    const norm = (v) => {
      const m = Math.hypot(v[0], v[1]);
      return [v[0] / m, v[1] / m];
    };
    let worstDir = 0;
    let worstDist = 0;
    for (let d = 0; d < 1600; d += 53) {
      const world = worldAt(d * DAY_S);
      const g = earthMarsGeometry(world);
      // arrow bearing rotated back into helio must point Earth→Sun (= −E dir)
      const dirE = rot([Math.cos(g.bearingEarth), Math.sin(g.bearingEarth)], g.phi);
      const trueE = norm(sub(world.sun.pos, world.earth.pos));
      worstDir = Math.max(worstDir, Math.hypot(dirE[0] - trueE[0], dirE[1] - trueE[1]));
      worstDist = Math.max(
        worstDist,
        Math.abs(g.earthSunDist - mag(world.earth.pos)),
        Math.abs(g.marsSunDist - mag(world.mars.pos)),
      );
    }
    check(
      "compare: Sun-arrow bearing & TRUE distance match heliocentric geometry ∀t (the bearing sweep = synodic cycle)",
      worstDir < 1e-9 && worstDist < 1e-6,
      `dir residual=${worstDir.toExponential(2)} dist residual=${worstDist.toExponential(2)} km`,
    );
  }

  // ===== 13. Phobos & Deimos: period recovery + REAL tempo ordering ======
  {
    const per = (k) => BODIES[k].elem.period;
    const recover = (k) => {
      const p0 = elementState(BODIES[k].elem, 0).pos;
      const p1 = elementState(BODIES[k].elem, per(k)).pos;
      return mag(sub(p1, p0)) / mag(p0);
    };
    check(
      "moons: Phobos & Deimos recover to start after one real period",
      recover("phobos") < 1e-9 && recover("deimos") < 1e-9,
      `drift Phobos=${recover("phobos").toExponential(2)} Deimos=${recover("deimos").toExponential(2)}`,
    );
    check(
      "moons: REAL tempo ordering — Phobos < 1 d, Phobos < Deimos < Moon (never faked)",
      per("phobos") / DAY_S < 1 && per("phobos") < per("deimos") && per("deimos") < per("moon"),
      `Phobos=${(per("phobos") / DAY_S).toFixed(3)} d, Deimos=${(per("deimos") / DAY_S).toFixed(3)} d, Moon=${(per("moon") / DAY_S).toFixed(2)} d`,
    );
  }

  // ===== 14. HUD Earth–Mars distance = heliocentric separation, real swing
  {
    let ok = true;
    let minAU = Infinity;
    let maxAU = -Infinity;
    for (let d = 0; d < 1700; d += 13) {
      const world = worldAt(d * DAY_S);
      const g = earthMarsGeometry(world);
      const trueSep = mag(sub(world.mars.pos, world.earth.pos));
      if (Math.abs(g.sep - trueSep) > 1e-6) ok = false;
      const au = g.sep / AU_KM;
      minAU = Math.min(minAU, au);
      maxAU = Math.max(maxAU, au);
    }
    check(
      "compare HUD: Earth–Mars distance = heliocentric separation, swings realistically (~0.4–2.6 AU)",
      ok && minAU < 0.8 && maxAU > 2.0,
      `true range ${minAU.toFixed(2)}–${maxAU.toFixed(2)} AU (pinned on screen, live in HUD)`,
    );
  }

  // ===== 15. NO exaggeration — rendered orbit radius = TRUE scaled radius =
  {
    const world = worldAt(0);
    const cam = new Camera(1000, 700);
    cam.fitBounds(bboxInFrame("geo", world));
    const eff = cam.scale * frameScaleFactor("geo", world); // isometric ⇒ = cam.scale
    const ent = satelliteEntity("moon");
    const fp = screenFootprintPx(ent.orbitRadiusKm, eff);
    check(
      "visibility: rendered moon-orbit radius = TRUE scaled radius (no exaggeration factor anywhere)",
      ent.orbitRadiusKm === BODIES.moon.elem.a && Math.abs(fp - BODIES.moon.elem.a * cam.scale) < 1e-9,
      `orbitRadiusKm=${ent.orbitRadiusKm} (=a) fp=${fp.toFixed(2)}px = a·scale`,
    );
  }

  // ===== 16. resolvability predicate: exact crossover boundary ===========
  {
    const entity = { orbitRadiusKm: 1e5, parentRadiusPx: 6 };
    const cross = (entity.parentRadiusPx + GAP_PX) / entity.orbitRadiusKm; // R·scale = parent+GAP
    check(
      "visibility: resolvable ⇔ orbit_px ≥ parentRadius + GAP_PX (exact crossover, deterministic)",
      resolvable(entity, cross * 1.0001) === true && resolvable(entity, cross * 0.9999) === false,
      `GAP_PX=${GAP_PX}`,
    );
  }

  // ===== 17. hysteresis dead-band (anti-flicker, still deterministic) ====
  {
    const entity = { orbitRadiusKm: 1e5, parentRadiusPx: 6 };
    const hideS = (entity.parentRadiusPx + GAP_PX) / entity.orbitRadiusKm;
    const showS = (entity.parentRadiusPx + GAP_PX + HYST_PX) / entity.orbitRadiusKm;
    const mid = (hideS + showS) / 2; // between HIDE and SHOW
    check(
      "visibility: hysteresis — hidden stays hidden below SHOW, shown stays shown above HIDE",
      resolvableHysteretic(entity, mid, false) === false &&
        resolvableHysteretic(entity, mid, true) === true &&
        resolvableHysteretic(entity, showS * 1.001, false) === true &&
        resolvableHysteretic(entity, hideS * 0.999, true) === false,
      `HYST_PX=${HYST_PX}`,
    );
  }

  // ===== 18. predicate purity + label collision uses the same rule =======
  {
    const entity = { orbitRadiusKm: 1e5, parentRadiusPx: 6 };
    const a = resolvable(entity, 1e-4);
    const b = resolvable(entity, 1e-4);
    // resolveMarks: greedy by priority, drops a lower-priority mark within GAP_PX
    const vis = resolveMarks([
      { pos: [0, 0], priority: 3 },
      { pos: [1, 0], priority: 1 }, // 1px < GAP ⇒ dropped by the higher-priority mark
      { pos: [100, 100], priority: 1 }, // far ⇒ kept
    ]);
    check(
      "visibility: predicate is pure; labels/L-points obey the SAME GAP_PX separability rule",
      a === b && vis[0] && !vis[1] && vis[2],
      `pure=${a === b} marks=${vis}`,
    );
  }

  // ===== 19. UNIFORMITY — compare hides all moons @ default; zoom / centric
  //          frames reveal them (one rule, no special-casing) =============
  {
    const world = worldAt(0);
    const camC = new Camera(1000, 700);
    camC.fitBounds(bboxInFrame("earth-mars", world));
    const effC = camC.scale * frameScaleFactor("earth-mars", world);
    const hiddenInCompare = ["moon", "phobos", "deimos"].every(
      (k) => !resolvableHysteretic(satelliteEntity(k), effC, false),
    );
    // zoom in ~1e4× toward a planet in the compare frame → Moon resolves
    const moonZoom = resolvableHysteretic(
      satelliteEntity("moon"),
      camC.scale * 1e4 * frameScaleFactor("earth-mars", world),
      false,
    );
    const camG = new Camera(1000, 700);
    camG.fitBounds(bboxInFrame("geo", world));
    const moonGeo = resolvableHysteretic(
      satelliteEntity("moon"),
      camG.scale * frameScaleFactor("geo", world),
      false,
    );
    const camA = new Camera(1000, 700);
    camA.fitBounds(bboxInFrame("areo", world));
    const effA = camA.scale * frameScaleFactor("areo", world);
    const areoMoons =
      resolvableHysteretic(satelliteEntity("phobos"), effA, false) &&
      resolvableHysteretic(satelliteEntity("deimos"), effA, false);
    check(
      "visibility uniformity: compare hides all 3 moons @ default; zoom reveals; geo shows Moon; areo shows Phobos+Deimos",
      hiddenInCompare && moonZoom && moonGeo && areoMoons,
      `hiddenCompare=${hiddenInCompare} zoomReveals=${moonZoom} geoMoon=${moonGeo} areoMoons=${areoMoons}`,
    );
  }

  // ===== 20. CAMERA — desired is a function of LIVE state ================
  {
    const cam = new Camera(1000, 700);
    const c0 = desiredCamera("helio", worldAt(0), "mars", cam).center;
    const c1 = desiredCamera("helio", worldAt(120 * DAY_S), "mars", cam).center;
    check(
      "camera: desiredCenter tracks LIVE sim state (focus=Mars moves as the clock advances, never cached)",
      Math.hypot(c0[0] - c1[0], c0[1] - c1[1]) > 1e6,
      `Δcenter over 120 d = ${Math.hypot(c0[0] - c1[0], c0[1] - c1[1]).toExponential(2)} km`,
    );
  }

  // ===== 21. CAMERA — monotone convergence on a LIVE moving target while
  //          the clock ADVANCES (this encodes "no black space, no jump") ==
  {
    const cam = new Camera(1000, 700);
    cam.snapTo(desiredCamera("helio", worldAt(0), null, cam)); // framed on the system
    let t = 0;
    const dt = 1 / 60;
    const targetDist = (tt) => {
      const des = desiredCamera("helio", worldAt(tt), "mars", cam);
      return Math.hypot(cam.cx - des.center[0], cam.cy - des.center[1]);
    };
    const dStart = targetDist(0);
    let maxD = 0;
    let last = dStart;
    for (let i = 0; i < 300; i++) {
      t += 15 * DAY_S * dt; // clock running (15 d/s) during the morph
      const des = desiredCamera("helio", worldAt(t), "mars", cam);
      cam.easeToward(des, dt, 7);
      last = Math.hypot(cam.cx - des.center[0], cam.cy - des.center[1]);
      maxD = Math.max(maxD, last);
    }
    check(
      "camera: converges on a LIVE moving focus with the clock advancing — never exceeds the start distance (no overshoot into black space), settles (no terminal jump)",
      maxD <= dStart * 1.0001 && last < dStart * 0.05,
      `start=${dStart.toExponential(2)} maxDuringMorph=${maxD.toExponential(2)} end=${last.toExponential(2)} km`,
    );
  }

  // ===== 22. CAMERA — helio→synodic scale span eases monotonically in log
  {
    const cam = new Camera(1000, 700);
    cam.snapTo(desiredCamera("helio", worldAt(0), null, cam));
    const startScale = cam.scale;
    const targetScale = desiredCamera("em-syn", worldAt(0), null, cam).scale;
    const goingUp = targetScale > startScale;
    let t = 0;
    const dt = 1 / 60;
    let monoLog = true;
    let maxStep = 0;
    for (let i = 0; i < 220; i++) {
      t += 30 * DAY_S * dt;
      const des = desiredCamera("em-syn", worldAt(t), null, cam);
      const before = Math.log(cam.scale);
      cam.easeToward(des, dt, 7);
      const after = Math.log(cam.scale);
      maxStep = Math.max(maxStep, Math.abs(after - before));
      // require monotone DIRECTION only while still morphing (before the camera
      // has converged); once settled, tiny live-target wiggle is not a jump.
      const gap = Math.abs(after - Math.log(des.scale));
      if (gap > 0.05 && (goingUp ? after < before - 1e-12 : after > before + 1e-12)) monoLog = false;
    }
    const desFinal = desiredCamera("em-syn", worldAt(t), null, cam).scale;
    const factor = targetScale / startScale;
    check(
      "camera: helio→Earth–Moon-synodic scale span (multi-order) eases monotonically in LOG space, no discontinuity",
      monoLog && Math.abs(Math.log(cam.scale) - Math.log(desFinal)) < 0.05 && factor > 200 && maxStep < 1,
      `scale factor ≈ ${factor.toExponential(1)}× · monotone-in-log=${monoLog} · max log-step=${maxStep.toFixed(3)}`,
    );
  }

  // ===== 23. Lambert solver — validated against Vallado Example 7-5 ======
  {
    // r in km, tof in s, mu_earth; short-way prograde. Vallado 4th ed. answer.
    const sol = lambert([15945.34, 0], [12214.83899, 10249.46731], 76 * 60, 398600.4418);
    const ok =
      sol &&
      Math.abs(sol.v1[0] - 2.058913) < 1e-4 &&
      Math.abs(sol.v1[1] - 2.915965) < 1e-4 &&
      Math.abs(sol.v2[0] - -3.451565) < 1e-4 &&
      Math.abs(sol.v2[1] - 0.910315) < 1e-4;
    check(
      "Lambert: reproduces the Vallado Example 7-5 reference solution",
      ok,
      sol ? `v1=[${sol.v1.map((x) => x.toFixed(5))}] v2=[${sol.v2.map((x) => x.toFixed(5))}]` : "null",
    );
  }

  // ===== 24. Lambert Hohmann degenerate = the corpus numbers (reconciled) =
  {
    const ae = BODIES.earth.elem.a;
    const am = BODIES.mars.elem.a;
    const h = hohmannEarthMars();
    const sol = lambert([ae, 0], [-am, 0], h.tof, MU_SUN); // exact 180°
    const vEarthCirc = [0, Math.sqrt(MU_SUN / ae)];
    const vMarsCirc = [0, -Math.sqrt(MU_SUN / am)];
    const dep = mag(sub(sol.v1, vEarthCirc));
    const arr = mag(sub(sol.v2, vMarsCirc));
    check(
      "Lambert: the 180° min-energy transfer = Hohmann corpus (dep 2.945, arr 2.649) AND agrees with hohmann.js",
      Math.abs(dep - 2.945) < 0.01 && Math.abs(arr - 2.649) < 0.01 && Math.abs(dep - h.dv1) < 1e-6,
      `Lambert dep=${dep.toFixed(4)} arr=${arr.toFixed(4)} · hohmann.js dv1=${h.dv1.toFixed(4)}`,
    );
  }

  // ===== 25. departing-now Δv is the metronome: troughs at synodic windows =
  {
    const ser = dvSeries("earth", "mars", 0, 2400 * DAY_S, 240, worldAt);
    const finite = ser.filter((p) => isFinite(p.dv)).map((p) => p.dv);
    const gmin = Math.min(...finite);
    const gmax = Math.max(...finite.filter((v) => v < 60));
    const minima = seriesMinima(ser, 1.3);
    const spacings = [];
    for (let k = 1; k < minima.length; k++) {
      spacings.push((ser[minima[k]].t - ser[minima[k - 1]].t) / DAY_S);
    }
    const synodic = 779.9;
    const spacingsOk = spacings.length >= 1 && spacings.every((s) => Math.abs(s - synodic) < 0.1 * synodic);
    check(
      "transfer: departing-now Δv troughs near the Hohmann floor at synodic-spaced windows, steep between",
      gmin < 3.1 && gmax > 3 * gmin && minima.length >= 2 && spacingsOk,
      `min=${gmin.toFixed(2)} max=${gmax.toFixed(1)} nWindows=${minima.length} spacing=[${spacings.map((s) => s.toFixed(0))}]d (synodic ${synodic})`,
    );
  }

  // ===== 26. chart series, telemetry number, live arc all read ONE value ==
  {
    const t = 640 * DAY_S;
    // series[0].t === t (i=0), so its value is exactly departureDvNow(t).
    const seriesVal = dvSeries("earth", "mars", t, t + 100 * DAY_S, 4, worldAt)[0].dv;
    const telemetryVal = departureDvNow("earth", "mars", t, worldAt);
    const best = bestTransferNow("earth", "mars", t, worldAt);
    check(
      "transfer: dvSeries, departureDvNow, and bestTransferNow return the SAME Δv (chart = telemetry = live-arc)",
      seriesVal === telemetryVal && telemetryVal === best.dv,
      `series=${seriesVal.toFixed(6)} telemetry=${telemetryVal.toFixed(6)} best=${best.dv.toFixed(6)}`,
    );
  }

  // ===== 27. the transfer trajectory actually connects Earth → Mars ========
  {
    const dep = 990 * DAY_S; // a window
    const best = bestTransferNow("earth", "mars", dep, worldAt);
    const traj = transferTrajectory("earth", "mars", dep, best.tof, worldAt, 96);
    const w1 = worldAt(dep);
    const w2 = worldAt(dep + best.tof);
    const startErr = mag(sub(traj[0], w1.earth.pos));
    const endErr = mag(sub(traj[traj.length - 1], w2.mars.pos));
    check(
      "transfer: the Lambert trajectory departs Earth and arrives at Mars (endpoints land, <1000 km)",
      traj.length > 2 && startErr < 1000 && endErr < 1000,
      `nPts=${traj.length} startErr=${startErr.toExponential(2)} endErr=${endErr.toExponential(2)} km`,
    );
  }

  // ===== 28. fixed vs live differ once the clock has advanced =============
  {
    const depFixed = 300 * DAY_S;
    const now = 480 * DAY_S; // clock advanced past the pin
    const fixedDv = departureDvNow("earth", "mars", depFixed, worldAt);
    const liveDv = departureDvNow("earth", "mars", now, worldAt);
    const fixedTraj = transferTrajectory(
      "earth",
      "mars",
      depFixed,
      bestTransferNow("earth", "mars", depFixed, worldAt).tof,
      worldAt,
      48,
    );
    const liveTraj = transferTrajectory(
      "earth",
      "mars",
      now,
      bestTransferNow("earth", "mars", now, worldAt).tof,
      worldAt,
      48,
    );
    const trajDiffer = mag(sub(fixedTraj[0], liveTraj[0])) > 1e6; // departure points differ
    check(
      "transfer: fixed (pinned epoch) and live (now) differ once the clock advances — the cost of waiting",
      Math.abs(fixedDv - liveDv) > 0.05 && trajDiffer,
      `fixedDv=${fixedDv.toFixed(3)} liveDv=${liveDv.toFixed(3)} depΔ=${(mag(sub(fixedTraj[0], liveTraj[0])) / AU_KM).toFixed(3)} AU`,
    );
  }

  // ===== 29. frame-aware: the SAME helio trajectory projects through any
  //          frame (heliocentric ellipse; compare-frame rotated) without error
  {
    const dep = 990 * DAY_S;
    const tof = bestTransferNow("earth", "mars", dep, worldAt).tof;
    const traj = transferTrajectory("earth", "mars", dep, tof, worldAt, 48);
    const world = worldAt(dep); // the frame is applied at the CURRENT time (= dep here)
    const arrWorld = worldAt(dep + tof);
    const mHelio = frameMap("helio", world);
    const mCompare = frameMap("earth-mars", world);
    let ok = true;
    for (const p of traj) {
      const a = mHelio(p);
      const b = mCompare(p);
      if (!isFinite(a[0]) || !isFinite(a[1]) || !isFinite(b[0]) || !isFinite(b[1])) ok = false;
    }
    // heliocentric map is identity, so the arc IS the ellipse: it starts at
    // Earth(dep) and ends at Mars(dep+tof). The compare projection is a genuinely
    // different (rotated/scaled) polyline of the same inertial trajectory.
    const helioSpansEM =
      mag(sub(mHelio(traj[0]), world.earth.pos)) < 1000 &&
      mag(sub(mHelio(traj[traj.length - 1]), arrWorld.mars.pos)) < 1000;
    const compareDiffersFromHelio = mag(sub(mCompare(traj[0]), mHelio(traj[0]))) > 1e6;
    check(
      "transfer: the same helio trajectory projects cleanly through helio (ellipse) AND earth-mars (rotated) frames",
      ok && helioSpansEM && compareDiffersFromHelio,
      `finite=${ok} helioEndpoints=${helioSpansEM} compare≠helio=${compareDiffersFromHelio}`,
    );
  }

  // ===== 30. porkchop grid min ≈ the Hohmann corpus + self-consistent =====
  {
    const pc = porkchop({
      fromKey: "earth",
      toKey: "mars",
      depWindow: [850 * DAY_S, 1120 * DAY_S],
      arrWindow: [1150 * DAY_S, 1450 * DAY_S],
      resolution: 48,
      bodyAt: worldAt,
    });
    const m = pc.min;
    // grid cell holds TOTAL Δv (dep+arr); recomputing it independently matches.
    const rc = transferDvs("earth", "mars", pc.depAxis[m.depIdx], m.tof, worldAt);
    const selfConsistent = Math.abs(rc.dep + rc.arr - m.dv) < 1e-9;
    // total ≈ Hohmann corpus 5.594 (dep 2.945 + arr 2.649); departure in-band.
    check(
      "porkchop: grid minimum ≈ the Hohmann corpus (total ~5.59, dep ~2.9) and is self-consistent with transfer.js",
      selfConsistent && m.dv > 5.0 && m.dv < 6.2 && m.dep > 2.2 && m.dep < 3.2,
      `min total=${m.dv.toFixed(3)} (dep=${m.dep.toFixed(3)} arr=${m.arr.toFixed(3)}) · corpus 5.594/2.945`,
    );
  }

  // ===== 31. the 2D islands sit at the same windows as the 1D chart troughs
  {
    const now = 300 * DAY_S;
    const plan = planEfficientLaunch("earth", "mars", now, worldAt);
    // the chart's next trough (window) after `now`
    const ser = dvSeries("earth", "mars", now, now + 900 * DAY_S, 90, worldAt);
    const mins = seriesMinima(ser, 1.3);
    const chartWindowDay = mins.length ? ser[mins[0]].t / DAY_S : NaN;
    const planWindowDay = plan.depTime / DAY_S;
    check(
      "porkchop: the efficient-launch departure aligns with the Δv chart's next window (2D islands = 1D troughs)",
      isFinite(chartWindowDay) && Math.abs(planWindowDay - chartWindowDay) < 40,
      `plan window=${planWindowDay.toFixed(0)}d chart window=${chartWindowDay.toFixed(0)}d`,
    );
  }

  // ===== 32. plan Δv budget is broken out from the research + sums right ===
  {
    const plan = planEfficientLaunch("earth", "mars", 300 * DAY_S, worldAt);
    const leg = plan.legs[0];
    const rows = leg.budget.rows;
    const sum = rows.reduce((s, r) => s + r.dv, 0);
    const allCited = rows.every((r) => typeof r.cite === "string" && r.cite.includes("windows-and-transfers"));
    const hasTMI = rows.some((r) => /trans-Mars injection|TMI/.test(r.label) && Math.abs(r.dv - 3.6) < 0.2);
    const hasSurface = rows.some((r) => /surface → LEO/.test(r.label) && r.dv >= 9.3 && r.dv <= 10);
    const hasCapture = rows.some((r) => /capture/.test(r.label) && Math.abs(r.dv - 0.9) < 0.1);
    check(
      "plan: Δv budget rows are the cited research figures (surface→LEO 9.3–10, TMI ~3.6, capture 0.9) and sum to ~13–14",
      allCited &&
        hasSurface &&
        hasTMI &&
        hasCapture &&
        Math.abs(sum - leg.budgetTotal) < 1e-9 &&
        sum >= 13 &&
        sum <= 14.5,
      `Σ=${sum.toFixed(1)} km/s (surface→${leg.budget.target}); rows cited=${allCited}`,
    );
  }

  // ===== 33. label registry complete; hidden marks get NO label ==========
  {
    const ids = ["sun", "earth", "moon", "mars", "phobos", "deimos", "L1", "L2", "L3", "L4", "L5", "elevator", "craft"];
    const complete = ids.every((id) => DESCRIPTIONS[id] && DESCRIPTIONS[id].label && DESCRIPTIONS[id].blurb);
    const fallback = describe("nonexistent").label === "nonexistent";
    // a label inherits its mark's resolvability: a moon hidden by the predicate
    // (below SHOW at a tiny effScale) draws nothing — dot, ring, AND label.
    const hiddenMoon = resolvableHysteretic(satelliteEntity("moon"), 1e-12, false) === false;
    check(
      "labels: description registry covers every entity; a hidden mark (unresolvable) yields no label",
      complete && fallback && hiddenMoon,
      `registryComplete=${complete} fallback=${fallback} hiddenMoonNoLabel=${hiddenMoon}`,
    );
  }

  // ===== 34. clicking a porkchop cell → a frame-aware transfer ============
  {
    const pc = porkchop({
      fromKey: "earth",
      toKey: "mars",
      depWindow: [900 * DAY_S, 1080 * DAY_S],
      arrWindow: [1180 * DAY_S, 1380 * DAY_S],
      resolution: 24,
      bodyAt: worldAt,
    });
    const dep = pc.depAxis[pc.min.depIdx];
    const traj = transferTrajectory("earth", "mars", dep, pc.min.tof, worldAt, 48);
    const world = worldAt(dep);
    const mHelio = frameMap("helio", world);
    const mCompare = frameMap("earth-mars", world);
    let finite = true;
    for (const p of traj) {
      const a = mHelio(p);
      const b = mCompare(p);
      if (![a[0], a[1], b[0], b[1]].every(isFinite)) finite = false;
    }
    const startsAtEarth = mag(sub(traj[0], world.earth.pos)) < 1000;
    check(
      "porkchop: a clicked cell yields a transfer that renders frame-aware (helio + compare, no NaN)",
      traj.length > 2 && finite && startsAtEarth,
      `nPts=${traj.length} finite=${finite} startsAtEarth=${startsAtEarth}`,
    );
  }

  // ===== 35. EVERY body has a finite position in EVERY frame (no culling) =
  {
    let ok = true;
    let worstFrame = "";
    for (const frameId of FRAME_ORDER) {
      const world = worldAt(200 * DAY_S);
      const map = frameMap(frameId, world);
      for (const key of BODY_KEYS) {
        const s = map(world[key].pos);
        if (!isFinite(s[0]) || !isFinite(s[1])) {
          ok = false;
          worstFrame = `${frameId}/${key}`;
        }
      }
    }
    check(
      "navigation: every body maps to a finite position in every frame (no focus-culling; zoom-out reveals the system)",
      ok,
      ok ? `${BODY_KEYS.length} bodies × ${FRAME_ORDER.length} frames all finite` : `NaN at ${worstFrame}`,
    );
  }

  // ===== 36. frameForZoom: rotating/pinned cascade; translation frames stay =
  {
    let ok = true;
    const details = [];
    // Rotating (em-syn/se-syn) + pinned (earth-mars) frames cascade UP past threshold.
    for (const frameId of ["em-syn", "se-syn", "earth-mars"]) {
      const thr = CASCADE_EFFSCALE[frameId];
      const below = frameForZoom(frameId, thr * 0.99); // zoomed OUT past threshold
      const above = frameForZoom(frameId, thr * 1.01); // still in the frame's range
      if (below !== "helio" || above !== frameId) ok = false;
      details.push(`${frameId}@${thr.toExponential(1)}`);
    }
    // Translation frames (geo/areo) are clean-centred zoomed out → they NEVER
    // cascade, at any zoom (the reported "don't snap me to helio" fix).
    const geoStays = frameForZoom("geo", 1e-12) === "geo" && frameForZoom("geo", 1e3) === "geo";
    const areoStays = frameForZoom("areo", 1e-12) === "areo" && frameForZoom("areo", 1e3) === "areo";
    const noTranslationThreshold = !("geo" in CASCADE_EFFSCALE) && !("areo" in CASCADE_EFFSCALE);
    // one-directional: heliocentric is terminal; zoom-IN (large effScale) never cascades
    const helioTerminal = frameForZoom("helio", 1e-12) === "helio";
    const noDownCascade = frameForZoom("earth-mars", 1e3) === "earth-mars";
    check(
      "navigation: rotating/pinned frames cascade to helio past threshold; translation frames (geo/areo) stay in-frame at any zoom; one-directional",
      ok && geoStays && areoStays && noTranslationThreshold && helioTerminal && noDownCascade,
      `boundaries ${details.join(" ")} · geoStays=${geoStays} areoStays=${areoStays} noThr=${noTranslationThreshold} helioTerminal=${helioTerminal} noDown=${noDownCascade}`,
    );
  }

  // ===== 37. camera scale extent permits a heliocentric framing from any frame
  {
    const cam = new Camera(1000, 700);
    const helioFit = cam.fitScale(bboxInFrame("helio", worldAt(0))); // the system-view scale
    // the extent must not clamp the helio-fit scale, and must reach it from a deep
    // frame (compare/geo) — i.e. minScale ≤ helioFit ≤ maxScale, un-clamped.
    check(
      "navigation: the camera scale extent permits a heliocentric-framing scale (zoom-out to the whole system)",
      cam.clampScale(helioFit) === helioFit &&
        cam.minScale <= helioFit &&
        helioFit <= cam.maxScale &&
        cam.minScale < CASCADE_EFFSCALE["earth-mars"],
      `helioFit=${helioFit.toExponential(2)} extent=[${cam.minScale.toExponential(1)}, ${cam.maxScale.toExponential(1)}]`,
    );
  }

  // ===== 38. default Earth→Mars→Earth course = a conjunction-class mission =
  {
    const c = planCourse({
      waypoints: [{ body: "earth" }, { body: "mars", mode: "orbit" }, { body: "earth", mode: "orbit" }],
      startTime: 0,
      assumptions: { bodyAt: worldAt },
    });
    const yr = c.totalDurationDays / 365.25;
    const l1 = c.legs[0];
    const l2 = c.legs[1];
    // each leg's transferDv IS its porkchop minimum (a real window, not off-window)
    const legsAreWindows =
      l1.transferDv === l1.porkchop.min.dv &&
      l2.transferDv === l2.porkchop.min.dv &&
      l1.transferDv < 8 &&
      l2.transferDv < 8;
    // the return leg departs at a real Mars→Earth window AFTER the Mars stay
    const returnAfterStay = l2.depTime > l1.arrTime && Math.abs((l2.depTime - l1.arrTime) / DAY_S - c.stays[0]) < 1;
    check(
      "course: default Earth→Mars→Earth (orbit/orbit, refuel-on, wait) is conjunction-class (~2.5–3 yr), legs are windows",
      yr > 2.4 && yr < 3.1 && legsAreWindows && returnAfterStay && c.legs.length === 2,
      `duration=${yr.toFixed(2)} yr · legDv=[${l1.transferDv.toFixed(2)},${l2.transferDv.toFixed(2)}] · Mars stay=${c.stays[0].toFixed(0)} d · totalDv=${c.totalDv.toFixed(2)}`,
    );
  }

  // ===== 39. waypoint modes: flyby 0 · orbit = research capture · drop = orbit
  {
    const vInf = 3.16; // ~ a Hohmann-window Mars arrival v∞
    const flyby = waypointDv("mars", "flyby", vInf);
    const orbit = waypointDv("mars", "orbit", vInf);
    const drop = waypointDv("mars", "drop", vInf);
    check(
      "course: flyby capture Δv = 0; orbit = Oberth capture ≈ research 0.9 km/s; drop = orbit",
      flyby === 0 && orbit > 0.7 && orbit < 1.2 && drop === orbit,
      `flyby=${flyby} orbit=${orbit.toFixed(3)} (corpus ~0.9) drop=${drop.toFixed(3)}`,
    );
  }

  // ===== 40. refuel-OFF mass ratio > refuel-ON (rocket-equation compounding)
  {
    const wp = [{ body: "earth" }, { body: "mars", mode: "orbit" }, { body: "earth", mode: "orbit" }];
    const c = planCourse({ waypoints: wp, startTime: 0, assumptions: { bodyAt: worldAt } });
    // manual check of the compounding: e^(Σ) > max e^(each), for ve
    const legDvs = c.legs.map((l) => l.transferDv + l.waypointDv);
    const expectOff = Math.exp(legDvs.reduce((a, b) => a + b, 0) / c.ve);
    const expectOn = Math.max(...legDvs.map((dv) => Math.exp(dv / c.ve)));
    check(
      "course: refuel-OFF (carry all propellant) mass ratio > refuel-ON — the rocket-equation compounds",
      c.massRatioRefuelOff > c.massRatioRefuelOn &&
        rel(c.massRatioRefuelOff, expectOff, 1e-9) &&
        rel(c.massRatioRefuelOn, expectOn, 1e-9),
      `OFF=${c.massRatioRefuelOff.toFixed(1)}× > ON=${c.massRatioRefuelOn.toFixed(1)}×`,
    );
  }

  // ===== 41. a single-leg course == the part-2 single plan (consistent) ====
  {
    const c = planCourse({
      waypoints: [{ body: "earth" }, { body: "mars", mode: "orbit" }],
      startTime: 0,
      assumptions: { bodyAt: worldAt },
    });
    const p2 = planEfficientLaunch("earth", "mars", 0, worldAt);
    const l = c.legs[0];
    check(
      "course: a single-leg course is IDENTICAL to the part-2 efficient launch (same window, same transfer)",
      l.depTime === p2.depTime && l.arrTime === p2.arrTime && l.transferDv === p2.heliocentricTotalDv,
      `course dep=${(l.depTime / DAY_S).toFixed(0)}d vs part2 ${(p2.depTime / DAY_S).toFixed(0)}d · Δv ${l.transferDv.toFixed(3)} vs ${p2.heliocentricTotalDv.toFixed(3)}`,
    );
  }

  // ===== 42. leave-now vs wait-for-window: costlier but faster =============
  {
    const wp = [{ body: "earth" }, { body: "mars", mode: "orbit" }, { body: "earth", mode: "orbit" }];
    const wait = planCourse({ waypoints: wp, startTime: 0, assumptions: { bodyAt: worldAt } });
    const now = planCourse({ waypoints: wp, startTime: 0, assumptions: { bodyAt: worldAt, returnTiming: "leave-now" } });
    check(
      "course: leave-now costs more Δv but takes less time than wait-for-window",
      now.totalDv > wait.totalDv && now.totalDurationDays < wait.totalDurationDays && synodicPeriod("earth", "mars") > 0,
      `leave-now Δv=${now.totalDv.toFixed(1)} (${(now.totalDurationDays / 365.25).toFixed(2)}yr) vs wait Δv=${wait.totalDv.toFixed(1)} (${(wait.totalDurationDays / 365.25).toFixed(2)}yr)`,
    );
  }

  // ===== 43. launch infra body-asymmetry: Earth elevator UNAVAILABLE ======
  {
    const earthEl = availableMethods("earth").find((m) => m.id === "space-elevator");
    const moonEl = surfaceToOrbitWith("moon", "space-elevator");
    const marsEl = surfaceToOrbitWith("mars", "space-elevator");
    check(
      "infra: Earth space-elevator UNAVAILABLE (material reason); Moon + Mars available and collapse surface→orbit",
      !earthEl.available &&
        /material|CNT|manufactur/i.test(earthEl.reason) &&
        moonEl.available &&
        marsEl.available &&
        moonEl.result < 0.5 &&
        marsEl.result < 0.5,
      `Earth el available=${earthEl.available} · Moon 1.9→${moonEl.result} · Mars 4.1→${marsEl.result}`,
    );
  }

  // ===== 44. mass driver: airless Moon removes ~all; Earth ≤ table's 2.4 ===
  {
    const moon = surfaceToOrbitWith("moon", "mass-driver");
    const earth = surfaceToOrbitWith("earth", "mass-driver");
    const mars = surfaceToOrbitWith("mars", "mass-driver");
    check(
      "infra: mass driver removes ~all on airless Moon (leaves a residual); Earth/Mars capped at the table's 2.4 km/s",
      moon.dvRemoved > SURFACE_TO_ORBIT.moon - 0.3 &&
        moon.result >= 0.2 &&
        Math.abs(earth.dvRemoved - 2.4) < 1e-9 &&
        Math.abs(mars.dvRemoved - 2.4) < 1e-9,
      `Moon removes ${moon.dvRemoved.toFixed(1)} (→${moon.result}) · Earth ${earth.dvRemoved.toFixed(1)} · Mars ${mars.dvRemoved.toFixed(1)}`,
    );
  }

  // ===== 45. applyLaunchMethod drops the surface budget; chemical = identical
  {
    const leg = planEfficientLaunch("earth", "mars", 0, worldAt).legs[0];
    const surfRow = (l) => l.budget.rows.find((r) => /surface\s*→\s*(leo|orbit)/i.test(r.label));
    const base = surfRow(leg).dv; // 9.4
    const fromOrbit = applyLaunchMethod(leg, "from-orbit");
    const massDriver = applyLaunchMethod(leg, "mass-driver");
    const chem = applyLaunchMethod(leg, "chemical");
    const dropOk =
      surfRow(fromOrbit).dv === 0 &&
      Math.abs(leg.budgetTotal - fromOrbit.budgetTotal - base) < 1e-9 && // total drops by exactly the removed amount
      Math.abs(surfRow(massDriver).dv - (base - 2.4)) < 1e-9;
    const chemIdentical = chem.budgetTotal === leg.budgetTotal && surfRow(chem).dv === base;
    check(
      "infra: applying a method drops surface→orbit + the total by the table amount; chemical is byte-identical",
      dropOk && chemIdentical,
      `base=${base} from-orbit total ${leg.budgetTotal}→${fromOrbit.budgetTotal} · mass-driver surf ${surfRow(massDriver).dv.toFixed(1)} · chemical unchanged=${chemIdentical}`,
    );
  }

  // ===== 46. craft Δv budgets (rocket equation) match the archetypes ======
  {
    const b = (k) => craftBudget(CRAFT_ARCHETYPES[k].isp, CRAFT_ARCHETYPES[k].propFraction);
    check(
      "mission: craft budgets from the rocket equation — chemical ~7.9, nuclear ~10.6, ion ~27 km/s",
      Math.abs(b("chemical-tug") - 7.9) < 0.2 &&
        Math.abs(b("nuclear-shuttle") - 10.6) < 0.2 &&
        Math.abs(b("ion-freighter") - 27) < 0.5,
      `chemical=${b("chemical-tug").toFixed(1)} nuclear=${b("nuclear-shuttle").toFixed(1)} ion=${b("ion-freighter").toFixed(1)}`,
    );
  }

  // ===== 47. efficient vs fast: fast trades Δv for time (shorter, costlier) =
  {
    const wp = [{ body: "earth", launchMethod: "from-orbit" }, { body: "mars", mode: "orbit" }];
    const craft = CRAFT_ARCHETYPES["nuclear-shuttle"];
    const eff = makeMission({ waypoints: wp, objective: "efficient", craft, bodyAt: worldAt });
    const fast = makeMission({ waypoints: wp, objective: "fast", craft, bodyAt: worldAt });
    check(
      "mission: FAST has shorter TOF and higher Δv than EFFICIENT (trades Δv for time)",
      fast.legs[0].tof < eff.legs[0].tof && fast.inSpaceDv > eff.inSpaceDv,
      `fast TOF ${(fast.legs[0].tof / DAY_S).toFixed(0)}d Δv ${fast.inSpaceDv.toFixed(1)} vs efficient TOF ${(eff.legs[0].tof / DAY_S).toFixed(0)}d Δv ${eff.inSpaceDv.toFixed(1)}`,
    );
  }

  // ===== 48. feasibility: infra reduces requiredDv and can flip it =========
  {
    const craft = CRAFT_ARCHETYPES["chemical-tug"]; // ~7.9 km/s
    const rt = makeMission({
      waypoints: [{ body: "earth", launchMethod: "from-orbit" }, { body: "mars", mode: "orbit" }, { body: "earth", mode: "orbit" }],
      objective: "efficient",
      craft,
      bodyAt: worldAt,
    });
    const surf = makeMission({ waypoints: [{ body: "earth", launchMethod: "chemical" }, { body: "mars", mode: "orbit" }], craft, bodyAt: worldAt });
    const orbit = makeMission({ waypoints: [{ body: "earth", launchMethod: "from-orbit" }, { body: "mars", mode: "orbit" }], craft, bodyAt: worldAt });
    check(
      "mission: chemical tug BUSTS the efficient round-trip (runs dry); from-orbit infra cuts requiredDv and flips one-way feasible",
      !rt.feasible &&
        rt.runsDryLeg >= 0 &&
        Math.abs(rt.requiredDv - rt.budget - 0) > 0 &&
        !surf.feasible &&
        orbit.feasible &&
        orbit.requiredDv < surf.requiredDv &&
        Math.abs(surf.requiredDv - orbit.requiredDv - SURFACE_TO_ORBIT.earth) < 1e-9,
      `round-trip req ${rt.requiredDv.toFixed(1)}>budget ${rt.budget.toFixed(1)} (dry@${rt.runsDryLeg}) · surf ${surf.requiredDv.toFixed(1)} infeasible → orbit ${orbit.requiredDv.toFixed(1)} feasible`,
    );
  }

  // ===== 49. missionStateAt: continuity at arrivals + phase transitions ====
  {
    const m = makeMission({
      waypoints: [{ body: "earth", launchMethod: "from-orbit" }, { body: "mars", mode: "orbit" }, { body: "earth", mode: "orbit" }],
      objective: "efficient",
      craft: CRAFT_ARCHETYPES["nuclear-shuttle"],
      bodyAt: worldAt,
    });
    let worstErr = 0;
    for (const leg of m.legs) {
      const s = missionStateAt(m, leg.tArrive);
      worstErr = Math.max(worstErr, mag(sub(s.pos, worldAt(leg.tArrive)[leg.toKey].pos)));
    }
    const pre = missionStateAt(m, m.legs[0].tDepart - 5 * DAY_S).phase;
    const coast = missionStateAt(m, (m.legs[0].tDepart + m.legs[0].tArrive) / 2).phase;
    const wait = missionStateAt(m, (m.legs[0].tArrive + m.legs[1].tDepart) / 2).phase;
    const arr = missionStateAt(m, m.legs[1].tArrive + 30 * DAY_S).phase;
    check(
      "mission: missionStateAt is continuous (craft lands on each arrival body) with correct phases prelaunch→coasting→waiting→arrived",
      worstErr < 1000 && pre === "prelaunch" && coast === "coasting" && wait === "waiting" && arr === "arrived",
      `worst arrival err ${worstErr.toExponential(2)} km · phases ${pre}/${coast}/${wait}/${arr}`,
    );
  }

  // ===== 50. launch timing: now departs at launchTime; at-window departs later
  {
    const wp = [{ body: "earth", launchMethod: "from-orbit" }, { body: "mars", mode: "orbit" }];
    const craft = CRAFT_ARCHETYPES["nuclear-shuttle"];
    const now = makeMission({ waypoints: wp, objective: "efficient", timing: "leave-now", craft, launchTime: 0, bodyAt: worldAt });
    const win = makeMission({ waypoints: wp, objective: "efficient", timing: "wait-for-window", craft, launchTime: 0, bodyAt: worldAt });
    check(
      "mission: launch-now departs at launchTime (costlier); wait-for-window departs later at lower Δv",
      now.legs[0].tDepart === 0 &&
        win.legs[0].tDepart > 0 &&
        win.legs[0].transferDv < now.legs[0].transferDv,
      `now dep day ${(now.legs[0].tDepart / DAY_S).toFixed(0)} Δv ${now.legs[0].transferDv.toFixed(1)} vs window dep day ${(win.legs[0].tDepart / DAY_S).toFixed(0)} Δv ${win.legs[0].transferDv.toFixed(1)}`,
    );
  }

  // ===== 51. fleet auto-naming: <DEST>-<n>, turnaround not last waypoint ===
  {
    const oneWay = [{ body: "earth", launchMethod: "from-orbit" }, { body: "mars", mode: "orbit" }];
    const roundTrip = [{ body: "earth" }, { body: "mars", mode: "orbit" }, { body: "earth", mode: "orbit" }];
    const moonHop = [{ body: "earth" }, { body: "moon", mode: "orbit" }];
    // turnaround = the farthest waypoint; on a round trip that is Mars, NOT the
    // returning Earth. Per-dest counter increments: MARS-1, MARS-2, …
    check(
      "fleet: auto-name <DEST>-<n> uses the TURNAROUND waypoint (round-trip → MARS, not Earth); counter increments",
      turnaroundKey(oneWay) === "mars" &&
        turnaroundKey(roundTrip) === "mars" &&
        turnaroundKey(moonHop) === "moon" &&
        fleetName(oneWay, 0) === "MARS-1" &&
        fleetName(roundTrip, 1) === "MARS-2" &&
        fleetName(moonHop, 0) === "MOON-1",
      `oneWay=${fleetName(oneWay, 0)} roundTrip@1=${fleetName(roundTrip, 1)} moon=${fleetName(moonHop, 0)}`,
    );
  }

  // ===== 52. two missions with different launchT stay INDEPENDENT ==========
  {
    const wp = [{ body: "earth", launchMethod: "from-orbit" }, { body: "mars", mode: "orbit" }];
    const craft = CRAFT_ARCHETYPES["nuclear-shuttle"];
    const a = makeMission({ waypoints: wp, craft, launchTime: 0, bodyAt: worldAt });
    const b = makeMission({ waypoints: wp, craft, launchTime: 500 * DAY_S, bodyAt: worldAt });
    // different launch epochs ⇒ different departure windows (the missions are
    // separate objects; missionStateAt(a,·) reads only a, so they never couple).
    const depDiffer = a.legs[0].tDepart !== b.legs[0].tDepart;
    // at a's arrival, a has arrived at Mars while b (launched 500 d later) is still
    // parked pre-launch at Earth — two craft, two independent states, same clock.
    const t = a.legs[0].tArrive;
    const sa = missionStateAt(a, t);
    const sb = missionStateAt(b, t);
    const independent =
      sa.phase !== sb.phase && Math.hypot(sa.pos[0] - sb.pos[0], sa.pos[1] - sb.pos[1]) > 1e6;
    check(
      "fleet: two missions with different launchT fly independently (distinct windows + states under one clock)",
      depDiffer && independent && b.legs[0].tDepart > 500 * DAY_S,
      `a dep ${(a.legs[0].tDepart / DAY_S).toFixed(0)}d (${sa.phase}) vs b dep ${(b.legs[0].tDepart / DAY_S).toFixed(0)}d (${sb.phase})`,
    );
  }

  // ===== 53. FOLLOW camera: desired centre = the craft's live mapped position
  {
    const wp = [{ body: "earth", launchMethod: "from-orbit" }, { body: "mars", mode: "orbit" }];
    const m = makeMission({ waypoints: wp, craft: CRAFT_ARCHETYPES["nuclear-shuttle"], launchTime: 0, bodyAt: worldAt });
    const cam = new Camera(1000, 700);
    const t = (m.legs[0].tDepart + m.legs[0].tArrive) / 2; // mid-coast
    const w = worldAt(t);
    const st = missionStateAt(m, t);
    // the target the camera eases toward is EXACTLY the craft position mapped
    // through the active frame (a pure assertion), in helio AND a translation frame
    const dHelio = desiredCameraAt("helio", w, st.pos, cam);
    const mapHelio = frameMap("helio", w)(st.pos);
    const dGeo = desiredCameraAt("geo", w, st.pos, cam);
    const mapGeo = frameMap("geo", w)(st.pos);
    const centreMatches =
      Math.hypot(dHelio.center[0] - mapHelio[0], dHelio.center[1] - mapHelio[1]) < 1e-9 &&
      Math.hypot(dGeo.center[0] - mapGeo[0], dGeo.center[1] - mapGeo[1]) < 1e-9;
    // scale is left user-controlled (= the camera's current scale, not a fit)
    const scalePreserved = dHelio.scale === cam.scale;
    // and it TRACKS live state: a later coasting sample re-centres on the moved craft
    const t2 = t + 20 * DAY_S;
    const d2 = desiredCameraAt("helio", worldAt(t2), missionStateAt(m, t2).pos, cam);
    const tracksLive = Math.hypot(d2.center[0] - dHelio.center[0], d2.center[1] - dHelio.center[1]) > 1e6;
    check(
      "fleet: FOLLOW target centre = missionStateAt(m,t).pos mapped through the frame (frame-agnostic, live, zoom-preserving)",
      centreMatches && scalePreserved && tracksLive,
      `centreMatch=${centreMatches} scalePreserved=${scalePreserved} tracksLive=${tracksLive}`,
    );
  }

  // ===== 54. definition library: presets exist + resolve to missions =======
  {
    const oneWay = MISSION_PRESETS[0];
    const round = MISSION_PRESETS[1];
    const m1 = resolveDefinition(oneWay, 0, worldAt);
    const m2 = resolveDefinition(round, 0, worldAt);
    check(
      "define: two presets (Earth→Mars one-way + round-trip) resolve to missions with the right legs",
      MISSION_PRESETS.length >= 2 &&
        oneWay.waypoints.length === 2 &&
        m1.legs.length === 1 &&
        m1.legs[0].fromKey === "earth" &&
        m1.legs[0].toKey === "mars" &&
        round.waypoints.length === 3 &&
        m2.legs.length === 2,
      `presets=[${MISSION_PRESETS.map((p) => p.name).join(", ")}] · legs ${m1.legs.length}/${m2.legs.length}`,
    );
  }

  // ===== 55. define→launch is an IMMUTABLE snapshot ========================
  {
    const def = definitionFrom({
      name: "X",
      waypoints: [{ body: "earth", launchMethod: "from-orbit" }, { body: "mars", mode: "orbit" }],
    });
    const m = resolveDefinition(def, 0, worldAt);
    const before = { n: m.legs.length, to: m.legs[0].toKey, mode: m.legs[0].mode, dep: m.legs[0].tDepart };
    // mutate the DEFINITION after launch — the snapshot must not move
    def.waypoints[1].mode = "flyby";
    def.waypoints.push({ body: "earth", mode: "orbit" });
    def.objective = "fast";
    def.isp = 5000;
    check(
      "define→launch: the resolved mission is an IMMUTABLE snapshot — editing the def afterward never touches it",
      m.legs.length === before.n &&
        m.legs[0].toKey === before.to &&
        m.legs[0].mode === before.mode &&
        m.legs[0].tDepart === before.dep,
      `legs ${m.legs.length} (was ${before.n}) · leg0 mode ${m.legs[0].mode} (was ${before.mode})`,
    );
  }

  // ===== 56. per-Mars stay/return sets the RETURN leg's departure epoch =====
  {
    const wp = [
      { body: "earth", launchMethod: "from-orbit" },
      { body: "mars", mode: "orbit" },
      { body: "earth", mode: "orbit" },
    ];
    const craft = CRAFT_ARCHETYPES["nuclear-shuttle"];
    const win = makeMission({ waypoints: wp, craft, bodyAt: worldAt }); // next return window
    const stay = 90;
    const fixed = makeMission({ waypoints: wp, craft, assumptions: { returnStayDays: stay, bodyAt: worldAt }, bodyAt: worldAt });
    const gapFixed = (fixed.legs[1].tDepart - fixed.legs[0].tArrive) / DAY_S;
    const gapWindow = (win.legs[1].tDepart - win.legs[0].tArrive) / DAY_S;
    check(
      "define: per-Mars stay/return — a fixed stay departs the return leg exactly N days after arrival (vs the min-Δv window)",
      Math.abs(gapFixed - stay) < 1e-6 && Math.abs(gapWindow - stay) > 30,
      `fixed stay ${gapFixed.toFixed(0)} d (set ${stay}) vs window stay ${gapWindow.toFixed(0)} d`,
    );
  }

  // ===== 57. travel-time totals: total duration = transit + stays ==========
  {
    const m = makeMission({
      waypoints: [
        { body: "earth", launchMethod: "from-orbit" },
        { body: "mars", mode: "orbit" },
        { body: "earth", mode: "orbit" },
      ],
      craft: CRAFT_ARCHETYPES["nuclear-shuttle"],
      bodyAt: worldAt,
    });
    const transit = m.legs.reduce((s, l) => s + l.tof, 0) / DAY_S;
    const stays = m.course.stays.reduce((s, x) => s + x, 0);
    const total = m.course.totalDurationDays;
    const txt = formatMission(m);
    check(
      "define: travel time — total mission duration = transit + stays, and formatMission surfaces it",
      Math.abs(total - (transit + stays)) < 1 &&
        /travel/.test(txt) &&
        /transit/.test(txt) &&
        txt.includes(total.toFixed(0)),
      `transit ${transit.toFixed(0)} + stays ${stays.toFixed(0)} = ${total.toFixed(0)} d`,
    );
  }

  // ===== 58. analysis views key off the SELECTED def's first leg ============
  {
    const marsDef = MISSION_PRESETS[0];
    const moonDef = definitionFrom({
      name: "Moon",
      waypoints: [{ body: "earth", launchMethod: "from-orbit" }, { body: "moon", mode: "orbit" }],
    });
    const km = firstLegKeys(marsDef);
    const kk = firstLegKeys(moonDef);
    const single = firstLegKeys(definitionFrom({ name: "z", waypoints: [{ body: "earth" }] }));
    check(
      "define: analysis (preview/porkchop/plan/chart) keys off the SELECTED def's first leg (firstLegKeys), not a hardcoded earth→mars",
      km.from === "earth" && km.to === "mars" && kk.from === "earth" && kk.to === "moon" && single === null,
      `mars-def ${km.from}→${km.to} · moon-def ${kk.from}→${kk.to} · single=${single}`,
    );
  }

  // ===== 59. Mars/Earth orbit rings project through the COMPARE frame ========
  {
    const world = worldAt(200 * DAY_S);
    const map = frameMap("earth-mars", world);
    const eOrbit = orbitTrace("earth").map(map);
    const mOrbit = orbitTrace("mars").map(map);
    const allFinite = [...eOrbit, ...mOrbit].every((p) => isFinite(p[0]) && isFinite(p[1]));
    // the coherent-reference property: each planet lands ON its own projected ring
    // (min distance to the polyline ≈ 0, limited only by the trace's chord spacing).
    const eScr = map(world.earth.pos);
    const mScr = map(world.mars.pos);
    const sunScr = map(world.sun.pos);
    const meanR = (poly) => poly.reduce((s, q) => s + Math.hypot(q[0] - sunScr[0], q[1] - sunScr[1]), 0) / poly.length;
    const minDist = (pt, poly) => Math.min(...poly.map((q) => Math.hypot(q[0] - pt[0], q[1] - pt[1])));
    const eR = meanR(eOrbit);
    const mR = meanR(mOrbit);
    check(
      "render: Earth/Mars orbit rings project FINITE through the pinned compare frame, each planet riding its own ring (item-1)",
      allFinite && minDist(eScr, eOrbit) / eR < 0.05 && minDist(mScr, mOrbit) / mR < 0.05 && mR > eR,
      `finite=${allFinite} · Earth off-ring ${(minDist(eScr, eOrbit) / eR).toFixed(3)} · Mars off-ring ${(minDist(mScr, mOrbit) / mR).toFixed(3)} · rings E<M ${mR > eR}`,
    );
  }

  // ===== 10. defensive: junk inputs must not throw ======================
  {
    let survived = true;
    try {
      frameMap("nonsense", worldAt(0))([1, 2]);
      frameUnmap("nonsense", worldAt(0))([1, 2]);
      frameMap("earth-mars", worldAt(0))(worldAt(0).mars.pos);
      frameMap("areo", worldAt(0))(worldAt(0).phobos.pos);
      lagrangeHelio(worldAt(0), "helio"); // non-synodic → []
      lagrangeHelio(worldAt(0), "earth-mars"); // non-synodic → []
      synodicState({ pos: [0, 0], vel: [0, 0] }, { pos: [1, 0], vel: [0, 1] });
      orbitFromState([1e5, 0], [0, 1], MU_EARTH);
      craftStateAt(makeCraft([7000, 0], [0, 7.5], MU_EARTH, "earth", 0), 500);
      resolvable(satelliteEntity("phobos"), 1e-9);
      resolveMarks([]);
      desiredCamera("earth-mars", worldAt(0), null, new Camera(800, 600));
      lambert([1, 0], [1, 0], 100, MU_SUN); // collinear degenerate → null, no throw
      departureDvNow("earth", "mars", 0, worldAt);
      transferTrajectory("earth", "mars", 0, 200 * DAY_S, worldAt, 8);
      seriesMinima([]);
      porkchop({ fromKey: "earth", toKey: "mars", depWindow: [0, 10 * DAY_S], arrWindow: [0, 5 * DAY_S], resolution: 4, bodyAt: worldAt });
      planEfficientLaunch("earth", "mars", 0, worldAt, { resolution: 8 });
      planCourse({ waypoints: [{ body: "earth" }], startTime: 0, assumptions: { bodyAt: worldAt } }); // 1 waypoint → 0 legs
      waypointDv("sun", "orbit", 5); // no capture data → 0, no throw
      surfaceToOrbitWith("sun", "space-elevator"); // no budget → 0, no throw
      applyLaunchMethod({ from: "earth", to: "mars", budget: null }, "space-elevator"); // Earth el unavailable → unchanged
      availableMethods("ceres");
      makeMission({ waypoints: [{ body: "earth" }], craft: null, bodyAt: worldAt }); // 0 legs, no craft
      missionStateAt(makeMission({ waypoints: [{ body: "earth" }], bodyAt: worldAt }), 0);
      craftBudget(0, 2); // invalid → 0, no throw
      turnaroundKey([]); // empty → default "earth", no throw
      fleetName([{ body: "earth" }, { body: "mars" }], 0); // → "MARS-1"
      desiredCameraAt("nonsense", worldAt(0), [1, 2], new Camera(800, 600)); // bad frame → no throw
      firstLegKeys(definitionFrom({ name: "z", waypoints: [{ body: "earth" }] })); // 1 wp → null
      resolveDefinition(definitionFrom({ name: "z", waypoints: [{ body: "earth" }] }), 0, worldAt); // 0 legs
      makeMission({ waypoints: [{ body: "earth" }, { body: "mars", mode: "orbit" }, { body: "earth", mode: "orbit" }], assumptions: { returnStayDays: 0, bodyAt: worldAt }, bodyAt: worldAt }); // 0-day stay
      describe("nope");
    } catch (err) {
      survived = false;
      check("defensive: junk inputs do not throw", false, String(err));
    }
    if (survived) check("defensive: unknown frames / degenerate states do not throw", true, "");
  }

  // ===== 60. UI state model: the reducer is TOTAL and every transition lands in
  //           a KNOWN state; the named invariants hold (incl. the Sun-fix) =======
  // This is what makes "known states, not bespoke buggy experiences" machine-checked
  // rather than aspirational: the combination-bug class is provably closed here.
  {
    const validUi = (u) =>
      !!u &&
      FRAME_IDS.includes(u.frame) &&
      !!u.camera &&
      CAMERA_KINDS.includes(u.camera.kind) &&
      WORKSPACES.includes(u.workspace) &&
      !!u.playback &&
      typeof u.playback.playing === "boolean" &&
      u.playback.rate > 0;

    const emThr = CASCADE_EFFSCALE["earth-mars"];
    const emState = reduce(INITIAL, { type: "SELECT_FRAME", frame: "earth-mars" });
    const followEM = reduce(emState, { type: "FOLLOW_CRAFT", id: "m1" });
    const geoState = reduce(INITIAL, { type: "SELECT_FRAME", frame: "geo" });
    const followGeo = reduce(geoState, { type: "FOLLOW_CRAFT", id: "m1" });
    const defineState = reduce(INITIAL, { type: "OPEN_WORKSPACE", workspace: "define" });
    const startStates = [INITIAL, emState, followEM, geoState, followGeo, defineState];
    const ACTIONS = [
      { type: "SELECT_FRAME", frame: "earth-mars" },
      { type: "SELECT_FRAME", frame: "geo" },
      { type: "SELECT_FRAME", frame: "nonsense" }, // rejected → identity
      { type: "ZOOM", effScale: emThr * 0.99 }, // deep zoom-out
      { type: "ZOOM", effScale: 1e3 }, // zoom-in
      { type: "PAN" },
      { type: "FIT" },
      { type: "FOCUS_BODY", key: "mars" },
      { type: "FOLLOW_CRAFT", id: "m1" },
      { type: "UNFOLLOW" },
      { type: "OPEN_WORKSPACE", workspace: "define" },
      { type: "OPEN_WORKSPACE", workspace: "fleet" },
      { type: "CLOSE_WORKSPACE" },
      { type: "TOGGLE_WORKSPACE", workspace: "sandbox" },
      { type: "PLAY" },
      { type: "PAUSE" },
      { type: "SET_RATE", rate: 12345 },
      { type: "RESET_T" },
      { type: "__unknown__" },
      {},
      null,
    ];
    let swept = 0;
    let allValid = true;
    for (const s of startStates) {
      for (const a of ACTIONS) {
        let r;
        try {
          r = reduce(s, a);
        } catch {
          allValid = false;
          continue;
        }
        swept++;
        if (!validUi(r)) allValid = false;
      }
    }
    check(
      "ui-model: reducer is total — every (state × action) lands in a KNOWN valid state",
      allValid && swept === startStates.length * ACTIONS.length,
      `swept ${swept} transitions`,
    );

    // THE SUN FIX, asserted directly: a pinned frame zoomed OUT past its threshold
    // cascades to the heliocentric container (where the Sun is a disc), so the
    // "stranded Sun in zoomed-out compare" state is now UNREACHABLE.
    check(
      "ui-model: ZOOM-out in the pinned compare frame cascades to heliocentric (Sun-stranded state unreachable)",
      reduce(emState, { type: "ZOOM", effScale: emThr * 0.99 }).frame === "helio",
      `earth-mars @ ${(emThr * 0.99).toExponential(2)} → helio`,
    );
    {
      const z = reduce(geoState, { type: "ZOOM", effScale: 1e-12 });
      check(
        "ui-model: a translation frame (geo) never cascades on zoom-out — stays in-frame, camera → manual",
        z.frame === "geo" && z.camera.kind === "manual",
        `geo → ${z.frame} / ${z.camera.kind}`,
      );
    }
    check(
      "ui-model: SELECT_FRAME reframes — releases any follow/focus back to fit",
      reduce(followEM, { type: "SELECT_FRAME", frame: "geo" }).camera.kind === "fit",
      "",
    );
    check(
      "ui-model: at most one workspace open (OPEN switches; TOGGLE same closes)",
      reduce(defineState, { type: "OPEN_WORKSPACE", workspace: "fleet" }).workspace === "fleet" &&
        reduce(defineState, { type: "TOGGLE_WORKSPACE", workspace: "define" }).workspace === "none",
      "",
    );
    check(
      "ui-model: a craft-follow survives an ordinary zoom AND a cascade; only PAN drops it",
      reduce(followGeo, { type: "ZOOM", effScale: 1e-12 }).camera.kind === "follow" &&
        reduce(followEM, { type: "ZOOM", effScale: emThr * 0.99 }).camera.kind === "follow" &&
        reduce(followEM, { type: "PAN" }).camera.kind === "manual",
      "",
    );
    check(
      "ui-model: unknown & malformed actions are identity (no accidental state change)",
      reduce(INITIAL, { type: "nope" }) === INITIAL &&
        reduce(INITIAL, {}) === INITIAL &&
        reduce(INITIAL, null) === INITIAL,
      "",
    );
    check(
      "ui-model: PLAY/PAUSE toggle playback MODE; SET_RATE takes only a positive rate",
      reduce(reduce(INITIAL, { type: "PAUSE" }), { type: "PLAY" }).playback.playing === true &&
        reduce(INITIAL, { type: "PAUSE" }).playback.playing === false &&
        reduce(INITIAL, { type: "SET_RATE", rate: 999 }).playback.rate === 999 &&
        reduce(INITIAL, { type: "SET_RATE", rate: -5 }) === INITIAL,
      "",
    );
  }

  const pass = results.every((r) => r.ok);
  return { pass, results };
}

// ---- node entry (browser-safe: gated on globalThis.process) ----------------
// eslint reads apps/**/*.js with browser globals only, so reach node's `process`
// through globalThis to stay lint-clean and undefined in the browser.
const proc = globalThis.process;
if (proc && Array.isArray(proc.argv) && /selftest\.js$/.test(proc.argv[1] || "")) {
  const { pass, results } = runSelftest();
  for (const r of results) {
    console.log(`  [${r.ok ? "ok  " : "FAIL"}] ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }
  console.log(`\n[delta-v-sim] selftest ${pass ? "PASS" : "FAIL"} (${results.filter((r) => r.ok).length}/${results.length})`);
  proc.exit(pass ? 0 : 1);
}
