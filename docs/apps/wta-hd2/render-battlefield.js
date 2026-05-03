// L3 — battlefield canvas renderer.
// Reads from controller snapshot only. Never mutates state.
// All time/animation lives in requestAnimationFrame; no setTimeout.
// All math lives in render-helpers.js; this module owns DOM/canvas only.

import {
  worldToScreen,
  pixelsPerMeter,
  radiusByTier,
  colorByFaction,
  colorBySlot,
  hpBarWidth,
  arcWedgePoints,
  drawGlyphPath,
  paletteForArchetype,
  weaponFamily,
  familyStyle,
  shortWeaponName,
  PLAYER_BOTTOM_GUTTER_PX,
  FORWARD_RANGE_M,
} from "./render-helpers.js";

const BG = "#0e0e10";
const RING_STROKE = "#2a2a2e";
const RING_LABEL = "rgba(170, 170, 180, 0.7)";
const ARC_FILL = "rgba(255, 58, 58, 0.04)";
const PROJECTILE_BULLET = "#fff2c4";
const PROJECTILE_AOE = "rgba(255, 200, 80, 0.6)";
const STRATAGEM_DIAMOND = "#3affc8";
const PLAYER_COLOR = "#f2f2ee";
const HP_BAR_BG = "rgba(0,0,0,0.5)";
const HP_BAR_FG = "#ff3a3a";

const HALF_CONE_RAD = (60 * Math.PI) / 180; // 60° each side = 120° cone
const RING_STEP_M = 20;
const HP_BAR_WIDTH_PX = 12;
const HP_BAR_HEIGHT_PX = 3;

export function mountBattlefield(canvas, controller) {
  if (!canvas || canvas.tagName !== "CANVAS") {
    throw new Error("mountBattlefield: canvas required");
  }
  if (!controller || typeof controller.subscribe !== "function") {
    throw new Error("mountBattlefield: controller required");
  }

  const ctx = canvas.getContext("2d");
  let snapshot = controller.getSnapshot ? controller.getSnapshot() : null;
  let cssW = 0;
  let cssH = 0;
  let dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  let rafId = null;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, Math.round(rect.width));
    cssH = Math.max(1, Math.round(rect.height));
    dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  resize();

  let resizeObs = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObs = new ResizeObserver(() => resize());
    resizeObs.observe(canvas);
  }

  // Ephemeral fx particle queue. Cap at 60 (FIFO).
  const fxQueue = [];
  const FX_CAP = 60;

  const unsubscribe = controller.subscribe((snap) => {
    snapshot = snap;
    const flashes = snap.fxFlashes ?? [];
    for (const f of flashes) {
      fxQueue.push({ ...f });
      if (fxQueue.length > FX_CAP) fxQueue.shift();
    }
  });

  function frame() {
    rafId = (typeof requestAnimationFrame !== "undefined")
      ? requestAnimationFrame(frame)
      : null;
    draw();
  }

  function draw() {
    if (!snapshot) return;
    // Camera follows the player so kiting doesn't push them off-screen.
    // World origin (0,0) is no longer fixed at screen center-bottom — the
    // player is. Range rings, arc cone, and the stratagem call-in marker
    // are HUD elements pinned to the player's screen position.
    const player = snapshot.player;
    const dims = {
      W: cssW,
      H: cssH,
      camera: { x: player?.x ?? 0, y: player?.y ?? 0 },
    };

    ctx.save();
    // Reset transform then apply DPR scale once per frame.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1. Clear + bg fill
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, cssW, cssH);

    // 2. Range rings
    drawRangeRings(ctx, dims);

    // 3. Forward arc cone
    drawArcCone(ctx, dims);

    // 3b. Range labels along the right cone edge (20m / 40m / 60m / 80m)
    drawRangeLabels(ctx, dims);

    // 4. Persistent effects
    drawEffects(ctx, dims, snapshot.effects ?? [], snapshot.t);

    // 5. Enemies (batched by archetype)
    drawEnemies(ctx, dims, snapshot.enemies ?? [], snapshot.scenario);

    // 6. Projectiles
    drawProjectiles(ctx, dims, snapshot.projectiles ?? []);

    // 7. Stratagem call-in markers
    drawStratagemCallIns(ctx, dims, snapshot.stratagems ?? []);

    // 8. Player
    drawPlayer(ctx, dims, snapshot.player);

    // 8b. Reload indicators — stacked thin bars below the diver, plus a
    // ROOTED chip when a heavy reload is locking movement. Surfaces the
    // time/action management cost of an empty mag.
    drawReloadIndicators(ctx, dims, snapshot.weapons ?? [], snapshot.player);

    // 9a. Tracers — bright lines from player to assigned targets this tick.
    // Most prominent visual cue that the helldiver is shooting. Style varies
    // by weapon family (bullet/laser/arc/plasma/flame/explosive).
    const familyByWeaponId = buildFamilyMap(snapshot);
    drawTracers(ctx, dims, snapshot.assignments ?? [], snapshot.enemies ?? [], snapshot.player, familyByWeaponId);

    // 9. Assignment tells (glow rings) over the targets
    drawAssignmentTells(ctx, dims, snapshot.assignments ?? [], snapshot.enemies ?? []);

    // 10. Cartoonish fx particles (explosions, gas, electric, laser, fire, spark)
    drawFxParticles(ctx, dims, fxQueue, snapshot.t);

    ctx.restore();
  }

  // Kick the loop.
  if (typeof requestAnimationFrame !== "undefined") {
    rafId = requestAnimationFrame(frame);
  } else {
    draw();
  }

  return function unmount() {
    if (rafId != null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(rafId);
    }
    rafId = null;
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }
    unsubscribe();
    snapshot = null;
  };
}

// ---- draw helpers (use ctx + dims; no module-level state) ----

function drawRangeRings(ctx, dims) {
  const ppm = pixelsPerMeter(dims.W, dims.H);
  const cx = dims.W / 2;
  const cy = dims.H - PLAYER_BOTTOM_GUTTER_PX;
  ctx.strokeStyle = RING_STROKE;
  ctx.lineWidth = 1;
  for (let m = RING_STEP_M; m <= FORWARD_RANGE_M; m += RING_STEP_M) {
    ctx.beginPath();
    ctx.arc(cx, cy, m * ppm, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Range labels sit on the right cone edge so they don't overlap enemies
// (which approach down the centerline). One label per ring step.
function drawRangeLabels(ctx, dims) {
  const ppm = pixelsPerMeter(dims.W, dims.H);
  const cx = dims.W / 2;
  const cy = dims.H - PLAYER_BOTTOM_GUTTER_PX;
  const sinH = Math.sin(HALF_CONE_RAD);
  const cosH = Math.cos(HALF_CONE_RAD);
  ctx.save();
  ctx.fillStyle = RING_LABEL;
  ctx.font = "10px ui-sans-serif, system-ui, -apple-system, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (let m = RING_STEP_M; m <= FORWARD_RANGE_M; m += RING_STEP_M) {
    const r = m * ppm;
    // Right cone edge intersection, nudged outward 4px so text sits past the line.
    const sx = cx + sinH * r + 4;
    const sy = cy - cosH * r;
    ctx.fillText(`${m}m`, sx, sy);
  }
  ctx.restore();
}

function drawArcCone(ctx, dims) {
  const w = arcWedgePoints(dims, HALF_CONE_RAD, FORWARD_RANGE_M);
  const ppm = pixelsPerMeter(dims.W, dims.H);
  const r = FORWARD_RANGE_M * ppm;
  ctx.fillStyle = ARC_FILL;
  ctx.beginPath();
  ctx.moveTo(w.cx, w.cy);
  // Arc goes from -π/2 - halfCone to -π/2 + halfCone in canvas angle space
  // (canvas 0 rad = +x, π/2 = down). World "up" (+y) = canvas angle -π/2.
  const startA = -Math.PI / 2 - HALF_CONE_RAD;
  const endA = -Math.PI / 2 + HALF_CONE_RAD;
  ctx.arc(w.cx, w.cy, r, startA, endA);
  ctx.closePath();
  ctx.fill();
}

function drawEffects(ctx, dims, effects, snapshotT) {
  const ppm = pixelsPerMeter(dims.W, dims.H);
  for (const eff of effects) {
    const { sx, sy } = worldToScreen({ x: eff.x ?? 0, y: eff.y ?? 0 }, dims);
    const r = (eff.radiusM ?? 1) * ppm;
    switch (eff.kind) {
      case "callin": {
        // Two phases:
        //   pre-impact (snapshotT < resolveAt): throw arc + countdown crosshair.
        //   post-impact lingering (1200ms): expanding amber ring + bright core.
        const landed = eff.landedAt != null && (snapshotT ?? 0) >= eff.landedAt;
        const remainSec = Math.max(0, ((eff.resolveAt ?? snapshotT) - (snapshotT ?? 0)) / 1000);
        const totalSec = Math.max(0.001, ((eff.resolveAt ?? 0) - (eff.bornT ?? 0)) / 1000);
        const t01 = totalSec > 0 ? 1 - remainSec / totalSec : 1;
        if (landed) {
          const linger = Math.max(0, Math.min(1, ((snapshotT ?? 0) - eff.landedAt) / 1200));
          const fade = 1 - linger;
          const ringR = Math.max(8, r) * (1 + linger * 1.4);
          ctx.strokeStyle = `rgba(255, 230, 160, ${0.85 * fade})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(sx, sy, ringR, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = `rgba(255, 255, 230, ${0.5 * fade})`;
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(4, r * 0.4) * (1 - linger * 0.5), 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        // Throw arc — parabolic-ish curve from player to beacon, brighter near landing.
        if (eff.playerX != null) {
          const ps = worldToScreen({ x: eff.playerX, y: eff.playerY ?? 0 }, dims);
          const midX = (ps.sx + sx) / 2;
          const midY = Math.min(ps.sy, sy) - Math.max(20, Math.hypot(sx - ps.sx, sy - ps.sy) * 0.35);
          ctx.strokeStyle = `rgba(58, 255, 200, ${0.35 + 0.45 * t01})`;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(ps.sx, ps.sy);
          ctx.quadraticCurveTo(midX, midY, sx, sy);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // Pulsing AoE target ring.
        const pulse = 0.7 + 0.3 * Math.sin((snapshotT ?? 0) * 0.012);
        ctx.strokeStyle = `rgba(58, 255, 200, ${0.7 * pulse})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(6, r), 0, Math.PI * 2);
        ctx.stroke();
        // Inner crosshair beacon.
        ctx.strokeStyle = "rgba(58, 255, 200, 0.95)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(sx - 6, sy); ctx.lineTo(sx + 6, sy);
        ctx.moveTo(sx, sy - 6); ctx.lineTo(sx, sy + 6);
        ctx.stroke();
        // Countdown text above beacon.
        ctx.fillStyle = "rgba(58, 255, 200, 1)";
        ctx.font = "600 11px ui-monospace, SF Mono, Menlo, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        const countdown = remainSec >= 1
          ? `${remainSec.toFixed(1)}s`
          : `${Math.max(0, Math.round(remainSec * 1000))}ms`;
        const stratName = shortStratName(eff.weaponId);
        ctx.fillText(`${stratName} ${countdown}`, sx, sy - Math.max(8, r) - 4);
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
        break;
      }
      case "gas": {
        const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
        grad.addColorStop(0, "rgba(120, 200, 80, 0.35)");
        grad.addColorStop(1, "rgba(120, 200, 80, 0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
        drawLabel(ctx, sx, sy - r - 2, "GAS", "rgba(180, 230, 120, 0.95)");
        break;
      }
      case "sentry": {
        // Sentry actor — triangle with range halo, lifetime fade.
        const remainPct = eff.until ? Math.max(0, (eff.until - (snapshotT ?? 0)) / Math.max(1, eff.until - (eff.bornT ?? 0))) : 1;
        // Range halo
        ctx.strokeStyle = `rgba(154, 166, 255, ${0.15 * remainPct})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(sx, sy, (eff.maxRangeM ?? 60) * ppm, 0, Math.PI * 2);
        ctx.stroke();
        // Body — bright triangle
        ctx.fillStyle = `rgba(154, 166, 255, ${0.6 + 0.4 * remainPct})`;
        ctx.beginPath();
        ctx.moveTo(sx, sy - 8);
        ctx.lineTo(sx - 6, sy + 5);
        ctx.lineTo(sx + 6, sy + 5);
        ctx.closePath();
        ctx.fill();
        // Inner dot
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(sx, sy, 1.5, 0, Math.PI * 2);
        ctx.fill();
        drawLabel(ctx, sx, sy - 12, shortStratName(eff.defId || "sentry"), "rgba(180, 200, 255, 0.95)");
        break;
      }
      case "pickup": {
        // EAT / resupply share one visual: a hollow circle near the diver
        // with the remaining-uses count inside, name above. Effect is
        // dropped from state when usesLeft hits 0, so we never render ×0.
        const usesLeft = eff.usesLeft ?? 0;
        if (usesLeft <= 0) break;
        ctx.fillStyle = "rgba(255, 144, 80, 0.18)";
        ctx.beginPath();
        ctx.arc(sx, sy, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 144, 80, 0.85)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(sx, sy, 9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "rgba(255, 220, 180, 0.95)";
        ctx.font = "bold 10px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(usesLeft), sx, sy + 0.5);
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
        drawLabel(ctx, sx, sy - 13, shortStratName(eff.weaponName || "pickup"), "rgba(255, 200, 120, 0.95)");
        break;
      }
      case "dot": {
        // Persistent damage cloud — gas/napalm/laser pool. Sub-kind controls color.
        const remainPct = eff.until ? Math.max(0, (eff.until - (snapshotT ?? 0)) / Math.max(1, eff.until - (eff.bornT ?? 0))) : 1;
        const baseAlpha = 0.4 * remainPct;
        let inner = `rgba(120, 200, 80, ${baseAlpha})`, outer = `rgba(120, 200, 80, 0)`;
        let labelText = "GAS", labelColor = "rgba(180, 230, 120, 0.95)";
        if (eff.subKind === "fire") {
          inner = `rgba(255, 130, 40, ${baseAlpha})`; outer = `rgba(180, 40, 0, 0)`;
          labelText = "FIRE"; labelColor = "rgba(255, 180, 100, 0.95)";
        }
        if (eff.subKind === "laser") {
          inner = `rgba(255, 100, 100, ${baseAlpha})`; outer = `rgba(180, 30, 30, 0)`;
          labelText = "LASER"; labelColor = "rgba(255, 160, 160, 0.95)";
        }
        const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
        grad.addColorStop(0, inner);
        grad.addColorStop(1, outer);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
        // Animated flicker particles inside the dot — adds life without
        // spawning per-tick fxFlashes. 4 dots, deterministic from snapshotT.
        const t = (snapshotT ?? 0) * 0.004;
        ctx.fillStyle = inner.replace(/[0-9.]+\)$/, `${0.9 * remainPct})`);
        for (let i = 0; i < 4; i++) {
          const a = t * (1 + i * 0.3) + i * 1.7;
          const rr = r * (0.3 + 0.4 * ((i * 0.37 + t * 0.5) % 1));
          ctx.beginPath();
          ctx.arc(sx + Math.cos(a) * rr, sy + Math.sin(a) * rr, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
        drawLabel(ctx, sx, sy - r - 2, labelText, labelColor);
        break;
      }
      case "mine": {
        ctx.fillStyle = "#ffb13a";
        ctx.beginPath();
        ctx.arc(sx, sy, 2, 0, Math.PI * 2);
        ctx.fill();
        drawLabel(ctx, sx, sy - 6, "MINE", "rgba(255, 200, 120, 0.85)");
        break;
      }
      default: {
        // Generic effect ring
        ctx.strokeStyle = "rgba(200, 200, 200, 0.4)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(2, r), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}

function drawEnemies(ctx, dims, enemies, scenario) {
  if (enemies.length === 0) return;
  const faction = scenario?.faction;
  const archetypesById = new Map();
  for (const a of (scenario?.archetypes ?? [])) archetypesById.set(a.id, a);

  const now = (typeof performance !== "undefined" ? performance.now() : 0);

  // Group by archetypeId so we set fillStyle once per group.
  const byArch = new Map();
  for (const e of enemies) {
    if (!e.alive) continue;
    const list = byArch.get(e.archetypeId);
    if (list) list.push(e);
    else byArch.set(e.archetypeId, [e]);
  }

  // Cache per-enemy bobbed screen pos for HP bars + name labels below.
  const screenById = new Map();

  for (const [archId, group] of byArch) {
    const arch = archetypesById.get(archId);
    const glyph = arch?.glyph ?? "ring";
    const fill = paletteForArchetype(faction, arch);
    const isJumper = isJumpingArchetype(archId, arch?.name);
    ctx.fillStyle = fill;
    for (const e of group) {
      const base = worldToScreen({ x: e.x, y: e.y }, dims);
      let sx = base.sx, sy = base.sy;
      if (isJumper) {
        // Hunter/Pouncer/Stalker bob — small Y oscillation per-enemy phase.
        // hash from id keeps each bug out of phase. amplitude 5px.
        const phase = jumpPhase(e.id) + now * 0.012;
        sy -= Math.abs(Math.sin(phase)) * 5;
      }
      screenById.set(e.id, { sx, sy });
      const r = radiusByTier(e.threatTier);
      drawGlyphPath(ctx, glyph, sx, sy, r);
      ctx.fill();
      if (arch?.outline) {
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.lineWidth = 1.2;
        drawGlyphPath(ctx, glyph, sx, sy, r + 1.5);
        ctx.stroke();
      }
    }
  }

  // HP bars (only for damaged enemies). Drawn after all dots so bars stack on top.
  for (const e of enemies) {
    if (!e.alive) continue;
    if (!(e.hp < e.hpMax)) continue;
    const s = screenById.get(e.id);
    if (!s) continue;
    const r = radiusByTier(e.threatTier);
    const bx = s.sx - HP_BAR_WIDTH_PX / 2;
    const by = s.sy - r - HP_BAR_HEIGHT_PX - 2;
    ctx.fillStyle = HP_BAR_BG;
    ctx.fillRect(bx, by, HP_BAR_WIDTH_PX, HP_BAR_HEIGHT_PX);
    ctx.fillStyle = HP_BAR_FG;
    ctx.fillRect(bx, by, hpBarWidth(e.hp, e.hpMax, HP_BAR_WIDTH_PX), HP_BAR_HEIGHT_PX);
  }

  // Name labels — small text under each glyph so the player can identify
  // the bug at a glance. One fillText pair per enemy is cheap (count < 30).
  ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const e of enemies) {
    if (!e.alive) continue;
    const s = screenById.get(e.id);
    if (!s) continue;
    const arch = archetypesById.get(e.archetypeId);
    const text = arch?.name || e.archetypeId;
    const r = radiusByTier(e.threatTier);
    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.fillText(text, s.sx + 1, s.sy + r + 3);
    ctx.fillStyle = "rgba(220, 220, 230, 0.9)";
    ctx.fillText(text, s.sx, s.sy + r + 2);
  }
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

// Cheap, deterministic phase from enemy id so each bug bobs out of phase
// without any RNG cost.
function jumpPhase(id) {
  let h = 2166136261 >>> 0;
  const s = String(id || "");
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return (h % 6283) / 1000;
}

function isJumpingArchetype(id, name) {
  const tag = `${id || ""} ${name || ""}`.toLowerCase();
  return /hunter|pouncer|stalker|scout|jumper|leaper/.test(tag);
}

function drawProjectiles(ctx, dims, projectiles) {
  const ppm = pixelsPerMeter(dims.W, dims.H);
  ctx.strokeStyle = PROJECTILE_BULLET;
  ctx.lineWidth = 1;
  // Bullet line segments first.
  ctx.beginPath();
  for (const p of projectiles) {
    if (p.kind === "aoe") continue;
    const { sx, sy } = worldToScreen({ x: p.x, y: p.y }, dims);
    const vx = p.vx ?? 0;
    const vy = p.vy ?? 0;
    // 50ms tail
    const tailX = sx - vx * ppm * 0.05;
    const tailY = sy + vy * ppm * 0.05; // world +y = screen up, so subtract gives forward; flip back
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(sx, sy);
  }
  ctx.stroke();

  // AoE rings (fading).
  for (const p of projectiles) {
    if (p.kind !== "aoe") continue;
    const { sx, sy } = worldToScreen({ x: p.x, y: p.y }, dims);
    const r = (p.radiusM ?? 4) * ppm;
    ctx.strokeStyle = PROJECTILE_AOE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawStratagemCallIns(ctx, dims, stratagems) {
  // Strip is throw-only: shows pending call-ins (pct < 1). Once landed, the
  // on-field effect (sentry/pickup/dot/mine) takes over and the chip clears.
  const calling = stratagems.filter((s) => s.callInPct != null && s.callInPct < 1);
  if (!calling.length) return;
  const blink = ((typeof performance !== "undefined" ? performance.now() : Date.now()) / 250) | 0;
  // Anchor 5m ahead of the player so the marker stays HUD-pinned during kiting.
  const camX = dims.camera?.x ?? 0;
  const camY = dims.camera?.y ?? 0;
  const { sx, sy } = worldToScreen({ x: camX, y: camY + 5 }, dims);
  const SPACING = 22;
  // Diamonds laid out in a horizontal row, labels stacked vertically above
  // them with thin leader lines back to each diamond — labels are wider than
  // SPACING so per-diamond stacking would garble them into one another.
  calling.forEach((s, i) => {
    const cx = sx + i * SPACING;
    const cy = sy;
    if (blink % 2 === 0) {
      ctx.fillStyle = STRATAGEM_DIAMOND;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 6);
      ctx.lineTo(cx + 5, cy);
      ctx.lineTo(cx, cy + 6);
      ctx.lineTo(cx - 5, cy);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = STRATAGEM_DIAMOND;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (s.callInPct ?? 0));
    ctx.stroke();
  });
  const rowH = 11;
  const stackTop = sy - 18 - (calling.length - 1) * rowH;
  const centerX = sx + ((calling.length - 1) * SPACING) / 2;
  ctx.save();
  ctx.strokeStyle = "rgba(58, 255, 200, 0.35)";
  ctx.lineWidth = 1;
  calling.forEach((s, i) => {
    const cx = sx + i * SPACING;
    const labelY = stackTop + i * rowH;
    ctx.beginPath();
    ctx.moveTo(centerX, labelY + 1);
    ctx.lineTo(cx, sy - 11);
    ctx.stroke();
  });
  ctx.restore();
  calling.forEach((s, i) => {
    const labelY = stackTop + i * rowH;
    drawLabel(ctx, centerX, labelY, `${shortStratName(s.defId || s.id)} CALLED`, STRATAGEM_DIAMOND);
  });
}

function drawLabel(ctx, x, y, text, color) {
  ctx.save();
  ctx.font = "600 9px ui-monospace, SF Mono, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  // shadow for readability over busy fields
  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  ctx.fillText(text, x + 1, y + 1);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function shortStratName(defId) {
  if (!defId) return "STRATAGEM";
  // Compact display for tight battlefield real estate.
  return String(defId).replace(/^eagle-/, "EAGLE ")
    .replace(/^orbital-/, "ORB ")
    .replace(/^sentry-/, "SENTRY ")
    .replace(/-/g, " ")
    .toUpperCase();
}

function drawPlayer(ctx, dims, player) {
  if (!player) return;
  const { sx, sy } = worldToScreen({ x: player.x ?? 0, y: player.y ?? 0 }, dims);
  const facing = player.facingRad ?? Math.PI / 2; // default facing forward (world +y)
  // World facing 0 = +x; π/2 = +y (forward, which is screen up).
  // To convert world angle -> canvas angle: canvas angle = -facing (since y flips).
  const canvasA = -facing;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(canvasA);
  ctx.fillStyle = PLAYER_COLOR;
  ctx.beginPath();
  // Triangle pointing +x in local coords (because we rotated by canvasA matching facing)
  ctx.moveTo(8, 0);
  ctx.lineTo(-5, 5);
  ctx.lineTo(-5, -5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  drawMovementArrow(ctx, dims, player, sx, sy);
  drawVelocityReadout(ctx, player, sx, sy);
}

// Reload bars stacked below the diver. One row per weapon currently
// reloading, oldest-mag-out at the top. Bar colour signals the
// time-and-action cost: amber = reloading-but-can-move,
// red = ROOTED (heavy reload, no movement, no other fire). When at least
// one rooting reload is in progress, a "ROOTED — N.Ns" chip is drawn just
// above the player triangle so the user catches the lockout even if they
// aren't reading the bars.
function drawReloadIndicators(ctx, dims, weapons, player) {
  if (!player) return;
  const reloading = (weapons || []).filter((w) => (w.reloadingPct ?? 1) < 1);
  if (reloading.length === 0) return;
  const { sx, sy } = worldToScreen({ x: player.x ?? 0, y: player.y ?? 0 }, dims);
  const BAR_W = 56;
  const BAR_H = 4;
  const ROW_GAP = 3;
  const baseY = sy + 22;
  const baseX = sx - BAR_W / 2;

  let rootedSecsRemaining = 0;
  for (const w of reloading) {
    if (!w.rootsPlayer) continue;
    const remain = (1 - (w.reloadingPct ?? 0)) * (w.reloadSecs ?? 2);
    if (remain > rootedSecsRemaining) rootedSecsRemaining = remain;
  }

  ctx.save();
  ctx.font = "600 9px ui-monospace, SF Mono, Menlo, monospace";
  ctx.textBaseline = "middle";
  reloading.forEach((w, i) => {
    const y = baseY + i * (BAR_H + ROW_GAP + 8);
    const filled = Math.max(0, Math.min(1, w.reloadingPct ?? 0)) * BAR_W;
    const fg = w.rootsPlayer ? "#ff3a3a" : "#d97a2c";
    // bg
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(baseX - 1, y - 1, BAR_W + 2, BAR_H + 2);
    ctx.fillStyle = "rgba(40, 40, 44, 0.9)";
    ctx.fillRect(baseX, y, BAR_W, BAR_H);
    ctx.fillStyle = fg;
    ctx.fillRect(baseX, y, filled, BAR_H);
    // label
    const remainSec = Math.max(0, (1 - (w.reloadingPct ?? 0)) * (w.reloadSecs ?? 2));
    const label = `${shortWeaponName(w.defId)} ${remainSec.toFixed(1)}s`;
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillText(label, baseX + 1, y + BAR_H + 7);
    ctx.fillStyle = w.rootsPlayer ? "#ff7a7a" : "#f0c080";
    ctx.fillText(label, baseX, y + BAR_H + 6);
  });

  if (rootedSecsRemaining > 0) {
    const chipY = sy - 18;
    const text = `ROOTED ${rootedSecsRemaining.toFixed(1)}s`;
    ctx.font = "700 10px ui-monospace, SF Mono, Menlo, monospace";
    ctx.textAlign = "center";
    const textW = ctx.measureText(text).width;
    const padX = 5;
    const chipW = textW + padX * 2;
    const chipH = 14;
    ctx.fillStyle = "rgba(255, 58, 58, 0.92)";
    ctx.fillRect(sx - chipW / 2, chipY - chipH / 2, chipW, chipH);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, sx, chipY);
  }
  ctx.restore();
}

// Numeric vx / vy (m/s) printed next to the diver. Sign-explicit so the
// reader can tell forward/back and left/right at a glance without re-deriving
// from the arrow direction.
function drawVelocityReadout(ctx, player, sx, sy) {
  const vx = player.vx ?? 0;
  const vy = player.vy ?? 0;
  ctx.save();
  ctx.font = "600 10px ui-monospace, SF Mono, Menlo, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const tx = sx + 12;
  const ty = sy + 10;
  const sign = (n) => (n >= 0 ? "+" : "");
  const text = `vx ${sign(vx)}${vx.toFixed(1)}  vy ${sign(vy)}${vy.toFixed(1)} m/s`;
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillText(text, tx + 1, ty + 1);
  ctx.fillStyle = "rgba(230, 230, 235, 0.95)";
  ctx.fillText(text, tx, ty);
  ctx.restore();
}

function drawMovementArrow(ctx, dims, player, sx, sy) {
  const vx = player.vx ?? 0;
  const vy = player.vy ?? 0;
  const speed = Math.hypot(vx, vy);
  if (speed < 0.05) return;
  // Length in world meters scaled by speed; capped so a fast kite doesn't dominate.
  const lenWorld = Math.min(6, speed * 1.2);
  const dx2 = (vx / speed) * lenWorld;
  const dy2 = (vy / speed) * lenWorld;
  const tip = worldToScreen({ x: (player.x ?? 0) + dx2, y: (player.y ?? 0) + dy2 }, dims);
  const mode = player.mode ?? "HOLD";
  const color = mode === "KITE" ? "#d97a2c" : mode === "PUSH" ? "#9be57f" : "#888";
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(tip.sx, tip.sy);
  ctx.stroke();
  const ang = Math.atan2(tip.sy - sy, tip.sx - sx);
  ctx.beginPath();
  ctx.moveTo(tip.sx, tip.sy);
  ctx.lineTo(tip.sx - 6 * Math.cos(ang - 0.4), tip.sy - 6 * Math.sin(ang - 0.4));
  ctx.lineTo(tip.sx - 6 * Math.cos(ang + 0.4), tip.sy - 6 * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawAssignmentTells(ctx, dims, assignments, enemies) {
  if (assignments.length === 0) return;
  const enemyById = new Map();
  for (const e of enemies) enemyById.set(e.id, e);

  // Bucket assignments by targetId so concentric rings render from same center.
  const byTarget = new Map();
  for (const a of assignments) {
    const list = byTarget.get(a.targetId);
    if (list) list.push(a);
    else byTarget.set(a.targetId, [a]);
  }

  for (const [tid, list] of byTarget) {
    const e = enemyById.get(tid);
    if (!e || !e.alive) continue;
    const { sx, sy } = worldToScreen({ x: e.x, y: e.y }, dims);
    const baseR = radiusByTier(e.threatTier) + 3;
    list.forEach((a, idx) => {
      ctx.strokeStyle = colorBySlot(weaponSlotFromId(a.weaponId));
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(sx, sy, baseR + idx * 3, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }
}

function weaponSlotFromId(id) {
  if (!id) return "";
  // Pass-through; helper handles aliases like slot1/strat-1/primary etc.
  return id;
}

// ---- cartoonish fx particles ----
function drawFxParticles(ctx, dims, queue, nowMs) {
  if (!queue.length) return;
  const surviving = [];
  for (const fx of queue) {
    const age = nowMs - fx.bornT;
    if (age < 0 || age > fx.durMs) continue;
    surviving.push(fx);
    const t = age / fx.durMs; // 0..1
    drawFxOne(ctx, dims, fx, t);
  }
  // mutate queue in place to drop dead particles
  queue.length = 0;
  for (const f of surviving) queue.push(f);
}

function drawFxOne(ctx, dims, fx, t) {
  const { sx, sy } = worldToScreenLocal(fx.x, fx.y, dims);
  const fade = 1 - t;
  switch (fx.kind) {
    case "explosion":   return drawExplosion(ctx, sx, sy, fx.r, t, fade, fx.isKill);
    case "gas":         return drawGas(ctx, sx, sy, fx.r, t, fade);
    case "electric":    return drawElectric(ctx, sx, sy, fx.r, t, fade);
    case "laser":       return drawLaser(ctx, sx, sy, fx.r, t, fade);
    case "fire":        return drawFire(ctx, sx, sy, fx.r, t, fade);
    case "spark":       return drawSpark(ctx, sx, sy, fx.r, t, fade);
    case "muzzle":      return drawMuzzle(ctx, sx, sy, fx.r, t, fade);
    case "back-blast":  return drawBackBlast(ctx, sx, sy, fx.r, t, fade);
    case "rocket":      return drawRocket(ctx, dims, fx, t, fade);
    case "sentry-tracer": return drawSentryTracer(ctx, dims, fx, fade);
    default:            return drawSpark(ctx, sx, sy, fx.r, t, fade);
  }
}

// Big grey smoke puff at the diver's feet/back when an RR / Spear / EAT
// fires. Expands and fades — meant to read as "something heavy just left
// here" in the user's peripheral vision.
function drawBackBlast(ctx, sx, sy, rM, t, fade) {
  const radius = Math.max(14, rM * 6) * (0.6 + t * 1.2);
  const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, radius);
  grad.addColorStop(0, `rgba(220, 220, 215, ${0.55 * fade})`);
  grad.addColorStop(0.5, `rgba(170, 170, 170, ${0.35 * fade})`);
  grad.addColorStop(1, `rgba(120, 120, 120, 0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(sx, sy, radius, 0, Math.PI * 2);
  ctx.fill();
  // Bright muzzle core for the first ~30% of the puff.
  if (t < 0.3) {
    ctx.fillStyle = `rgba(255, 240, 200, ${(0.9 - t * 3) * fade})`;
    ctx.beginPath();
    ctx.arc(sx, sy, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Rocket / smoke trail traveling from `fromX/fromY` to `x/y` over the fx's
// durMs. Drops 5 trailing smoke puffs along the path so the projectile reads
// as a streak rather than a single dot — matters at 80m where the travel is
// only a few canvas pixels per tick.
function drawRocket(ctx, dims, fx, t, fade) {
  const a = worldToScreenLocal(fx.fromX ?? 0, fx.fromY ?? 0, dims);
  const b = worldToScreenLocal(fx.x ?? 0, fx.y ?? 0, dims);
  const hx = a.sx + (b.sx - a.sx) * t;
  const hy = a.sy + (b.sy - a.sy) * t;
  // Smoke trail — 5 puffs evenly spaced from launch to current head, each
  // older (further from head) is bigger and fainter.
  const puffs = 5;
  for (let i = 0; i < puffs; i++) {
    const f = i / puffs;
    const px = a.sx + (hx - a.sx) * f;
    const py = a.sy + (hy - a.sy) * f;
    const r = 2 + (1 - f) * 4;
    const alpha = (0.45 - f * 0.3) * fade;
    ctx.fillStyle = `rgba(200, 200, 195, ${alpha})`;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Bright projectile head.
  ctx.fillStyle = `rgba(255, 230, 160, ${0.95 * fade})`;
  ctx.beginPath();
  ctx.arc(hx, hy, 3, 0, Math.PI * 2);
  ctx.fill();
  // Faint flight line so the trajectory reads even before puffs render.
  ctx.strokeStyle = `rgba(255, 220, 160, ${0.25 * fade})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(a.sx, a.sy);
  ctx.lineTo(hx, hy);
  ctx.stroke();
}

// Thin wrapper around the (x, y) signature used by tracer/fx callers.
// Delegates to worldToScreen so the camera offset on `dims` is respected.
function worldToScreenLocal(x, y, dims) {
  return worldToScreen({ x, y }, dims);
}

function drawExplosion(ctx, sx, sy, rM, t, fade, isKill) {
  const scale = 1 + t * 1.5;
  const radius = Math.max(8, rM * 6 * scale);
  const grad = ctx.createRadialGradient(sx, sy, radius * 0.1, sx, sy, radius);
  grad.addColorStop(0, `rgba(255, 240, 180, ${0.9 * fade})`);
  grad.addColorStop(0.4, `rgba(255, 140, 40, ${0.7 * fade})`);
  grad.addColorStop(1, `rgba(255, 50, 30, 0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(sx, sy, radius, 0, Math.PI * 2);
  ctx.fill();
  // core
  ctx.fillStyle = `rgba(255, 255, 240, ${0.8 * fade})`;
  ctx.beginPath();
  ctx.arc(sx, sy, radius * 0.18, 0, Math.PI * 2);
  ctx.fill();
  if (isKill) {
    // shockwave ring
    ctx.strokeStyle = `rgba(255, 200, 100, ${0.6 * fade})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, radius * 0.85, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawGas(ctx, sx, sy, rM, t, fade) {
  const radius = Math.max(20, rM * 4) * (0.7 + t * 0.4);
  const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, radius);
  grad.addColorStop(0, `rgba(180, 230, 90, ${0.45 * fade})`);
  grad.addColorStop(0.6, `rgba(140, 200, 60, ${0.25 * fade})`);
  grad.addColorStop(1, `rgba(100, 160, 40, 0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(sx, sy, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawElectric(ctx, sx, sy, rM, t, fade) {
  const reach = Math.max(20, rM * 6);
  ctx.strokeStyle = `rgba(180, 220, 255, ${fade})`;
  ctx.lineWidth = 1.5;
  // 4 jagged bolts radiating out
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + t * 1.3;
    let x = sx, y = sy;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const segs = 4;
    for (let s = 0; s < segs; s++) {
      const f = (s + 1) / segs;
      const targetX = sx + Math.cos(a) * reach * f;
      const targetY = sy + Math.sin(a) * reach * f;
      const jitter = 6 * (1 - f);
      x = targetX + (Math.cos(a + 1.7 + s) * jitter);
      y = targetY + (Math.sin(a + 1.7 + s) * jitter);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // bright core
  ctx.fillStyle = `rgba(220, 240, 255, ${fade})`;
  ctx.beginPath();
  ctx.arc(sx, sy, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawLaser(ctx, sx, sy, rM, t, fade) {
  // Beam from sky
  const beamLen = 200;
  const grad = ctx.createLinearGradient(sx, sy - beamLen, sx, sy);
  grad.addColorStop(0, `rgba(255, 80, 80, 0)`);
  grad.addColorStop(0.7, `rgba(255, 60, 60, ${0.7 * fade})`);
  grad.addColorStop(1, `rgba(255, 240, 200, ${fade})`);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(sx, sy - beamLen);
  ctx.lineTo(sx, sy);
  ctx.stroke();
  // ground burst
  const radius = Math.max(8, rM * 5);
  ctx.fillStyle = `rgba(255, 200, 200, ${0.8 * fade})`;
  ctx.beginPath();
  ctx.arc(sx, sy, radius * (0.6 + t * 0.6), 0, Math.PI * 2);
  ctx.fill();
}

function drawFire(ctx, sx, sy, rM, t, fade) {
  const radius = Math.max(10, rM * 4);
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + t * 4;
    const x = sx + Math.cos(ang) * radius * 0.4 * t;
    const y = sy + Math.sin(ang) * radius * 0.4 * t - t * radius * 0.3;
    const r = radius * 0.4 * (1 - t * 0.5);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255, 220, 100, ${fade})`);
    grad.addColorStop(0.6, `rgba(255, 100, 30, ${0.7 * fade})`);
    grad.addColorStop(1, `rgba(180, 30, 0, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawSpark(ctx, sx, sy, rM, t, fade) {
  const radius = Math.max(6, rM * 4) * (0.5 + t * 0.7);
  ctx.strokeStyle = `rgba(255, 220, 100, ${fade})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(sx, sy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = `rgba(255, 240, 200, ${0.9 * fade})`;
  ctx.beginPath();
  ctx.arc(sx, sy, radius * 0.25, 0, Math.PI * 2);
  ctx.fill();
}

function drawMuzzle(ctx, sx, sy, _rM, _t, fade) {
  ctx.fillStyle = `rgba(255, 255, 220, ${fade})`;
  ctx.beginPath();
  ctx.arc(sx, sy, 3, 0, Math.PI * 2);
  ctx.fill();
}

// ---- tracers (line from player to each assigned target this tick) ----
// Tracers are batched per weapon family — one strokeStyle/beginPath per family
// — so a tick with 12 assignments across 3 families issues 3 stroke calls.
function buildFamilyMap(snapshot) {
  const m = new Map();
  for (const w of (snapshot.weapons ?? [])) m.set(w.id, weaponFamily(w.defId, w.id));
  for (const s of (snapshot.stratagems ?? [])) m.set(s.id, weaponFamily(s.defId, s.id));
  return m;
}

function drawTracers(ctx, dims, assignments, enemies, player, familyByWeaponId) {
  if (!assignments.length || !player) return;
  const enemyById = new Map();
  for (const e of enemies) enemyById.set(e.id, e);
  const ps = worldToScreenLocal(player.x ?? 0, player.y ?? 0, dims);

  // Group assignments by family so we set strokeStyle/lineWidth once per group.
  const byFamily = new Map();
  for (const a of assignments) {
    const target = enemyById.get(a.targetId);
    if (!target || !target.alive) continue;
    const fam = (familyByWeaponId && familyByWeaponId.get(a.weaponId)) || "bullet";
    let list = byFamily.get(fam);
    if (!list) { list = []; byFamily.set(fam, list); }
    list.push(target);
  }
  if (byFamily.size === 0) return;

  const phase = (typeof performance !== "undefined" ? performance.now() : 0) * 0.02;
  for (const [fam, targets] of byFamily) {
    const style = familyStyle(fam);
    ctx.strokeStyle = style.color;
    ctx.fillStyle = style.color;
    ctx.lineWidth = style.lineWidth;
    if (style.kind === "zigzag") {
      ctx.beginPath();
      for (const t of targets) {
        const ts = worldToScreenLocal(t.x, t.y, dims);
        zigzagPath(ctx, ps.sx, ps.sy, ts.sx, ts.sy, phase);
      }
      ctx.stroke();
    } else {
      ctx.beginPath();
      for (const t of targets) {
        const ts = worldToScreenLocal(t.x, t.y, dims);
        ctx.moveTo(ps.sx, ps.sy);
        ctx.lineTo(ts.sx, ts.sy);
      }
      ctx.stroke();
      if (style.dotR > 0) {
        ctx.beginPath();
        for (const t of targets) {
          const ts = worldToScreenLocal(t.x, t.y, dims);
          ctx.moveTo(ts.sx + style.dotR, ts.sy);
          ctx.arc(ts.sx, ts.sy, style.dotR, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }
  }
}

function zigzagPath(ctx, x0, y0, x1, y1, phase) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  const segs = 4;
  const amp = Math.min(8, len * 0.08);
  ctx.moveTo(x0, y0);
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    const cx = x0 + dx * t;
    const cy = y0 + dy * t;
    const sign = (i % 2 === 0) ? -1 : 1;
    const j = sign * amp * (0.6 + 0.4 * Math.sin(phase + i * 1.3));
    ctx.lineTo(cx + px * j, cy + py * j);
  }
  ctx.lineTo(x1, y1);
}

function drawSentryTracer(ctx, dims, fx, fade) {
  const a = worldToScreenLocal(fx.fromX ?? 0, fx.fromY ?? 0, dims);
  const b = worldToScreenLocal(fx.x ?? 0, fx.y ?? 0, dims);
  const fam = weaponFamily(fx.defId, "");
  const style = familyStyle(fam);
  // Apply family color with the per-flash fade.
  ctx.strokeStyle = style.color.replace(/,\s*0?\.[0-9]+\)$/, `, ${(0.95 * fade).toFixed(3)})`);
  ctx.lineWidth = style.lineWidth;
  ctx.beginPath();
  if (style.kind === "zigzag") {
    zigzagPath(ctx, a.sx, a.sy, b.sx, b.sy, fx.bornT * 0.02);
  } else {
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(b.sx, b.sy);
  }
  ctx.stroke();
  if (style.dotR > 0) {
    ctx.fillStyle = style.color.replace(/,\s*0?\.[0-9]+\)$/, `, ${fade.toFixed(3)})`);
    ctx.beginPath();
    ctx.arc(b.sx, b.sy, style.dotR, 0, Math.PI * 2);
    ctx.fill();
  }
}
