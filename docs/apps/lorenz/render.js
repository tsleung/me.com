// render.js — canvas 2D painting. No state of its own beyond what's passed in.
//
// THE ARCHITECTURAL DECISION HERE: the canvas is cleared and the trail is
// redrawn from vertices, every frame.
//
// This reverses the first design, which never cleared and instead aged the ink
// by pulling alpha out of the whole surface once a frame. That was cheaper,
// but it could only ever produce one curve — see trail.js for why, and for the
// curve that replaced it. The batching in `drawTrail` is what makes redrawing
// affordable: attributes vary smoothly along a trajectory, so quantized runs
// are long.
//
// TRAIL AGE IS SIMULATED TIME, not frames and not wall clock. That is what
// keeps the trail control and the speed control independent — the same trail
// setting means the same length of history at any playback speed.

import { ATTRACTOR_DIAMETER } from "./lorenz.js";
import { cssRgba } from "./color.js";
import { trailAlpha, runKey } from "./trail.js";

/**
 * Fit the attractor into the viewport. The classic XZ silhouette: x across,
 * z up. `yaw` rotates the x–y plane before projecting, which turns the flat
 * butterfly into a solid without changing what the axes mean.
 */
export function makeCamera(width, height, { yaw = 0, params = null } = {}) {
  // Extents are DERIVED from the parameters, not hardcoded to the classic
  // attractor. ρ is a live slider up to 60, and at σ=20 ρ=60 β=6 the state
  // reaches |x| ≈ 41 and z ≈ 103 — against fixed extents of 46/56 that
  // projects half a canvas above the top edge, so the attractor simply
  // climbs out of frame. The in-app notes invite moving ρ, so this is a
  // control the visitor is told to use.
  //
  // The wings sit at ±√(β(ρ−1)) and reach z ≈ 2(ρ−1); the margins below are
  // measured slack over that, checked against 60k-step runs at the corners of
  // the slider space.
  const { extentX, extentZ } = cameraExtents(params);
  const scale = Math.min(width / extentX, height / extentZ) * 0.92;
  // `yaw` is consumed here into cos/sin and deliberately not stored: `project`
  // reads only those, and a stale copy of the angle is a thing to get wrong.
  return {
    scale,
    cx: width / 2,
    cy: height / 2,
    zCenter: cameraExtents(params).zCenter,
    cos: Math.cos(yaw),
    sin: Math.sin(yaw),
    zCenterOverride: null,
  };
}

/** Half-extents that contain the attractor for the given parameters. */
export function cameraExtents(params) {
  if (!params || !(params.rho > 1)) return { extentX: 46, extentZ: 56, zCenter: 25 };
  const wing = Math.sqrt(Math.max(0, params.beta * (params.rho - 1)));
  const extentX = Math.max(46, 4.6 * wing);
  const zTop = Math.max(50, 2 * (params.rho - 1) + 10);
  return { extentX, extentZ: Math.max(56, zTop * 1.12), zCenter: zTop / 2 };
}

/** State → screen. Returns {sx, sy}. */
export function project(s, cam) {
  const xr = s.x * cam.cos - s.y * cam.sin;
  return {
    sx: cam.cx + xr * cam.scale,
    sy: cam.cy - (s.z - cam.zCenter) * cam.scale,
  };
}

/** Size the backing store for devicePixelRatio and return the CSS-pixel box. */
export function fitCanvas(canvas, dpr = window.devicePixelRatio || 1) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  const changed = canvas.width !== bw || canvas.height !== bh;
  if (changed) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: w, height: h, changed };
}

/**
 * Draw one trajectory's trail, oldest to newest, batching runs of identical
 * pen state into single paths.
 *
 * `attrs(sample, alpha)` returns `{rgb, width, alpha}` for a vertex — the
 * caller owns the color formula and the brush, this function owns only the
 * geometry and the batching.
 *
 * Returns the number of stroke() calls issued, which is the number worth
 * watching if this ever gets slow.
 */
export function drawTrail(ctx, cam, samples, tNow, trailSpan, attrs) {
  if (samples.length < 2 || !(trailSpan > 0)) return 0;

  let strokes = 0;
  let key = -1;
  let started = false;
  let prevPt = null;

  const flush = () => {
    if (started) {
      ctx.stroke();
      strokes++;
      started = false;
    }
  };

  for (const s of samples) {
    const u = (tNow - s.t) / trailSpan;
    const a = trailAlpha(u);
    if (a <= 0) {
      // Past the cutoff. Break the run so the next visible vertex does not
      // get joined to it across the gap.
      flush();
      prevPt = null;
      key = -1;
      continue;
    }

    const { rgb, width, alpha } = attrs(s, a);
    const pt = project(s, cam);
    const k = runKey(rgb, alpha, width);

    if (prevPt) {
      if (k !== key) {
        flush();
        ctx.strokeStyle = cssRgba(rgb, alpha);
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(prevPt.sx, prevPt.sy);
        started = true;
        key = k;
      }
      ctx.lineTo(pt.sx, pt.sy);
    }
    prevPt = pt;
  }
  flush();
  return strokes;
}

// Blend presets moved to pen.js — a blend is a property of the pen, and
// nothing in this file ever read them.


/** Wipe the stage. Every frame now — the trail is redrawn, not accumulated. */
export function clearStage(ctx, width, height) {
  ctx.clearRect(0, 0, width, height);
}

// The two wing centres C± used to be marked here with faint rings. They were
// removed: they were the brightest thing on a dark canvas, they competed with
// the line for attention, and what they encode — the unstable points the
// spirals wind away from — is better said in a sentence than drawn as two
// white balls. `fixedPoints()` in lorenz.js is still the authority if a marker
// is ever wanted back.

/** The current head of a trajectory. */
export function drawHead(ctx, p, rgb, radius = 2.6) {
  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = cssRgba(rgb, 0.95);
  ctx.beginPath();
  ctx.arc(p.sx, p.sy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = prev;
}

// ------------------------------------------------------------ divergence chart

/**
 * log₁₀‖Δ‖ against t. The shape IS the argument: a straight line of slope
 * λ/ln(10) while the error is small, then a hard ceiling at attractor
 * diameter where the twin is simply somewhere else. The tolerance line and
 * its crossing mark the moment the forecast stopped being a forecast.
 */
export function drawDivergenceChart(ctx, width, height, opts) {
  const {
    samples = [],
    eps = 1e-6,
    ceiling = ATTRACTOR_DIAMETER,
    tolerance = 1,
    lambda = null,
    window: tWindow = 45,
    expiredAt = null,
    ink = "#f2f2ee",
    muted = "#6a6a6a",
    accent = "#ff3a3a",
    line = "#2a2a2e",
  } = opts;

  ctx.clearRect(0, 0, width, height);

  const padL = 40;
  const padR = 8;
  const padT = 10;
  const padB = 20;
  const plotW = Math.max(1, width - padL - padR);
  const plotH = Math.max(1, height - padT - padB);

  const yLo = Math.log10(Math.max(eps, 1e-16)) - 0.5;
  const yHi = Math.log10(ceiling) + 0.3;
  const toY = (d) => {
    const l = Math.log10(Math.max(d, 1e-300));
    return padT + plotH * (1 - (l - yLo) / (yHi - yLo));
  };

  const tEnd = samples.length ? samples[samples.length - 1].t : 0;
  const tStart = Math.max(samples.length ? samples[0].t : 0, tEnd - tWindow);
  const span = Math.max(1e-6, tEnd - tStart);
  const toX = (t) => padL + plotW * ((t - tStart) / span);

  ctx.font = "10px ui-monospace, SF Mono, Menlo, monospace";
  ctx.textBaseline = "middle";

  // Decade gridlines.
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.fillStyle = muted;
  ctx.textAlign = "right";
  for (let e = Math.ceil(yLo); e <= Math.floor(yHi); e++) {
    const y = toY(Math.pow(10, e));
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(width - padR, y);
    ctx.stroke();
    ctx.fillText(`1e${e}`, padL - 6, y);
  }

  // Tolerance: "a forecast this wrong is not a forecast".
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = accent;
  const yTol = toY(tolerance);
  ctx.beginPath();
  ctx.moveTo(padL, yTol);
  ctx.lineTo(width - padR, yTol);
  ctx.stroke();
  ctx.setLineDash([]);

  if (samples.length >= 2) {
    // The fitted exponential, drawn from the first sample.
    if (lambda && lambda > 0) {
      const s0 = samples[0];
      ctx.strokeStyle = "rgba(242,242,238,0.28)";
      ctx.beginPath();
      let started = false;
      for (let t = s0.t; t <= tEnd; t += span / 120) {
        const d = s0.d * Math.exp(lambda * (t - s0.t));
        if (d > ceiling) break;
        const x = toX(t);
        const y = toY(d);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    samples.forEach((s, i) => {
      const x = toX(s.t);
      const y = toY(s.d);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  if (expiredAt != null && expiredAt >= tStart && expiredAt <= tEnd) {
    const x = toX(expiredAt);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
  }

  ctx.fillStyle = muted;
  ctx.textAlign = "left";
  ctx.fillText("‖Δ‖", padL + 2, padT + 6);
  ctx.textAlign = "right";
  ctx.fillText(`t = ${tEnd.toFixed(1)}`, width - padR, height - padB / 2);
}
