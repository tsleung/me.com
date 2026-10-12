// The page: one loop owns the world, draws the canvas every frame, and
// re-renders the HUD eight times a second. The side comes from <body data-mode>.
import { makeWorld, advance, tide, T_CLOSE } from "./sim.js";
import { VW, VH, drawWorld, camStep } from "./draw.js";
import { hudOf, withCall } from "./hud.js";

const MODE = document.body.dataset.mode === "mind" ? "mind" : "burning";
const B = MODE === "burning";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

$("tideLine").setAttribute(
  "points",
  Array.from({ length: 56 }, (_, i) => {
    const t = (i / 55) * T_CLOSE;
    return ((t / T_CLOSE) * 365).toFixed(1) + "," + (29 - tide(t) * 27).toFixed(1);
  }).join(" "),
);

let w = makeWorld(20261013, MODE);
let speed = 1;
let paused = false;
const queue = [];
const cam = { x: 11, y: 23 };
const canvas = $("view");
const dpr = Math.min(2, window.devicePixelRatio || 1);
canvas.width = VW * dpr;
canvas.height = VH * dpr;
const ctx = canvas.getContext("2d");

function render(h) {
  $("title").textContent = h.title;
  $("title").style.color = h.accent;
  $("clock").textContent = h.clock;
  const ban = $("banner");
  ban.style.opacity = h.hasBanner ? h.banOp : 0;
  $("banText").textContent = h.banText;
  $("banText").style.color = h.banC;
  $("banText").style.fontSize = h.banSize + "px";
  $("banText").style.textShadow = "0 0 18px " + h.banC + ",0 2px 0 #000";
  $("banSub").textContent = h.banSub;
  $("tideTxt").textContent = "THE TIDE · " + h.tideTxt;
  $("windowTxt").textContent = h.windowTxt;
  $("tideNow").style.left = h.nowX + "px";
  $("tideCommit").style.left = h.commitX + "px";
  $("tideCommit").style.opacity = h.commitOp;
  $("initTxt").textContent = "MOMENTUM · " + h.initTxt;
  const bar = $("initBar");
  bar.style.left = h.initL + "%";
  bar.style.width = h.initW + "%";
  bar.style.background = h.initC;
  $("rows").innerHTML = h.rows
    .map(
      (r) =>
        `<div class="row" style="opacity:${r.op}"><div class="rname" style="color:${r.c}">${esc(r.name)}</div><div class="bars"><div class="b1"><div style="width:${r.a}%;background:${r.ac}"></div></div><div class="b2"><div style="width:${r.b}%;background:${r.bc}"></div></div></div><div class="rst" style="color:${r.sc}">${esc(r.st)}</div></div>`,
    )
    .join("");
  const dec = $("decision");
  dec.style.borderColor = h.decBc;
  $("decKicker").textContent = h.decKicker;
  $("closeTxt").textContent = h.closeTxt;
  $("decOpts").innerHTML = h.decOpts
    .map((o) => `<div class="opt"><div class="olabel" style="color:${o.c}">${esc(o.label)}</div><div class="obar"><div style="width:${o.v}%;background:${o.c}"></div></div></div>`)
    .join("");
  $("log").innerHTML = h.log.map((l) => `<div style="color:${l.c}">${esc(l.text)}</div>`).join("");
  const end = $("end");
  end.hidden = !h.ended;
  if (h.ended) {
    $("endTitle").textContent = h.endTitle;
    $("endTitle").style.color = h.endC;
    $("endStats").textContent = h.endStats;
    $("funRows").innerHTML = h.funRows.map((f) => `<div><span>${esc(f.k)}</span><b>${esc(f.v)}</b></div>`).join("");
    $("moments").innerHTML = h.moments.map((m) => `<div style="color:${m.c}">${esc(m.text)}</div>`).join("");
  }
  renderButtons();
}

function button(label, on, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (on) b.classList.add("on");
  b.addEventListener("click", onClick);
  return b;
}
function renderButtons() {
  const kind = B ? "stance" : "oc";
  const cur = w.override[kind];
  const calls = B
    ? [["PUSH", "push"], ["STEADY", "steady"], ["AUTO", "auto"]]
    : [["OVERCLOCK", "on"], ["COOL", "off"], ["AUTO", "auto"]];
  const box = $("calls");
  box.replaceChildren(
    ...calls.map(([label, id]) =>
      button(label, id === "auto" ? !cur : cur === id, () => queue.push((ww) => withCall(ww, kind, id))),
    ),
  );
  const sp = $("speeds");
  sp.replaceChildren(
    ...[["II", 0], ["×1", 1], ["×2", 2], ["×4", 4], ["NEW", -1]].map(([label, v]) =>
      button(label, v === 0 ? paused : v > 0 && !paused && speed === v, () => {
        if (v === -1) queue.push((ww) => makeWorld((ww.seed * 7 + 13) >>> 0, MODE));
        else if (v === 0) paused = !paused;
        else {
          speed = v;
          paused = false;
        }
      }),
    ),
  );
}

$("newRun").addEventListener("click", () => queue.push((ww) => makeWorld((ww.seed * 7 + 13) >>> 0, MODE)));
$("replay").addEventListener("click", () => queue.push((ww) => makeWorld(ww.seed, MODE)));

let last = performance.now();
let hudT = 0;
function frame() {
  const now = performance.now();
  const real = Math.max(0, Math.min(0.25, (now - last) / 1000));
  last = now;
  for (const f of queue.splice(0)) w = f(w);
  if (!paused) w = advance(w, real, speed);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawWorld(ctx, w, camStep(w, cam, real), now / 1000);
  hudT -= real;
  if (hudT <= 0) {
    hudT = 0.12;
    render(hudOf(w, speed, paused));
  }
  requestAnimationFrame(frame);
}
document.body.classList.add(B ? "side-burning" : "side-mind");
requestAnimationFrame(frame);
