// app.js — wiring. Owns mutable state and the animation loop; all math lives
// in lorenz.js / fork.js / color.js / director.js / render.js.

import {
  CLASSIC,
  DT,
  ATTRACTOR_DIAMETER,
  phaseSpeed,
  separation,
} from "./lorenz.js";
import { makeSim, refork as reforkSim, step, vertex, sinceFork } from "./sim.js";
import { lyapunovBenettin, divergenceNorm, fitGrowthRate } from "./fork.js";
import { colorFor } from "./color.js";
import { attrsFor, BLENDS } from "./pen.js";
import { readoutText, staticText } from "./hud.js";
import { ringBuffer, sampler } from "./history.js";
import { directedParams } from "./director.js";
import { introSpeed, introRevealed } from "./intro.js";
import { SLIDERS, EPS_LIMITS, fromSlider, toSlider } from "./controls.js";
import {
  makeCamera,
  project,
  fitCanvas,
  clearStage,
  drawTrail,
  drawHead,
  drawDivergenceChart,
} from "./render.js";
import { makeTrail } from "./trail.js";

const el = (id) => document.getElementById(id);

// The difference Lorenz typed: 0.506 where the machine held 0.506127.
//
// Strictly that was the 1961 twelve-variable model, not these three equations
// from 1963 — a distinction the in-app copy now makes, since presenting them as
// one story is the usual retelling and it is wrong. Used as the default because
// it is the right order of magnitude for "a rounding nobody would worry about".
const LORENZ_ROUNDING = 1.27e-4;

// A belt-and-braces cap only. The reachable ceiling is ~900: realDt clamps to
// 0.1s and speed to SPEED_LIMITS.max = 36, so 3.6/0.004. Left deliberately
// above that so a future clamp change cannot make a frame unbounded.
const MAX_STEPS_PER_FRAME = 4000;
const SATURATION = 25; // ‖Δ‖ past which the twin is simply elsewhere
const TOLERANCE = 1.0; // ‖Δ‖ past which we call the forecast dead

const S = {
  params: { ...CLASSIC },
  // The whole evolving simulation, replaced wholesale each step by sim.js.
  // Everything else in here is a setting, a cache, or an accumulator.
  sim: null,
  eps: LORENZ_ROUNDING,
  manualSpeed: 3,
  manualTrail: 5,
  effSpeed: 3,
  effTrail: 5,
  field: "lobe",
  palette: "ember",
  blend: "filament",
  mode: "calligraphy",
  period: 30,
  yaw: 0,
  running: true,
  // The opening (see intro.js). `introT` counts REAL seconds of playback, so
  // pausing pauses the opening too. `revealed` gates the chrome — including
  // the markers drawn on the pen itself, which are chrome like anything else.
  introT: 0,
  introActive: true,
  revealed: false,
  panelOpen: false,
  // Set by anything that changes the picture without advancing time, so a
  // paused canvas still responds to controls.
  needsRepaint: true,
  showTwin: true,
  refork: true,
  trailA: makeTrail(),
  trailB: makeTrail(),
  stepAcc: 0,
  series: ringBuffer(4000),
  sample: sampler(0.06),
  expiredAt: null,
  prevExpiredAt: null,
  lambda: null, // Benettin, careful
  lambdaLive: null, // least-squares over the current fork
  cam: null,
  W: 0,
  H: 0,
  ctx: null,
};

// ------------------------------------------------------------------ lifecycle

function reseed() {
  // A different point on the attractor each time. `seed()` itself stays
  // deterministic — the tests depend on that — so the variation goes into how
  // far we walk before starting. Without this the button cleared the trail and
  // then drew the exact same curve: a control that looked like it worked.
  S.sim = makeSim(S.params, S.eps, 8 + Math.random() * 14);
  resetForkRecord();
  clearTrails();
}

function refork() {
  S.sim = reforkSim(S.sim, S.eps);
  resetForkRecord();
  // The twin teleports back onto the reference here, so its old trail is
  // history that no longer belongs to it.
  S.trailB.clear();
}

/** The measurements that are only meaningful within one fork. */
function resetForkRecord() {
  S.series.clear();
  S.sample.reset();
  S.prevExpiredAt = S.expiredAt;
  S.expiredAt = null;
  S.lambdaLive = null;
}

/**
 * Drop the recorded vertices. Named for what it does: the canvas itself needs
 * no clearing, because the whole surface is wiped and repainted every frame.
 */
function clearTrails() {
  S.trailA.clear();
  S.trailB.clear();
}

/**
 * Fade the chrome in. Idempotent; CSS owns the timing.
 *
 * The drawer opens as part of the reveal. A panel that only appears if you
 * find the button is a panel most people never find — the button stays as the
 * way to get it back out of the way, not as the only way in.
 *
 * Note this does NOT call `takeOver()`: the opening's speed ramp runs to ~26s
 * and the reveal lands at ~11s, so ending the ramp here would cut it short.
 * Touching an actual control still ends it, via the delegated listener.
 */
function reveal() {
  if (S.revealed) return;
  S.revealed = true;
  document.body.classList.add("is-revealed", "is-revealing");
  setPanel(true);
  // Drop back to the snappy drawer transition once the reveal is over: a panel
  // you asked for should not take seven seconds to arrive. Duration is read
  // from CSS so the stylesheet stays the single source of that number.
  const ms = parseFloat(getComputedStyle(document.body).getPropertyValue("--reveal-ms"));
  setTimeout(
    () => document.body.classList.remove("is-revealing"),
    Number.isFinite(ms) ? ms : 0,
  );
}

/**
 * Hand control back to the user. Called by every control, because someone who
 * has reached for a slider is no longer watching an opening — leaving the ramp
 * running would fight their input for the next several seconds.
 */
function takeOver() {
  S.introActive = false;
  reveal();
}

function setPanel(open) {
  S.panelOpen = open;
  document.body.classList.toggle("is-panel-open", open);
  el("c-panel").setAttribute("aria-expanded", String(open));
}

/**
 * Benettin λ for the current parameters. ~100k RK4 steps over two trajectories,
 * SYNCHRONOUS on the main thread — this is a visible frame hitch on every
 * σ/ρ/β release, not background work. Debounced by `scheduleLambda` so it fires
 * once per drag rather than once per input event.
 */
function recomputeLambda() {
  const { lambda } = lyapunovBenettin(S.params, { total: 180, burnIn: 20 });
  S.lambda = lambda;
  renderStatic();
}

// --------------------------------------------------------------------- the loop

let lastNow = 0;

function frame(now) {
  const realDt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
  lastNow = now;

  // Resizing re-fits the camera and nothing else. Vertices hold STATE, so the
  // existing trail simply re-projects at the new size — the same reason the
  // yaw control does not clear either. (The clear that used to live here was
  // left over from the accumulate-and-fade renderer, where the trail lived in
  // pixels and a resize genuinely destroyed it.)
  const fit = fitCanvas(el("stage"));
  S.ctx = fit.ctx;
  if (fit.changed || S.W !== fit.width || S.H !== fit.height) {
    S.W = fit.width;
    S.H = fit.height;
    S.cam = makeCamera(S.W, S.H, { yaw: S.yaw, params: S.params });
    S.needsRepaint = true;
  }

  // Measured from the PREVIOUS frame's end state, purely to choose this
  // frame's playback speed — the director needs a number before the loop runs.
  // Everything user-visible (readouts, head marker, chart) is re-measured from
  // the post-step state below, because at high playback a frame covers up to
  // 3.6 simulated units and stale values were visibly wrong.
  const directed = directedParams({
    mode: S.mode,
    t: S.sim.t,
    period: S.period,
    manual: { speed: S.manualSpeed, trail: S.manualTrail },
    // The SMOOTHED press, so playback speed eases the same way the stroke
    // width does. Feeding the raw target here would put a step in the speed.
    sample: {
      v: phaseSpeed(S.sim.a, S.params),
      divergenceNorm: divergenceNorm(separation(S.sim.a, S.sim.b), S.eps),
      press: S.sim.penA.press,
    },
  });
  // The opening overrides speed until its ramp completes, then hands back by
  // returning null. It chases `directed.speed` rather than a captured value,
  // so moving the slider mid-opening moves the target.
  if (S.introActive && S.running) S.introT += realDt;
  const opening = S.introActive ? introSpeed(S.introT, directed.speed) : null;
  if (S.introActive && opening == null) S.introActive = false;
  if (!S.revealed && introRevealed(S.introT)) reveal();

  S.effSpeed = opening ?? directed.speed;
  S.effTrail = directed.trail;

  const simDt = S.running ? S.effSpeed * realDt : 0;

  // ---- advance the system, recording vertices as we go ----
  if (simDt > 0) {
    S.stepAcc += simDt / DT;
    let steps = Math.floor(S.stepAcc);
    S.stepAcc -= steps;
    if (steps > MAX_STEPS_PER_FRAME) steps = MAX_STEPS_PER_FRAME;

    // The step itself is pure and lives in sim.js; what stays here is the
    // accumulators — the sinks a step feeds, which is exactly what a shell is.
    for (let i = 0; i < steps; i++) {
      S.sim = step(S.sim, S.params);
      const d = separation(S.sim.a, S.sim.b);

      S.trailA.record(vertex(S.sim, S.params, "a", d), S.sim.t, S.effTrail);
      if (S.showTwin) {
        S.trailB.record(vertex(S.sim, S.params, "b", d), S.sim.t, S.effTrail);
      }

      if (S.expiredAt == null && d > TOLERANCE) S.expiredAt = sinceFork(S.sim);
      if (S.sample.due(S.sim.t)) S.series.push({ t: sinceFork(S.sim), d });
    }
  }

  // Re-measured after stepping, so what is shown is what is drawn.
  const delta = separation(S.sim.a, S.sim.b);
  const dNorm = divergenceNorm(delta, S.eps);
  const vNow = phaseSpeed(S.sim.a, S.params);

  // Repaint only when something changed. Paused, the image is static, so the
  // ~700–2000 strokes a frame were redrawing an identical picture indefinitely
  // — continuous battery drain on a page the user deliberately stopped.
  if (simDt > 0 || S.needsRepaint) {
    drawStage(vNow, delta);
    S.needsRepaint = false;
  }

  // Gated on `revealed`, NOT on the drawer.
  //
  // An earlier version of this gate used `panelOpen`, on the belief that the
  // chart lived inside the drawer. It does not — `.chart-wrap` is a sibling of
  // `</aside>`, in normal flow, permanently on screen. That gate froze a fully
  // visible chart whenever the controls were closed: close them early in a fork
  // and the plot sat stale beside a moving attractor forever.
  //
  // `revealed` is the honest version of the same saving. Before the reveal the
  // chart is at opacity 0 and there is genuinely nothing to see.
  if (S.revealed) {
    const samples = S.series.toArray();
    const live = fitGrowthRate(samples, S.eps);
    if (live) S.lambdaLive = live.lambda;
    drawChart(samples);
  }
  renderReadouts(delta, dNorm, vNow, directed.u);

  if (S.refork && delta > SATURATION) refork();

  requestAnimationFrame(frame);
}

/**
 * Repaint the stage: clear, redraw both trails from their vertices, then the
 * heads. Everything transient now lives on this one surface, because the whole
 * surface is transient — see trail.js for why redrawing replaced the
 * accumulate-and-fade renderer.
 */
function drawStage(vNow, delta) {
  const blend = BLENDS[S.blend];
  const calligraphic = S.mode === "calligraphy";
  const ctx = S.ctx;

  clearStage(ctx, S.W, S.H);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalCompositeOperation = blend.op;

  const pen = { field: S.field, palette: S.palette, blend: S.blend, calligraphic };
  drawTrail(ctx, S.cam, S.trailA.samples(), S.sim.t, S.effTrail, attrsFor(pen));
  if (S.showTwin) {
    const shadow = attrsFor({ ...pen, dim: true });
    drawTrail(ctx, S.cam, S.trailB.samples(), S.sim.t, S.effTrail, shadow);
  }

  ctx.globalCompositeOperation = "source-over";
  if (!S.revealed) return;

  const head = vertex(S.sim, S.params, "a", delta);
  drawHead(ctx, project(S.sim.a, S.cam), colorFor(head, S.field, S.palette).rgb);
  if (S.showTwin) {
    const pb = project(S.sim.b, S.cam);
    ctx.strokeStyle = "rgba(242,242,238,0.7)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(pb.sx, pb.sy, 4, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawChart(samples) {
  const fit = fitCanvas(el("chart"));
  drawDivergenceChart(fit.ctx, fit.width, fit.height, {
    samples,
    eps: S.eps,
    ceiling: ATTRACTOR_DIAMETER,
    tolerance: TOLERANCE,
    lambda: S.lambdaLive ?? S.lambda,
    expiredAt: S.expiredAt,
    window: 45,
  });
}

// ---------------------------------------------------------------- the readouts

/**
 * Apply hud.js's id→text map. The only DOM knowledge in here is "textContent".
 */
function applyText(map) {
  for (const [id, text] of Object.entries(map)) el(id).textContent = text;
}

function renderReadouts(delta, dNorm, v, u) {
  applyText(
    readoutText({
      t: S.sim.t,
      sinceFork: sinceFork(S.sim),
      delta,
      dNorm,
      v,
      effSpeed: S.effSpeed,
      effTrail: S.effTrail,
      u,
      lambdaLive: S.lambdaLive,
      expiredAt: S.expiredAt,
      prevExpiredAt: S.prevExpiredAt,
    }),
  );
  el("stat-expired").classList.toggle("is-live", S.expiredAt != null);
}

/** Everything that only changes when a control does. */
function renderStatic() {
  const view = staticText({
    lambda: S.lambda,
    eps: S.eps,
    params: S.params,
    field: S.field,
    palette: S.palette,
    blend: S.blend,
    mode: S.mode,
    tolerance: TOLERANCE,
    manualSpeed: S.manualSpeed,
    manualTrail: S.manualTrail,
    period: S.period,
    yaw: S.yaw,
  });
  applyText(view.text);
  el("legend-bar").style.background = view.legendGradient;
  el("p-warn").hidden = !view.paletteIsLoud;
  el("tour-row").hidden = !view.showTourRow;
  el("manual-rows").classList.toggle("is-overridden", view.manualOverridden);
}

// ------------------------------------------------------------------- controls

function bind() {
  el("c-panel").addEventListener("click", () => {
    setPanel(!S.panelOpen);
    takeOver();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && S.panelOpen) setPanel(false);
  });
  // One delegated listener instead of a takeOver() call in every handler:
  // any touch of the panel ends the opening, and there is no way to add a
  // control later and forget to wire it.
  for (const evt of ["input", "change", "click"]) {
    el("panel").addEventListener(evt, () => {
      takeOver();
      // Paused, the loop skips painting; any control that alters the picture
      // must ask for one frame or the change appears not to have happened.
      S.needsRepaint = true;
    });
  }

  const speedIn = el("c-speed");
  speedIn.value = String(toSlider(S.manualSpeed, SLIDERS.speed));
  speedIn.addEventListener("input", () => {
    S.manualSpeed = fromSlider(+speedIn.value, SLIDERS.speed);
    renderStatic();
  });

  const trailIn = el("c-trail");
  trailIn.value = String(toSlider(S.manualTrail, SLIDERS.trail));
  trailIn.addEventListener("input", () => {
    S.manualTrail = fromSlider(+trailIn.value, SLIDERS.trail);
    renderStatic();
  });

  const epsIn = el("c-eps");
  epsIn.value = String(toSlider(S.eps, EPS_LIMITS));
  epsIn.addEventListener("input", () => {
    S.eps = fromSlider(+epsIn.value, EPS_LIMITS);
    refork();
    renderStatic();
  });

  el("c-eps-lorenz").addEventListener("click", () => {
    S.eps = LORENZ_ROUNDING;
    epsIn.value = String(toSlider(S.eps, EPS_LIMITS));
    refork();
    renderStatic();
  });

  el("c-field").addEventListener("change", (e) => {
    S.field = e.target.value;
    renderStatic();
  });
  el("c-palette").addEventListener("change", (e) => {
    S.palette = e.target.value;
    renderStatic();
  });
  el("c-blend").addEventListener("change", (e) => {
    S.blend = e.target.value;
    renderStatic();
  });
  el("c-mode").addEventListener("change", (e) => {
    S.mode = e.target.value;
    renderStatic();
  });

  const periodIn = el("c-period");
  periodIn.addEventListener("input", () => {
    S.period = +periodIn.value;
    renderStatic();
  });

  // Yaw is a static setting rather than an animation: a camera turning under a
  // still attractor competes with the color channel for attention. Since the
  // trail is redrawn from state (not pixels), changing it re-projects the whole
  // existing trail — no clearing needed.
  const yawIn = el("c-yaw");
  yawIn.addEventListener("input", () => {
    S.yaw = (+yawIn.value * Math.PI) / 180;
    S.cam = makeCamera(S.W, S.H, { yaw: S.yaw, params: S.params });
    renderStatic();
  });

  el("c-twin").addEventListener("change", (e) => {
    S.showTwin = e.target.checked;
    S.trailB.clear();
  });
  el("c-refork").addEventListener("change", (e) => {
    S.refork = e.target.checked;
  });

  el("c-play").addEventListener("click", () => {
    S.running = !S.running;
    el("c-play").textContent = S.running ? "pause" : "play";
    el("c-play").setAttribute("aria-pressed", String(!S.running));
  });
  el("c-refork-now").addEventListener("click", () => refork());
  el("c-reseed").addEventListener("click", () => reseed());
  el("c-clear").addEventListener("click", () => clearTrails());

  for (const [key, id] of [
    ["sigma", "c-sigma"],
    ["rho", "c-rho"],
    ["beta", "c-beta"],
  ]) {
    const input = el(id);
    input.value = String(S.params[key]);
    input.addEventListener("input", () => {
      S.params = { ...S.params, [key]: +input.value };
      // The camera's extents derive from the parameters, so it must be rebuilt
      // or a high-rho attractor climbs out of the frame.
      S.cam = makeCamera(S.W, S.H, { yaw: S.yaw, params: S.params });
      renderStatic();
      scheduleLambda();
    });
  }
  el("c-classic").addEventListener("click", () => {
    S.params = { ...CLASSIC };
    el("c-sigma").value = String(CLASSIC.sigma);
    el("c-rho").value = String(CLASSIC.rho);
    el("c-beta").value = String(CLASSIC.beta);
    reseed();
    renderStatic();
    scheduleLambda();
  });
}

let lambdaTimer = 0;
function scheduleLambda() {
  clearTimeout(lambdaTimer);
  // Blank it and repaint immediately. Without the repaint the panel kept
  // showing the PREVIOUS parameters' lambda as though it were current, for the
  // debounce plus the compute — a stale number is worse than a visible dash.
  S.lambda = null;
  renderStatic();
  lambdaTimer = setTimeout(recomputeLambda, 250);
}

// ------------------------------------------------------------------- start up

bind();
reseed();
renderStatic();
recomputeLambda();
requestAnimationFrame(frame);
