// historical.js — real Mars missions as selectable presets. The sim uses
// ILLUSTRATIVE phasing (not a real ephemeris), so we deliberately DON'T reproduce a
// mission's calendar date — a mission's identity is its ITINERARY (waypoints +
// modes), and the sim resolves it at the CURRENT clock, finding a real transfer
// window. The date / agency / outcome are METADATA (legibility + education), never
// simulation inputs. Pure/DOM-free.
//
// Mode mapping: flyby → flyby; orbiter → orbit; lander/rover → drop (delivered a
// payload — the sim doesn't model descent); sample-return → a round trip (→ Earth).
//
// Mars moons are REAL waypoints (2026-07-26): a Phobos/Deimos leg routes its
// interplanetary transfer via Mars (the moon co-moves with its primary), then costs
// a Mars-orbit rendezvous with the moon (plan.moonRendezvousDv — no gravity well to
// capture into, so you match its orbit, ~2 km/s ON TOP of reaching Mars). What the
// sim still does NOT resolve: the detailed Mars-centric transfer geometry (the arc
// is drawn to the moon's position ≈ Mars); the cost + window are honest.

import { definitionFrom } from "./mission.js";

const EARTH = { body: "earth", launchMethod: "from-orbit" }; // the probe starts in a parking orbit

// Every mission flew chemical propulsion → the chemical-tug archetype. A sample
// return on chemical is honestly heavy (often infeasible in-sim) — that IS the
// lesson (why Mars-system sample return is hard). Names carry the year.
export const HISTORICAL_MISSIONS = [
  // --- flyby ---
  {
    id: "mariner-4", name: "Mariner 4", year: 1965, agency: "NASA", kind: "flyby",
    note: "First successful Mars flyby — 22 images of a cratered world.",
    waypoints: [EARTH, { body: "mars", mode: "flyby" }],
  },
  // --- orbiters ---
  {
    id: "mariner-9", name: "Mariner 9", year: 1971, agency: "NASA", kind: "orbiter",
    note: "First spacecraft to orbit another planet; mapped ~85% of Mars.",
    waypoints: [EARTH, { body: "mars", mode: "orbit" }],
  },
  {
    id: "mars-express", name: "Mars Express", year: 2003, agency: "ESA", kind: "orbiter",
    note: "ESA's first Mars mission; orbiter (+ the lost Beagle 2 lander).",
    waypoints: [EARTH, { body: "mars", mode: "orbit" }],
  },
  {
    id: "mro", name: "Mars Reconnaissance Orbiter", year: 2005, agency: "NASA", kind: "orbiter",
    note: "High-resolution imaging + the primary telecom relay at Mars.",
    waypoints: [EARTH, { body: "mars", mode: "orbit" }],
  },
  {
    id: "mom", name: "Mars Orbiter Mission (Mangalyaan)", year: 2013, agency: "ISRO", kind: "orbiter",
    note: "India's first interplanetary mission — Earth-orbit-raising, then transfer.",
    waypoints: [EARTH, { body: "mars", mode: "orbit" }],
  },
  {
    id: "maven", name: "MAVEN", year: 2013, agency: "NASA", kind: "orbiter",
    note: "Studies how Mars lost its atmosphere to space.",
    waypoints: [EARTH, { body: "mars", mode: "orbit" }],
  },
  {
    id: "hope", name: "Hope (Emirates Mars Mission)", year: 2020, agency: "UAE", kind: "orbiter",
    note: "First Arab interplanetary mission; global weather + atmosphere.",
    waypoints: [EARTH, { body: "mars", mode: "orbit" }],
  },
  // --- landers / rovers (drop) ---
  {
    id: "mars-3", name: "Mars 3", year: 1971, agency: "USSR", kind: "lander",
    note: "First soft landing on Mars — transmitted for ~20 seconds.",
    waypoints: [EARTH, { body: "mars", mode: "drop" }],
  },
  {
    id: "viking-1", name: "Viking 1", year: 1975, agency: "NASA", kind: "orbiter + lander",
    note: "First long-duration Mars landing; orbiter + lander, ~6 yrs of surface data.",
    waypoints: [EARTH, { body: "mars", mode: "drop" }],
  },
  {
    id: "pathfinder", name: "Mars Pathfinder", year: 1996, agency: "NASA", kind: "lander + rover",
    note: "Sojourner — the first wheels on Mars; airbag landing.",
    waypoints: [EARTH, { body: "mars", mode: "drop" }],
  },
  {
    id: "mer", name: "Spirit & Opportunity (MER)", year: 2003, agency: "NASA", kind: "rovers",
    note: "Twin rovers; found abundant evidence of past liquid water.",
    waypoints: [EARTH, { body: "mars", mode: "drop" }],
  },
  {
    id: "curiosity", name: "Curiosity (MSL)", year: 2011, agency: "NASA", kind: "rover",
    note: "Gale crater + Mount Sharp; the sky-crane landing.",
    waypoints: [EARTH, { body: "mars", mode: "drop" }],
  },
  {
    id: "perseverance", name: "Perseverance (Mars 2020)", year: 2020, agency: "NASA", kind: "rover",
    note: "Jezero crater; caches samples + flew Ingenuity, the first Mars helicopter.",
    waypoints: [EARTH, { body: "mars", mode: "drop" }],
  },
  {
    id: "tianwen-1", name: "Tianwen-1", year: 2020, agency: "CNSA", kind: "orbiter + lander + rover",
    note: "China's first Mars mission — orbiter, lander, and Zhurong rover in one.",
    waypoints: [EARTH, { body: "mars", mode: "drop" }],
  },
  // --- Mars moons (REAL waypoints — the interplanetary transfer routes via Mars,
  //     then a Mars-orbit rendezvous with the moon; see plan.moonRendezvousDv) ---
  {
    id: "phobos-2", name: "Phobos 2", year: 1988, agency: "USSR", kind: "moon orbiter",
    note: "Reached Mars orbit and imaged Phobos before contact was lost.",
    target: "Phobos", waypoints: [EARTH, { body: "phobos", mode: "orbit" }],
  },
  {
    id: "fobos-grunt", name: "Fobos-Grunt", year: 2011, agency: "Russia", kind: "sample return",
    note: "Phobos sample return — stranded in Earth orbit after launch.",
    target: "Phobos",
    waypoints: [EARTH, { body: "phobos", mode: "orbit" }, { body: "earth", mode: "orbit" }],
  },
  {
    id: "mmx", name: "MMX (Martian Moons eXploration)", year: 2026, agency: "JAXA", kind: "sample return",
    note: "Phobos sample return + Deimos flybys — first sample return from the Mars system.",
    target: "Phobos / Deimos",
    waypoints: [EARTH, { body: "phobos", mode: "orbit" }, { body: "earth", mode: "orbit" }],
  },
];

// One historical mission → a definition (reuses definitionFrom). The name carries
// the year; the metadata rides in `historical` for the readout.
export function historicalDefinition(m) {
  return definitionFrom({
    name: `${m.name} (${m.year})`,
    waypoints: m.waypoints,
    craftId: m.craftId || "chemical-tug",
    historical: { year: m.year, agency: m.agency, kind: m.kind, note: m.note, target: m.target || null },
  });
}

// All historical missions as definitions (the library appends these after the
// generic presets, so the default stays the generic Earth→Mars→Earth). Also the
// source for the ambient QUEUE (app.js): one mission at a time flies with its
// launch-window countdown, then the next queues — so the elegant orbital view
// stays readable (17 concurrent arcs turned it into a tangle). Wait-for-window
// timing keeps each arc a clean efficient ellipse and makes the timer meaningful.
export function historicalDefinitions() {
  return HISTORICAL_MISSIONS.map(historicalDefinition);
}
