// visibility.js — the deterministic "resolvability by separability" rule.
//
// Refuse-to-fake discipline (owner, 2026-07-20): moons are drawn at TRUE scale
// in EVERY frame — never a per-body exaggeration factor to force visibility.
// Whether a mark is *shown* is a pure, unit-tested predicate, not an eyeballed
// threshold, and the SAME predicate + constant govern bodies, Lagrange points,
// and labels. A moon whose true-scale orbit can't clear its parent's drawn disk
// by a visible gap is HIDDEN (body + ring + label together); it returns honestly
// as the user zooms toward the planet or opens its centric frame. This is the
// sim's instance of the project's make-the-rule-explicit-and-testable discipline.

import { BODIES } from "./sim.js";
import { FRAMES, earthMarsGeometry } from "./frames.js";

// GAP_PX: the minimum on-screen separation (px) at which two marks read as
// distinct. The one tunable — no scattered magic numbers.
export const GAP_PX = 3.5;
// HYST_PX: anti-flicker dead-band. SHOW threshold = HIDE threshold + HYST_PX, so
// a mark at the boundary doesn't strobe on/off while zooming. The only stateful
// bit (needs prior visibility); still deterministic given it.
export const HYST_PX = 2;

// The uniform local scale of a frame's map (a px-per-km multiplier on top of
// camera.scale). Inertial & synodic frames are isometries (1); the compare
// frame applies its normalization scale s. So effScale = camera.scale × this.
export function frameScaleFactor(frameId, world) {
  const f = FRAMES[frameId] || FRAMES.helio;
  if (f.kind === "compare") return earthMarsGeometry(world).s;
  return 1;
}

// On-screen orbit footprint of an orbiting body (px): its orbit radius scaled.
export function screenFootprintPx(orbitRadiusKm, effScale) {
  return orbitRadiusKm * effScale;
}

// Base predicate (no state): an orbiting body is resolvable iff its orbit clears
// the parent's drawn disk by GAP_PX — else it draws on top of the planet and
// conveys nothing. entity = { orbitRadiusKm, parentRadiusPx }.
export function resolvable(entity, effScale) {
  return screenFootprintPx(entity.orbitRadiusKm, effScale) >= entity.parentRadiusPx + GAP_PX;
}

// Anti-flicker wrapper: once shown, stays shown until below HIDE (parent+GAP);
// once hidden, stays hidden until above SHOW (parent+GAP+HYST). Deterministic
// given `wasVisible`.
export function resolvableHysteretic(entity, effScale, wasVisible) {
  const fp = screenFootprintPx(entity.orbitRadiusKm, effScale);
  const hide = entity.parentRadiusPx + GAP_PX;
  const show = hide + HYST_PX;
  return wasVisible ? fp >= hide : fp >= show;
}

// Greedy separability for standalone marks / labels: keep a mark iff it sits
// ≥ GAP_PX from every higher-priority mark already kept. marks: [{ pos:[x,y]px,
// priority }]. Returns a parallel boolean array. Used for L-points and the label
// collision pass — the same GAP_PX rule as the body predicate.
export function resolveMarks(marks, gap = GAP_PX) {
  const kept = [];
  const visible = new Array(marks.length).fill(false);
  const order = marks
    .map((m, i) => ({ m, i }))
    .sort((a, b) => b.m.priority - a.m.priority || a.i - b.i);
  for (const { m, i } of order) {
    const clash = kept.some((k) => Math.hypot(k.pos[0] - m.pos[0], k.pos[1] - m.pos[1]) < gap);
    if (!clash) {
      kept.push(m);
      visible[i] = true;
    }
  }
  return visible;
}

// Orbiting-body entity for the predicate: orbit radius = semi-major axis (km),
// parent's DRAWN dot radius (px, bodies-not-to-scale glyph size).
export function satelliteEntity(satKey) {
  const b = BODIES[satKey];
  if (!b || !b.elem || !BODIES[b.primary]) return null;
  return { orbitRadiusKm: b.elem.a, parentRadiusPx: BODIES[b.primary].radiusPx };
}
