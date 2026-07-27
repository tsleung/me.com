// Chapter 1–2: diversification WITHIN a round. You stake everything, split
// across N simultaneous hands drawn from one deck. Watch the distribution of
// outcomes build as we deal hand after hand, and watch its spread collapse as
// N grows. All math from the pure modules; this file is DOM + the animation.

import { makeRng } from "./deck.js";
import { hyperVar, binomVar } from "./stats.js";
import { roundMultiplier, simulateRound, ensembleGrowth } from "./sim.js";
import { barChart, lineChart } from "./charts.js";

const TOTAL = 52;
const REDS = 26;
const BINS = 49;
const CHUNK = 3000; // hands dealt per animation frame
const CAP = 300000; // stop after this many hands

// slider t in [0,1] → payoff. t=0: even money (l=1, no house edge).
// t=1: win ×2 / lose ÷2 (l=0.5, the ergodic knife-edge). g pinned at +100%.
const payoffOf = (t) => ({ g: 1, l: 1 - 0.5 * t });

const rangeRow = (label, min, max, step, value) => {
  const wrap = document.createElement("label");
  wrap.className = "ctl";
  const name = document.createElement("span");
  name.className = "ctl-name";
  name.textContent = label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const out = document.createElement("span");
  out.className = "ctl-val";
  wrap.append(name, input, out);
  return { wrap, input, out };
};

export const mountWithin = (root) => {
  root.innerHTML = "";

  const controls = document.createElement("div");
  controls.className = "controls";
  const hands = rangeRow("hands this round", 1, 26, 1, 1);
  const edge = rangeRow("payoff", 0, 1, 0.01, 1);
  controls.append(hands.wrap, edge.wrap);

  const readout = document.createElement("div");
  readout.className = "readout";

  const distWrap = document.createElement("figure");
  distWrap.className = "chart-fig";
  const distCap = document.createElement("figcaption");
  distCap.innerHTML =
    "outcome of a single round, over <b class='dealt'>0</b> rounds dealt";
  const dist = document.createElement("div");
  dist.className = "chart-box";
  distWrap.append(dist, distCap);

  const sdWrap = document.createElement("figure");
  sdWrap.className = "chart-fig";
  const sdCap = document.createElement("figcaption");
  sdCap.textContent =
    "how much a round can swing, by hands played — and why one deck beats independent bets";
  const sd = document.createElement("div");
  sd.className = "chart-box";
  sdWrap.append(sd, sdCap);

  root.append(controls, readout, distWrap, sdWrap);

  const rng = makeRng(20260704);
  let anim = 0;
  let state = null;

  const payoffLabel = (t) => {
    const l = 1 - 0.5 * t;
    return `win +100% / lose −${Math.round(l * 100)}%` + (t >= 0.999 ? " (×2 / ÷2)" : t <= 0.001 ? " (even money)" : "");
  };

  const restart = () => {
    cancelAnimationFrame(anim);
    const nHands = Number(hands.input.value);
    const t = Number(edge.input.value);
    const payoff = payoffOf(t);
    hands.out.textContent = String(nHands);
    edge.out.textContent = payoffLabel(t);

    // f = 1: you stake everything, split across the hands. Multiplier domain.
    const lo = 1 - payoff.l;
    const hi = 1 + payoff.g;
    const edges = Array.from({ length: BINS + 1 }, (_, i) => lo + ((hi - lo) * i) / BINS);
    state = {
      nHands,
      payoff,
      edges,
      counts: new Array(BINS).fill(0),
      dealt: 0,
      sum: 0,
      sumSq: 0,
      down: 0,
    };
    draw();
    step();
  };

  const binIndex = (m, edges) => {
    const lo = edges[0];
    const hi = edges[edges.length - 1];
    let idx = Math.floor(((m - lo) / (hi - lo)) * BINS);
    if (idx < 0) idx = 0;
    if (idx >= BINS) idx = BINS - 1;
    return idx;
  };

  const step = () => {
    const s = state;
    const chunk = Math.min(CHUNK, CAP - s.dealt);
    for (let i = 0; i < chunk; i++) {
      const m = simulateRound(rng, {
        reds: REDS,
        total: TOTAL,
        nHands: s.nHands,
        f: 1,
        payoff: s.payoff,
      });
      s.counts[binIndex(m, s.edges)] += 1;
      s.sum += m;
      s.sumSq += m * m;
      if (m < 1) s.down += 1;
      s.dealt += 1;
    }
    draw();
    if (s.dealt < CAP) anim = requestAnimationFrame(step);
  };

  const draw = () => {
    const s = state;
    const mean = ensembleGrowth(1, s.payoff); // exact ensemble mean at f=1
    barChart(dist, {
      counts: s.counts,
      edges: s.edges,
      marker: { value: mean, label: `ensemble ${mean.toFixed(2)}×` },
    });
    distWrap.querySelector(".dealt").textContent = s.dealt.toLocaleString("en-US");

    const empMean = s.dealt ? s.sum / s.dealt : 0;
    const empSd = s.dealt ? Math.sqrt(Math.max(0, s.sumSq / s.dealt - empMean * empMean)) : 0;
    const pDown = s.dealt ? s.down / s.dealt : 0;
    const oneHandSd = (s.payoff.g + s.payoff.l) * 0.5;
    readout.innerHTML = `
      <div class="stat"><span class="k">spread of a round</span><span class="v">±${(empSd * 100).toFixed(1)}%</span><span class="sub">one hand: ±${(oneHandSd * 100).toFixed(0)}%</span></div>
      <div class="stat"><span class="k">chance you finish down</span><span class="v">${(pDown * 100).toFixed(1)}%</span><span class="sub">of the round</span></div>
      <div class="stat"><span class="k">ensemble average</span><span class="v">${mean.toFixed(2)}×</span><span class="sub">what a full room earns</span></div>`;

    // analytic swing-vs-hands curve (f = 1)
    const scale = s.payoff.g + s.payoff.l;
    const noRepl = [];
    const indep = [];
    for (let n = 1; n <= 26; n++) {
      noRepl.push([n, (scale * Math.sqrt(hyperVar(TOTAL, REDS, n))) / n]);
      indep.push([n, (scale * Math.sqrt(binomVar(n, 0.5))) / n]);
    }
    lineChart(sd, {
      series: [
        { label: "one deck", color: "var(--data-blue)", points: noRepl },
        { label: "independent", color: "var(--data-amber)", points: indep },
      ],
      xMax: 26,
      yMax: scale * 0.5,
      yLabel: "± swing",
    });
  };

  hands.input.addEventListener("input", restart);
  edge.input.addEventListener("input", restart);
  restart();
};
