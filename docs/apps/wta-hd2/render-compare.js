// L3 — side-by-side comparison.
// Runs the same loadout in parallel across multiple lanes and renders
// compact score panels so the user can see how the loadout fares.
//
// Two modes:
//   - "factions": one lane per faction (terminids/automatons/illuminate),
//     all on the same encounter type (default: patrol). Answers
//     "should I push or run vs each faction at this difficulty?"
//   - "encounters": one lane per encounter type (patrol/breach/drop)
//     for a single faction. Answers "how does playstyle shift across
//     spawn shapes?"
//
// Each lane spins up its own L1 engine with a deterministic seed.

import { fmtSeconds } from "./analytics-helpers.js";

const ENCOUNTERS = ["patrol", "breach", "drop"];
const FACTIONS = ["terminids", "automatons", "illuminate"];
const TICK_MS = 100;

export function mountCompare({ rootEl, engineFactory, getCfg, data, getActive, mode = "factions" }) {
  rootEl.classList.add("wta-compare-root");
  injectStyles();
  rootEl.innerHTML = "";

  const variants = mode === "encounters" ? ENCOUNTERS : FACTIONS;
  const dim = mode === "encounters" ? "encounter" : "faction";

  const lanes = variants.map((variant) => {
    const cfg = makeCfg(getCfg(), dim, variant, data);
    const engine = engineFactory(cfg, data);
    const lane = {
      variant,
      engine,
      state: engine.initialState,
      el: makeLaneEl(rootEl, variant, dim),
      lastSnap: null,
    };
    paintLane(lane, engine.view(lane.state));
    return lane;
  });

  let timer = null;
  let running = false;

  function loop() {
    if (!running) return;
    for (const lane of lanes) {
      lane.state = lane.engine.tick(lane.state);
      paintLane(lane, lane.engine.view(lane.state));
    }
    timer = setTimeout(loop, TICK_MS);
  }

  function start() {
    if (running) return;
    running = true;
    loop();
  }

  function stop() {
    running = false;
    if (timer != null) { clearTimeout(timer); timer = null; }
  }

  function reset() {
    stop();
    for (const lane of lanes) {
      const cfg = makeCfg(getCfg(), dim, lane.variant, data);
      lane.engine = engineFactory(cfg, data);
      lane.state = lane.engine.initialState;
      paintLane(lane, lane.engine.view(lane.state));
    }
  }

  const observer = new MutationObserver(() => {
    if (getActive?.()) start(); else stop();
  });
  observer.observe(rootEl, { attributes: true, attributeFilter: ["data-active"] });
  if (getActive?.()) start();

  return {
    start, stop, reset,
    unmount: () => { stop(); observer.disconnect(); rootEl.innerHTML = ""; },
  };
}

function makeCfg(base, dim, variant, data) {
  const next = { ...base };
  if (dim === "encounter") {
    next.scenario = { ...base.scenario, encounter: variant };
  } else {
    // dim === "faction": pick the first valid subfaction for that faction
    const subs = data.factions?.[variant]?.subfactions ?? [{ id: "standard" }];
    next.scenario = { ...base.scenario, faction: variant, subfaction: subs[0].id };
  }
  next.seed = (base.seed ?? 1) * 7919 + variant.length;
  return next;
}

function _legacyMakeCfg(base, encounter) {
  return {
    ...base,
    seed: (base.seed ?? 1) * 7919 + encounter.length, // distinct seed per lane keeps RNG independent
    scenario: { ...base.scenario, encounter },
  };
}

function makeLaneEl(root, variant, dim = "encounter") {
  const wrap = document.createElement("div");
  wrap.className = "compare-lane";
  wrap.dataset[dim] = variant;
  const enc = variant;
  wrap.innerHTML = `
    <div class="cl-header">
      <div class="cl-name">${enc}</div>
      <div class="cl-meta"><span class="cl-time">0.0s</span></div>
    </div>
    <canvas class="cl-canvas" width="300" height="180"></canvas>
    <div class="cl-row">
      <div class="cl-stat">
        <div class="cl-stat-label">cleared</div>
        <div class="cl-bar"><div class="cl-bar-fill cl-adv"></div></div>
        <div class="cl-stat-val cl-adv-val">0%</div>
      </div>
      <div class="cl-stat">
        <div class="cl-stat-label">closest</div>
        <div class="cl-bar"><div class="cl-bar-fill cl-surv"></div></div>
        <div class="cl-stat-val cl-surv-val">—</div>
      </div>
    </div>
    <div class="cl-row cl-row-meta">
      <span class="cl-meta-tag">kills <span class="cl-kills">0</span></span>
      <span class="cl-meta-tag">alive <span class="cl-alive">0</span></span>
      <span class="cl-meta-tag cl-breach-tag">breach <span class="cl-breach">—</span></span>
    </div>
    <div class="cl-verdict cl-verdict-tbd">— assess in 10s —</div>
  `;
  root.appendChild(wrap);
  return wrap;
}

function paintLane(lane, snap) {
  const el = lane.el;
  const adv = snap.scores?.advance ?? {};
  const surv = snap.scores?.survival ?? {};
  const aliveCount = (snap.enemies ?? []).filter((e) => e.alive).length;

  paintLaneCanvas(el.querySelector(".cl-canvas"), snap);

  el.querySelector(".cl-time").textContent = fmtSeconds(snap.t || 0);

  const advPct = Math.round((adv.fractionCleared ?? 0) * 100);
  el.querySelector(".cl-adv").style.width = `${advPct}%`;
  el.querySelector(".cl-adv-val").textContent = `${advPct}%`;

  const closest = surv.closestEnemyM;
  const survPct = closest === Infinity || closest == null
    ? 100
    : Math.round(Math.min(100, (closest / 80) * 100));
  el.querySelector(".cl-surv").style.width = `${survPct}%`;
  el.querySelector(".cl-surv-val").textContent =
    closest === Infinity || closest == null ? "—" : `${closest.toFixed(1)}m`;

  el.querySelector(".cl-kills").textContent = String(adv.kills ?? 0);
  el.querySelector(".cl-alive").textContent = String(aliveCount);

  const breachEl = el.querySelector(".cl-breach");
  const breachTag = el.querySelector(".cl-breach-tag");
  if (surv.breachedAt != null) {
    breachEl.textContent = fmtSeconds(surv.breachedAt);
    breachTag.classList.add("cl-breach-on");
  } else {
    breachEl.textContent = "—";
    breachTag.classList.remove("cl-breach-on");
  }

  // Verdict — "push" or "run" — based on observed sim trajectory.
  // Simple heuristic: after 10s of sim time, look at advance + survival.
  //   - breach already happened       → run, you're being overrun
  //   - closest < 8m and aliveCount > 8 → run, swarmed
  //   - advance >= 0.6 in <30s        → push, clearing fast
  //   - kps >= 1.5 and closest > 15m  → push, sustaining
  //   - else                          → hold, neither side winning
  const verdictEl = el.querySelector(".cl-verdict");
  const verdict = computeVerdict(snap, adv, surv, aliveCount);
  verdictEl.textContent = verdict.text;
  verdictEl.className = `cl-verdict cl-verdict-${verdict.kind}`;
}

function paintLaneCanvas(canvas, snap) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H - 18;
  const maxRangeM = 80;
  const ppm = (H - 24) / maxRangeM;

  // bg
  ctx.fillStyle = "#0e0e10";
  ctx.fillRect(0, 0, W, H);

  // forward arc cone
  ctx.fillStyle = "rgba(255,58,58,0.05)";
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  const halfCone = (60 * Math.PI) / 180;
  ctx.arc(cx, cy, maxRangeM * ppm, -Math.PI / 2 - halfCone, -Math.PI / 2 + halfCone);
  ctx.closePath();
  ctx.fill();

  // range rings
  ctx.strokeStyle = "#1f1f23";
  ctx.lineWidth = 0.5;
  for (let r = 20; r <= maxRangeM; r += 20) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * ppm, 0, Math.PI * 2);
    ctx.stroke();
  }

  // enemies
  const fac = snap.scenario?.faction;
  const facColor = fac === "automatons" ? "#c0413f" : fac === "illuminate" ? "#6db5ff" : "#d97a2c";
  const enemies = snap.enemies ?? [];
  for (const e of enemies) {
    if (!e.alive) continue;
    const sx = cx + e.x * ppm;
    const sy = cy - e.y * ppm;
    const r = e.threatTier === "boss" ? 4 : e.threatTier === "heavy" ? 3 : e.threatTier === "medium" ? 2 : 1.5;
    ctx.fillStyle = facColor;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // fx flashes
  const now = snap.t || 0;
  for (const f of (snap.fxFlashes ?? [])) {
    const sx = cx + f.x * ppm;
    const sy = cy - f.y * ppm;
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

  // player triangle
  ctx.fillStyle = "#f2f2ee";
  ctx.beginPath();
  ctx.moveTo(cx, cy - 5);
  ctx.lineTo(cx - 4, cy + 4);
  ctx.lineTo(cx + 4, cy + 4);
  ctx.closePath();
  ctx.fill();
}

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

function injectStyles() {
  if (document.getElementById("wta-compare-styles")) return;
  const s = document.createElement("style");
  s.id = "wta-compare-styles";
  s.textContent = `
    .wta-compare-root { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 12px; }
    @media (max-width: 900px) { .wta-compare-root { grid-template-columns: 1fr; } }
    .compare-lane { background: var(--panel,#17171a); border:1px solid var(--dim,#2a2a2e); border-radius:2px; padding:10px 12px; display:flex; flex-direction:column; gap:8px; }
    .cl-canvas { display:block; width:100%; height:auto; background:#0e0e10; border:1px solid #1f1f23; border-radius:2px; }
    .cl-header { display:flex; justify-content:space-between; align-items:baseline; }
    .cl-name { font-size:11px; color:var(--ink,#f2f2ee); letter-spacing:0.12em; text-transform:uppercase; font-weight:600; }
    .cl-meta { font-size:10px; color:var(--ink-muted,#8d8d92); font-variant-numeric:tabular-nums; }
    .cl-row { display:flex; flex-direction:column; gap:6px; }
    .cl-stat { display:grid; grid-template-columns:55px 1fr 50px; align-items:center; gap:6px; font-size:10px; }
    .cl-stat-label { color:var(--ink-muted,#8d8d92); letter-spacing:0.06em; text-transform:uppercase; }
    .cl-bar { height:6px; background:var(--dim,#2a2a2e); border-radius:1px; overflow:hidden; }
    .cl-bar-fill { height:100%; transition:width 200ms; }
    .cl-adv { background:var(--accent,#ff3a3a); }
    .cl-surv { background:var(--on,#3ddc84); }
    .cl-stat-val { color:var(--ink,#f2f2ee); font-variant-numeric:tabular-nums; text-align:right; }
    .cl-row-meta { flex-direction:row; gap:8px; flex-wrap:wrap; font-size:10px; color:var(--ink-muted,#8d8d92); }
    .cl-meta-tag { background:var(--panel-2,#121215); padding:2px 6px; border-radius:1px; }
    .cl-breach-on { color:var(--accent,#ff3a3a); border:1px solid var(--accent,#ff3a3a); }
    .cl-verdict { font-size:11px; padding:6px 8px; border-radius:1px; text-align:center; letter-spacing:0.04em; font-weight:600; margin-top:2px; }
    .cl-verdict-tbd  { background:var(--panel-2,#121215); color:var(--ink-muted,#8d8d92); font-weight:400; }
    .cl-verdict-push { background:rgba(61,220,132,0.12); color:var(--on,#3ddc84); border:1px solid var(--on,#3ddc84); }
    .cl-verdict-hold { background:rgba(217,122,44,0.12); color:#d97a2c; border:1px solid #d97a2c; }
    .cl-verdict-run  { background:rgba(255,58,58,0.18); color:var(--accent,#ff3a3a); border:1px solid var(--accent,#ff3a3a); }
  `;
  document.head.appendChild(s);
}
