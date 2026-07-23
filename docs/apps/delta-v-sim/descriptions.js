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

// UI-CONCEPT blurbs — the "ⓘ" affordances next to Define-panel controls, so the app
// explains itself. Same data-driven pattern as DESCRIPTIONS (one row per concept),
// surfaced through the SAME hover-tooltip DOM. Keep each a single tight line.
export const UI_BLURBS = {
  isp: "specific impulse: engine efficiency (seconds). Higher = more Δv per kg of propellant.",
  prop: "propellant mass fraction (0–1): the share of the craft that's fuel. Higher = more Δv (structurally harder).",
  budget:
    "the total Δv a full tank delivers: Isp·g₀·ln(1/(1−prop)) — the rocket equation. The mission is feasible if budget ≥ required Δv.",
  craft:
    "presets for Isp + prop: chemical tug (~7.9), nuclear shuttle (~10.6), ion freighter (~27 km/s). Sets the Δv budget.",
  objective:
    "efficient = minimum Δv (waits for the launch window); fast = minimum time (higher Δv, shorter trip).",
  timing:
    "at-window: loiter until the min-Δv departure window; now: leave immediately — costs far more Δv.",
  window:
    "found by the porkchop: scan departure × arrival dates over the next synodic period (~780 d for Earth–Mars) and take the minimum-Δv cell.",
  refuel:
    "tank up at each stop, so the craft carries only ONE leg's Δv at a time (feasibility = worst leg). Off = carry all propellant at once (feasibility = the sum).",
  "launch-method":
    "surface→orbit cost leaving the ORIGIN, after infrastructure (elevator / mass-driver cut it). Later legs launch from the orbit the craft is already in (0).",
  feasibility:
    "feasible if the craft's Δv budget ≥ the mission's required Δv (with refuel, the worst single leg).",
  elevator:
    "standalone demo — let a payload go from the lunar elevator; the Moon's orbital motion + the elevator's rotation give it velocity with NO propellant, and the sim draws the resulting orbit. It illustrates 'elevator as a launch system' — it does NOT feed the mission planner (the space-elevator LAUNCH METHOD in a mission is separate).",
};

export function uiBlurb(id) {
  return UI_BLURBS[id] || "";
}
