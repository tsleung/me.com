// Chapter 3: diversification OVER time. Reinvest across rounds, inject fresh
// capital each round, and watch the gap open between the ensemble average
// (the mean line) and what a single player actually lives through (the median
// band). Diversifying within each round — more hands — pulls the median back
// up toward the mean. Recomputed synchronously on every control change.

import { makeRng } from "./deck.js";
import { fanBands, ensembleGrowth } from "./sim.js";
import { fanChart } from "./charts.js";

const TOTAL = 52;
const REDS = 26;
const PATHS = 800;
const QS = [0.1, 0.25, 0.5, 0.75, 0.9];

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

const fmtMoney = (v) =>
  v >= 1000 ? "$" + Math.round(v).toLocaleString("en-US") : "$" + v.toFixed(0);

export const mountOverTime = (root) => {
  root.innerHTML = "";

  const controls = document.createElement("div");
  controls.className = "controls";
  const hands = rangeRow("hands per round", 1, 26, 1, 1);
  const frac = rangeRow("stake per round", 0.05, 1, 0.05, 0.5);
  const rounds = rangeRow("rounds", 10, 120, 5, 60);
  const initial = rangeRow("starting balance", 0, 500, 50, 100);
  const inject = rangeRow("injected each round", 0, 200, 25, 100);
  const edge = rangeRow("payoff", 0, 1, 0.01, 1);
  controls.append(
    hands.wrap,
    frac.wrap,
    rounds.wrap,
    initial.wrap,
    inject.wrap,
    edge.wrap,
  );

  const readout = document.createElement("div");
  readout.className = "readout";

  const fanWrap = document.createElement("figure");
  fanWrap.className = "chart-fig";
  const fanCap = document.createElement("figcaption");
  fanCap.innerHTML =
    "wealth over time across " +
    PATHS.toLocaleString("en-US") +
    " lives (log scale) — shaded bands are the 10–90 and 25–75 ranges";
  const fan = document.createElement("div");
  fan.className = "chart-box";
  fanWrap.append(fan, fanCap);

  root.append(controls, readout, fanWrap);

  const payoffLabel = (t) => {
    const l = 1 - 0.5 * t;
    return (
      `win +100% / lose −${Math.round(l * 100)}%` +
      (t >= 0.999 ? " (×2 / ÷2)" : t <= 0.001 ? " (even money)" : "")
    );
  };

  const recompute = () => {
    const nHands = Number(hands.input.value);
    const f = Number(frac.input.value);
    const nRounds = Number(rounds.input.value);
    const init = Number(initial.input.value);
    const injection = Number(inject.input.value);
    const t = Number(edge.input.value);
    const payoff = payoffOf(t);

    hands.out.textContent = String(nHands);
    frac.out.textContent = Math.round(f * 100) + "%";
    rounds.out.textContent = String(nRounds);
    initial.out.textContent = fmtMoney(init);
    inject.out.textContent = fmtMoney(injection);
    edge.out.textContent = payoffLabel(t);

    const opts = {
      rounds: nRounds,
      initial: init,
      injection,
      reds: REDS,
      total: TOTAL,
      nHands,
      f,
      payoff,
    };
    const rng = makeRng(20260704);
    const { bands, means } = fanBands(rng, opts, PATHS, QS);

    fanChart(fan, { qs: QS, bands, means, rounds: nRounds });

    const median = bands[QS.indexOf(0.5)][nRounds];
    const mean = means[nRounds];
    const eg = ensembleGrowth(f, payoff);
    // fraction of lives that never grew their stake (ended at or below the
    // total capital they were handed) — the lived-experience of drag.
    const contributed = init + injection * nRounds;
    readout.innerHTML = `
      <div class="stat"><span class="k">median life ends with</span><span class="v">${fmtMoney(median)}</span><span class="sub">the typical player</span></div>
      <div class="stat"><span class="k">mean (the ensemble)</span><span class="v">${fmtMoney(mean)}</span><span class="sub">average over all lives</span></div>
      <div class="stat"><span class="k">you put in</span><span class="v">${fmtMoney(contributed)}</span><span class="sub">balance + injections</span></div>
      <div class="stat"><span class="k">ensemble edge / round</span><span class="v">${eg >= 1 ? "+" : ""}${((eg - 1) * 100).toFixed(1)}%</span><span class="sub">mean growth of the stake</span></div>`;
  };

  [hands, frac, rounds, initial, inject, edge].forEach((c) =>
    c.input.addEventListener("input", recompute),
  );
  recompute();
};
