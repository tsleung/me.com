// tiers.js — the provenance TIER taxonomy, the enforceable form of the sim's
// refuse-to-fake discipline (notes/delta-v-sim/journeys.md §Provenance tiers).
// Every physical number a catalog carries and every mark the sim draws declares
// exactly one tier; an undeclared tier is a bug, not a default. Pure/DOM-free.
//
//   measured        — a real physical quantity (JPL/IAU): orbital elements, μ, radii.
//                     Drawn to true scale, NEVER scaled for legibility (hide instead).
//   derived         — cited closed-form physics from measured inputs (conics, Lambert,
//                     the rocket equation). Correct given the stated model.
//   cited-proposal  — a published engineering figure about a system that does not
//                     exist yet (mass-driver exit velocity, MXER tip speed, the L1
//                     anchor). A real number about an unbuilt machine — needs a cite.
//   illustrative    — makes NO physical claim (glyph sizes, effects, structure
//                     geometry drawn as a symbol, title cards). Must be badged.
export const TIER = {
  MEASURED: "measured",
  DERIVED: "derived",
  CITED_PROPOSAL: "cited-proposal",
  ILLUSTRATIVE: "illustrative",
};

export const TIERS = Object.values(TIER);

export function isTier(t) {
  return TIERS.includes(t);
}
