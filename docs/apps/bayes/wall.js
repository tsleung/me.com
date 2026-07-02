// wall.js — demo 2: Gott's Copernican principle ("how long will the wall
// stand?"). Mounts into #wall-app. Pure helpers up top, one render pass,
// event wiring at the bottom — no state outside mountWall's closure.

import { gottInterval, gottMedianTotal } from "./math.js";

// --- data -------------------------------------------------------------

const PRESETS = [
  {
    id: "berlin",
    chip: "berlin wall, 1969",
    thing: "berlin wall",
    age: 8,
    actual: 20,
    outcome: "fell november 1989",
    marker: "fell here",
  },
  {
    id: "ussr",
    chip: "ussr, 1977",
    thing: "ussr",
    age: 55,
    actual: 14,
    outcome: "dissolved 1991",
    marker: "dissolved here",
  },
  {
    id: "nature",
    chip: "nature (the journal), 1993",
    thing: "nature (the journal)",
    age: 123,
    actual: null,
    outcome: "still publishing",
    marker: null,
  },
  {
    id: "stonehenge",
    chip: "stonehenge, 1969",
    thing: "stonehenge",
    age: 3868,
    actual: null,
    outcome: "still standing",
    marker: null,
  },
  {
    id: "custom",
    chip: "custom",
    thing: "custom",
    age: null,
    actual: null,
    outcome: null,
    marker: null,
  },
];

const CONFS = [
  { id: "wall-conf-50", label: "50%", c: 0.5 },
  { id: "wall-conf-95", label: "95%", c: 0.95 },
];

const MAX_AGE = 1e7;

// --- pure helpers -------------------------------------------------------

// windows / readouts: <10 -> one decimal, else rounded, with commas
const fmt = (x) =>
  x < 10
    ? x.toLocaleString("en-US", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })
    : Math.round(x).toLocaleString("en-US");

const fmtInt = (x) => Math.round(x).toLocaleString("en-US");

const pctLabel = (c) => (c === 0.5 ? "50%" : "95%");

// timeline geometry
const W = 640;
const H = 130;
const ML = 10;
const MR = 10;
const AXIS_Y = 96;

const r1 = (v) => Math.round(v * 10) / 10;

const xScale = (xmax) => (v) => r1(ML + (v / xmax) * (W - ML - MR));

// anchor labels away from the edges so they never clip
const anchorFor = (px) =>
  px < W * 0.15 ? "start" : px > W * 0.85 ? "end" : "middle";

const dxFor = (a) => (a === "start" ? 3 : a === "end" ? -3 : 0);

// 1 / 2 / 5 * 10^k step aiming for ~4 ticks across the span
const niceStep = (span) => {
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return nice * mag;
};

// clean round tick values, skipping any that would crowd 0, the age tick,
// or the right edge; capped at 3
const roundTicks = (xmax, agePx, x) => {
  const step = niceStep(xmax);
  const out = [];
  for (let v = step; v <= xmax * 0.97; v += step) {
    const px = x(v);
    if (px < 44 || px > W - 34 || Math.abs(px - agePx) < 44) continue;
    out.push(v);
  }
  if (out.length > 3)
    return [out[0], out[Math.floor(out.length / 2)], out[out.length - 1]];
  return out;
};

const svgText = (x, y, a, s) =>
  `<text x="${x}" y="${y}" dx="${dxFor(a)}" text-anchor="${a}" fill="var(--ink-muted)">${s}</text>`;

const outcomeLine = (preset, low, high) => {
  if (preset.actual === null)
    return "still standing as of the observation's era; the window remains open.";
  const inside = preset.actual >= low && preset.actual <= high;
  return `it actually lasted ${fmtInt(preset.actual)} more years — ${
    inside ? "inside" : "outside"
  } the window.`;
};

// --- svg builders --------------------------------------------------------

const timelineSvg = (preset, age, c) => {
  const { low, high } = gottInterval(age, c);
  const median = gottMedianTotal(age);
  const actual = preset.actual;
  const xmax = 1.06 * (age + Math.max(high, actual || 0));
  const x = xScale(xmax);
  const agePx = x(age);
  const parts = [];

  // confidence band (future window), slightly taller than the past bar
  const b0 = x(age + low);
  const b1 = x(age + high);
  parts.push(
    `<rect x="${b0}" y="73" width="${r1(b1 - b0)}" height="20" fill="var(--data-blue)" fill-opacity="0.12"/>`,
    `<line x1="${b0}" y1="73" x2="${b0}" y2="93" stroke="var(--data-blue)" stroke-opacity="0.4" stroke-width="1"/>`,
    `<line x1="${b1}" y1="73" x2="${b1}" y2="93" stroke="var(--data-blue)" stroke-opacity="0.4" stroke-width="1"/>`,
  );

  // past segment, right edge = now
  parts.push(
    `<rect x="${x(0)}" y="78" width="${r1(agePx - x(0))}" height="10" rx="2" fill="var(--data-blue)"/>`,
  );

  // baseline axis + ticks (0, age, clean rounds)
  parts.push(
    `<line x1="${ML}" y1="${AXIS_Y}" x2="${W - MR}" y2="${AXIS_Y}" stroke="var(--line)" stroke-width="1"/>`,
  );
  const ticks = [0, age, ...roundTicks(xmax, agePx, x)];
  for (const v of ticks) {
    const px = x(v);
    parts.push(
      `<line x1="${px}" y1="${AXIS_Y}" x2="${px}" y2="${AXIS_Y + 5}" stroke="var(--line)" stroke-width="1"/>`,
      svgText(px, 112, anchorFor(px), fmtInt(v)),
    );
  }

  // median-total tick — label offset vertically from "you look here"
  const mPx = x(median);
  parts.push(
    `<line x1="${mPx}" y1="68" x2="${mPx}" y2="${AXIS_Y}" stroke="var(--ink-muted)" stroke-width="1"/>`,
    svgText(mPx, 64, anchorFor(mPx), "median"),
  );

  // actual outcome, when history has ruled
  if (actual !== null) {
    const aPx = x(age + actual);
    parts.push(
      `<line x1="${aPx}" y1="44" x2="${aPx}" y2="${AXIS_Y}" stroke="var(--data-red)" stroke-width="2"/>`,
      svgText(aPx, 38, anchorFor(aPx), preset.marker || "ended here"),
    );
  }

  // observation marker
  parts.push(
    `<line x1="${agePx}" y1="26" x2="${agePx}" y2="${AXIS_Y}" stroke="var(--ink)" stroke-width="1.5"/>`,
    svgText(agePx, 20, anchorFor(agePx), "you look here"),
  );

  const aria =
    `timeline for ${preset.thing}: observed at age ${fmtInt(age)} years; ` +
    `${pctLabel(c)} confidence the future lies between ${fmt(low)} and ` +
    `${fmt(high)} more years` +
    (actual !== null
      ? `; it actually ended ${fmtInt(actual)} years after the observation`
      : "");

  return `<svg class="wall-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${aria}">${parts.join("")}</svg>`;
};

const derivationSvg = () => {
  const bx = 20;
  const bw = 600;
  const by = 40;
  const bh = 14;
  const q1 = bx + bw * 0.25;
  const q3 = bx + bw * 0.75;
  return (
    `<svg class="wall-svg" viewBox="0 0 640 90" role="img" aria-label="derivation: a random glance lands in the middle half of a lifetime 50% of the time; at one quarter of the way through, the future is three times the past; at three quarters, one third">` +
    `<text x="320" y="18" text-anchor="middle" fill="var(--ink-muted)">a random glance lands in the middle half of a lifetime 50% of the time</text>` +
    `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="none" stroke="var(--line)" stroke-width="1"/>` +
    `<rect x="${q1}" y="${by}" width="${bw / 2}" height="${bh}" fill="var(--data-blue)" fill-opacity="0.12"/>` +
    `<line x1="${q1}" y1="${by}" x2="${q1}" y2="${by + bh}" stroke="var(--data-blue)" stroke-opacity="0.4" stroke-width="1"/>` +
    `<line x1="${q3}" y1="${by}" x2="${q3}" y2="${by + bh}" stroke="var(--data-blue)" stroke-opacity="0.4" stroke-width="1"/>` +
    `<text x="${q1}" y="34" text-anchor="middle" fill="var(--ink-muted)">¼</text>` +
    `<text x="${q3}" y="34" text-anchor="middle" fill="var(--ink-muted)">¾</text>` +
    `<text x="${q1}" y="76" text-anchor="middle" fill="var(--ink-muted)">if you're at ¼, the future is 3x the past</text>` +
    `<text x="${q3}" y="76" text-anchor="middle" fill="var(--ink-muted)">if you're at ¾, it's ⅓x</text>` +
    `</svg>`
  );
};

// --- html builders --------------------------------------------------------

const legendHtml = (hasActual) =>
  `<li><span class="swatch" style="background: var(--data-blue)"></span>past</li>` +
  `<li><span class="swatch wall-swatch-wash"></span>plausible future</li>` +
  (hasActual
    ? `<li><span class="swatch" style="background: var(--data-red)"></span>actual end</li>`
    : "");

const tableHtml = () => {
  const rows = PRESETS.filter((p) => p.age !== null)
    .map((p) => {
      const w50 = gottInterval(p.age, 0.5);
      const w95 = gottInterval(p.age, 0.95);
      const happened =
        p.actual !== null
          ? `${p.outcome} — ${fmtInt(p.actual)} more years`
          : p.outcome;
      return (
        `<tr><td>${p.thing}</td><td>${fmtInt(p.age)}</td>` +
        `<td>${fmt(w50.low)} – ${fmt(w50.high)}</td>` +
        `<td>${fmt(w95.low)} – ${fmt(w95.high)}</td>` +
        `<td>${happened}</td></tr>`
      );
    })
    .join("");
  return (
    `<table><thead><tr>` +
    `<th scope="col">thing</th>` +
    `<th scope="col">age when seen (years)</th>` +
    `<th scope="col">50% window (more years)</th>` +
    `<th scope="col">95% window (more years)</th>` +
    `<th scope="col">what happened</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>`
  );
};

const skeleton = () =>
  `<div class="wall-chips" id="wall-presets" role="group" aria-label="preset examples">` +
  PRESETS.map(
    (p) =>
      `<button type="button" class="btn" data-preset="${p.id}">${p.chip}</button>`,
  ).join("") +
  `</div>` +
  `<div class="control-row">` +
  `<label class="control">` +
  `<span class="control-label">age when you observe it (years)</span>` +
  `<input id="wall-age" class="wall-age-input" type="number" min="1" step="1" inputmode="numeric"/>` +
  `</label>` +
  `<div class="control">` +
  `<span class="control-label" id="wall-conf-label">confidence</span>` +
  `<div class="wall-tabs" role="tablist" aria-labelledby="wall-conf-label">` +
  CONFS.map(
    (t) =>
      `<button type="button" class="btn" role="tab" id="${t.id}" aria-selected="false">${t.label}</button>`,
  ).join("") +
  `</div></div></div>` +
  `<div class="wall-readout" id="wall-readout" aria-live="polite">` +
  `<p class="hero wall-hero" id="wall-window"></p>` +
  `<p class="hero-caption" id="wall-window-caption"></p>` +
  `<p class="wall-median" id="wall-median"></p>` +
  `<p class="wall-outcome" id="wall-outcome"></p>` +
  `</div>` +
  `<div class="wall-timeline" id="wall-timeline"></div>` +
  `<ul class="legend" id="wall-legend"></ul>` +
  `<div class="wall-derivation" id="wall-derivation">${derivationSvg()}</div>` +
  `<details id="wall-table"><summary>view as table</summary>${tableHtml()}</details>`;

// --- mount ----------------------------------------------------------------

export function mountWall(root) {
  root.innerHTML = skeleton();

  const els = {
    age: root.querySelector("#wall-age"),
    window: root.querySelector("#wall-window"),
    caption: root.querySelector("#wall-window-caption"),
    median: root.querySelector("#wall-median"),
    outcome: root.querySelector("#wall-outcome"),
    timeline: root.querySelector("#wall-timeline"),
    legend: root.querySelector("#wall-legend"),
    chips: [...root.querySelectorAll("[data-preset]")],
    confs: CONFS.map((t) => [root.querySelector(`#${t.id}`), t.c]),
  };

  const state = { preset: PRESETS[0], age: PRESETS[0].age, c: 0.5 };
  els.age.value = String(state.age);

  const update = () => {
    const { preset, age, c } = state;
    const { low, high } = gottInterval(age, c);

    els.window.textContent = `${fmt(low)} – ${fmt(high)} more years`;
    els.caption.textContent = `${pctLabel(c)} confidence window`;
    els.median.textContent = `even odds it's past the halfway mark: median total ${fmtInt(gottMedianTotal(age))} years`;
    els.outcome.textContent = outcomeLine(preset, low, high);
    els.timeline.innerHTML = timelineSvg(preset, age, c);
    els.legend.innerHTML = legendHtml(preset.actual !== null);

    for (const chip of els.chips)
      chip.classList.toggle("active", chip.dataset.preset === preset.id);
    for (const [btn, bc] of els.confs) {
      btn.classList.toggle("active", c === bc);
      btn.setAttribute("aria-selected", String(c === bc));
    }
    els.age.disabled = preset.id !== "custom";
  };

  root.querySelector("#wall-presets").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-preset]");
    if (!btn) return;
    state.preset = PRESETS.find((p) => p.id === btn.dataset.preset);
    if (state.preset.age !== null) state.age = state.preset.age;
    els.age.value = String(state.age);
    update();
  });

  els.age.addEventListener("input", () => {
    const v = Math.floor(Number(els.age.value));
    if (!Number.isFinite(v) || v < 1) return;
    state.age = Math.min(v, MAX_AGE);
    update();
  });

  for (const [btn, c] of els.confs)
    btn.addEventListener("click", () => {
      state.c = c;
      update();
    });

  update();
}
