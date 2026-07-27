// gravity-assist.js — the patched-conic gravity assist, made REAL (replacing the
// v1 "flyby = free pass-through" that did not bend the trajectory). Pure/DOM-free,
// analytic (no integrator — fits the sim's architecture).
//
// The physics: inside a body's sphere of influence the flyby conserves the
// hyperbolic excess speed |v∞| but ROTATES it by up to a maximum deflection δ_max
// set by the closest approach. Because v_helio = v_body + v∞, rotating v∞ at
// constant magnitude CHANGES the heliocentric speed — that free change IS the
// slingshot. A burn covers only what gravity can't: the |v∞| mismatch between the
// incoming and required-outgoing excess, plus any turn beyond δ_max. Coplanar 2D,
// so the turn is a signed in-plane rotation.
//
// This RE-PRICES a flyby honestly (refuse-to-fake): a well-aligned flyby whose
// geometry gravity can supply costs ≈ 0 (a real assist); one that demands more than
// gravity gives costs the residual. It does NOT re-optimize the trajectory to SEEK
// beneficial assists — that (a constrained multi-leg search) stays roadmap.

import { mag, sub, dot } from "./vec.js";

// Max hyperbolic deflection (rad) for excess speed vInf at closest approach rp:
//   sin(δ/2) = 1/e,  e = 1 + rp·vInf²/μ.  Higher speed or higher periapsis ⇒ less
// bending. Returns 0 for degenerate inputs (no free turn).
export function maxDeflection(vInf, mu, rp) {
  if (!(vInf > 0) || !(mu > 0) || !(rp > 0)) return 0;
  const e = 1 + (rp * vInf * vInf) / mu;
  return 2 * Math.asin(1 / e);
}

// Rotate a 2D vector by angle a (CCW).
function rot2(v, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1]];
}

// The gravity assist at a flyby body. `vInfIn`/`vInfOut` are the incoming and
// required-outgoing hyperbolic-excess vectors RELATIVE TO THE BODY (v_helio −
// v_body); `mu`, `rpMin` are the body's gravitational parameter and minimum flyby
// periapsis. Returns:
//   residualDv   — the burn a powered flyby must add (0 ⇒ gravity did it all),
//   freeTurn     — the rotation gravity supplied (rad),
//   requiredTurn — the rotation the geometry demanded (rad),
//   maxTurn      — δ_max at this speed/periapsis (rad),
//   inMag/outMag — the excess speeds (a mismatch is un-assistable → costs Δv).
export function gravityAssist(vInfIn, vInfOut, mu, rpMin) {
  const inMag = mag(vInfIn);
  const outMag = mag(vInfOut);
  if (!(inMag > 0) || !(outMag > 0)) {
    return { residualDv: mag(sub(vInfOut, vInfIn)), freeTurn: 0, requiredTurn: 0, maxTurn: 0, inMag, outMag };
  }
  const cosT = Math.max(-1, Math.min(1, dot(vInfIn, vInfOut) / (inMag * outMag)));
  const requiredTurn = Math.acos(cosT);
  // sign of the required rotation (in-plane cross product z-component)
  const cz = vInfIn[0] * vInfOut[1] - vInfIn[1] * vInfOut[0];
  const dir = cz >= 0 ? 1 : -1;
  const maxTurn = maxDeflection(inMag, mu, rpMin);
  const usedTurn = Math.min(requiredTurn, maxTurn);
  // gravity's best: rotate the incoming excess by what it can, magnitude preserved
  const best = rot2(vInfIn, dir * usedTurn);
  // the burn spans gravity's best → the required outgoing excess (covers the |v∞|
  // mismatch AND any un-supplied turn)
  const residualDv = mag(sub(vInfOut, best));
  return { residualDv, freeTurn: usedTurn, requiredTurn, maxTurn, inMag, outMag };
}
