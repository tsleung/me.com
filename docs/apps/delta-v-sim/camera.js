// camera.js — the CAMERA + VIEW-MODEL layer. Two things:
//   1. `Camera`: the pan/zoom transform mapping FRAME coordinates (km, in
//      whatever reference frame is active) to screen pixels, plus its live
//      exponential-smoothing convergence and scale-bar math.
//   2. the view-model: per-frame framing (`landmarksFor` → `bboxInFrame`) and the
//      LIVE `desiredCamera` the RAF loop eases toward. DOM-free, so selftest can
//      assert the convergence behavior under `node`.
//
// Screen convention: canvas y grows downward, world y grows up, so worldToScreen
// flips y. The camera holds { scale (px per km), cx, cy (frame km at the screen
// centre) }.

import { add } from "./vec.js";
import { AU_KM, orbitTrace } from "./sim.js";
import { frameMap, lagrangeHelio, EM_COMPARE_SEP } from "./frames.js";

export class Camera {
  constructor(width = 800, height = 600) {
    this.w = width;
    this.h = height;
    this.scale = 1e-6; // px per km
    this.cx = 0;
    this.cy = 0;
    // zoom limits spanning ~4 orders of magnitude (Earth–Moon ↔ Sun–Mars)
    this.minScale = 1e-9;
    this.maxScale = 5e-2;
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
  }

  clampScale(s) {
    return Math.max(this.minScale, Math.min(this.maxScale, s));
  }

  worldToScreen(p) {
    return [(p[0] - this.cx) * this.scale + this.w / 2, this.h / 2 - (p[1] - this.cy) * this.scale];
  }

  screenToWorld(px, py) {
    return [(px - this.w / 2) / this.scale + this.cx, this.cy - (py - this.h / 2) / this.scale];
  }

  panByPixels(dxPx, dyPx) {
    this.cx -= dxPx / this.scale;
    this.cy += dyPx / this.scale;
  }

  // Zoom by `factor` while keeping the world point under (px,py) fixed.
  zoomAt(px, py, factor) {
    const before = this.screenToWorld(px, py);
    this.scale = this.clampScale(this.scale * factor);
    const after = this.screenToWorld(px, py);
    this.cx += before[0] - after[0];
    this.cy += before[1] - after[1];
  }

  // The fit scale for a bounds { minX,maxX,minY,maxY } (frame km), WITHOUT
  // moving the centre — used to build a "desired" camera the live loop eases to.
  fitScale(b, pad = 0.12) {
    const spanX = Math.max(b.maxX - b.minX, 1);
    const spanY = Math.max(b.maxY - b.minY, 1);
    return this.clampScale(Math.min((this.w * (1 - pad)) / spanX, (this.h * (1 - pad)) / spanY));
  }

  // Fit an axis-aligned bounds (snap both scale and centre). Used by the fit
  // button's immediate framing.
  fitBounds(b, pad = 0.12) {
    this.scale = this.fitScale(b, pad);
    this.cx = (b.minX + b.maxX) / 2;
    this.cy = (b.minY + b.maxY) / 2;
  }

  // Jump straight to a desired { scale, center:[x,y] } (reduced-motion path).
  snapTo(d) {
    this.scale = this.clampScale(d.scale);
    this.cx = d.center[0];
    this.cy = d.center[1];
  }

  // Frame-rate-independent exponential smoothing toward a LIVE desired camera.
  // a = 1 − exp(−k·dt): centre lerps linearly, scale lerps in LOG space (the
  // span is orders of magnitude). Monotone, no overshoot — because `desired` is
  // recomputed from live state each frame, the camera converges on the moving
  // target and never eases toward a stale endpoint (no black-space, no snap).
  easeToward(d, dt, k = 7) {
    const a = 1 - Math.exp(-k * Math.max(dt, 0));
    this.scale = this.clampScale(
      Math.exp(Math.log(this.scale) * (1 - a) + Math.log(this.clampScale(d.scale)) * a),
    );
    this.cx += (d.center[0] - this.cx) * a;
    this.cy += (d.center[1] - this.cy) * a;
  }

  snapshot() {
    return { scale: this.scale, cx: this.cx, cy: this.cy };
  }
}

// A "nice" round number ≤ x for scale-bar tick lengths (1/2/5 × 10^n).
export function niceNumber(x) {
  if (!(x > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / pow;
  const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return nf * pow;
}

// Scale-bar geometry: aim for ~targetPx, snap to a nice distance, label km/AU.
export function scaleBar(scale, targetPx = 130) {
  const rawKm = targetPx / scale;
  const km = niceNumber(rawKm);
  const px = km * scale;
  let label;
  if (km >= 1e6) {
    const au = km / AU_KM;
    label = `${au >= 1 ? au.toFixed(au >= 10 ? 0 : 2) : au.toPrecision(2)} AU`;
  } else {
    label = `${km.toLocaleString("en-US")} km`;
  }
  return { km, px, label };
}

// ============================================================================
//  View-model: per-frame framing + the live desired camera.
// ============================================================================

// Landmark heliocentric points whose bbox (in a given frame) defines a sensible
// "fit". Adapts per frame so one rule frames whatever matters there.
export function landmarksFor(frameId, world) {
  if (frameId === "helio") return [...orbitTrace("mars"), ...orbitTrace("earth")];
  if (frameId === "geo") {
    return orbitTrace("moon")
      .map((p) => add(world.earth.pos, p))
      .concat([world.earth.pos]);
  }
  if (frameId === "areo") {
    // Mars-centred: frame Deimos's orbit (Phobos sits inside it).
    return orbitTrace("deimos")
      .map((p) => add(world.mars.pos, p))
      .concat([world.mars.pos]);
  }
  if (frameId === "em-syn") {
    const ls = lagrangeHelio(world, "em-syn").map((l) => l.helio);
    return [world.earth.pos, world.moon.pos, ...ls];
  }
  if (frameId === "se-syn") {
    const ls = lagrangeHelio(world, "se-syn").map((l) => l.helio);
    return [world.sun.pos, world.earth.pos, ...ls];
  }
  return [world.sun.pos, world.earth.pos, world.mars.pos];
}

export function bboxInFrame(frameId, world) {
  // The compare frame's on-screen extent is fixed (both anchors pinned) — a
  // constant bbox keeps its fit-scale steady while the true separation swings.
  if (frameId === "earth-mars") {
    const S = EM_COMPARE_SEP;
    return { minX: -0.72 * S, maxX: 0.72 * S, minY: -0.5 * S, maxY: 0.5 * S };
  }
  const map = frameMap(frameId, world);
  const pts = landmarksFor(frameId, world).map(map);
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    if (!isFinite(p[0]) || !isFinite(p[1])) continue;
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  if (!isFinite(minX)) return { minX: -4e8, maxX: 4e8, minY: -4e8, maxY: 4e8 };
  return { minX, maxX, minY, maxY };
}

// The LIVE desired camera for a frame: fit-scale from the CURRENT bbox, centred
// on the focused body's CURRENT position in the frame (or the fit centre). This
// is recomputed every RAF frame — never snapshotted — so the camera converges on
// the target even as it (and the clock) move. Returns { scale, center }.
export function desiredCamera(frameId, world, focus, camera) {
  const bbox = bboxInFrame(frameId, world);
  const scale = camera.fitScale(bbox);
  let center;
  if (focus && world[focus]) {
    center = frameMap(frameId, world)(world[focus].pos); // live position in frame
  } else {
    center = [(bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2];
  }
  return { scale, center };
}

// The desired camera when FOLLOWING a moving craft. Same live-target discipline
// as desiredCamera, but the centre is a heliocentric point (the craft's current
// position from missionStateAt), mapped through the active frame — and the SCALE
// is left where the user put it (following drives only the centre; zoom stays
// user-controlled). Pure + recomputed every frame from the craft's live position,
// so the camera converges on the craft as it flies and re-maps cleanly through
// whatever frame is active (frame-agnostic follow). Returns { scale, center }.
export function desiredCameraAt(frameId, world, helioPos, camera) {
  return { scale: camera.scale, center: frameMap(frameId, world)(helioPos) };
}
