// elevator.js — the lunar space-elevator TOOL: a strut fixed in the Earth–Moon
// synodic frame, reaching from the Moon toward Earth (toward Earth–Moon L1).
// Release a payload at distance dFromMoon; its inertial velocity is
// v_moon + ω × offset, propagated as an Earth-relative 2-body conic. Pure.

import { add, sub, rot } from "./vec.js";
import { MU_EARTH } from "./sim.js";
import { synodicState } from "./frames.js";
import { makeCraft } from "./spacecraft.js";

// Heliocentric release state of a payload let go dFromMoon km up the elevator.
export function elevatorReleaseState(world, dFromMoon) {
  const { phi, omega } = synodicState(world.earth, world.moon);
  // Offset from the Moon toward Earth, in the synodic frame, is (−d, 0);
  // rotate into heliocentric coordinates.
  const offsetHelio = rot([-dFromMoon, 0], phi);
  const pos = add(world.moon.pos, offsetHelio);
  // v = v_moon + ω ẑ × offset   (ω ẑ × (ox,oy) = ω(−oy, ox))
  const vel = add(world.moon.vel, [-omega * offsetHelio[1], omega * offsetHelio[0]]);
  return { pos, vel };
}

// Build the released payload's Earth-relative 2-body conic (a drawable craft).
export function elevatorPayloadCraft(world, dFromMoon, t0) {
  const rel = elevatorReleaseState(world, dFromMoon);
  const rRel = sub(rel.pos, world.earth.pos);
  const vRel = sub(rel.vel, world.earth.vel);
  const craft = makeCraft(rRel, vRel, MU_EARTH, "earth", t0, "elevator payload");
  craft.releaseHelio = rel.pos;
  return craft;
}
