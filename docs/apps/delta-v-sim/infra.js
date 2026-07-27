// infra.js — the launch-infrastructure config knob. Each launch method modifies
// a departure's surface→orbit Δv, and availability is BODY-ASYMMETRIC straight
// from notes/delta-v/research/launch-and-velocity-transfer.md (the comparison
// table + the gravity-well table). That asymmetry IS the point: the buildable set
// at each body is a fingerprint of its escape velocity, atmosphere, and field —
// "the map teaches the physics." Pure/DOM-free. DEPARTURE side only; arrival-
// capture infrastructure (mass-driver catcher, skyhook catch) is the symmetric
// roadmap extension (see architecture.md).

import { dvRemovedByStructure } from "./structures.js";

const CITE = "launch-and-velocity-transfer.md";

// Practical surface→orbit budget per body, from the gravity-well table: Earth
// 9.3–10, Mars ~4.1 (ascent), Moon ~1.8–2. (§gravity-well depth)
export const SURFACE_TO_ORBIT = { earth: 9.4, mars: 4.1, moon: 1.9 };

// Each method: label + maturity, dvRemoved(body) (km/s taken off surface→orbit),
// a residual floor (a kick-stage / circularization bit it can't remove — never
// unphysically zeroed), a citation, and an availability RULE per body →
// { ok, reason?, caveat? } (the body-asymmetry).
export const LAUNCH_METHODS = {
  chemical: {
    id: "chemical",
    label: "chemical rocket (surface)",
    maturity: "FLOWN",
    dvRemoved: () => 0,
    residual: 0,
    cite: `${CITE} §gravity-well depth`,
    available: () => ({ ok: true }),
  },
  "from-orbit": {
    id: "from-orbit",
    label: "from orbit (already in LEO/parking)",
    maturity: "FLOWN",
    dvRemoved: (b) => SURFACE_TO_ORBIT[b] || 0, // skip surface→orbit entirely
    residual: 0,
    cite: `${CITE} §gravity-well depth`,
    available: () => ({ ok: true }),
  },
  "mass-driver": {
    id: "mass-driver",
    label: "mass driver (EM launch)",
    maturity: "PROVEN-PHYSICS; prototype TESTED 1977",
    // dvRemoved DERIVES from structures['mass-driver'].exitVel (2.4 km/s, > lunar
    // escape 2.38) — the SAME number the simulated object throws with. No drift.
    dvRemoved: (b) => dvRemovedByStructure("mass-driver", SURFACE_TO_ORBIT[b] || 0),
    residual: 0.2,
    cite: `${CITE} §A2 mass driver`,
    available: (b) => {
      if (b === "moon") return { ok: true }; // ✓✓ ideal (airless, shallow well)
      if (b === "mars") return { ok: true, caveat: "◐ thin atmosphere + moderate g limit it" };
      if (b === "earth")
        return { ok: true, caveat: "◐ cargo-only (high-g); atmosphere penalizes — airless-ideal" };
      return { ok: true }; // small airless bodies ✓✓
    },
  },
  skyhook: {
    id: "skyhook",
    label: "skyhook / rotovator",
    maturity: "PROVEN-PHYSICS; tethers TESTED",
    // dvRemoved DERIVES from structures.skyhook.exitVel — MXER's cited 2.4 km/s (the
    // conservative end of the research's 2.4–4 range; the old 3.2 was untraceable).
    dvRemoved: (b) => dvRemovedByStructure("skyhook", SURFACE_TO_ORBIT[b] || 0),
    residual: 0.3,
    cite: `${CITE} §B1 skyhook`,
    // Honest boundary (refuse-to-fake): the tip Δv is credited, but each throw drops
    // the tether and reboost is NOT modeled — flagged so it never reads as free.
    available: () => ({ ok: true, caveat: "◐ each throw drops the tether; reboost not modeled" }),
  },
  "space-elevator": {
    id: "space-elevator",
    label: "space elevator",
    maturity: "Moon/Mars PROVEN-PHYSICS; Earth SPECULATIVE",
    // dvRemoved DERIVES from structures['space-elevator'] (exitVel null ⇒ rides to
    // the balance point, removes ALL of surface→orbit).
    dvRemoved: (b) => dvRemovedByStructure("space-elevator", SURFACE_TO_ORBIT[b] || 0),
    residual: 0.2,
    cite: `${CITE} §A1 space elevator`,
    available: (b) => {
      if (b === "earth")
        return {
          ok: false,
          reason:
            "Earth: material infeasible — no CNT/graphene ribbon manufacturable at length (taper ratio explodes below ~30 MYuri; Google X's own study froze on the meter-length wall)",
        };
      if (b === "mars")
        return { ok: true, caveat: "◐ needs a Phobos-anchored/slewing variant (Phobos crosses the plane)" };
      if (b === "moon") return { ok: true }; // ✓ with today's fabrics (Dyneema/Zylon/M5)
      return { ok: true };
    },
  },
};

export const LAUNCH_METHOD_ORDER = [
  "chemical",
  "from-orbit",
  "mass-driver",
  "skyhook",
  "space-elevator",
];

// The methods at a body with availability + reason/caveat — for the UI's
// disabled-with-reason dropdown (the workbench pattern).
export function availableMethods(body) {
  return LAUNCH_METHOD_ORDER.map((id) => {
    const m = LAUNCH_METHODS[id];
    const a = m.available(body);
    return {
      id,
      label: m.label,
      available: !!a.ok,
      reason: a.reason || "",
      caveat: a.caveat || "",
      maturity: m.maturity,
    };
  });
}

// The surface→orbit Δv after applying a method at a body (clamped ≥ its residual
// floor — a mass driver/elevator still leaves a small insertion bit, never zero).
export function surfaceToOrbitWith(body, methodId) {
  const m = LAUNCH_METHODS[methodId] || LAUNCH_METHODS.chemical;
  const base = SURFACE_TO_ORBIT[body] || 0;
  const a = m.available(body);
  if (!a.ok) return { available: false, reason: a.reason, base, result: base, dvRemoved: 0 };
  const removed = Math.min(m.dvRemoved(body), base);
  const result = Math.max(m.residual, base - removed);
  return {
    available: true,
    method: m.id,
    label: m.label,
    base,
    result,
    dvRemoved: base - result,
    residual: m.residual,
    caveat: a.caveat || "",
    cite: m.cite,
  };
}
