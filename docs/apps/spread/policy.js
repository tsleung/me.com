// Chapter 4: the optimizer. Two things happen at once and you watch both:
//
//  1. Concrete play. The whole shoe is laid out as columns of rounds, left to
//     right — N cards each (26 hands → 2 rounds, 2 hands → 26 rounds). Each
//     round is revealed in one moment, the current bettor sizes its bet to the
//     count, a bankroll runs (with cash added or paid each round), and every
//     round's win-fraction drops into a histogram that bells into a normal as
//     you add hands (the central limit theorem, live).
//
//  2. Abstract learning. In the background a Monte-Carlo agent keeps playing
//     shoes and updating its action table; the heatmaps below show it sharpen
//     toward the exact optimum. The concrete play up top uses whichever policy
//     you pick, so you see the learned table actually bet.
//
// Math from rl.js / sim.js; this file is controls, the table, and time.

import { makeRng, freshShoe, shuffle } from "./deck.js";
import {
  createAgent,
  solveClosed,
  solveOpen,
  evaluatePolicy,
  reachableStates,
} from "./rl.js";
import { roundMultiplier } from "./sim.js";
import { heatmapChart, growthCurve, barChart } from "./charts.js";

const EVAL_SHOES = 250;
const LEARN_MS = 45;
const TRAIN_PER_TICK = 400;
const HIST_BINS = 41;

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

const button = (label, cls) => {
  const b = document.createElement("button");
  b.className = "btn" + (cls ? " " + cls : "");
  b.type = "button";
  b.textContent = label;
  return b;
};

const money = (v) => (v < 0 ? "−$" : "$") + Math.round(Math.abs(v)).toLocaleString("en-US");

export const mountPolicy = (root) => {
  root.innerHTML = "";

  // --- controls ---
  const controls = document.createElement("div");
  controls.className = "controls";
  const hands = rangeRow("hands per round", 1, 26, 1, 2);
  const edge = rangeRow("payoff", 0, 1, 0.01, 1);
  const initBal = rangeRow("starting balance", 0, 500, 50, 100);
  const cash = rangeRow("cash each round", -100, 200, 25, 50);
  const alpha = rangeRow("learning rate α", 0.005, 0.1, 0.005, 0.02);
  const eps = rangeRow("exploration ε", 0, 0.3, 0.01, 0.12);
  const optim = rangeRow("optimistic init", 0, 2, 0.1, 1);
  const speed = rangeRow("reveal speed", 1, 10, 1, 5);
  controls.append(
    hands.wrap, edge.wrap, initBal.wrap, cash.wrap,
    alpha.wrap, eps.wrap, optim.wrap, speed.wrap,
  );

  // --- action bar ---
  const bar = document.createElement("div");
  bar.className = "actionbar";
  const bettorBtn = button("bettor: learned", "bettor");
  const runBtn = button("play", "primary");
  const stepBtn = button("step one round", "step");
  const resetBtn = button("reset", "ghost");
  bar.append(bettorBtn, runBtn, stepBtn, resetBtn);

  // --- the whole shoe, laid out as rounds ---
  const shoeFig = document.createElement("figure");
  shoeFig.className = "chart-fig";
  const shoeCap = document.createElement("figcaption");
  shoeCap.textContent =
    "the whole shoe — each column is one round (left played first), revealed as the policy bets it";
  const grid = document.createElement("div");
  grid.className = "shoe-grid";
  shoeFig.append(grid, shoeCap);

  const playReadout = document.createElement("div");
  playReadout.className = "readout";

  const histFig = document.createElement("figure");
  histFig.className = "chart-fig";
  const histCap = document.createElement("figcaption");
  histCap.innerHTML =
    "how many of your hands win each round — add hands and it bells into a normal (the central limit theorem)";
  const hist = document.createElement("div");
  hist.className = "chart-box";
  histFig.append(hist, histCap);

  // --- the learned policy (abstract) ---
  const explain = document.createElement("p");
  explain.className = "aside";
  explain.innerHTML =
    "Below is the policy itself, as a table. Each cell is a state of the deck: " +
    "left↔right is the <b>count</b> (how red- or black-rich the rest of the deck " +
    "has become), top↔bottom is <b>cards left</b> (52 up top, nearly empty at the " +
    "bottom). Colour is <b>how big a bet</b> the policy makes there — near-black = " +
    "sit out, bright = bet big. It is diamond-shaped because a full deck must be " +
    "near-balanced, and only as cards deplete can the count swing far. <b>Left</b> " +
    "is what the agent has learned by playing; <b>right</b> is the exact optimum it " +
    "is chasing.";

  const maps = document.createElement("div");
  maps.className = "heatmaps";
  const learnedFig = document.createElement("figure");
  learnedFig.className = "chart-fig";
  const learnedCap = document.createElement("figcaption");
  learnedCap.textContent = "learned online — bet fraction per count";
  const learned = document.createElement("div");
  learned.className = "chart-box";
  learnedFig.append(learned, learnedCap);
  const exactFig = document.createElement("figure");
  exactFig.className = "chart-fig";
  const exactCap = document.createElement("figcaption");
  exactCap.textContent = "exact optimum (dynamic programming)";
  const exactBox = document.createElement("div");
  exactBox.className = "chart-box";
  exactFig.append(exactBox, exactCap);
  maps.append(learnedFig, exactFig);

  const legend = document.createElement("div");
  legend.className = "heat-legend";
  legend.innerHTML = "<span>bet 0</span><span class='ramp'></span><span>bet all</span>";

  const curveFig = document.createElement("figure");
  curveFig.className = "chart-fig";
  const curveCap = document.createElement("figcaption");
  curveCap.textContent =
    "shoe growth as it learns — solid = learned, dashed = exact ceiling; counting (blue) vs not (amber)";
  const curve = document.createElement("div");
  curve.className = "chart-box";
  curveFig.append(curve, curveCap);

  const learnReadout = document.createElement("div");
  learnReadout.className = "readout";

  root.append(
    controls, bar, shoeFig, playReadout, histFig,
    explain, maps, legend, curveFig, learnReadout,
  );

  // --- state ---
  const trainRng = makeRng(20260705);
  const playRng = makeRng(770077);
  let closedAgent, openAgent, ex, states, episodes, history, curN;
  let play, hgram; // playthrough + histogram
  let bettor = "learned"; // learned | exact | no-count
  let learnTimer = null;
  let playTimer = null;
  let learnTick = 0;

  const cfg = () => ({
    payoff: payoffOf(Number(edge.input.value)),
    nHands: Number(hands.input.value),
    alpha: Number(alpha.input.value),
    epsilon: Number(eps.input.value),
    optimistic: Number(optim.input.value),
  });

  // fraction + colour for a state under the current bettor
  const betOf = (r, b) => {
    if (bettor === "no-count") return { f: ex.open.fraction(), red: true };
    const f = bettor === "exact" ? ex.closed.fraction(r, b) : (closedAgent.fraction(r, b) ?? 0);
    return { f, red: r >= b };
  };

  const recomputeExact = () => {
    const c = cfg();
    ex = { closed: solveClosed(c), open: solveOpen(c) };
  };

  const newShoe = () => {
    play.shoe = shuffle(playRng, freshShoe());
    play.roundIdx = 0;
    play.reds = 26;
    play.blacks = 26;
    play.numRounds = Math.floor(52 / play.nHands);
    play.results = [];
  };

  const resetHist = () => {
    hgram = {
      edges: Array.from({ length: HIST_BINS + 1 }, (_, i) => (100 * i) / HIST_BINS),
      counts: new Array(HIST_BINS).fill(0),
      n: 0,
      sum: 0,
      sumSq: 0,
    };
  };

  const resetPlay = () => {
    play = {
      nHands: cfg().nHands,
      bankroll: Number(initBal.input.value),
      rounds: 0,
      injected: 0,
      lastRet: 0,
      busted: false,
    };
    newShoe();
    resetHist();
  };

  const rebuild = () => {
    const c = cfg();
    curN = c.nHands;
    states = reachableStates(c);
    closedAgent = createAgent({ ...c, counts: true });
    openAgent = createAgent({ ...c, counts: false });
    episodes = 0;
    history = [];
    recomputeExact();
    resetPlay();
  };

  // --- the concrete play ---
  const playRound = () => {
    if (play.roundIdx >= play.numRounds) newShoe();
    const N = play.nHands;
    const start = play.roundIdx * N;
    const cards = play.shoe.slice(start, start + N);
    const redsInRound = cards.filter((c) => c.red).length;
    const { f, red } = betOf(play.reds, play.blacks);
    const wins = red ? redsInRound : N - redsInRound;
    const p = wins / N;
    const m = roundMultiplier(wins, N, f, cfg().payoff);
    const cashPerRound = Number(cash.input.value);

    play.bankroll = Math.max(0, play.bankroll * m) + cashPerRound;
    play.injected += cashPerRound;
    play.busted = play.bankroll <= 0;
    play.lastRet = (m - 1) * 100;
    play.rounds += 1;
    play.results[play.roundIdx] = { f, red, redsInRound, m, p };
    play.reds -= redsInRound;
    play.blacks -= N - redsInRound;
    play.roundIdx += 1;

    // histogram of win-fraction (%) — the CLT quantity
    const pct = p * 100;
    let idx = Math.floor((pct / 100) * HIST_BINS);
    if (idx >= HIST_BINS) idx = HIST_BINS - 1;
    if (idx < 0) idx = 0;
    hgram.counts[idx] += 1;
    hgram.n += 1;
    hgram.sum += pct;
    hgram.sumSq += pct * pct;
  };

  // --- rendering ---
  const miniCard = (card, faceUp, showFace) => {
    const c = document.createElement("div");
    let cls = "mini-card " + (faceUp ? (card.red ? "red" : "black") : "back");
    if (faceUp && showFace) cls += " face";
    c.className = cls;
    if (faceUp && showFace) c.textContent = card.rank + card.suit;
    return c;
  };

  const drawGrid = () => {
    grid.textContent = "";
    const N = play.nHands;
    const showFace = play.numRounds <= 13;
    const showLabel = play.numRounds <= 18;
    for (let r = 0; r < play.numRounds; r++) {
      const col = document.createElement("div");
      col.className = "round-col";
      if (r === play.roundIdx) col.classList.add("next");
      const revealed = r < play.roundIdx;
      const cardsWrap = document.createElement("div");
      cardsWrap.className = "col-cards";
      for (let i = 0; i < N; i++) {
        const card = play.shoe[r * N + i];
        cardsWrap.appendChild(miniCard(card, revealed, showFace));
      }
      col.appendChild(cardsWrap);
      if (showLabel) {
        const lab = document.createElement("div");
        lab.className = "bet-label";
        if (revealed) {
          const res = play.results[r];
          lab.textContent = Math.round(res.f * 100) + "%";
          lab.classList.add(res.m >= 1 ? "win" : "lose");
        } else {
          lab.textContent = "·";
        }
        col.appendChild(lab);
      }
      grid.appendChild(col);
    }
  };

  const drawPlayReadout = () => {
    const winRate = hgram.n ? hgram.sum / hgram.n : 0;
    const cur = betOf(play.reds, play.blacks);
    playReadout.innerHTML = `
      <div class="stat big"><span class="k">bankroll</span><span class="v">${money(play.bankroll)}</span><span class="sub ${play.lastRet > 0 ? "up" : play.lastRet < 0 ? "down" : ""}">last round ${play.lastRet >= 0 ? "+" : ""}${play.lastRet.toFixed(0)}%${play.busted ? " · busted" : ""}</span></div>
      <div class="stat"><span class="k">rounds played</span><span class="v">${play.rounds.toLocaleString("en-US")}</span><span class="sub">${play.numRounds}/shoe · reshuffles ongoing</span></div>
      <div class="stat"><span class="k">avg hands won</span><span class="v">${winRate.toFixed(0)}%</span><span class="sub">per round, across play</span></div>
      <div class="stat"><span class="k">next bet</span><span class="v">${Math.round(cur.f * 100)}%</span><span class="sub">on ${cur.red ? "red" : "black"} · ${play.reds}r/${play.blacks}b left</span></div>`;
  };

  const drawHist = () => {
    const { counts, edges, n, sum, sumSq } = hgram;
    const mu = n ? sum / n : 0;
    const varr = n ? Math.max(0, sumSq / n - mu * mu) : 0;
    const sd = Math.sqrt(varr);
    const binW = 100 / HIST_BINS;
    let curvePts = null;
    if (sd > 0.75 && n > 30) {
      curvePts = [];
      for (let i = 0; i < HIST_BINS; i++) {
        const c = edges[i] + binW / 2;
        const pdf = Math.exp(-((c - mu) * (c - mu)) / (2 * sd * sd)) / (sd * Math.sqrt(2 * Math.PI));
        curvePts.push([c, n * binW * pdf]);
      }
    }
    barChart(hist, {
      counts,
      edges,
      unit: "%",
      marker: { value: mu, label: `mean ${mu.toFixed(0)}%` },
      curve: curvePts,
    });
  };

  const drawExact = () => {
    heatmapChart(exactBox, { states, value: (s) => ex.closed.fraction(s.r, s.b) });
  };

  const drawLearned = () => {
    heatmapChart(learned, { states, value: (s) => closedAgent.fraction(s.r, s.b) });
  };

  const drawCurve = () => {
    const yMax = Math.max(0.1, ex.closed.value * 1.1, ...history.map((h) => h.closed));
    growthCurve(curve, {
      xMax: Math.max(1, episodes),
      yMin: 0,
      yMax,
      yLabel: "growth / shoe",
      series: [
        { label: "counting", color: "var(--data-blue)", points: history.map((h) => [h.ep, h.closed]) },
        { label: "no count", color: "var(--data-amber)", points: history.map((h) => [h.ep, h.open]) },
        { label: "exact", color: "var(--data-blue)", dash: true, points: [[0, ex.closed.value], [Math.max(1, episodes), ex.closed.value]] },
        { label: "exact", color: "var(--data-amber)", dash: true, points: [[0, ex.open.value], [Math.max(1, episodes), ex.open.value]] },
      ],
    });
  };

  const drawLearnReadout = () => {
    const c = cfg();
    const cl = evaluatePolicy(makeRng(999), closedAgent.policy(), { ...c, counts: true }, EVAL_SHOES);
    const op = evaluatePolicy(makeRng(999), openAgent.policy(), { ...c, counts: false }, EVAL_SHOES);
    const pct = ex.closed.value > 0 ? Math.max(0, (cl / ex.closed.value) * 100) : 0;
    history.push({ ep: episodes, closed: cl, open: op });
    if (history.length > 600) history.shift();
    learnReadout.innerHTML = `
      <div class="stat"><span class="k">episodes trained</span><span class="v">${episodes.toLocaleString("en-US")}</span><span class="sub">shoes played to learn</span></div>
      <div class="stat"><span class="k">counting policy</span><span class="v">${cl.toFixed(2)}</span><span class="sub">${pct.toFixed(0)}% of exact ${ex.closed.value.toFixed(2)}</span></div>
      <div class="stat"><span class="k">no-count policy</span><span class="v">${op.toFixed(2)}</span><span class="sub">exact ceiling ${ex.open.value.toFixed(2)}</span></div>
      <div class="stat"><span class="k">value of counting</span><span class="v">${(cl - op).toFixed(2)}</span><span class="sub">growth/shoe the count buys</span></div>`;
  };

  const drawPlay = () => {
    drawGrid();
    drawPlayReadout();
    drawHist();
  };
  const drawLearningAll = () => {
    drawLearned();
    drawCurve();
    drawLearnReadout();
  };

  // --- loops ---
  const trainBatch = () => {
    for (let i = 0; i < TRAIN_PER_TICK; i++) {
      closedAgent.trainEpisode(trainRng);
      openAgent.trainEpisode(trainRng);
    }
    episodes += TRAIN_PER_TICK;
    learnTick += 1;
    if (learnTick % 4 === 0) drawLearningAll();
  };

  const revealMs = () => 1100 - Number(speed.input.value) * 100;

  const stop = () => {
    if (learnTimer) clearInterval(learnTimer);
    if (playTimer) clearInterval(playTimer);
    learnTimer = playTimer = null;
    runBtn.classList.remove("on");
    runBtn.textContent = "play";
  };
  const start = () => {
    if (learnTimer) return stop();
    runBtn.classList.add("on");
    runBtn.textContent = "pause";
    learnTimer = setInterval(trainBatch, LEARN_MS);
    playTimer = setInterval(() => {
      playRound();
      drawPlay();
    }, revealMs());
  };

  const syncLabels = () => {
    const t = Number(edge.input.value);
    const l = 1 - 0.5 * t;
    hands.out.textContent = hands.input.value;
    edge.out.textContent =
      `win +100% / lose −${Math.round(l * 100)}%` +
      (t >= 0.999 ? " (×2/÷2)" : t <= 0.001 ? " (even)" : "");
    initBal.out.textContent = money(Number(initBal.input.value));
    const cv = Number(cash.input.value);
    cash.out.textContent =
      cv > 0 ? money(cv) + " income" : cv < 0 ? money(cv) + " to play" : "$0";
    alpha.out.textContent = Number(alpha.input.value).toFixed(3);
    eps.out.textContent = Number(eps.input.value).toFixed(2);
    optim.out.textContent = Number(optim.input.value).toFixed(1);
    speed.out.textContent = Number(speed.input.value).toFixed(0);
  };

  const onConfigChange = (e) => {
    syncLabels();
    const c = cfg();
    const src = e && e.target;
    if (c.nHands !== curN) {
      stop();
      rebuild();
    } else if (src === initBal.input) {
      resetPlay();
    } else {
      closedAgent.reconfigure({ ...c, counts: true });
      openAgent.reconfigure({ ...c, counts: false });
      recomputeExact();
    }
    if (src === speed.input && playTimer) {
      clearInterval(playTimer);
      playTimer = setInterval(() => {
        playRound();
        drawPlay();
      }, revealMs());
    }
    drawExact();
    drawPlay();
    drawLearningAll();
  };

  // --- wiring ---
  runBtn.addEventListener("click", start);
  stepBtn.addEventListener("click", () => {
    trainBatch();
    playRound();
    drawPlay();
    drawLearningAll();
  });
  resetBtn.addEventListener("click", () => {
    stop();
    resetPlay();
    drawExact();
    drawPlay();
    drawLearningAll();
  });
  bettorBtn.addEventListener("click", () => {
    bettor = bettor === "learned" ? "exact" : bettor === "exact" ? "no-count" : "learned";
    bettorBtn.textContent = "bettor: " + bettor;
    resetHist();
    drawPlay();
  });
  [hands, edge, alpha, eps, optim].forEach((c) =>
    c.input.addEventListener("input", onConfigChange),
  );
  initBal.input.addEventListener("input", onConfigChange);
  cash.input.addEventListener("input", syncLabels);
  speed.input.addEventListener("input", onConfigChange);

  syncLabels();
  rebuild();
  drawExact();
  drawPlay();
  drawLearningAll();
};
