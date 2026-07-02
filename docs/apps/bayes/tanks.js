// demo 3: the german tank problem — capture serials, estimate the run,
// then check the answer against "the records". state lives inside
// mountTanks; everything above it is a pure string/geometry helper.

import {
  tankEstimate,
  makeRng,
  sampleSerials,
  simulateEstimates,
  binCounts,
} from "./math.js";

// --- pure helpers ----------------------------------------------------------

const W = 640;
const NL_H = 110;
const AXIS_Y = 78;
const HIST_H = 90;
const HIST_BASE = 86;
const HIST_BINS = 33;
const CHAR_W = 6.6; // approx advance of 11px monospace

const r2 = (v) => Math.round(v * 100) / 100;

const fmt = (n) => Math.round(n).toLocaleString("en-US");

const signedPct = (pct) => {
  const abs = Math.abs(pct).toFixed(1);
  const sign = pct < 0 && abs !== "0.0" ? "−" : "+";
  return `${sign}${abs}%`;
};

const errorPct = (est, trueN) => ((est - trueN) / trueN) * 100;

// smallest clean step that keeps the axis at <= 5 intervals
const pickTickStep = (axisMax) =>
  [25, 50, 100, 250, 500, 1000].find((s) => axisMax / s <= 5) ?? 1000;

// keep a middle-anchored label of width w inside the viewbox
const clampLabelX = (cx, w) => Math.min(Math.max(cx, w / 2 + 2), W - w / 2 - 2);

// place the "m = …" label beside the max dot without crossing the
// estimate / records verticals; null means "doesn't fit, skip it"
// (the value is always in the counters line and the table).
const mLabelSpec = (mx, label, blockedXs) => {
  const w = label.length * CHAR_W;
  const fits = (x0, x1) =>
    x0 >= 4 &&
    x1 <= W - 4 &&
    blockedXs.every((bx) => bx < x0 - 5 || bx > x1 + 5);
  if (fits(mx - 8 - w, mx - 8)) return { x: mx - 8, anchor: "end" };
  if (fits(mx + 8, mx + 8 + w)) return { x: mx + 8, anchor: "start" };
  return null;
};

const dotSvg = (cx, r, serial) =>
  `<circle cx="${r2(cx)}" cy="${AXIS_Y}" r="${r}" fill="var(--data-blue)" ` +
  `stroke="var(--panel)" stroke-width="2"><title>serial ${serial}</title></circle>`;

const numberLineSvg = ({ captured, m, est, trueN, revealed }) => {
  const k = captured.length;
  const axisMax = Math.max(100, 1.15 * Math.max(m, est, revealed ? trueN : 0));
  const x = (v) => (v / axisMax) * W;
  const parts = [];

  // axis + ticks
  parts.push(
    `<line x1="0" y1="${AXIS_Y}" x2="${W}" y2="${AXIS_Y}" stroke="var(--line)" stroke-width="1"/>`,
  );
  const step = pickTickStep(axisMax);
  for (let t = 0; t <= axisMax; t += step) {
    const tx = r2(x(t));
    const label = fmt(t);
    const lx = r2(clampLabelX(x(t), label.length * CHAR_W));
    parts.push(
      `<line x1="${tx}" y1="${AXIS_Y}" x2="${tx}" y2="${AXIS_Y + 6}" stroke="var(--line)" stroke-width="1"/>`,
      `<text x="${lx}" y="97" text-anchor="middle">${label}</text>`,
    );
  }

  const estX = k ? x(est) : null;
  const trueX = revealed ? x(trueN) : null;

  // estimate marker: vertical tick + pennant, amber (identity via legend)
  if (k) {
    const ex = r2(estX);
    const tip = r2(estX > W - 16 ? estX - 12 : estX + 12);
    parts.push(
      `<g><title>estimate ${fmt(est)}</title>` +
        `<line x1="${ex}" y1="26" x2="${ex}" y2="${AXIS_Y}" stroke="var(--data-amber)" stroke-width="2"/>` +
        `<polygon points="${ex},20 ${tip},25 ${ex},30" fill="var(--data-amber)"/>` +
        `</g>`,
    );
  }

  // records marker, only after reveal
  if (revealed) {
    const tx = r2(trueX);
    parts.push(
      `<g><title>the records: ${fmt(trueN)}</title>` +
        `<line x1="${tx}" y1="14" x2="${tx}" y2="${AXIS_Y}" stroke="var(--data-red)" stroke-width="2"/>` +
        `</g>`,
    );
  }

  // captured dots; the max drawn last and emphasized
  for (const s of [...captured].sort((a, b) => a - b)) {
    if (s !== m) parts.push(dotSvg(x(s), 4.5, s));
  }
  if (k) {
    parts.push(dotSvg(x(m), 6, m));
    const label = `m = ${fmt(m)}`;
    const spec = mLabelSpec(
      x(m),
      label,
      [estX, trueX].filter((v) => v !== null),
    );
    if (spec) {
      parts.push(
        `<text x="${r2(spec.x)}" y="62" text-anchor="${spec.anchor}">${label}</text>`,
      );
    }
  }

  const desc = k
    ? `number line from 0 to ${fmt(axisMax)}: ${k} captured serial${
        k === 1 ? "" : "s"
      } in blue, estimate ${fmt(est)} marked in amber${
        revealed ? `, records value ${fmt(trueN)} marked in red` : ""
      }`
    : "empty number line from 0 to 100 — no tanks captured yet";
  return `<svg viewBox="0 0 ${W} ${NL_H}" role="img" aria-label="${desc}">${parts.join("")}</svg>`;
};

const histogramSvg = ({ counts, trueN, k }) => {
  const maxC = Math.max(...counts, 1);
  const binW = W / HIST_BINS;
  const parts = [
    `<line x1="0" y1="${HIST_BASE}" x2="${W}" y2="${HIST_BASE}" stroke="var(--line)" stroke-width="1"/>`,
  ];
  counts.forEach((c, i) => {
    if (c === 0) return;
    const h = Math.max(1, (c / maxC) * 70);
    parts.push(
      `<rect x="${r2(i * binW + 1)}" y="${r2(HIST_BASE - h)}" width="${r2(binW - 2)}" height="${r2(h)}" fill="var(--data-blue)"/>`,
    );
  });
  const tx = r2(W / 2.2); // trueN over a [0, 2.2·trueN] axis
  parts.push(
    `<line x1="${tx}" y1="10" x2="${tx}" y2="${HIST_BASE}" stroke="var(--data-red)" stroke-width="2"/>`,
  );
  const desc =
    `histogram of 1,000 simulated estimates at k = ${k}; ` +
    `the true run of ${fmt(trueN)} is marked by a red line near the center`;
  return `<svg viewBox="0 0 ${W} ${HIST_H}" role="img" aria-label="${desc}">${parts.join("")}</svg>`;
};

const histTableHtml = (counts, trueN) => {
  const span = (2.2 * trueN) / HIST_BINS;
  const rows = counts
    .map(
      (c, i) =>
        `<tr><td>${fmt(i * span)}–${fmt((i + 1) * span)}</td><td>${c}</td></tr>`,
    )
    .join("");
  return (
    `<table><thead><tr><th scope="col">estimate range</th>` +
    `<th scope="col">count of 1,000</th></tr></thead><tbody>${rows}</tbody></table>`
  );
};

const twinTableHtml = ({ captured, k, m, est, trueN, revealed }) => {
  const serials = k ? [...captured].sort((a, b) => a - b).join(", ") : "—";
  const rows = [
    ["captured serials", serials],
    ["captured (k)", String(k)],
    ["largest serial (m)", k ? fmt(m) : "—"],
    ["estimate", k ? fmt(est) : "—"],
  ];
  if (revealed) {
    rows.push(["the records", fmt(trueN)]);
    rows.push(["error", signedPct(errorPct(est, trueN))]);
  }
  const body = rows
    .map(([q, v]) => `<tr><td>${q}</td><td>${v}</td></tr>`)
    .join("");
  return (
    `<table><thead><tr><th scope="col">quantity</th>` +
    `<th scope="col">value</th></tr></thead><tbody>${body}</tbody></table>`
  );
};

const legendHtml = (revealed) => {
  const items = [
    `<li><span class="swatch tanks-swatch-blue"></span>captured serial</li>`,
    `<li><span class="swatch tanks-swatch-amber"></span>estimate</li>`,
  ];
  if (revealed) {
    items.push(`<li><span class="swatch tanks-swatch-red"></span>the records</li>`);
  }
  return items.join("");
};

// --- mount ------------------------------------------------------------------

export function mountTanks(root) {
  const state = {
    trueN: 276, // february 1944, panther month — hidden until reveal
    rng: makeRng(20260701),
    pool: [],
    captured: [],
    revealed: false,
  };
  state.pool = sampleSerials(state.trueN, state.trueN, state.rng);

  root.innerHTML = `
    <div class="control-row">
      <button type="button" id="tanks-capture" class="btn btn-primary">capture a tank</button>
      <button type="button" id="tanks-capture-5" class="btn">capture 5</button>
      <button type="button" id="tanks-reveal" class="btn">reveal the records</button>
      <button type="button" id="tanks-new-run" class="btn">new production run</button>
    </div>
    <p class="tanks-counters" id="tanks-counters"></p>
    <div class="hero" id="tanks-hero" aria-live="polite">—</div>
    <p class="hero-caption" id="tanks-hero-caption">capture a tank to estimate</p>
    <p class="hero-caption" id="tanks-one-tank" hidden>one tank: 2m − 1. double what you see.</p>
    <p class="tanks-reveal-line" id="tanks-reveal-line" aria-live="polite" hidden></p>
    <div class="tanks-chart" id="tanks-numberline"></div>
    <ul class="legend" id="tanks-legend" hidden></ul>
    <div class="tanks-hist" id="tanks-hist" hidden>
      <p class="tanks-hist-caption" id="tanks-hist-caption"></p>
      <div class="tanks-chart" id="tanks-hist-chart"></div>
      <details><summary>view as table</summary><div id="tanks-hist-table"></div></details>
    </div>
    <details><summary>view as table</summary><div id="tanks-table"></div></details>
  `;

  const el = (id) => root.querySelector(`#${id}`);
  const refs = {
    capture: el("tanks-capture"),
    capture5: el("tanks-capture-5"),
    reveal: el("tanks-reveal"),
    newRun: el("tanks-new-run"),
    counters: el("tanks-counters"),
    hero: el("tanks-hero"),
    heroCaption: el("tanks-hero-caption"),
    oneTank: el("tanks-one-tank"),
    revealLine: el("tanks-reveal-line"),
    numberline: el("tanks-numberline"),
    legend: el("tanks-legend"),
    hist: el("tanks-hist"),
    histCaption: el("tanks-hist-caption"),
    histChart: el("tanks-hist-chart"),
    histTable: el("tanks-hist-table"),
    table: el("tanks-table"),
  };

  const capture = (count) => {
    for (let i = 0; i < count && state.pool.length > 0; i += 1) {
      state.captured.push(state.pool.pop());
    }
  };

  const render = () => {
    const { trueN, revealed } = state;
    const k = state.captured.length;
    const m = k ? Math.max(...state.captured) : 0;
    const est = k ? Math.round(tankEstimate(m, k)) : 0;

    refs.capture.disabled = state.pool.length === 0;
    refs.capture5.disabled = state.pool.length === 0;
    refs.reveal.disabled = revealed || k === 0;

    refs.counters.textContent = `captured: ${fmt(k)} · largest serial: ${k ? fmt(m) : "—"}`;
    refs.hero.textContent = k ? fmt(est) : "—";
    refs.heroCaption.textContent = k
      ? "estimated production run"
      : "capture a tank to estimate";
    refs.oneTank.hidden = k !== 1;

    refs.revealLine.hidden = !revealed;
    refs.revealLine.textContent = revealed
      ? `the records say ${fmt(trueN)} — you were off by ${signedPct(errorPct(est, trueN))}.`
      : "";

    refs.numberline.innerHTML = numberLineSvg({
      captured: state.captured,
      m,
      est,
      trueN,
      revealed,
    });
    refs.legend.hidden = k === 0;
    refs.legend.innerHTML = legendHtml(revealed);

    const showHist = revealed && k > 0;
    refs.hist.hidden = !showHist;
    if (showHist) {
      const kk = Math.min(k, trueN); // simulateEstimates needs k <= n
      const sims = simulateEstimates(trueN, kk, 1000, makeRng(7));
      const counts = binCounts(sims, 0, 2.2 * trueN, HIST_BINS);
      refs.histCaption.textContent = `the estimator, re-run 1,000 times at k = ${kk} — more captures tighten it`;
      refs.histChart.innerHTML = histogramSvg({ counts, trueN, k: kk });
      refs.histTable.innerHTML = histTableHtml(counts, trueN);
    }

    refs.table.innerHTML = twinTableHtml({
      captured: state.captured,
      k,
      m,
      est,
      trueN,
      revealed,
    });
  };

  refs.capture.addEventListener("click", () => {
    capture(1);
    render();
  });
  refs.capture5.addEventListener("click", () => {
    capture(5);
    render();
  });
  refs.reveal.addEventListener("click", () => {
    state.revealed = true;
    render();
  });
  refs.newRun.addEventListener("click", () => {
    state.trueN = 150 + Math.floor(state.rng() * 1850);
    state.pool = sampleSerials(state.trueN, state.trueN, state.rng);
    state.captured = [];
    state.revealed = false;
    render();
  });

  render();
}
