// descriptions.js — the entity description registry: one row per entity, giving
// its always-on short `label` and a one-line hover `blurb`. Data-driven: a new
// entity is a new row here (render reads label; the tooltip reads blurb). Pure.

export const DESCRIPTIONS = {
  sun: { label: "Sun", blurb: "The primary. Heliocentric origin; μ = 1.327×10¹¹ km³/s²." },
  earth: {
    label: "Earth",
    blurb: "Home. a = 1 AU, e = 0.017. Departure body for Mars transfers.",
  },
  moon: {
    label: "Moon",
    blurb: "Earth's moon. a = 384,400 km, T = 27.32 d. Space-elevator anchor via Earth–Moon L1.",
  },
  mars: {
    label: "Mars",
    blurb: "The destination. a = 1.524 AU, e = 0.093 — its eccentricity drives cheap-vs-expensive windows.",
  },
  phobos: {
    label: "Phobos",
    blurb: "Inner Mars moon. a = 9,376 km, T = 0.319 d — orbits Mars ~3×/day.",
  },
  deimos: { label: "Deimos", blurb: "Outer Mars moon. a = 23,463 km, T = 1.26 d." },
  L1: {
    label: "L1",
    blurb: "Earth–Moon L1, ~5.8×10⁴ km from the Moon — the lunar space-elevator anchor.",
  },
  L2: { label: "L2", blurb: "Collinear Lagrange point just beyond the secondary." },
  L3: { label: "L3", blurb: "Collinear Lagrange point on the far side of the primary." },
  L4: { label: "L4", blurb: "Equilateral (leading) Lagrange point, +60° — stable." },
  L5: { label: "L5", blurb: "Equilateral (trailing) Lagrange point, −60° — stable." },
  elevator: {
    label: "elevator",
    blurb: "Lunar space elevator: Moon → Earth–Moon L1, fixed in the rotating frame.",
  },
  release: { label: "release", blurb: "Elevator payload release point along the strut." },
  craft: { label: "craft", blurb: "Your spacecraft: a 2-body conic around its primary." },
};

// Lookup with a safe fallback so a missing row never breaks a draw.
export function describe(id) {
  return DESCRIPTIONS[id] || { label: id, blurb: "" };
}
