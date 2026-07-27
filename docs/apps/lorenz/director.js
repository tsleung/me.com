// director.js — the meta-parameter: automated variation of speed and trail.
//
// Speed and trail are the two hand controls. The director is the knob above
// them that moves both. Three modes, in increasing order of how much of the
// system's own behavior leaks into the controls:
//
//   off      the hand controls are the controls
//   tour     one scalar u(t) sweeps a curated path through (speed, trail)
//   coupled  the system drives its own controls
//
// TOUR. u runs a triangle wave over `period`, and speed/trail are ANTI-
// correlated along it: slow-and-long at u=0 (structure — the attractor as a
// static object), fast-and-short at u=1 (flow — the attractor as a process).
// Both are ratio quantities, so both interpolate geometrically; a linear
// sweep would spend most of its time at the fast end.
//
// COUPLED. Two couplings, chosen because each turns a control into a readout:
//   · speed ∝ 1/|dX/dt| — the drawn line advances at near-constant ARC LENGTH,
//     so the pen moves evenly and the geometry stops being confounded by the
//     system's own wildly uneven pace. What you lose is the felt sense of
//     speed, which is real information; that is the trade.
//   · trail shortens as ‖Δ‖ grows — memory decays exactly as the forecast
//     does. By the time the twins have separated the trail is a short comet
//     head, which is the honest picture of what you still know.
//
// All pure: same inputs, same outputs, no clock reads. The caller owns time.

export const MODES = Object.freeze(["off", "tour", "coupled", "calligraphy"]);

export const MODE_BLURB = Object.freeze({
  off: "Hand controls only.",
  tour: "One scalar sweeps slow-and-long ↔ fast-and-short.",
  coupled: "The system drives its own controls: even pen speed, decaying memory.",
  calligraphy:
    "A brush, not a plotter. Slows and presses into turns, lifts and runs on " +
    "the straight. The speed slider becomes the tempo.",
});

/**
 * How far the brush model is allowed to push the tempo either way. Multipliers
 * on the hand-set speed rather than absolute speeds, so the slider keeps
 * meaning something in this mode — a mode that ignored the slider would have
 * satisfied the brush request by breaking the speed request.
 */
export const BRUSH_TEMPO = Object.freeze({ lifted: 2.2, pressed: 0.22 });

/** Geometric (log) interpolation — right for ratio quantities like speed. */
export const lerpGeom = (a, b, t) => a * Math.pow(b / a, Math.min(1, Math.max(0, t)));

/** Triangle wave on [0,1] with the given period. Smooth turnarounds via cosine. */
export function tourPhase(t, period) {
  if (!(period > 0)) return 0;
  const cycle = (((t / period) % 1) + 1) % 1;
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * cycle);
}

// The bottom of the speed range is set by "coupled" mode, not by taste: to hold
// arc length constant it needs REFERENCE_ARC/|v| to stay unclamped across the
// whole attractor, and |v| reaches ~260. 26/260 = 0.1, so the floor sits below
// that with headroom. A higher floor would silently make coupled mode speed up
// exactly where it is supposed to slow down.
export const SPEED_LIMITS = Object.freeze({ min: 0.08, max: 36 });
export const TRAIL_LIMITS = Object.freeze({ min: 0.4, max: 40 });

/**
 * The two ends of the tour, named rather than derived from the limits above —
 * the endpoints are a curatorial choice about what is worth looking at, and
 * should not drift when a clamp moves for an unrelated reason.
 */
export const TOUR = Object.freeze({
  speedSlow: 0.6, // the attractor as a static object
  speedFast: 24, // the attractor as a process
  trailLong: 30,
  trailShort: 1,
});

// NaN-safe by construction: `NaN > 0` is false, so NaN collapses to 0 rather
// than propagating. The obvious `v < 0 ? 0 : v > 1 ? 1 : v` passes NaN through,
// and a single NaN reaching the color pipeline makes the stroke silently
// invisible — canvas discards `rgba(NaN,...)` without an error.
const clamp = (v, lo, hi) => (v > lo ? (v < hi ? v : hi) : lo);

/**
 * Resolve the effective (speed, trail) for this frame.
 *
 * @param {object} cfg
 *   mode    one of MODES
 *   t       simulated time
 *   period  tour period, in simulated time units
 *   manual  {speed, trail} — the hand-control values, used as-is in "off"
 *           and as the center point that "coupled" modulates around
 *   sample  {v, divergenceNorm} — current speed through phase space and the
 *           normalized twin separation, both required by "coupled"
 * @returns {{speed:number, trail:number, u:number|null}}
 */
export function directedParams(cfg) {
  const { mode = "off", t = 0, period = 30, manual, sample } = cfg;
  const speedManual = clamp(manual?.speed ?? 2, SPEED_LIMITS.min, SPEED_LIMITS.max);
  const trailManual = clamp(manual?.trail ?? 6, TRAIL_LIMITS.min, TRAIL_LIMITS.max);

  if (mode === "tour") {
    const u = tourPhase(t, period);
    return {
      u,
      speed: lerpGeom(TOUR.speedSlow, TOUR.speedFast, u),
      trail: lerpGeom(TOUR.trailLong, TOUR.trailShort, u),
    };
  }

  if (mode === "coupled") {
    const v = Math.max(1e-6, sample?.v ?? 1);
    // Constant arc length per unit wall-clock: the pen moves evenly.
    // REFERENCE_ARC is in state-units per real second.
    const REFERENCE_ARC = 26;
    const speed = clamp(REFERENCE_ARC / v, SPEED_LIMITS.min, SPEED_LIMITS.max);
    // Memory decays with the forecast. d=0 → full trail, d=1 → a comet head.
    const d = clamp(sample?.divergenceNorm ?? 0, 0, 1);
    const trail = clamp(
      lerpGeom(trailManual, TRAIL_LIMITS.min, d),
      TRAIL_LIMITS.min,
      TRAIL_LIMITS.max,
    );
    return { u: d, speed, trail };
  }

  if (mode === "calligraphy") {
    // `press` comes from calligraphy.js; 0 is a lifted brush on a straight
    // run, 1 is pressed into a turn or entering a stroke.
    const press = clamp(sample?.press ?? 0, 0, 1);
    return {
      u: press,
      speed: clamp(
        speedManual * lerpGeom(BRUSH_TEMPO.lifted, BRUSH_TEMPO.pressed, press),
        SPEED_LIMITS.min,
        SPEED_LIMITS.max,
      ),
      trail: trailManual,
    };
  }

  return { u: null, speed: speedManual, trail: trailManual };
}
