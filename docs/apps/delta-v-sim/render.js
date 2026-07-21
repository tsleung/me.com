// render.js — canvas 2D drawing. Stateless-ish: render(ctx, scene) reads a scene
// object assembled by app.js each frame and paints it. Defensive throughout —
// guards on ctx/world/frame so a missing body or a bad frame id never throws
// mid-RAF. All physics + visibility rules come from sim.js/frames.js via the
// scene/imports; this file only knows how to draw.
//
// Visibility is the deterministic "resolvability by separability" predicate from
// frames.js (GAP_PX / resolvableHysteretic / resolveMarks) applied uniformly to
// moons (body+ring+label), Lagrange points, and labels. The only stateful bit is
// the per-satellite hysteresis flag (anti-flicker), kept module-local below.

import { add } from "./vec.js";
import { frameMap, lagrangeHelio, earthMarsGeometry } from "./frames.js";
import {
  frameScaleFactor,
  resolvableHysteretic,
  resolveMarks,
  satelliteEntity,
} from "./visibility.js";
import { BODIES, orbitTrace, AU_KM } from "./sim.js";
import { sampleConic, craftStateAt } from "./spacecraft.js";
import { scaleBar } from "./camera.js";
import { describe } from "./descriptions.js";
import { missionStateAt } from "./mission.js";
import { frameDesc } from "./uiState.js";

const OFF = 6e4; // px: treat |coord| beyond this as off-canvas (avoid huge strokes)

// Anti-flicker hysteresis: prior on-screen visibility per satellite. The one
// allowed bit of state; makes resolvableHysteretic deterministic frame-to-frame.
const satShown = { moon: false, phobos: false, deimos: false };

// Hover targets from the LAST render: every visible mark (id + screen pos + hit
// radius), so app can hit-test for tooltips against exactly what's on screen. A
// hidden mark isn't registered, so it has neither label nor tooltip.
let hoverMarks = [];
function registerHover(id, s, r) {
  if (Math.abs(s[0]) < OFF && Math.abs(s[1]) < OFF) hoverMarks.push({ id, x: s[0], y: s[1], r });
}
export function pickMark(px, py) {
  let best = null;
  let bestD = 16; // px pick radius
  for (const m of hoverMarks) {
    const d = Math.hypot(m.x - px, m.y - py);
    if (d < Math.max(bestD, m.r + 6)) {
      bestD = d;
      best = m.id;
    }
  }
  return best;
}

// Frame switches immediately (a frame is a pure map, never animated) — only the
// camera eases — so the projector is just the active frame map ∘ camera.
function makeProjector(scene) {
  const { world, camera } = scene;
  const map = frameMap(scene.toId, world);
  return (helio) => camera.worldToScreen(map(helio));
}

function inRange(pt) {
  return Math.abs(pt[0]) < OFF && Math.abs(pt[1]) < OFF;
}

function strokePath(ctx, helioPts, project, style, width = 1, dash = null) {
  if (!helioPts || helioPts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  let pen = false;
  for (const hp of helioPts) {
    const s = project(hp);
    if (!isFinite(s[0]) || !isFinite(s[1]) || !inRange(s)) {
      pen = false;
      continue;
    }
    if (!pen) {
      ctx.moveTo(s[0], s[1]);
      pen = true;
    } else {
      ctx.lineTo(s[0], s[1]);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function glowDot(ctx, s, r, core, glow, coreAlpha = 1) {
  if (!inRange(s)) return;
  ctx.save();
  const g = ctx.createRadialGradient(s[0], s[1], 0, s[0], s[1], r * 3.2);
  g.addColorStop(0, glow);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s[0], s[1], r * 3.2, 0, 2 * Math.PI);
  ctx.fill();
  ctx.globalAlpha = coreAlpha;
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(s[0], s[1], r, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();
}

function selectionRing(ctx, s, r) {
  if (!inRange(s)) return;
  ctx.save();
  ctx.strokeStyle = "rgba(242,242,238,0.6)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(s[0], s[1], r + 6, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.restore();
}

export function render(ctx, scene) {
  if (!ctx || !scene || !scene.world || !scene.camera) return;
  const { world, camera } = scene;
  const W = camera.w;
  const H = camera.h;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#05060a";
  ctx.fillRect(0, 0, W, H);

  const project = makeProjector(scene);
  // Frame FACTS as data (uiState descriptor) instead of scattered `isCompare`
  // branches: sunAs → the Sun is a drawn disc vs an off-screen bearing arrow;
  // pinned → the pair is anchored (compare extras + no scale bar).
  const desc = frameDesc(scene.toId);
  const sunAsDisc = desc.sunAs === "disc";
  const isPinned = desc.pinned;
  const effScale = camera.scale * frameScaleFactor(scene.toId, world);
  hoverMarks = []; // rebuilt below with every VISIBLE mark

  // Deferred labels — every label routes through one resolveMarks pass so the
  // GAP_PX separability rule governs labels exactly as it governs bodies. Label
  // text comes from the description registry (data-driven: new entity = one row).
  const labels = [];
  const pushLabel = (pos, id, color, priority, dx = 9, dy = -8) => {
    if (!inRange(pos)) return;
    labels.push({ pos, text: describe(id).label, color, priority, dx, dy });
  };

  // --- planet orbit traces (faint) — drawn in EVERY frame, compare included.
  // In the pinned compare frame the map sends each true heliocentric orbit to a
  // clean circle centred on the (off-screen) Sun, radius = a·s (the normalization
  // scale) — and each planet lands exactly on its own ring, so the two rings read
  // as a coherent "which orbit each body rides" reference. The circles breathe
  // with the true separation (s = SEP/sep), which is honest to the normalization.
  try {
    strokePath(ctx, orbitTrace("earth"), project, "rgba(90,169,255,0.22)", 1);
    strokePath(ctx, orbitTrace("mars"), project, "rgba(255,106,74,0.20)", 1);
  } catch {
    /* decorative — never fatal */
  }

  // --- satellites: TRUE scale, deterministic resolvability gate ---
  try {
    drawSatellites(ctx, scene, project, effScale, pushLabel);
  } catch {
    /* ignore */
  }

  // --- synodic axis + Lagrange points (gated by the same separability rule) ---
  const synId = [scene.toId].find((id) => id && id.endsWith("-syn"));
  if (synId && scene.showLagrange !== false) {
    try {
      drawLagrange(ctx, scene, project, synId, pushLabel);
    } catch {
      /* L-points optional */
    }
  }

  // The uncommitted "if I launch now" preview (the Mission panel open): ghosted
  // neutral arcs, no craft — it is a candidate, not a committed flight.
  if (scene.preview && scene.preview.legs) {
    try {
      drawPreview(ctx, scene.preview, project);
    } catch {
      /* ignore */
    }
  }

  // The committed FLEET: every active mission's course arcs + its flying craft,
  // each in the mission's colour (the followed/selected one highlighted).
  if (scene.fleet && scene.fleet.length) {
    try {
      for (const m of scene.fleet) drawFleetMission(ctx, m, scene.t, project);
    } catch {
      /* ignore */
    }
  }

  if (scene.craft) {
    try {
      drawCraft(ctx, scene, scene.craft, project, "#49d0ff", "craft");
    } catch {
      /* ignore */
    }
  }

  if (scene.elevator && scene.elevator.craft) {
    try {
      drawElevator(ctx, scene, project, pushLabel);
    } catch {
      /* ignore */
    }
  }

  // --- primary bodies (always drawn) ---
  // The Sun is a drawn disc wherever the descriptor says `sunAs:'disc'`; in the
  // pinned compare frame (`sunAs:'arrow'`) it is off-screen and an arrow stands in.
  const bodyKeys = sunAsDisc ? ["sun", "earth", "mars"] : ["earth", "mars"];
  for (const key of bodyKeys) {
    const b = BODIES[key];
    const st = world[key];
    if (!b || !st) continue;
    const s = project(st.pos);
    glowDot(ctx, s, b.radiusPx, b.color, b.glow);
    pushLabel(s, key, "rgba(242,242,238,0.9)", 3);
    registerHover(key, s, b.radiusPx);
    if (scene.selected === key) selectionRing(ctx, s, b.radiusPx);
  }

  // --- pinned-frame extras: the anchored axis + off-screen Sun arrows ---
  if (isPinned) {
    try {
      drawEarthMarsExtras(ctx, scene, project);
    } catch {
      /* ignore */
    }
  } else {
    drawScaleBar(ctx, camera); // normalized coords when pinned ⇒ no scale bar
  }

  flushLabels(ctx, labels);
}

// Satellites (Moon, Phobos, Deimos) at TRUE scale, in every frame. Shown iff the
// resolvability predicate clears the parent's disk by GAP_PX (with hysteresis).
// A hidden satellite draws no dot, no ring, and pushes no label — label inherits.
function drawSatellites(ctx, scene, project, effScale, pushLabel) {
  const { world } = scene;
  for (const key of ["moon", "phobos", "deimos"]) {
    const b = BODIES[key];
    const st = world[key];
    const entity = satelliteEntity(key);
    if (!b || !st || !entity || !world[b.primary]) {
      satShown[key] = false;
      continue;
    }
    const vis = resolvableHysteretic(entity, effScale, satShown[key]);
    satShown[key] = vis;
    if (!vis) continue; // honest hide: too small to render truthfully
    const ring = orbitTrace(key).map((p) => add(world[b.primary].pos, p));
    strokePath(ctx, ring, project, "rgba(200,200,207,0.16)", 1);
    const s = project(st.pos);
    glowDot(ctx, s, b.radiusPx, b.color, b.glow);
    pushLabel(s, key, "rgba(230,230,232,0.85)", 2, 7, -6);
    registerHover(key, s, b.radiusPx);
    if (scene.selected === key) selectionRing(ctx, s, b.radiusPx);
  }
}

function drawLagrange(ctx, scene, project, synId, pushLabel) {
  const { world } = scene;
  const Ls = lagrangeHelio(world, synId);
  if (!Ls.length) return;
  const prim = synId === "em-syn" ? world.earth.pos : world.sun.pos;
  const sec = synId === "em-syn" ? world.moon.pos : world.earth.pos;
  strokePath(ctx, [prim, sec], project, "rgba(180,142,245,0.25)", 1, [4, 5]);
  // Same GAP_PX separability rule: pair bodies are top priority, L-points below;
  // an L-point that can't clear a body/another L-point is dropped.
  const marks = [
    { pos: project(prim), priority: 3 },
    { pos: project(sec), priority: 3 },
    ...Ls.map((L) => ({ pos: project(L.helio), priority: 1 })),
  ];
  const vis = resolveMarks(marks);
  Ls.forEach((L, i) => {
    if (!vis[i + 2]) return; // first two marks are the pair bodies
    const s = marks[i + 2].pos;
    if (!inRange(s)) return;
    ctx.save();
    ctx.strokeStyle = "#b48ef5";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(s[0] - 4, s[1]);
    ctx.lineTo(s[0] + 4, s[1]);
    ctx.moveTo(s[0], s[1] - 4);
    ctx.lineTo(s[0], s[1] + 4);
    ctx.stroke();
    ctx.restore();
    pushLabel(s, L.name, "rgba(180,142,245,0.9)", 1, 6, -6);
    registerHover(L.name, s, 4);
  });
}

// The mission colour palette — one colour PER MISSION (cycled at launch), so
// concurrent fleet craft read as distinct itineraries. Exported so app.js
// assigns the same colours it draws with.
export const COURSE_PALETTE = ["#3ddc84", "#49d0ff", "#ffb35a", "#ff6a9a", "#b48ef5"];

// The uncommitted preview: the course you'd get "if I launch now", drawn as a
// neutral ghost (dashed, no craft) so it never competes with committed fleet
// craft. Arrival ends get a faint dot.
const PREVIEW_COLOR = "rgba(150,160,180,0.55)";
function drawPreview(ctx, preview, project) {
  for (const leg of preview.legs || []) {
    if (!leg.pts || leg.pts.length < 2) continue;
    strokePath(ctx, leg.pts, project, PREVIEW_COLOR, 1.2, [3, 4]);
    glowDot(ctx, project(leg.pts[leg.pts.length - 1]), 2.5, PREVIEW_COLOR, PREVIEW_COLOR);
  }
}

// One committed mission: its multi-leg course (frame-aware arcs in the mission's
// colour, the active leg solid+wide, the rest dashed) plus its flying craft — a
// PHASE-AWARE dot (parked grey / coasting gold / arrived green) inside a
// mission-colour ring, labelled with the mission name. `missionStateAt` is the
// pure piecewise position; a followed/selected mission draws bigger + brighter.
function drawFleetMission(ctx, m, t, project) {
  const legs = m.legs || [];
  const active = m.activeLeg;
  legs.forEach((leg, i) => {
    if (!leg.pts || leg.pts.length < 2) return;
    const isActive = active != null && active >= 0 && i === active;
    const width = isActive ? 2.4 : m.selected ? 1.7 : 1.3;
    strokePath(ctx, leg.pts, project, m.color, width, isActive ? null : [4, 4]);
    glowDot(ctx, project(leg.pts[leg.pts.length - 1]), 3, m.color, m.color);
  });
  const st = missionStateAt(m.mission, t);
  if (!st || !st.pos) return;
  const s = project(st.pos);
  if (!inRange(s)) return;
  const phaseColor =
    st.phase === "coasting" ? "#ffd25a" : st.phase === "arrived" ? "#3ddc84" : "#9aa0ac";
  glowDot(ctx, s, m.selected ? 5 : 4, phaseColor, phaseColor);
  ctx.save();
  ctx.strokeStyle = m.color;
  ctx.lineWidth = m.selected ? 1.8 : 1.2;
  ctx.beginPath();
  ctx.arc(s[0], s[1], m.selected ? 9 : 7, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.fillStyle = m.color;
  ctx.font = "11px ui-monospace, Menlo, monospace";
  ctx.fillText(`▸ ${m.name || st.phase}`, s[0] + 11, s[1] - 9);
  ctx.restore();
}

function drawCraft(ctx, scene, craft, project, color, labelId) {
  const primary = scene.world[craft.primaryKey];
  if (!primary) return;
  const toHelio = (p) => add(primary.pos, p);
  strokePath(ctx, sampleConic(craft).map(toHelio), project, color, 1.3);
  const now = craftStateAt(craft, scene.t);
  const sNow = project(toHelio(now.pos));
  glowDot(ctx, sNow, 2.6, color, color);
  if (inRange(sNow)) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(sNow[0], sNow[1], 5, 0, 2 * Math.PI);
    ctx.stroke();
    if (labelId) {
      ctx.fillStyle = color;
      ctx.font = "11px ui-monospace, Menlo, monospace";
      ctx.fillText(describe(labelId).label, sNow[0] + 8, sNow[1] - 7);
      registerHover(labelId, sNow, 5);
    }
    ctx.restore();
  }
}

function drawElevator(ctx, scene, project, pushLabel) {
  const { world } = scene;
  const el = scene.elevator;
  const Ls = lagrangeHelio(world, "em-syn");
  const L1 = Ls.find((p) => p.name === "L1");
  if (L1) strokePath(ctx, [world.moon.pos, L1.helio], project, "rgba(255,210,90,0.85)", 2);
  if (el.craft.releaseHelio) {
    const sr = project(el.craft.releaseHelio);
    glowDot(ctx, sr, 3, "#ffd25a", "#ffb638");
    pushLabel(sr, "release", "rgba(255,210,90,0.9)", 2, 6, -6);
    registerHover("release", sr, 3);
  }
  drawCraft(ctx, scene, el.craft, project, "#ffd25a");
}

// Pinned Earth–Mars axis + one Sun arrow per planet (bearing true; its sweep
// over time IS the synodic cycle), labeled with the TRUE solar distance.
function drawEarthMarsExtras(ctx, scene, project) {
  const { world } = scene;
  const g = earthMarsGeometry(world);
  const eScr = project(world.earth.pos);
  const mScr = project(world.mars.pos);
  ctx.save();
  ctx.strokeStyle = "rgba(140,150,170,0.25)";
  ctx.setLineDash([4, 6]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(eScr[0], eScr[1]);
  ctx.lineTo(mScr[0], mScr[1]);
  ctx.stroke();
  ctx.restore();
  drawSunArrow(ctx, eScr, g.bearingEarth, g.earthSunDist);
  drawSunArrow(ctx, mScr, g.bearingMars, g.marsSunDist);
}

function drawSunArrow(ctx, from, bearing, distKm) {
  if (!inRange(from)) return;
  const L = 92;
  const dir = [Math.cos(bearing), -Math.sin(bearing)]; // screen y flips
  const tip = [from[0] + dir[0] * L, from[1] + dir[1] * L];
  ctx.save();
  ctx.strokeStyle = "#ffd25a";
  ctx.fillStyle = "#ffd25a";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(tip[0], tip[1]);
  ctx.stroke();
  const ah = 8;
  const a1 = bearing + 2.7;
  const a2 = bearing - 2.7;
  ctx.beginPath();
  ctx.moveTo(tip[0], tip[1]);
  ctx.lineTo(tip[0] + Math.cos(a1) * ah, tip[1] - Math.sin(a1) * ah);
  ctx.lineTo(tip[0] + Math.cos(a2) * ah, tip[1] - Math.sin(a2) * ah);
  ctx.closePath();
  ctx.fill();
  ctx.font = "11px ui-monospace, Menlo, monospace";
  ctx.fillText(`☉ ${(distKm / AU_KM).toFixed(2)} AU`, tip[0] + dir[0] * 6 + 4, tip[1] + dir[1] * 6);
  ctx.restore();
}

// One label-collision pass: greedy by priority, drop any label whose anchor is
// within GAP_PX of a higher-priority kept label (same rule as the body gate).
function flushLabels(ctx, labels) {
  if (!labels.length) return;
  const vis = resolveMarks(labels);
  ctx.save();
  ctx.font = "11px ui-monospace, Menlo, monospace";
  labels.forEach((l, i) => {
    if (!vis[i]) return;
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, l.pos[0] + l.dx, l.pos[1] + l.dy);
  });
  ctx.restore();
}

function drawScaleBar(ctx, camera) {
  const bar = scaleBar(camera.scale);
  if (!(bar.px > 4 && bar.px < camera.w)) return;
  const x0 = 18;
  const y0 = camera.h - 26;
  ctx.save();
  ctx.strokeStyle = "rgba(242,242,238,0.8)";
  ctx.fillStyle = "rgba(242,242,238,0.85)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0 + bar.px, y0);
  ctx.moveTo(x0, y0 - 4);
  ctx.lineTo(x0, y0 + 4);
  ctx.moveTo(x0 + bar.px, y0 - 4);
  ctx.lineTo(x0 + bar.px, y0 + 4);
  ctx.stroke();
  ctx.font = "11px ui-monospace, Menlo, monospace";
  ctx.fillText(bar.label, x0, y0 - 8);
  ctx.restore();
}
