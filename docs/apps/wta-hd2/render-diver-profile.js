// L3 — side-profile diver renderer.
// Reads from controller snapshot only. Never mutates state.
// All time/animation lives in requestAnimationFrame; no setTimeout.
//
// Renders a small side-view silhouette of the helldiver in the upper-right
// of the battlefield. The pose tracks what the sim has the diver doing this
// tick (firing primary, reloading recoilless, throwing a stratagem, etc.) so
// the user can read the time/action cost of their loadout in concrete body
// language instead of inferring it from bars and chips.

import { weaponFamily, weaponFiresRocket, shortWeaponName } from "./render-helpers.js";

const BG = "rgba(14, 14, 16, 0.78)";
const BORDER = "rgba(58, 58, 64, 0.85)";
const SKIN = "#cbd1cf";       // armor mid-grey
const SKIN_DARK = "#7f8784";  // armor shadow
const VISOR = "#ffd64a";      // helldiver visor yellow
const HELMET = "#3a3d44";     // helmet shell — darker than armor for contrast
const HELMET_HI = "#5a5e66";  // helmet rim/highlight
const CAPE = "#c13a3a";       // Super Earth red, the cape that says "democracy"
const CAPE_DARK = "#7a1f1f";  // cape shadow fold
const WEAPON = "#2a2c30";     // weapon dark grey
const WEAPON_HI = "#5a5d63";  // weapon highlight
const STRAT_BALL = "#3affc8";
const FX = "#ffe6a0";
const TXT = "rgba(230, 230, 235, 0.92)";
const TXT_DIM = "rgba(160, 160, 170, 0.85)";

const W = 180;
const H = 220;
const GROUND_Y = 198;
const FOOT_X = 86; // body roughly centered, room to the right for the weapon

const THROW_HOLD_MS = 700; // diver stays in throw-back pose this long after a stratagem ball leaves their hand

// Compute the diver's current visible action from a snapshot. Pure — no
// canvas, no DOM, no time except snapshot.t. Memory carries cross-tick state
// (which call-ins were already in flight, when the most recent throw should
// stop being shown). Returns { action, memory }.
//
// Priority ladder (highest first):
//   throw           — a stratagem ball just left the diver's hand (sticky 700ms)
//   reload-heavy    — any rooting reload in progress (RR/Spear/EAT/etc.)
//   fire-heavy      — assignment fired through a rocket-class support stratagem
//   reload-light    — primary/secondary mid-reload
//   fire-primary    — primary in this tick's assignments
//   fire-secondary  — secondary in this tick's assignments
//   fire-stratagem  — non-rocket support stratagem in this tick's assignments
//   throw-grenade   — grenade slot fired
//   idle            — nothing happening
export function deriveDiverAction(snapshot, memory = {}) {
  const t = snapshot?.t ?? 0;
  const weapons = snapshot?.weapons ?? [];
  const stratagems = snapshot?.stratagems ?? [];
  const assignments = snapshot?.assignments ?? [];

  const prevActive = memory.activeCallIns instanceof Set ? memory.activeCallIns : new Set();
  const nowActive = new Set();
  let throwUntilT = memory.throwUntilT ?? 0;
  let throwingDefId = memory.throwingDefId ?? null;
  for (const s of stratagems) {
    if (s.callInPct == null) continue;
    nowActive.add(s.id);
    if (!prevActive.has(s.id)) {
      throwUntilT = t + THROW_HOLD_MS;
      throwingDefId = s.defId;
    }
  }
  const newMemory = { activeCallIns: nowActive, throwUntilT, throwingDefId };

  if (t < throwUntilT && throwingDefId) {
    const t01 = 1 - Math.max(0, (throwUntilT - t) / THROW_HOLD_MS);
    return { action: { kind: "throw", defId: throwingDefId, t01 }, memory: newMemory };
  }

  const stratById = new Map(stratagems.map((s) => [s.id, s]));
  const weaponById = new Map(weapons.map((w) => [w.id, w]));

  const rootedReload = weapons.find((w) => w.rootsPlayer && (w.reloadingPct ?? 1) < 1);
  if (rootedReload) {
    return {
      action: {
        kind: "reload-heavy",
        defId: rootedReload.defId,
        t01: rootedReload.reloadingPct ?? 0,
        secsRemaining: Math.max(0, (1 - (rootedReload.reloadingPct ?? 0)) * (rootedReload.reloadSecs ?? 2)),
      },
      memory: newMemory,
    };
  }

  let firingHeavy = null;
  let firingStratLight = null;
  let firingPrimary = false;
  let firingSecondary = false;
  let firingGrenade = false;
  for (const a of assignments) {
    const id = a.weaponId;
    if (id === "primary") firingPrimary = true;
    else if (id === "secondary") firingSecondary = true;
    else if (id === "grenade") firingGrenade = true;
    else if (typeof id === "string" && id.startsWith("strat-")) {
      const s = stratById.get(id);
      if (!s) continue;
      // Only treat support-type stratagems as "fired from the hip" — orbital,
      // eagle, sentry etc. are throw-only and would have been caught by the
      // throw branch above.
      if (s.type !== "support") continue;
      if (weaponFiresRocket(s.defId)) firingHeavy = s;
      else firingStratLight = s;
    }
  }

  if (firingHeavy) {
    return { action: { kind: "fire-heavy", defId: firingHeavy.defId, family: weaponFamily(firingHeavy.defId, firingHeavy.id) }, memory: newMemory };
  }

  // Light reload only matters when a heavy isn't drowning it out visually.
  const lightReload = weapons.find((w) => !w.rootsPlayer && (w.reloadingPct ?? 1) < 1);
  if (lightReload) {
    return {
      action: {
        kind: "reload-light",
        defId: lightReload.defId,
        slot: lightReload.id,
        t01: lightReload.reloadingPct ?? 0,
        secsRemaining: Math.max(0, (1 - (lightReload.reloadingPct ?? 0)) * (lightReload.reloadSecs ?? 2)),
      },
      memory: newMemory,
    };
  }

  if (firingPrimary) {
    const w = weaponById.get("primary");
    return { action: { kind: "fire-primary", defId: w?.defId, family: weaponFamily(w?.defId, "primary") }, memory: newMemory };
  }
  if (firingSecondary) {
    const w = weaponById.get("secondary");
    return { action: { kind: "fire-secondary", defId: w?.defId, family: weaponFamily(w?.defId, "secondary") }, memory: newMemory };
  }
  if (firingStratLight) {
    return { action: { kind: "fire-stratagem", defId: firingStratLight.defId, family: weaponFamily(firingStratLight.defId, firingStratLight.id) }, memory: newMemory };
  }
  if (firingGrenade) {
    const w = weaponById.get("grenade");
    return { action: { kind: "throw-grenade", defId: w?.defId }, memory: newMemory };
  }
  return { action: { kind: "idle" }, memory: newMemory };
}

export function mountDiverProfile(canvas, controller) {
  if (!canvas || canvas.tagName !== "CANVAS") {
    throw new Error("mountDiverProfile: canvas required");
  }
  if (!controller || typeof controller.subscribe !== "function") {
    throw new Error("mountDiverProfile: controller required");
  }

  const ctx = canvas.getContext("2d");
  let snapshot = controller.getSnapshot ? controller.getSnapshot() : null;
  let memory = { activeCallIns: new Set(), throwUntilT: 0, throwingDefId: null };
  let dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  let cssW = W;
  let cssH = H;
  let rafId = null;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, Math.round(rect.width || W));
    cssH = Math.max(1, Math.round(rect.height || H));
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

  const unsubscribe = controller.subscribe((snap) => { snapshot = snap; });

  function frame() {
    rafId = (typeof requestAnimationFrame !== "undefined")
      ? requestAnimationFrame(frame)
      : null;
    draw();
  }

  function draw() {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Internal coords are W×H; scale to fit cssW/cssH so external CSS sizing
    // doesn't squish the silhouette.
    const sx = cssW / W;
    const sy = cssH / H;
    ctx.scale(sx, sy);

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

    // Title strip
    ctx.fillStyle = TXT_DIM;
    ctx.font = "600 9px ui-monospace, SF Mono, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("DIVER PROFILE", 8, 6);

    let action;
    if (snapshot) {
      const r = deriveDiverAction(snapshot, memory);
      action = r.action;
      memory = r.memory;
    } else {
      action = { kind: "idle" };
    }

    // Ground line
    ctx.strokeStyle = "rgba(120, 120, 130, 0.35)";
    ctx.beginPath();
    ctx.moveTo(10, GROUND_Y + 0.5);
    ctx.lineTo(W - 10, GROUND_Y + 0.5);
    ctx.stroke();

    drawPose(ctx, action, snapshot?.t ?? 0);
    drawActionLabel(ctx, action);

    ctx.restore();
  }

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
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    unsubscribe();
    snapshot = null;
  };
}

// ---- pose rendering ----------------------------------------------------

function drawActionLabel(ctx, action) {
  const map = {
    "idle":           ["IDLE", null],
    "fire-primary":   ["FIRING", "primary"],
    "fire-secondary": ["FIRING", "secondary"],
    "fire-heavy":     ["FIRING", action.defId],
    "fire-stratagem": ["FIRING", action.defId],
    "reload-light":   ["RELOAD", action.defId],
    "reload-heavy":   ["ROOTED RELOAD", action.defId],
    "throw":          ["THROWING", action.defId],
    "throw-grenade":  ["GRENADE", action.defId],
  };
  const [verb, sub] = map[action.kind] ?? ["IDLE", null];
  ctx.fillStyle = action.kind === "reload-heavy"
    ? "#ff7a7a"
    : action.kind.startsWith("fire") ? FX : TXT;
  ctx.font = "700 11px ui-monospace, SF Mono, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(verb, W / 2, H - 18);

  if (sub) {
    ctx.fillStyle = TXT_DIM;
    ctx.font = "9px ui-monospace, SF Mono, Menlo, monospace";
    ctx.fillText(shortWeaponName(sub).toLowerCase(), W / 2, H - 6);
  }

  // Reload countdown surfaces directly below the action so the user reads
  // "ROOTED RELOAD recoilless 1.4s" as a single block.
  if (action.kind === "reload-light" || action.kind === "reload-heavy") {
    ctx.fillStyle = action.kind === "reload-heavy" ? "#ff7a7a" : TXT_DIM;
    ctx.font = "10px ui-monospace, SF Mono, Menlo, monospace";
    ctx.fillText(`${action.secsRemaining.toFixed(1)}s`, W - 22, H - 18);
  }
}

function drawPose(ctx, action, nowMs) {
  const kneel = action.kind === "fire-heavy" || action.kind === "reload-heavy";
  drawBody(ctx, kneel, nowMs);
  switch (action.kind) {
    case "idle":            return drawIdleArms(ctx, nowMs);
    case "fire-primary":    return drawPrimaryFire(ctx, action, nowMs);
    case "fire-secondary":  return drawSecondaryFire(ctx, action, nowMs);
    case "fire-stratagem":  return drawPrimaryFire(ctx, { ...action, longBarrel: true }, nowMs);
    case "fire-heavy":      return drawHeavyFire(ctx, action, nowMs);
    case "reload-light":    return drawLightReload(ctx, action);
    case "reload-heavy":    return drawHeavyReload(ctx, action);
    case "throw":           return drawThrow(ctx, action);
    case "throw-grenade":   return drawGrenadeToss(ctx, action);
  }
}

// Common body (head, torso, legs). Idle vs kneel changes the legs only.
function drawBody(ctx, kneel, nowMs) {
  const bob = Math.sin(nowMs * 0.005) * 0.6;
  const torsoTop = (kneel ? 96 : 78) + bob;
  const hipY = (kneel ? 142 : 124) + bob;

  // legs
  ctx.fillStyle = SKIN_DARK;
  if (kneel) {
    // back leg knee on ground, front leg planted
    // back leg (left, behind): hip→knee on ground
    ctx.beginPath();
    ctx.moveTo(FOOT_X - 2, hipY);
    ctx.lineTo(FOOT_X + 6, hipY);
    ctx.lineTo(FOOT_X + 14, GROUND_Y);
    ctx.lineTo(FOOT_X - 12, GROUND_Y);
    ctx.closePath();
    ctx.fill();
    // boot on the ground (back leg sole)
    ctx.fillStyle = "#1c1d20";
    ctx.fillRect(FOOT_X - 16, GROUND_Y - 3, 22, 4);
    // front leg (right, kneeling forward), foot planted
    ctx.fillStyle = SKIN;
    ctx.beginPath();
    ctx.moveTo(FOOT_X + 6, hipY);
    ctx.lineTo(FOOT_X + 14, hipY);
    ctx.lineTo(FOOT_X + 32, GROUND_Y - 18);
    ctx.lineTo(FOOT_X + 24, GROUND_Y - 22);
    ctx.closePath();
    ctx.fill();
    // shin going down to boot
    ctx.beginPath();
    ctx.moveTo(FOOT_X + 24, GROUND_Y - 22);
    ctx.lineTo(FOOT_X + 32, GROUND_Y - 18);
    ctx.lineTo(FOOT_X + 30, GROUND_Y);
    ctx.lineTo(FOOT_X + 22, GROUND_Y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#1c1d20";
    ctx.fillRect(FOOT_X + 18, GROUND_Y - 3, 16, 4);
  } else {
    // standing — slight stance, back foot trailing
    ctx.fillStyle = SKIN_DARK;
    // back leg
    ctx.fillRect(FOOT_X - 8, hipY, 8, GROUND_Y - hipY);
    // front leg (forward foot)
    ctx.fillStyle = SKIN;
    ctx.fillRect(FOOT_X + 4, hipY, 8, GROUND_Y - hipY);
    // boots
    ctx.fillStyle = "#1c1d20";
    ctx.fillRect(FOOT_X - 10, GROUND_Y - 3, 14, 4);
    ctx.fillRect(FOOT_X + 2, GROUND_Y - 3, 14, 4);
  }

  // backpack — small block trailing the torso (left = behind, since diver faces +x)
  ctx.fillStyle = "#36383d";
  ctx.fillRect(FOOT_X - 14, torsoTop + 4, 8, 24);
  ctx.fillStyle = "#22232a";
  ctx.fillRect(FOOT_X - 14, torsoTop + 4, 8, 4); // pack lid

  // cape — Super Earth red, hangs from the shoulders behind the backpack.
  // A small idle sway uses the same bob phase so the body and cape move
  // together. Drawn as a polygon (shoulder line → trailing edge ending below
  // the hip) plus a darker fold on the leading edge for depth.
  const sway = Math.sin(nowMs * 0.003) * 2;
  const capeTopL = FOOT_X - 9;
  const capeTopR = FOOT_X + 4;
  const capeBotL = FOOT_X - 22 + sway;
  const capeBotR = FOOT_X - 4 + sway * 0.5;
  const capeBotY = hipY + 18;
  ctx.fillStyle = CAPE_DARK;
  ctx.beginPath();
  ctx.moveTo(capeTopL, torsoTop - 2);
  ctx.lineTo(capeTopR, torsoTop - 2);
  ctx.lineTo(capeBotR, capeBotY);
  ctx.lineTo(capeBotL, capeBotY + 2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = CAPE;
  ctx.beginPath();
  ctx.moveTo(capeTopL, torsoTop - 2);
  ctx.lineTo(capeTopR - 4, torsoTop - 2);
  ctx.lineTo(capeBotR - 4, capeBotY - 1);
  ctx.lineTo(capeBotL + 2, capeBotY + 1);
  ctx.closePath();
  ctx.fill();
  // tattered hem — three small triangle notches along the bottom edge.
  ctx.fillStyle = BG;
  for (let i = 0; i < 3; i++) {
    const f = (i + 1) / 4;
    const nx = capeBotL + (capeBotR - capeBotL) * f;
    const ny = capeBotY + 1;
    ctx.beginPath();
    ctx.moveTo(nx - 2, ny);
    ctx.lineTo(nx + 2, ny);
    ctx.lineTo(nx, ny + 4);
    ctx.closePath();
    ctx.fill();
  }

  // torso — trapezoid, broader at shoulder
  ctx.fillStyle = SKIN;
  ctx.beginPath();
  ctx.moveTo(FOOT_X - 8, torsoTop);   // left shoulder
  ctx.lineTo(FOOT_X + 12, torsoTop);  // right shoulder
  ctx.lineTo(FOOT_X + 8, hipY);
  ctx.lineTo(FOOT_X - 4, hipY);
  ctx.closePath();
  ctx.fill();
  // chest plate seam
  ctx.strokeStyle = SKIN_DARK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(FOOT_X + 2, torsoTop + 4);
  ctx.lineTo(FOOT_X + 4, hipY - 4);
  ctx.stroke();

  // neck
  ctx.fillStyle = SKIN_DARK;
  ctx.fillRect(FOOT_X + 1, torsoTop - 5, 8, 6);

  // head
  const headCx = FOOT_X + 5;
  const headCy = torsoTop - 14;
  ctx.fillStyle = SKIN;
  ctx.beginPath();
  ctx.arc(headCx, headCy, 9, 0, Math.PI * 2);
  ctx.fill();
  // Full helmet — domed shell wrapping the whole head with a forward visor
  // slot, a back skirt covering the nape, and a small antenna stub on top.
  // This is the iconic helldiver silhouette, not just a top-half cap.
  ctx.fillStyle = HELMET;
  ctx.beginPath();
  // dome top
  ctx.arc(headCx, headCy - 1, 10.5, Math.PI * 1.05, Math.PI * 0.05);
  // forward jaw guard
  ctx.lineTo(headCx + 10, headCy + 6);
  ctx.lineTo(headCx + 6, headCy + 8);
  // chin notch (visor cutout sits above this)
  ctx.lineTo(headCx + 2, headCy + 7);
  // back skirt — slightly flared down behind the neck
  ctx.lineTo(headCx - 8, headCy + 8);
  ctx.lineTo(headCx - 10, headCy + 4);
  ctx.closePath();
  ctx.fill();
  // helmet rim highlight along the top arc
  ctx.strokeStyle = HELMET_HI;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(headCx, headCy - 1, 10.5, Math.PI * 1.05, Math.PI * 0.05);
  ctx.stroke();
  // visor — yellow slit recessed in the front face
  ctx.fillStyle = VISOR;
  ctx.fillRect(headCx + 1, headCy - 1, 9, 3);
  // visor inner glow line
  ctx.fillStyle = "rgba(255, 240, 180, 0.95)";
  ctx.fillRect(headCx + 1, headCy - 1, 9, 1);
  // antenna stub on the helmet crown
  ctx.fillStyle = HELMET_HI;
  ctx.fillRect(headCx - 3, headCy - 12, 1.5, 4);
  ctx.fillStyle = "#ff5050";
  ctx.fillRect(headCx - 3.5, headCy - 13, 2, 1.5); // red tip
}

function shoulderXY(kneel, nowMs) {
  const bob = Math.sin(nowMs * 0.005) * 0.6;
  const y = (kneel ? 100 : 82) + bob;
  return { x: FOOT_X + 8, y };
}

function drawIdleArms(ctx, nowMs) {
  const sh = shoulderXY(false, nowMs);
  // Slung rifle across the chest, arms low.
  ctx.fillStyle = WEAPON;
  ctx.save();
  ctx.translate(sh.x - 4, sh.y + 14);
  ctx.rotate(-0.35);
  ctx.fillRect(-12, -2, 28, 4);
  ctx.fillStyle = WEAPON_HI;
  ctx.fillRect(-12, -2, 28, 1);
  ctx.restore();
  // hands resting
  ctx.fillStyle = SKIN;
  ctx.fillRect(sh.x - 2, sh.y + 18, 5, 8);
  ctx.fillRect(sh.x - 14, sh.y + 8, 5, 8);
}

function drawPrimaryFire(ctx, action, nowMs) {
  const sh = shoulderXY(false, nowMs);
  const recoil = Math.sin(nowMs * 0.06) * 1.5;
  // Rifle: long horizontal rectangle from shoulder forward.
  const len = action.longBarrel ? 50 : 42;
  const muzzleX = sh.x + len + 4 + recoil;
  const muzzleY = sh.y + 4;
  // stock against shoulder
  ctx.fillStyle = WEAPON;
  ctx.fillRect(sh.x - 4 + recoil, sh.y, len, 6);
  ctx.fillStyle = WEAPON_HI;
  ctx.fillRect(sh.x - 4 + recoil, sh.y, len, 1);
  // sight
  ctx.fillRect(sh.x + 6 + recoil, sh.y - 3, 6, 3);
  // magazine drop
  ctx.fillStyle = "#3a3c40";
  ctx.fillRect(sh.x + 14 + recoil, sh.y + 6, 6, 8);
  // arms — front arm forward at the foregrip, back arm bent at trigger
  ctx.fillStyle = SKIN;
  ctx.fillRect(sh.x + 22 + recoil, sh.y + 4, 6, 10);  // front grip arm
  ctx.fillRect(sh.x - 2 + recoil, sh.y + 2, 8, 8);    // trigger arm shoulder→elbow
  ctx.fillRect(sh.x + 4 + recoil, sh.y + 6, 6, 6);    // forearm to grip
  // muzzle flash
  drawMuzzleFlash(ctx, muzzleX, muzzleY, action.family ?? "bullet");
}

function drawSecondaryFire(ctx, action, nowMs) {
  const sh = shoulderXY(false, nowMs);
  const recoil = Math.sin(nowMs * 0.08) * 1;
  // Sidearm: short barrel held one-handed, arm extended forward and slightly raised.
  const grip = { x: sh.x + 18 + recoil, y: sh.y + 2 };
  // arm
  ctx.fillStyle = SKIN;
  ctx.fillRect(sh.x + 2, sh.y + 2, 18, 6);
  // pistol body
  ctx.fillStyle = WEAPON;
  ctx.fillRect(grip.x, grip.y - 4, 14, 6);
  ctx.fillRect(grip.x + 1, grip.y + 2, 5, 6); // grip
  ctx.fillStyle = WEAPON_HI;
  ctx.fillRect(grip.x, grip.y - 4, 14, 1);
  // off hand at chest
  ctx.fillStyle = SKIN;
  ctx.fillRect(sh.x - 6, sh.y + 12, 6, 6);
  // muzzle flash
  drawMuzzleFlash(ctx, grip.x + 14, grip.y - 1, action.family ?? "bullet");
}

function drawHeavyFire(ctx, action, nowMs) {
  const sh = shoulderXY(true, nowMs);
  // Recoilless / Quasar / Spear: long tube on shoulder, both hands forward.
  // back-blast smoke trails behind the diver.
  const tubeY = sh.y - 2;
  const tubeStart = sh.x - 22;
  const tubeEnd = sh.x + 60;
  // back-blast cloud (behind diver)
  const cloudPhase = (nowMs % 600) / 600;
  for (let i = 0; i < 5; i++) {
    const a = i / 5;
    const cx = tubeStart - 4 - i * 5 - cloudPhase * 6;
    const cy = tubeY + 2 + Math.sin((cloudPhase + i) * 6) * 2;
    const r = 4 + i * 1.4;
    ctx.fillStyle = `rgba(200, 200, 200, ${0.55 * (1 - a)})`;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // tube
  ctx.fillStyle = WEAPON;
  ctx.fillRect(tubeStart, tubeY, tubeEnd - tubeStart, 8);
  ctx.fillStyle = WEAPON_HI;
  ctx.fillRect(tubeStart, tubeY, tubeEnd - tubeStart, 2);
  // optic on tube
  ctx.fillStyle = "#1a1b1f";
  ctx.fillRect(sh.x + 4, tubeY - 4, 8, 4);
  // arms wrapping the tube — forward grip, back grip
  ctx.fillStyle = SKIN;
  ctx.fillRect(sh.x + 24, tubeY + 4, 6, 10); // front grip arm
  ctx.fillRect(sh.x - 4, tubeY + 4, 6, 10);  // back grip arm
  // Muzzle flash at the front of the tube.
  drawMuzzleFlash(ctx, tubeEnd + 2, tubeY + 4, action.family ?? "explosive");
}

function drawHeavyReload(ctx, action) {
  const sh = shoulderXY(true, 0);
  // Tube held forward and slightly down, breech end at shoulder. Diver is
  // sliding a fat shell into the open back of the tube — the shell's
  // position lerps from "outside" → "fully seated" as t01 climbs.
  const t = Math.max(0, Math.min(1, action.t01 ?? 0));
  const tubeY = sh.y + 2;
  const tubeStart = sh.x - 16;
  const tubeEnd = sh.x + 50;
  ctx.fillStyle = WEAPON;
  ctx.fillRect(tubeStart, tubeY, tubeEnd - tubeStart, 8);
  ctx.fillStyle = WEAPON_HI;
  ctx.fillRect(tubeStart, tubeY, tubeEnd - tubeStart, 2);
  // shell — starts near hip, slides into breech. red warhead, brass case.
  const shellMaxX = tubeStart + 6;     // nearly fully inserted
  const shellMinX = tubeStart - 22;    // pulled back, ready to seat
  const shellX = shellMinX + (shellMaxX - shellMinX) * t;
  ctx.fillStyle = "#9a6a2c"; // brass case
  ctx.fillRect(shellX, tubeY + 1, 20, 6);
  ctx.fillStyle = "#c13a3a"; // red warhead
  ctx.beginPath();
  ctx.moveTo(shellX + 20, tubeY + 1);
  ctx.lineTo(shellX + 26, tubeY + 4);
  ctx.lineTo(shellX + 20, tubeY + 7);
  ctx.closePath();
  ctx.fill();
  // arms — one hand on tube (front), other hand on shell (back, follows shell)
  ctx.fillStyle = SKIN;
  ctx.fillRect(sh.x + 18, tubeY + 6, 6, 10);    // front hand on tube
  ctx.fillRect(shellX + 4, tubeY + 8, 6, 10);   // back hand on shell, slides with it
  // forearm connecting back shoulder to shell hand
  const armAngle = Math.atan2((tubeY + 8) - sh.y, (shellX + 4) - sh.x);
  ctx.save();
  ctx.translate(sh.x, sh.y);
  ctx.rotate(armAngle);
  const armLen = Math.hypot(shellX + 4 - sh.x, (tubeY + 8) - sh.y);
  ctx.fillRect(0, -3, armLen, 6);
  ctx.restore();
  // progress bar under the tube — explicit since the shell-slide is subtle.
  drawReloadBar(ctx, tubeStart, tubeY + 14, tubeEnd - tubeStart, t, true);
}

function drawLightReload(ctx, action) {
  const sh = shoulderXY(false, 0);
  const t = Math.max(0, Math.min(1, action.t01 ?? 0));
  // Rifle tilted muzzle-down, mag pulled out, fresh mag rising into magwell.
  const angle = -0.35;
  ctx.save();
  ctx.translate(sh.x + 4, sh.y + 12);
  ctx.rotate(angle);
  ctx.fillStyle = WEAPON;
  ctx.fillRect(-4, -3, 38, 6);
  ctx.fillStyle = WEAPON_HI;
  ctx.fillRect(-4, -3, 38, 1);
  // empty magwell
  ctx.fillStyle = "#2a2c30";
  ctx.fillRect(8, 3, 6, 4);
  ctx.restore();
  // hands: top hand near barrel (steady), bottom hand carries fresh mag up
  ctx.fillStyle = SKIN;
  // top steady hand
  ctx.fillRect(sh.x + 4, sh.y + 4, 6, 8);
  // mag travel — starts at belt (low, near hip), ends seated in magwell
  const startMagX = sh.x - 4, startMagY = sh.y + 28;
  // approximate magwell screen-space position after the rotation above
  const endMagX = sh.x + 14, endMagY = sh.y + 22;
  const magX = startMagX + (endMagX - startMagX) * t;
  const magY = startMagY + (endMagY - startMagY) * t;
  ctx.fillStyle = "#3a3c40";
  ctx.fillRect(magX, magY, 7, 10);
  ctx.fillStyle = "#2a2c30";
  ctx.fillRect(magX + 1, magY, 5, 2);
  ctx.fillStyle = SKIN;
  ctx.fillRect(magX - 2, magY + 8, 6, 6); // hand wrapping the mag
  // progress bar under feet
  drawReloadBar(ctx, FOOT_X - 20, GROUND_Y + 6, 60, t, false);
}

function drawThrow(ctx, action) {
  const sh = shoulderXY(false, 0);
  // Arm cocked back over the head holding a glowing stratagem ball; t01 grows
  // as the throw winds forward → release.
  const t = Math.max(0, Math.min(1, action.t01 ?? 0));
  // Arm rotates from -135° (back) to -30° (forward release).
  const angle = (-Math.PI * 0.75) + t * Math.PI * 0.55;
  const armLen = 18;
  const elbow = { x: sh.x + Math.cos(angle) * armLen * 0.6, y: sh.y + Math.sin(angle) * armLen * 0.6 - 4 };
  const hand = { x: sh.x + Math.cos(angle) * armLen, y: sh.y + Math.sin(angle) * armLen - 4 };
  ctx.strokeStyle = SKIN;
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(sh.x, sh.y);
  ctx.lineTo(elbow.x, elbow.y);
  ctx.lineTo(hand.x, hand.y);
  ctx.stroke();
  ctx.lineCap = "butt";
  // off arm bracing forward
  ctx.fillStyle = SKIN;
  ctx.fillRect(sh.x - 2, sh.y + 4, 18, 6);
  // stratagem ball
  ctx.fillStyle = STRAT_BALL;
  ctx.beginPath();
  ctx.arc(hand.x, hand.y, 4, 0, Math.PI * 2);
  ctx.fill();
  // glow
  ctx.strokeStyle = "rgba(58, 255, 200, 0.45)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(hand.x, hand.y, 7, 0, Math.PI * 2);
  ctx.stroke();
}

function drawGrenadeToss(ctx, action) {
  const sh = shoulderXY(false, 0);
  // Underhand bowling-style toss — arm angled forward and slightly down.
  ctx.fillStyle = SKIN;
  ctx.fillRect(sh.x, sh.y + 4, 22, 6);
  ctx.fillRect(sh.x - 4, sh.y + 12, 8, 6);
  // grenade
  ctx.fillStyle = "#3a3c40";
  ctx.beginPath();
  ctx.arc(sh.x + 26, sh.y + 8, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1a1b1f";
  ctx.fillRect(sh.x + 25, sh.y + 3, 2, 3); // pin handle
}

function drawMuzzleFlash(ctx, x, y, family) {
  const colors = {
    bullet:    ["#fff2c4", "#ffb44a"],
    laser:     ["#ffe0e0", "#ff5050"],
    arc:       ["#e0f0ff", "#a0c8ff"],
    plasma:    ["#d8fff2", "#3fffd2"],
    flame:     ["#ffe1a0", "#ff8030"],
    explosive: ["#fff0c0", "#ffa040"],
  };
  const [hi, lo] = colors[family] ?? colors.bullet;
  // jagged star — 3 points forward
  ctx.fillStyle = lo;
  ctx.beginPath();
  ctx.moveTo(x - 2, y - 6);
  ctx.lineTo(x + 12, y);
  ctx.lineTo(x - 2, y + 6);
  ctx.lineTo(x + 4, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = hi;
  ctx.beginPath();
  ctx.moveTo(x, y - 3);
  ctx.lineTo(x + 7, y);
  ctx.lineTo(x, y + 3);
  ctx.lineTo(x + 3, y);
  ctx.closePath();
  ctx.fill();
}

function drawReloadBar(ctx, x, y, w, t01, rooted) {
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(x - 1, y - 1, w + 2, 5);
  ctx.fillStyle = "rgba(40, 40, 44, 0.9)";
  ctx.fillRect(x, y, w, 3);
  ctx.fillStyle = rooted ? "#ff3a3a" : "#d97a2c";
  ctx.fillRect(x, y, w * t01, 3);
}
