// demo 1: base-rate fallacy — "the test says you're guilty".
// dot grid of 1000 players + flagged-group bar. all math from math.js.

import { posterior, confusionCounts, makeRng, sampleSerials } from "./math.js";

const N = 1000;
const COLS = 40;
const PITCH = 14;
const DOT_R = 4;
const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_LABEL_PX = 40;

// block order along the fixed permutation: [tp, fn, fp, tn]
const STATES = [
  {
    key: "tp",
    color: "var(--data-blue)",
    title: "cheating · flagged (true positive)",
    legend: "cheating, flagged",
  },
  {
    key: "fn",
    color: "var(--data-amber)",
    title: "cheating · cleared (missed cheater)",
    legend: "cheating, cleared",
  },
  {
    key: "fp",
    color: "var(--data-red)",
    title: "honest · flagged (false positive)",
    legend: "honest, flagged",
  },
  {
    key: "tn",
    color: "var(--data-dim)",
    title: "honest · cleared (true negative)",
    legend: "honest, cleared",
  },
];

const PRESETS = {
  anticheat: { label: "anti-cheat 90 / 10", base: 10, sens: 90, spec: 90 },
  eddy: {
    label: "cancer screening (eddy 1982)",
    base: 1,
    sens: 79.2,
    spec: 90.4,
  },
};

// --- pure helpers -----------------------------------------------------------

const fmtInt = (n) => n.toLocaleString("en-US");

// percent readout: 1 decimal below 10%, whole number otherwise
const fmtPct = (p) => (p < 10 ? p.toFixed(1) : String(Math.round(p))) + "%";

// slider readout: drop the decimal when it's a whole number
const fmtSlider = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)) + "%";

const freqSentence = ({ tp, fp }) => {
  const flagged = tp + fp;
  if (flagged === 0) return `of ${fmtInt(N)} players: no one gets flagged.`;
  const verb = flagged === 1 ? "gets" : "get";
  return `of ${fmtInt(N)} players: ${fmtInt(flagged)} ${verb} flagged — ${fmtInt(tp)} cheating, ${fmtInt(fp)} honest.`;
};

const stateAtRank = (rank, { tp, fn, fp }) =>
  rank < tp ? 0 : rank < tp + fn ? 1 : rank < tp + fn + fp ? 2 : 3;

const gridAria = ({ tp, fn, fp, tn }) =>
  `dot grid of ${fmtInt(N)} players: ${tp} cheating and flagged, ` +
  `${fn} cheating but cleared, ${fp} honest but flagged, ` +
  `${tn} honest and cleared`;

// --- mount ------------------------------------------------------------------

export const mountDetector = (root) => {
  // one fixed permutation of cell indices — dots never reshuffle, only flip
  const perm = sampleSerials(N, N, makeRng(12)).map((s) => s - 1);

  root.innerHTML = `
    <div class="control-row">
      <div class="control">
        <label class="control-label" for="detector-base">
          cheaters in the population
          <span class="control-value" data-value="base"></span>
        </label>
        <input type="range" id="detector-base" min="1" max="50" step="1" value="10" />
      </div>
      <div class="control">
        <label class="control-label" for="detector-accuracy">
          test accuracy
          <span class="control-value" data-value="acc"></span>
        </label>
        <input type="range" id="detector-accuracy" min="50" max="99" step="1" value="90" />
      </div>
    </div>
    <details class="detector-split">
      <summary>split sensitivity / specificity</summary>
      <div class="control-row">
        <div class="control">
          <label class="control-label" for="detector-sens">
            sensitivity (catches cheaters)
            <span class="control-value" data-value="sens"></span>
          </label>
          <input type="range" id="detector-sens" min="50" max="99.9" step="0.1" value="90" />
        </div>
        <div class="control">
          <label class="control-label" for="detector-spec">
            specificity (clears honest players)
            <span class="control-value" data-value="spec"></span>
          </label>
          <input type="range" id="detector-spec" min="50" max="99.9" step="0.1" value="90" />
        </div>
      </div>
    </details>
    <div class="control-row" role="group" aria-label="presets">
      <button type="button" class="btn" data-preset="anticheat">${PRESETS.anticheat.label}</button>
      <button type="button" class="btn" data-preset="eddy">${PRESETS.eddy.label}</button>
    </div>
    <div class="detector-readout">
      <div aria-live="polite">
        <div class="hero" id="detector-hero"></div>
        <div class="hero-caption">chance a flagged player is actually cheating</div>
      </div>
      <div class="detector-freq" id="detector-freq"></div>
    </div>
    <svg id="detector-grid" class="detector-grid-svg" viewBox="0 0 ${COLS * PITCH} ${(N / COLS) * PITCH}" role="img" preserveAspectRatio="xMidYMid meet"></svg>
    <ul class="legend">
      ${STATES.map(
        (s) => `
      <li>
        <span class="swatch" style="background: ${s.color}"></span>
        <span>${s.legend} — <span data-legend="${s.key}"></span></span>
      </li>`,
      ).join("")}
    </ul>
    <div class="detector-bar-wrap">
      <div class="microlabel">everyone who got flagged</div>
      <div class="detector-bar" id="detector-bar" role="img">
        <div class="detector-bar-seg" data-seg="tp" style="background: var(--data-blue)"><span></span></div>
        <div class="detector-bar-seg" data-seg="fp" style="background: var(--data-red)"><span></span></div>
      </div>
      <div class="detector-bar-empty" data-bar-empty hidden>no one gets flagged</div>
      <ul class="legend">
        <li>
          <span class="swatch" style="background: var(--data-blue)"></span>
          <span>cheating — <span data-barlegend="tp"></span></span>
        </li>
        <li>
          <span class="swatch" style="background: var(--data-red)"></span>
          <span>honest — <span data-barlegend="fp"></span></span>
        </li>
      </ul>
    </div>
    <details>
      <summary>view as table</summary>
      <table>
        <thead>
          <tr>
            <th scope="col"></th>
            <th scope="col">flagged</th>
            <th scope="col">cleared</th>
            <th scope="col">total</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">cheating</th>
            <td data-cell="tp"></td><td data-cell="fn"></td><td data-cell="cheaters"></td>
          </tr>
          <tr>
            <th scope="row">honest</th>
            <td data-cell="fp"></td><td data-cell="tn"></td><td data-cell="honest"></td>
          </tr>
          <tr>
            <th scope="row">total</th>
            <td data-cell="flagged"></td><td data-cell="cleared"></td><td data-cell="n"></td>
          </tr>
        </tbody>
      </table>
    </details>
  `;

  const q = (sel) => root.querySelector(sel);
  const qa = (sel) => [...root.querySelectorAll(sel)];

  const baseInput = q("#detector-base");
  const accInput = q("#detector-accuracy");
  const sensInput = q("#detector-sens");
  const specInput = q("#detector-spec");
  const values = Object.fromEntries(
    qa("[data-value]").map((el) => [el.dataset.value, el]),
  );
  const chips = qa("[data-preset]");
  const heroEl = q("#detector-hero");
  const freqEl = q("#detector-freq");
  const svg = q("#detector-grid");
  const legendCounts = Object.fromEntries(
    qa("[data-legend]").map((el) => [el.dataset.legend, el]),
  );
  const barEl = q("#detector-bar");
  const barEmptyEl = q("[data-bar-empty]");
  const segs = Object.fromEntries(
    qa("[data-seg]").map((el) => [el.dataset.seg, el]),
  );
  const barLegendCounts = Object.fromEntries(
    qa("[data-barlegend]").map((el) => [el.dataset.barlegend, el]),
  );
  const cells = Object.fromEntries(
    qa("[data-cell]").map((el) => [el.dataset.cell, el]),
  );

  // build the 1000 dots once; render only flips fills at block boundaries
  const dots = Array.from({ length: N }, (_, cell) => {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String((cell % COLS) * PITCH + PITCH / 2));
    circle.setAttribute("cy", String(Math.floor(cell / COLS) * PITCH + PITCH / 2));
    circle.setAttribute("r", String(DOT_R));
    circle.setAttribute("stroke", "var(--panel)");
    circle.setAttribute("stroke-width", "2");
    const title = document.createElementNS(SVG_NS, "title");
    circle.appendChild(title);
    svg.appendChild(circle);
    return { circle, title };
  });
  const lastState = new Array(N).fill(-1);

  const state = { base: 10, sens: 90, spec: 90, preset: "anticheat" };

  const renderBar = (tp, fp) => {
    const flagged = tp + fp;
    barEl.hidden = flagged === 0;
    barEmptyEl.hidden = flagged !== 0;
    barLegendCounts.tp.textContent = fmtInt(tp);
    barLegendCounts.fp.textContent = fmtInt(fp);
    if (flagged === 0) return;
    barEl.setAttribute(
      "aria-label",
      `flagged players: ${tp} cheating, ${fp} honest`,
    );
    const gap = tp > 0 && fp > 0 ? 2 : 0;
    const width = barEl.clientWidth;
    const setSeg = (seg, count) => {
      seg.hidden = count === 0;
      seg.style.flexGrow = String(count);
      const px = ((width - gap) * count) / flagged;
      // direct-label inside only when it fits; the legend carries it otherwise
      seg.firstElementChild.textContent = px > MIN_LABEL_PX ? fmtInt(count) : "";
    };
    setSeg(segs.tp, tp);
    setSeg(segs.fp, fp);
  };

  const render = () => {
    const counts = confusionCounts(
      N,
      state.base / 100,
      state.sens / 100,
      state.spec / 100,
    );
    const { tp, fn, fp, tn } = counts;
    const flagged = tp + fp;
    const p =
      posterior(state.base / 100, state.sens / 100, state.spec / 100) * 100;

    heroEl.textContent = flagged === 0 ? "—" : fmtPct(p);
    freqEl.textContent = freqSentence(counts);

    values.base.textContent = state.base + "%";
    values.acc.textContent =
      state.sens === state.spec ? fmtSlider(state.sens) : "mixed";
    values.sens.textContent = state.sens.toFixed(1) + "%";
    values.spec.textContent = state.spec.toFixed(1) + "%";
    for (const chip of chips) {
      chip.classList.toggle("active", chip.dataset.preset === state.preset);
    }

    for (let rank = 0; rank < N; rank += 1) {
      const s = stateAtRank(rank, counts);
      if (s === lastState[rank]) continue;
      lastState[rank] = s;
      const dot = dots[perm[rank]];
      dot.circle.setAttribute("fill", STATES[s].color);
      dot.title.textContent = STATES[s].title;
    }
    svg.setAttribute("aria-label", gridAria(counts));

    legendCounts.tp.textContent = fmtInt(tp);
    legendCounts.fn.textContent = fmtInt(fn);
    legendCounts.fp.textContent = fmtInt(fp);
    legendCounts.tn.textContent = fmtInt(tn);

    renderBar(tp, fp);

    cells.tp.textContent = fmtInt(tp);
    cells.fn.textContent = fmtInt(fn);
    cells.fp.textContent = fmtInt(fp);
    cells.tn.textContent = fmtInt(tn);
    cells.cheaters.textContent = fmtInt(tp + fn);
    cells.honest.textContent = fmtInt(fp + tn);
    cells.flagged.textContent = fmtInt(flagged);
    cells.cleared.textContent = fmtInt(fn + tn);
    cells.n.textContent = fmtInt(N);
  };

  // --- event wiring ---------------------------------------------------------

  const clearPreset = () => {
    state.preset = null;
  };

  baseInput.addEventListener("input", () => {
    state.base = Number(baseInput.value);
    clearPreset();
    render();
  });

  accInput.addEventListener("input", () => {
    const v = Number(accInput.value);
    state.sens = v;
    state.spec = v;
    sensInput.value = String(v);
    specInput.value = String(v);
    clearPreset();
    render();
  });

  sensInput.addEventListener("input", () => {
    state.sens = Number(sensInput.value);
    clearPreset();
    render();
  });

  specInput.addEventListener("input", () => {
    state.spec = Number(specInput.value);
    clearPreset();
    render();
  });

  const applyPreset = (key) => {
    const preset = PRESETS[key];
    state.base = preset.base;
    state.sens = preset.sens;
    state.spec = preset.spec;
    state.preset = key;
    baseInput.value = String(preset.base);
    sensInput.value = String(preset.sens);
    specInput.value = String(preset.spec);
    accInput.value = String(
      preset.sens === preset.spec
        ? preset.sens
        : Math.round((preset.sens + preset.spec) / 2),
    );
    render();
  };

  for (const chip of chips) {
    chip.addEventListener("click", () => applyPreset(chip.dataset.preset));
  }

  render();
};
