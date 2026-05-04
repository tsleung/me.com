// L3 — Reusable simulation lane component.
//
// A SimLane owns:
//   - one L1 engine (cfg + data → state machine)
//   - a small battlefield canvas (top-down map, same convention as the
//     main battlefield: camera follows the diver, range rings, tracers,
//     enemies, effects)
//   - score bars (cleared / closest), kills / alive / breach chips
//   - a verdict chip (push / hold / run, derived from the snapshot)
//   - a diver-profile canvas (side-view silhouette, one per lane)
//   - an analytics cluster (heatmap, score chart, loadout, waves) when
//     `layout: "full"` is requested
//
// It does NOT own its own clock — the caller drives `.tick()` from
// whatever time source it wants (a setTimeout loop in compare mode,
// or a controller subscription in single mode).
//
// Each lane is fully self-contained; compare mode just creates N of them
// and wires up a shared start/stop loop. No cross-lane state, no shared
// mutable records. Adding a fourth lane is one entry in an array.

import { fmtSeconds } from "./analytics-helpers.js";
import { paintDiverProfile, newDiverProfileMemory } from "./render-diver-profile.js";
import { mountLaneAnalytics } from "./render-analytics.js";

const MAX_RANGE_M = 80;
const HALF_CONE_RAD = (60 * Math.PI) / 180;

const FACTION_COLORS = {
  terminids: "#d97a2c",
  automatons: "#c0413f",
  illuminate: "#6db5ff",
};

/**
 * Mount a simulation lane.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.parent       Element to append the lane into.
 * @param {object}      opts.cfg          Engine config (scenario, loadout, seed).
 * @param {object}      opts.data         Data bundle.
 * @param {Function}    opts.engineFactory (cfg, data) → engine.
 * @param {string}      opts.label        Header text (e.g. "terminids").
 * @param {string}      opts.variant      Arbitrary lane id used as a data attr.
 * @param {string}      [opts.dim="faction"] Which dataset key holds variant.
 * @param {"compact"|"full"} [opts.layout="compact"] Whether to mount analytics.
 * @param {object}      [opts.controller=null] Global controller — only used
 *   to dispatch policy edits from the embedded analytics. Snapshots and
 *   ticking come from this lane's own engine, not the controller.
 * @returns {object} lane API
 */
export function mountSimLane({
  parent,
  cfg,
  data,
  engineFactory,
  label,
  variant,
  dim = "faction",
  layout = "compact",
  controller = null,
}) {
  const el = buildLaneEl(parent, label, variant, dim, layout);

  const engine = engineFactory(cfg, data);
  const lane = {
    el,
    cfg,
    engine,
    state: engine.initialState,
    diverMemory: newDiverProfileMemory(),
    analytics: null,
  };

  if (layout === "full") {
    const analyticsHost = el.querySelector(".sl-analytics");
    if (analyticsHost) {
      // Pass the global controller through so the embedded policy grid can
      // dispatch policy edits — policy is shared across all lanes, so an
      // edit made from any lane's grid takes effect everywhere on the next
      // tick.
      lane.analytics = mountLaneAnalytics(analyticsHost, () => lane.cfg, controller);
    }
  }

  // Initial paint (engine view of the initial state — empty enemies, t=0).
  paintLane(lane);

  function tick() {
    lane.state = lane.engine.tick(lane.state);
    paintLane(lane);
  }

  // Build a fresh engine for the current cfg, replacing all per-run state.
  // Used by compare mode's `reset` action so the user can re-run the same
  // loadout against the same scenario without reloading the page.
  function reset(nextCfg = lane.cfg) {
    lane.cfg = nextCfg;
    lane.engine = engineFactory(nextCfg, data);
    lane.state = lane.engine.initialState;
    lane.diverMemory = newDiverProfileMemory();
    paintLane(lane);
  }

  function snapshot() {
    return lane.engine.view(lane.state);
  }

  function unmount() {
    if (lane.analytics) lane.analytics.unmount?.();
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  return { tick, reset, snapshot, unmount, el };
}

// ---- DOM scaffolding ---------------------------------------------------

function buildLaneEl(parent, label, variant, dim, layout) {
  const wrap = document.createElement("div");
  wrap.className = "sim-lane";
  wrap.dataset[dim] = variant;
  wrap.dataset.layout = layout;
  wrap.innerHTML = `
    <div class="sl-header">
      <div class="sl-name">${label}</div>
      <div class="sl-meta"><span class="sl-time">0.0s</span></div>
    </div>
    <div class="sl-canvas-wrap">
      <canvas class="sl-canvas" width="300" height="180"></canvas>
      <canvas class="sl-diver" width="120" height="146"></canvas>
    </div>
    <div class="sl-row">
      <div class="sl-stat">
        <div class="sl-stat-label">cleared</div>
        <div class="sl-bar"><div class="sl-bar-fill sl-adv"></div></div>
        <div class="sl-stat-val sl-adv-val">0%</div>
      </div>
      <div class="sl-stat">
        <div class="sl-stat-label">closest</div>
        <div class="sl-bar"><div class="sl-bar-fill sl-surv"></div></div>
        <div class="sl-stat-val sl-surv-val">—</div>
      </div>
    </div>
    <div class="sl-row sl-row-meta">
      <span class="sl-meta-tag">kills <span class="sl-kills">0</span></span>
      <span class="sl-meta-tag">alive <span class="sl-alive">0</span></span>
      <span class="sl-meta-tag sl-breach-tag">breach <span class="sl-breach">—</span></span>
    </div>
    <div class="sl-verdict sl-verdict-tbd">— assess in 10s —</div>
    ${layout === "full" ? `<div class="sl-analytics"></div>` : ""}
  `;
  parent.appendChild(wrap);
  return wrap;
}

// ---- per-frame painters (lane-scoped, no module state) ----------------

function paintLane(lane) {
  const snap = lane.engine.view(lane.state);
  const el = lane.el;
  const adv = snap.scores?.advance ?? {};
  const surv = snap.scores?.survival ?? {};
  const aliveCount = (snap.enemies ?? []).filter((e) => e.alive).length;

  paintBattlefieldCanvas(el.querySelector(".sl-canvas"), snap);
  paintDiverCanvas(el.querySelector(".sl-diver"), snap, lane);

  el.querySelector(".sl-time").textContent = fmtSeconds(snap.t || 0);

  const advPct = Math.round((adv.fractionCleared ?? 0) * 100);
  setPctBar(el.querySelector(".sl-adv"), advPct);
  el.querySelector(".sl-adv-val").textContent = `${advPct}%`;

  const closest = surv.closestEnemyM;
  const survPct = closest === Infinity || closest == null
    ? 100
    : Math.round(Math.min(100, (closest / MAX_RANGE_M) * 100));
  setPctBar(el.querySelector(".sl-surv"), survPct);
  el.querySelector(".sl-surv-val").textContent =
    closest === Infinity || closest == null ? "—" : `${closest.toFixed(1)}m`;

  el.querySelector(".sl-kills").textContent = String(adv.kills ?? 0);
  el.querySelector(".sl-alive").textContent = String(aliveCount);

  const breachEl = el.querySelector(".sl-breach");
  const breachTag = el.querySelector(".sl-breach-tag");
  if (surv.breachedAt != null) {
    breachEl.textContent = fmtSeconds(surv.breachedAt);
    breachTag.classList.add("sl-breach-on");
  } else {
    breachEl.textContent = "—";
    breachTag.classList.remove("sl-breach-on");
  }

  const verdictEl = el.querySelector(".sl-verdict");
  const verdict = computeVerdict(snap, adv, surv, aliveCount);
  verdictEl.textContent = verdict.text;
  verdictEl.className = `sl-verdict sl-verdict-${verdict.kind}`;

  if (lane.analytics) lane.analytics.render(snap);
}

function setPctBar(bar, pct) {
  if (!bar) return;
  bar.style.width = `${pct}%`;
}

// Diver silhouette canvas — DPR-resize on first paint then thread the lane's
// own memory carrier through so throw stickiness and call-in tracking are
// independent across lanes.
function paintDiverCanvas(canvas, snap, lane) {
  if (!canvas) return;
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  const wantW = Math.round(cssW * dpr);
  const wantH = Math.round(cssH * dpr);
  if (canvas.width !== wantW || canvas.height !== wantH) {
    canvas.width = wantW;
    canvas.height = wantH;
  }
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  lane.diverMemory = paintDiverProfile(ctx, snap, lane.diverMemory, { width: cssW, height: cssH });
  ctx.restore();
}

function paintBattlefieldCanvas(canvas, snap) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const player = snap.player || { x: 0, y: 0 };
  const camX = player.x ?? 0;
  const camY = player.y ?? 0;
  const cx = W / 2;
  const cy = H - 18;
  const ppm = (H - 24) / MAX_RANGE_M;
  const wx = (x) => cx + (x - camX) * ppm;
  const wy = (y) => cy - (y - camY) * ppm;

  ctx.fillStyle = "#0e0e10";
  ctx.fillRect(0, 0, W, H);

  // Forward arc cone — same 120° as the main battlefield.
  ctx.fillStyle = "rgba(255,58,58,0.05)";
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, MAX_RANGE_M * ppm, -Math.PI / 2 - HALF_CONE_RAD, -Math.PI / 2 + HALF_CONE_RAD);
  ctx.closePath();
  ctx.fill();

  // Range rings every 20m.
  ctx.strokeStyle = "#1f1f23";
  ctx.lineWidth = 0.5;
  for (let r = 20; r <= MAX_RANGE_M; r += 20) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * ppm, 0, Math.PI * 2);
    ctx.stroke();
  }

  paintEffects(ctx, snap, wx, wy, ppm);
  paintEnemies(ctx, snap, wx, wy);
  paintProjectiles(ctx, snap, wx, wy, ppm);
  paintTracersAndTells(ctx, snap, wx, wy, player);
  paintFxFlashes(ctx, snap, wx, wy);

  // Player triangle, always at center-bottom (camera follows player).
  ctx.fillStyle = "#f2f2ee";
  ctx.beginPath();
  ctx.moveTo(cx, cy - 5);
  ctx.lineTo(cx - 4, cy + 4);
  ctx.lineTo(cx + 4, cy + 4);
  ctx.closePath();
  ctx.fill();
}

function paintEffects(ctx, snap, wx, wy, ppm) {
  for (const eff of (snap.effects ?? [])) {
    const sx = wx(eff.x ?? 0);
    const sy = wy(eff.y ?? 0);
    const r = (eff.radiusM ?? 1) * ppm;
    if (eff.kind === "dot" || eff.kind === "gas") {
      const sub = eff.subKind || "gas";
      const inner = sub === "fire" ? "rgba(255,130,40,0.45)"
        : sub === "laser" ? "rgba(255,100,100,0.45)"
        : "rgba(120,200,80,0.4)";
      const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
      grad.addColorStop(0, inner);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (eff.kind === "sentry") {
      ctx.fillStyle = "rgba(154,166,255,0.85)";
      ctx.beginPath();
      ctx.moveTo(sx, sy - 4);
      ctx.lineTo(sx - 3, sy + 3);
      ctx.lineTo(sx + 3, sy + 3);
      ctx.closePath();
      ctx.fill();
    } else if (eff.kind === "callin") {
      ctx.strokeStyle = "rgba(58,255,200,0.8)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(3, r), 0, Math.PI * 2);
      ctx.stroke();
    } else if (eff.kind === "mine" || eff.kind === "pickup") {
      ctx.fillStyle = eff.kind === "mine" ? "#ffb13a" : "#ff9050";
      ctx.beginPath();
      ctx.arc(sx, sy, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function paintEnemies(ctx, snap, wx, wy) {
  const fac = snap.scenario?.faction;
  const facColor = FACTION_COLORS[fac] || FACTION_COLORS.terminids;
  for (const e of (snap.enemies ?? [])) {
    if (!e.alive) continue;
    const r = enemyRadius(e.threatTier);
    ctx.fillStyle = facColor;
    ctx.beginPath();
    ctx.arc(wx(e.x), wy(e.y), r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintProjectiles(ctx, snap, wx, wy, ppm) {
  for (const p of (snap.projectiles ?? [])) {
    const sx = wx(p.x);
    const sy = wy(p.y);
    if (p.kind === "aoe") {
      ctx.strokeStyle = "rgba(255,200,80,0.6)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, (p.radiusM ?? 4) * ppm, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const tailX = sx - (p.vx ?? 0) * ppm * 0.05;
      const tailY = sy + (p.vy ?? 0) * ppm * 0.05;
      ctx.strokeStyle = "#fff2c4";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(sx, sy);
      ctx.stroke();
    }
  }
}

function paintTracersAndTells(ctx, snap, wx, wy, player) {
  const enemies = snap.enemies ?? [];
  const enemyById = new Map();
  for (const e of enemies) {
    if (!e.alive) continue;
    enemyById.set(e.id, e);
  }
  const px = wx(player.x ?? 0);
  const py = wy(player.y ?? 0);
  ctx.strokeStyle = "rgba(255,242,196,0.85)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const a of (snap.assignments ?? [])) {
    const t = enemyById.get(a.targetId);
    if (!t) continue;
    ctx.moveTo(px, py);
    ctx.lineTo(wx(t.x), wy(t.y));
  }
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,242,196,0.7)";
  ctx.lineWidth = 0.8;
  for (const a of (snap.assignments ?? [])) {
    const t = enemyById.get(a.targetId);
    if (!t) continue;
    const r = enemyRadius(t.threatTier) + 2;
    ctx.beginPath();
    ctx.arc(wx(t.x), wy(t.y), r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function paintFxFlashes(ctx, snap, wx, wy) {
  for (const f of (snap.fxFlashes ?? [])) {
    const sx = wx(f.x);
    const sy = wy(f.y);
    const r = Math.max(2, (f.r || 2) * 1.5);
    const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 2);
    if (f.kind === "gas") {
      grad.addColorStop(0, "rgba(180,230,90,0.5)");
      grad.addColorStop(1, "rgba(180,230,90,0)");
    } else if (f.kind === "electric") {
      grad.addColorStop(0, "rgba(180,220,255,0.8)");
      grad.addColorStop(1, "rgba(180,220,255,0)");
    } else if (f.kind === "laser") {
      grad.addColorStop(0, "rgba(255,150,150,0.8)");
      grad.addColorStop(1, "rgba(255,150,150,0)");
    } else {
      grad.addColorStop(0, "rgba(255,200,80,0.8)");
      grad.addColorStop(1, "rgba(255,80,30,0)");
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(sx, sy, r * 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function enemyRadius(tier) {
  if (tier === "boss") return 4;
  if (tier === "heavy") return 3;
  if (tier === "medium") return 2;
  return 1.5;
}

// ---- verdict ----------------------------------------------------------

function computeVerdict(snap, adv, surv, aliveCount) {
  const tSec = (snap.t || 0) / 1000;
  if (tSec < 10) return { kind: "tbd", text: `— assess in ${(10 - tSec).toFixed(0)}s —` };
  if (surv.breachedAt != null) return { kind: "run", text: `RUN — breached at ${fmtSeconds(surv.breachedAt)}` };
  const closest = surv.closestEnemyM ?? Infinity;
  if (closest < 8 && aliveCount > 8) return { kind: "run", text: "RUN — swarmed at close range" };
  if (closest < 5) return { kind: "run", text: "RUN — enemies on top of you" };
  const advFrac = adv.fractionCleared ?? 0;
  if (advFrac >= 0.6 && tSec < 30) return { kind: "push", text: "PUSH — clearing fast" };
  if ((adv.killsPerSec ?? 0) >= 1.5 && closest > 15) return { kind: "push", text: "PUSH — sustaining the line" };
  if (advFrac >= 0.85) return { kind: "push", text: "PUSH — wave nearly cleared" };
  return { kind: "hold", text: "HOLD — neither pushing nor losing" };
}

// ---- styles -----------------------------------------------------------

// Singleton style block. The lane component owns its own visual scheme
// (`.sl-*`) so the compare-root and any future single-mode use of SimLane
// don't have to re-declare the cosmetics.
let _stylesInjected = false;
export function injectSimLaneStyles() {
  if (_stylesInjected || typeof document === "undefined") return;
  if (document.getElementById("wta-sim-lane-styles")) { _stylesInjected = true; return; }
  const s = document.createElement("style");
  s.id = "wta-sim-lane-styles";
  s.textContent = `
    .sim-lane { background: var(--panel,#17171a); border:1px solid var(--dim,#2a2a2e); border-radius:2px; padding:10px 12px; display:flex; flex-direction:column; gap:8px; }
    .sl-canvas-wrap { position:relative; width:100%; }
    .sl-canvas { display:block; width:100%; height:auto; background:#0e0e10; border:1px solid #1f1f23; border-radius:2px; }
    /* Diver silhouette — small overlay pinned to the top-right of the lane
       canvas, mirrors the single-mode placement so the visual language is
       consistent. pointer-events:none so map clicks aren't intercepted. */
    .sl-diver {
      position:absolute; top:6px; right:6px;
      width:60px; aspect-ratio:120/146;
      pointer-events:none;
      border-radius:2px;
    }
    @media (min-width: 1280px) {
      .sl-diver { width:72px; }
    }
    .sl-analytics { margin-top:8px; }
    .sl-analytics .ana-stack-lane { gap:8px; }
    .sl-analytics .ana-panel { padding:8px 10px 10px; }
    .sl-header { display:flex; justify-content:space-between; align-items:baseline; }
    .sl-name { font-size:11px; color:var(--ink,#f2f2ee); letter-spacing:0.12em; text-transform:uppercase; font-weight:600; }
    .sl-meta { font-size:10px; color:var(--ink-muted,#8d8d92); font-variant-numeric:tabular-nums; }
    .sl-row { display:flex; flex-direction:column; gap:6px; }
    .sl-stat { display:grid; grid-template-columns:55px 1fr 50px; align-items:center; gap:6px; font-size:10px; }
    .sl-stat-label { color:var(--ink-muted,#8d8d92); letter-spacing:0.06em; text-transform:uppercase; }
    .sl-bar { height:6px; background:var(--dim,#2a2a2e); border-radius:1px; overflow:hidden; }
    .sl-bar-fill { height:100%; transition:width 200ms; }
    .sl-adv { background:var(--accent,#ff3a3a); }
    .sl-surv { background:var(--on,#3ddc84); }
    .sl-stat-val { color:var(--ink,#f2f2ee); font-variant-numeric:tabular-nums; text-align:right; }
    .sl-row-meta { flex-direction:row; gap:8px; flex-wrap:wrap; font-size:10px; color:var(--ink-muted,#8d8d92); }
    .sl-meta-tag { background:var(--panel-2,#121215); padding:2px 6px; border-radius:1px; }
    .sl-breach-on { color:var(--accent,#ff3a3a); border:1px solid var(--accent,#ff3a3a); }
    .sl-verdict { font-size:11px; padding:6px 8px; border-radius:1px; text-align:center; letter-spacing:0.04em; font-weight:600; margin-top:2px; }
    .sl-verdict-tbd  { background:var(--panel-2,#121215); color:var(--ink-muted,#8d8d92); font-weight:400; }
    .sl-verdict-push { background:rgba(61,220,132,0.12); color:var(--on,#3ddc84); border:1px solid var(--on,#3ddc84); }
    .sl-verdict-hold { background:rgba(217,122,44,0.12); color:#d97a2c; border:1px solid #d97a2c; }
    .sl-verdict-run  { background:rgba(255,58,58,0.18); color:var(--accent,#ff3a3a); border:1px solid var(--accent,#ff3a3a); }
  `;
  document.head.appendChild(s);
  _stylesInjected = true;
}
