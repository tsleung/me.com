import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

// ----- shannon's mind-reading machine -----
// state key (3 bits):
//   a: machine won round n-1
//   b: player switched between n-2 and n-1
//   c: machine won round n-2
// index = a + 2b + 4c  (0..7)
// each cell: { tendency: 'stay' | 'switch', confidence: 0 | 1 }
// predict: if confidence=1 use tendency, else random
// update: if observed matches tendency -> confidence=1
//         else if confidence was 0 -> flip tendency
//              else confidence=0  (hysteresis — needs two misses to flip)

const NUM_CELLS = 8;
const state = {
  round: 1,
  scoreM: 0,
  scoreY: 0,
  history: [],            // [{ you, machine, hit, stateIdx }]
  cells: Array.from({ length: NUM_CELLS }, () => ({
    tendency: Math.random() < 0.5 ? "stay" : "switch",
    confidence: 0,
  })),
  currentStateIdx: null,  // state for the upcoming prediction
  currentBits: null,      // { a, b, c }
  pendingPred: null,      // prediction about to be committed
  mode: "classic",
};

function computeState() {
  const h = state.history;
  if (h.length < 2) return null;
  const last = h[h.length - 1];
  const prev = h[h.length - 2];
  const a = last.hit ? 1 : 0;
  const b = last.you !== prev.you ? 1 : 0;
  const c = prev.hit ? 1 : 0;
  return { a, b, c, idx: a + 2 * b + 4 * c };
}

function predict() {
  const s = computeState();
  if (!s) return { move: Math.random() < 0.5 ? 0 : 1, stateIdx: null };
  const cell = state.cells[s.idx];
  const lastYou = state.history[state.history.length - 1].you;
  let move;
  if (cell.confidence === 1) {
    move = cell.tendency === "stay" ? lastYou : 1 - lastYou;
  } else {
    move = Math.random() < 0.5 ? 0 : 1;
  }
  return { move, stateIdx: s.idx, bits: s };
}

function updateCell(stateIdx, observed) {
  const cell = state.cells[stateIdx];
  if (observed === cell.tendency) {
    cell.confidence = 1;
  } else {
    if (cell.confidence === 0) {
      cell.tendency = observed;
    } else {
      cell.confidence = 0;
    }
  }
}

function play(you) {
  const pred = predict();
  const hit = pred.move === you;
  if (hit) state.scoreM++; else state.scoreY++;

  // update memory cell using the state we predicted from
  if (pred.stateIdx !== null && state.history.length >= 1) {
    const lastYou = state.history[state.history.length - 1].you;
    const observed = you === lastYou ? "stay" : "switch";
    updateCell(pred.stateIdx, observed);
  }

  state.history.push({
    you,
    machine: pred.move,
    hit,
    stateIdx: pred.stateIdx,
  });
  state.round++;

  // pre-compute state for the next prediction (for hood display)
  const nextState = computeState();
  state.currentStateIdx = nextState ? nextState.idx : null;
  state.currentBits = nextState;

  render({ justPlayed: { hit, machine: pred.move } });
}

function reset() {
  state.round = 1;
  state.scoreM = 0;
  state.scoreY = 0;
  state.history = [];
  state.cells = Array.from({ length: NUM_CELLS }, () => ({
    tendency: Math.random() < 0.5 ? "stay" : "switch",
    confidence: 0,
  }));
  state.currentStateIdx = null;
  state.currentBits = null;
  render({ reset: true });
}

// ----- DOM refs -----
const $ = (id) => document.getElementById(id);
const scoreM = $("score-m");
const scoreY = $("score-y");
const roundNum = $("round-num");
const predValue = $("pred-value");
const predHint = $("pred-hint");
const bitA = $("bit-a");
const bitB = $("bit-b");
const bitC = $("bit-c");
const stateIdxEl = $("state-idx");
const rateEl = $("rate");
const hoodEl = $("hood");
const mainEl = document.querySelector("main");

document.querySelectorAll(".play-btn").forEach((b) =>
  b.addEventListener("click", () => play(+b.dataset.move))
);
$("reset").addEventListener("click", reset);
$("how-to").addEventListener("click", () => {
  const d = $("instructions");
  d.open = !d.open;
  if (d.open) d.scrollIntoView({ behavior: "smooth", block: "nearest" });
});
document.querySelectorAll(".mode-tab").forEach((b) =>
  b.addEventListener("click", () => setMode(b.dataset.mode))
);

function setMode(m) {
  state.mode = m;
  document.querySelectorAll(".mode-tab").forEach((b) => {
    const on = b.dataset.mode === m;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on);
  });
  if (m === "hood") {
    hoodEl.hidden = false;
    mainEl.classList.add("hood-open");
  } else {
    hoodEl.hidden = true;
    mainEl.classList.remove("hood-open");
  }
  renderCells();
  renderAccuracy();
}

// ----- keyboard -----
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.key === "0") play(0);
  else if (e.key === "1") play(1);
  else if (e.key === "r" || e.key === "R") reset();
});

// ----- rendering -----
function render({ justPlayed, reset: wasReset } = {}) {
  scoreM.textContent = state.scoreM;
  scoreY.textContent = state.scoreY;
  roundNum.textContent = state.round;

  if (justPlayed) {
    predValue.textContent = justPlayed.machine;
    predValue.classList.remove("hit", "miss", "pop");
    predValue.classList.add(justPlayed.hit ? "hit" : "miss");
    // force reflow to retrigger the pop animation
    void predValue.offsetWidth;
    predValue.classList.add("pop");
    predHint.textContent = justPlayed.hit ? "hit" : "miss";
  } else if (wasReset) {
    predValue.textContent = "?";
    predValue.classList.remove("hit", "miss", "pop");
    predHint.textContent = "play a bit to begin";
  }

  const n = state.history.length;
  const hits = state.history.filter((h) => h.hit).length;
  rateEl.textContent = n > 0
    ? `machine ${Math.round((100 * hits) / n)}%`
    : "—";

  renderBits();
  renderHistory();
  renderCells();
  renderAccuracy();
}

function renderBits() {
  const b = state.currentBits;
  bitA.textContent = b ? b.a : "—";
  bitB.textContent = b ? b.b : "—";
  bitC.textContent = b ? b.c : "—";
  document.querySelectorAll(".bit").forEach((el) =>
    el.classList.toggle("on", !!b)
  );
  stateIdxEl.textContent = state.currentStateIdx ?? "—";
}

// ----- history strip (d3) -----
const historyStrip = d3.select("#history-strip");
const HISTORY_N = 40;

function renderHistory() {
  const svg = historyStrip;
  const node = svg.node();
  if (!node) return;
  const { width } = node.getBoundingClientRect();
  const h = 56;
  svg.attr("viewBox", `0 0 ${width} ${h}`);

  const data = state.history.slice(-HISTORY_N);
  const cell = Math.min(14, Math.floor((width - 12) / HISTORY_N));
  const gap = 2;
  const totalW = data.length * (cell + gap) - gap;
  const xStart = width - totalW - 6;
  const rowYou = 10;
  const rowMachine = 30;
  const dotY = 50;

  // you row
  const you = svg.selectAll("rect.you").data(data, (_, i) => state.history.length - data.length + i);
  you.join(
    (enter) => enter.append("rect").attr("class", "you").attr("y", rowYou).attr("height", cell)
      .attr("opacity", 0),
    (update) => update,
    (exit) => exit.remove()
  )
    .attr("x", (_, i) => xStart + i * (cell + gap))
    .attr("width", cell)
    .attr("height", cell)
    .attr("rx", 1)
    .attr("fill", (d) => d.you === 0 ? "#4aa8ff" : "#7ec3ff")
    .transition().duration(200).attr("opacity", 1);

  // machine row
  const mach = svg.selectAll("rect.machine").data(data, (_, i) => state.history.length - data.length + i);
  mach.join(
    (enter) => enter.append("rect").attr("class", "machine").attr("y", rowMachine).attr("height", cell)
      .attr("opacity", 0),
    (update) => update,
    (exit) => exit.remove()
  )
    .attr("x", (_, i) => xStart + i * (cell + gap))
    .attr("width", cell)
    .attr("height", cell)
    .attr("rx", 1)
    .attr("fill", (d) => d.machine === 0 ? "#ff3a3a" : "#ff7a7a")
    .transition().duration(200).attr("opacity", 1);

  // hit markers
  const hits = svg.selectAll("circle.hit").data(data, (_, i) => state.history.length - data.length + i);
  hits.join(
    (enter) => enter.append("circle").attr("class", "hit").attr("r", 2).attr("opacity", 0),
    (update) => update,
    (exit) => exit.remove()
  )
    .attr("cx", (_, i) => xStart + i * (cell + gap) + cell / 2)
    .attr("cy", dotY)
    .attr("fill", (d) => d.hit ? "#f2f2ee" : "transparent")
    .attr("stroke", (d) => d.hit ? "none" : "#2a2a2e")
    .transition().duration(200).attr("opacity", 1);

  // row labels
  svg.selectAll("text.label").data(["you", "mach"]).join(
    (enter) => enter.append("text").attr("class", "label")
      .attr("x", 4)
      .attr("font-size", 9)
      .attr("fill", "#8d8d92")
      .attr("font-family", "ui-monospace, Menlo, monospace")
      .attr("dominant-baseline", "hanging")
  )
    .attr("y", (_, i) => i === 0 ? rowYou + 2 : rowMachine + 2)
    .text((d) => d);
}

// ----- memory cells (d3) -----
const cellsSvg = d3.select("#cells-svg");

function renderCells() {
  if (state.mode !== "hood") return;
  const svg = cellsSvg;
  const node = svg.node();
  if (!node) return;
  const { width } = node.getBoundingClientRect();
  const height = width / 1.4;
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const cols = 4, rows = 2;
  const padX = 12, padY = 12;
  const gapX = 8, gapY = 10;
  const cw = (width - 2 * padX - (cols - 1) * gapX) / cols;
  const ch = (height - 2 * padY - (rows - 1) * gapY) / rows;

  const layout = state.cells.map((cell, i) => ({
    i,
    x: padX + (i % cols) * (cw + gapX),
    y: padY + Math.floor(i / cols) * (ch + gapY),
    w: cw,
    h: ch,
    cell,
    active: i === state.currentStateIdx,
  }));

  const groups = svg.selectAll("g.cell").data(layout, (d) => d.i);
  const enter = groups.enter().append("g").attr("class", "cell");

  enter.append("rect").attr("class", "cell-bg").attr("rx", 3);
  enter.append("text").attr("class", "cell-idx");
  enter.append("text").attr("class", "cell-arrow");
  enter.append("circle").attr("class", "cell-dot");
  enter.append("text").attr("class", "cell-meta");

  const merged = enter.merge(groups);

  merged.select("rect.cell-bg")
    .transition().duration(200)
    .attr("x", (d) => d.x)
    .attr("y", (d) => d.y)
    .attr("width", (d) => d.w)
    .attr("height", (d) => d.h)
    .attr("fill", (d) => d.active ? "#1a1313" : "#17171a")
    .attr("stroke", (d) => d.active ? "#ff3a3a" : "#2a2a2e")
    .attr("stroke-width", (d) => d.active ? 1.5 : 1);

  merged.select("text.cell-idx")
    .attr("x", (d) => d.x + 6)
    .attr("y", (d) => d.y + 12)
    .attr("font-size", 9)
    .attr("fill", "#8d8d92")
    .attr("font-family", "ui-monospace, Menlo, monospace")
    .text((d) => d.i);

  merged.select("text.cell-arrow")
    .attr("x", (d) => d.x + d.w / 2)
    .attr("y", (d) => d.y + d.h / 2 + 1)
    .attr("text-anchor", "middle")
    .attr("dominant-baseline", "middle")
    .attr("font-size", (d) => Math.min(28, d.h * 0.55))
    .attr("font-family", "ui-monospace, Menlo, monospace")
    .attr("fill", (d) => d.active ? "#f2f2ee" : "#bdbdb8")
    .text((d) => d.cell.tendency === "stay" ? "=" : "~");

  merged.select("circle.cell-dot")
    .transition().duration(200)
    .attr("cx", (d) => d.x + d.w - 9)
    .attr("cy", (d) => d.y + d.h - 9)
    .attr("r", 4)
    .attr("fill", (d) => d.cell.confidence ? "#3ddc84" : "transparent")
    .attr("stroke", (d) => d.cell.confidence ? "#3ddc84" : "#3a3a40");

  // bit pattern label (abc)
  merged.select("text.cell-meta")
    .attr("x", (d) => d.x + d.w - 6)
    .attr("y", (d) => d.y + 12)
    .attr("text-anchor", "end")
    .attr("font-size", 9)
    .attr("fill", "#4e4e54")
    .attr("font-family", "ui-monospace, Menlo, monospace")
    .text((d) => {
      const a = d.i & 1, b = (d.i >> 1) & 1, c = (d.i >> 2) & 1;
      return `${c}${b}${a}`;
    });

  groups.exit().remove();
}

// ----- accuracy chart (d3) -----
const accSvg = d3.select("#accuracy-chart");
const ACC_WINDOW = 20;

function rollingAccuracy() {
  const out = [];
  for (let i = 0; i < state.history.length; i++) {
    const start = Math.max(0, i - ACC_WINDOW + 1);
    const slice = state.history.slice(start, i + 1);
    const hits = slice.filter((h) => h.hit).length;
    out.push({ round: i + 1, acc: hits / slice.length });
  }
  return out;
}

function renderAccuracy() {
  if (state.mode !== "hood") return;
  const svg = accSvg;
  const node = svg.node();
  if (!node) return;
  const { width } = node.getBoundingClientRect();
  const height = 110;
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const data = rollingAccuracy();
  const ml = 28, mr = 10, mt = 10, mb = 18;
  const w = width - ml - mr;
  const h = height - mt - mb;

  const x = d3.scaleLinear()
    .domain([1, Math.max(20, data.length)])
    .range([ml, ml + w]);
  const y = d3.scaleLinear()
    .domain([0, 1])
    .range([mt + h, mt]);

  // grid: 0%, 50%, 100%
  const grid = svg.selectAll("line.grid").data([0, 0.5, 1]);
  grid.join(
    (enter) => enter.append("line").attr("class", "grid"),
    (update) => update,
    (exit) => exit.remove()
  )
    .attr("x1", ml).attr("x2", ml + w)
    .attr("y1", (d) => y(d)).attr("y2", (d) => y(d))
    .attr("stroke", (d) => d === 0.5 ? "#3a3a40" : "#2a2a2e")
    .attr("stroke-dasharray", (d) => d === 0.5 ? "2 3" : null);

  const yLabels = svg.selectAll("text.y-label").data([0, 0.5, 1]);
  yLabels.join(
    (enter) => enter.append("text").attr("class", "y-label")
      .attr("font-size", 9)
      .attr("font-family", "ui-monospace, Menlo, monospace")
      .attr("fill", "#8d8d92")
      .attr("text-anchor", "end")
      .attr("dominant-baseline", "middle"),
    (update) => update,
    (exit) => exit.remove()
  )
    .attr("x", ml - 6)
    .attr("y", (d) => y(d))
    .text((d) => `${Math.round(d * 100)}%`);

  // baseline 50% reference label
  svg.selectAll("text.baseline").data([0]).join(
    (enter) => enter.append("text").attr("class", "baseline")
      .attr("font-size", 9)
      .attr("font-family", "ui-monospace, Menlo, monospace")
      .attr("fill", "#4e4e54")
  )
    .attr("x", ml + w - 4)
    .attr("y", y(0.5) - 4)
    .attr("text-anchor", "end")
    .text("coin flip");

  // line
  const line = d3.line()
    .x((d) => x(d.round))
    .y((d) => y(d.acc))
    .curve(d3.curveMonotoneX);

  const path = svg.selectAll("path.acc").data(data.length ? [data] : []);
  path.join(
    (enter) => enter.append("path").attr("class", "acc")
      .attr("fill", "none")
      .attr("stroke", "#ff3a3a")
      .attr("stroke-width", 1.5),
    (update) => update,
    (exit) => exit.remove()
  )
    .attr("d", line);

  // current point
  const last = data[data.length - 1];
  const dot = svg.selectAll("circle.acc-dot").data(last ? [last] : []);
  dot.join(
    (enter) => enter.append("circle").attr("class", "acc-dot")
      .attr("r", 2.5).attr("fill", "#ff3a3a"),
    (update) => update,
    (exit) => exit.remove()
  )
    .attr("cx", (d) => x(d.round))
    .attr("cy", (d) => y(d.acc));
}

// ----- init + resize -----
window.addEventListener("resize", () => {
  renderHistory();
  renderCells();
  renderAccuracy();
});

render();
