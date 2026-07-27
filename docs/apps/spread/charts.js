// SVG chart helpers for the spread app. Renders into a container; reads its
// colors from the app's CSS custom properties so charts stay on-system. No
// app state lives here. Dark-surface, single-axis, thin marks, direct labels
// (the site is dark-only, matching its sibling apps).

const NS = "http://www.w3.org/2000/svg";
const W = 640;
const H = 320;

const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

const svgRoot = (container, aspectH = H) => {
  container.textContent = "";
  const svg = el("svg", {
    viewBox: `0 0 ${W} ${aspectH}`,
    class: "chart",
    preserveAspectRatio: "xMidYMid meet",
  });
  container.appendChild(svg);
  return svg;
};

// A floating tooltip div bound to a container (created once, reused).
const tipFor = (container) => {
  let tip = container.querySelector(".tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    container.appendChild(tip);
  }
  return tip;
};

const fmtMoney = (v) =>
  v >= 1000
    ? "$" + Math.round(v).toLocaleString("en-US")
    : "$" + v.toFixed(v < 10 ? 2 : 0);

// --- distribution bars ------------------------------------------------------
// A histogram of round outcomes. `edges` are the bin boundaries (length
// bins+1) in multiplier space; `counts` the per-bin frequencies. `marker` is
// an optional { value, label } vertical rule (e.g. the ensemble mean).
export const barChart = (container, { counts, edges, marker, curve, unit = "×" }) => {
  const svg = svgRoot(container);
  const padL = 8;
  const padR = 8;
  const padT = 16;
  const padB = 34;
  const bins = counts.length;
  const maxCount = Math.max(1, ...counts, ...(curve ? curve.map((p) => p[1]) : []));
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const lo = edges[0];
  const hi = edges[bins];
  const x = (v) => padL + ((v - lo) / (hi - lo)) * plotW;
  const gap = 2;
  const bw = plotW / bins;
  const tip = tipFor(container);

  // baseline
  svg.appendChild(
    el("line", {
      x1: padL,
      y1: padT + plotH,
      x2: padL + plotW,
      y2: padT + plotH,
      class: "axis-line",
    }),
  );

  counts.forEach((c, i) => {
    const h = (c / maxCount) * plotH;
    const bx = padL + i * bw;
    const by = padT + plotH - h;
    const rect = el("rect", {
      x: bx + gap / 2,
      y: by,
      width: Math.max(0, bw - gap),
      height: h,
      rx: Math.min(4, (bw - gap) / 2),
      class: "bar",
    });
    rect.addEventListener("mousemove", (e) => {
      const r = container.getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = `${e.clientX - r.left}px`;
      tip.style.top = `${e.clientY - r.top}px`;
      tip.innerHTML = `${(edges[i]).toFixed(2)}–${edges[i + 1].toFixed(
        2,
      )}${unit}<br><b>${c.toLocaleString("en-US")}</b> hands`;
    });
    rect.addEventListener("mouseleave", () => (tip.hidden = true));
    svg.appendChild(rect);
  });

  // x ticks at lo, mid, hi
  [lo, (lo + hi) / 2, hi].forEach((v) => {
    svg.appendChild(
      el("text", {
        x: x(v),
        y: padT + plotH + 20,
        class: "tick",
        "text-anchor": "middle",
      }),
    ).textContent = v.toFixed(2) + unit;
  });

  // fitted-normal overlay: `curve` is [[xValue, countValue], …]
  if (curve && curve.length > 1) {
    const cy = (c) => padT + plotH - (c / maxCount) * plotH;
    const d = curve
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p[0]).toFixed(1)} ${cy(p[1]).toFixed(1)}`)
      .join(" ");
    svg.appendChild(el("path", { d, class: "normal-curve" }));
  }

  if (marker) {
    const mx = x(marker.value);
    svg.appendChild(
      el("line", {
        x1: mx,
        y1: padT - 6,
        x2: mx,
        y2: padT + plotH,
        class: "marker-line",
      }),
    );
    const t = el("text", { x: mx, y: padT - 8, class: "marker-label", "text-anchor": "middle" });
    t.textContent = marker.label;
    svg.appendChild(t);
  }
};

// --- labelled line chart (SD vs number of hands) ----------------------------
// `series`: [{ label, color, points: [[x,y],…] }]. `x` is discrete (hands).
export const lineChart = (container, { series, xMax, yMax, yLabel }) => {
  const svg = svgRoot(container);
  const padL = 44;
  const padR = 64;
  const padT = 16;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const x = (v) => padL + (v / xMax) * plotW;
  const y = (v) => padT + plotH - (v / yMax) * plotH;

  // axes
  svg.appendChild(
    el("line", { x1: padL, y1: padT, x2: padL, y2: padT + plotH, class: "axis-line" }),
  );
  svg.appendChild(
    el("line", {
      x1: padL,
      y1: padT + plotH,
      x2: padL + plotW,
      y2: padT + plotH,
      class: "axis-line",
    }),
  );
  // y ticks
  [0, 0.25, 0.5].forEach((frac) => {
    const v = frac * yMax;
    svg.appendChild(
      el("text", { x: padL - 8, y: y(v) + 4, class: "tick", "text-anchor": "end" }),
    ).textContent = (v * 100).toFixed(0) + "%";
  });
  svg.appendChild(
    el("text", { x: padL - 8, y: padT - 4, class: "tick", "text-anchor": "end" }),
  ).textContent = yLabel;
  // x ticks
  [1, Math.round(xMax / 2), xMax].forEach((v) => {
    svg.appendChild(
      el("text", { x: x(v), y: padT + plotH + 20, class: "tick", "text-anchor": "middle" }),
    ).textContent = String(v);
  });
  svg.appendChild(
    el("text", { x: padL + plotW / 2, y: H - 4, class: "tick", "text-anchor": "middle" }),
  ).textContent = "hands per round";

  series.forEach((s) => {
    const d = s.points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`)
      .join(" ");
    svg.appendChild(el("path", { d, class: "series-line", style: `stroke:${s.color}` }));
    const last = s.points[s.points.length - 1];
    const t = el("text", {
      x: x(last[0]) + 6,
      y: y(last[1]) + 4,
      class: "series-label",
      style: `fill:${s.color}`,
    });
    t.textContent = s.label;
    svg.appendChild(t);
  });
};

// --- policy heatmap (bet fraction over the count-state) ---------------------
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rampColor = (t) => {
  // sequential single-hue: cold/near-surface (bet 0) → hot accent red (bet all)
  const a = hexRgb("#1b1b24");
  const b = hexRgb("#ff3a3a");
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
};

// `states`: reachableStates(). `value(state)` → bet fraction in [0,1], or null
// for an unlearned cell. Axes: x = count (r−b), y = cards left (full at top).
export const heatmapChart = (container, { states, value }) => {
  const svg = svgRoot(container);
  const padL = 40;
  const padR = 10;
  const padT = 10;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const levels = [...new Set(states.map((s) => s.cards))].sort((a, b) => b - a);
  const maxc = Math.max(1, ...states.map((s) => Math.abs(s.count)));
  const cols = maxc + 1;
  const rows = levels.length;
  const cw = plotW / cols;
  const ch = plotH / rows;
  const tip = tipFor(container);

  for (const s of states) {
    const v = value(s);
    const x = padL + ((s.count + maxc) / 2) * cw;
    const y = padT + levels.indexOf(s.cards) * ch;
    const rect = el("rect", {
      x: x + 0.4,
      y: y + 0.4,
      width: Math.max(0.5, cw - 0.8),
      height: Math.max(0.5, ch - 0.8),
      class: "heat-cell",
      fill: v == null ? "#131318" : rampColor(v),
    });
    rect.addEventListener("mousemove", (e) => {
      const r = container.getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = `${e.clientX - r.left}px`;
      tip.style.top = `${e.clientY - r.top}px`;
      tip.innerHTML = `count ${s.count > 0 ? "+" : ""}${s.count} · ${s.cards} left<br>${
        v == null ? "<i>unlearned</i>" : "bet <b>" + Math.round(v * 100) + "%</b>"
      }`;
    });
    rect.addEventListener("mouseleave", () => (tip.hidden = true));
    svg.appendChild(rect);
  }

  svg.appendChild(
    el("text", { x: padL + plotW / 2, y: H - 4, class: "tick", "text-anchor": "middle" }),
  ).textContent = "← black-rich     count     red-rich →";
  svg.appendChild(
    el("text", { x: padL - 6, y: padT + 8, class: "tick", "text-anchor": "end" }),
  ).textContent = String(levels[0]);
  svg.appendChild(
    el("text", { x: padL - 6, y: padT + plotH, class: "tick", "text-anchor": "end" }),
  ).textContent = String(levels[levels.length - 1]);
  const yl = el("text", {
    x: 12,
    y: padT + plotH / 2,
    class: "tick",
    "text-anchor": "middle",
    transform: `rotate(-90 12 ${padT + plotH / 2})`,
  });
  yl.textContent = "cards left";
  svg.appendChild(yl);
};

// --- generic growth curve (learning curve) ----------------------------------
// `series`: [{ label, color, points:[[x,y]…], dash? }]. Linear y on [yMin,yMax].
export const growthCurve = (container, { series, xMax, yMin, yMax, yLabel }) => {
  const svg = svgRoot(container);
  const padL = 48;
  const padR = 76;
  const padT = 16;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const span = yMax - yMin || 1;
  const x = (v) => padL + (v / (xMax || 1)) * plotW;
  const y = (v) => padT + plotH - ((v - yMin) / span) * plotH;

  svg.appendChild(el("line", { x1: padL, y1: padT, x2: padL, y2: padT + plotH, class: "axis-line" }));
  svg.appendChild(
    el("line", { x1: padL, y1: padT + plotH, x2: padL + plotW, y2: padT + plotH, class: "axis-line" }),
  );
  [yMin, (yMin + yMax) / 2, yMax].forEach((v) => {
    svg.appendChild(
      el("text", { x: padL - 8, y: y(v) + 4, class: "tick", "text-anchor": "end" }),
    ).textContent = v.toFixed(2);
  });
  svg.appendChild(
    el("text", { x: padL - 8, y: padT - 4, class: "tick", "text-anchor": "end" }),
  ).textContent = yLabel;
  [0, Math.round(xMax / 2), xMax].forEach((v) => {
    svg.appendChild(
      el("text", { x: x(v), y: padT + plotH + 20, class: "tick", "text-anchor": "middle" }),
    ).textContent = v >= 1000 ? Math.round(v / 1000) + "k" : String(v);
  });
  svg.appendChild(
    el("text", { x: padL + plotW / 2, y: H - 4, class: "tick", "text-anchor": "middle" }),
  ).textContent = "episodes trained";

  series.forEach((s) => {
    if (!s.points.length) return;
    const d = s.points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`)
      .join(" ");
    const attrs = { d, class: "series-line", style: `stroke:${s.color}` };
    if (s.dash) attrs["stroke-dasharray"] = "4 3";
    svg.appendChild(el("path", attrs));
    const last = s.points[s.points.length - 1];
    const t = el("text", {
      x: x(last[0]) + 6,
      y: y(last[1]) + 4,
      class: "series-label",
      style: `fill:${s.color}`,
    });
    t.textContent = s.label;
    svg.appendChild(t);
  });
};

// --- fan chart (wealth over rounds) -----------------------------------------
// Quantile bands nested from the outside in, a median line, and a dashed
// ensemble-mean line. Log y-scale, because multiplicative wealth spans orders
// of magnitude and the median↔mean gap is the whole point.
export const fanChart = (container, { qs, bands, means, rounds }) => {
  const svg = svgRoot(container);
  const padL = 52;
  const padR = 56;
  const padT = 16;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const all = bands.flat().concat(means);
  const rawMin = Math.min(...all.filter((v) => v > 0));
  const rawMax = Math.max(...all);
  const yFloor = Math.max(1, rawMin * 0.7);
  const yTop = Math.max(yFloor * 10, rawMax * 1.15);
  const ly = (v) => Math.log10(Math.max(yFloor, v));
  const lo = ly(yFloor);
  const hi = ly(yTop);
  const x = (r) => padL + (r / rounds) * plotW;
  const y = (v) => padT + plotH - ((ly(v) - lo) / (hi - lo)) * plotH;

  // gridlines at each decade
  for (let e = Math.ceil(lo); e <= Math.floor(hi); e++) {
    const gv = Math.pow(10, e);
    svg.appendChild(
      el("line", { x1: padL, y1: y(gv), x2: padL + plotW, y2: y(gv), class: "grid-line" }),
    );
    svg.appendChild(
      el("text", { x: padL - 8, y: y(gv) + 4, class: "tick", "text-anchor": "end" }),
    ).textContent = fmtMoney(gv);
  }

  // nested bands: pair qs symmetrically (outermost first) → increasing opacity
  const nPairs = Math.floor(qs.length / 2);
  for (let k = 0; k < nPairs; k++) {
    const upper = bands[qs.length - 1 - k];
    const lower = bands[k];
    const pts = [];
    for (let r = 0; r <= rounds; r++) pts.push(`${x(r).toFixed(1)} ${y(upper[r]).toFixed(1)}`);
    for (let r = rounds; r >= 0; r--) pts.push(`${x(r).toFixed(1)} ${y(lower[r]).toFixed(1)}`);
    svg.appendChild(
      el("polygon", {
        points: pts.join(" "),
        class: "band",
        style: `opacity:${0.18 + 0.22 * k}`,
      }),
    );
  }

  const linePath = (arr) =>
    arr.map((v, r) => `${r === 0 ? "M" : "L"}${x(r).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");

  // median (middle q) and mean
  const midIdx = qs.indexOf(0.5);
  if (midIdx >= 0) {
    svg.appendChild(el("path", { d: linePath(bands[midIdx]), class: "median-line" }));
  }
  svg.appendChild(el("path", { d: linePath(means), class: "mean-line" }));

  // direct labels at the right end
  const labelAt = (arr, text, cls) => {
    const t = el("text", { x: x(rounds) + 6, y: y(arr[rounds]) + 4, class: cls });
    t.textContent = text;
    svg.appendChild(t);
  };
  if (midIdx >= 0) labelAt(bands[midIdx], "median", "median-label");
  labelAt(means, "mean", "mean-label");

  // x ticks
  [0, Math.round(rounds / 2), rounds].forEach((r) => {
    svg.appendChild(
      el("text", { x: x(r), y: padT + plotH + 20, class: "tick", "text-anchor": "middle" }),
    ).textContent = String(r);
  });
  svg.appendChild(
    el("text", { x: padL + plotW / 2, y: H - 4, class: "tick", "text-anchor": "middle" }),
  ).textContent = "rounds played";

  // crosshair tooltip
  const tip = tipFor(container);
  const overlay = el("rect", {
    x: padL,
    y: padT,
    width: plotW,
    height: plotH,
    fill: "transparent",
  });
  const cross = el("line", { class: "crosshair", y1: padT, y2: padT + plotH, x1: padL, x2: padL });
  cross.setAttribute("visibility", "hidden");
  svg.appendChild(cross);
  overlay.addEventListener("mousemove", (ev) => {
    const rect = container.getBoundingClientRect();
    const frac = (ev.clientX - rect.left) / rect.width;
    const r = Math.max(0, Math.min(rounds, Math.round(frac * rounds)));
    cross.setAttribute("visibility", "visible");
    cross.setAttribute("x1", x(r));
    cross.setAttribute("x2", x(r));
    const med = midIdx >= 0 ? bands[midIdx][r] : means[r];
    tip.hidden = false;
    tip.style.left = `${ev.clientX - rect.left}px`;
    tip.style.top = `${ev.clientY - rect.top}px`;
    tip.innerHTML = `round <b>${r}</b><br>median ${fmtMoney(med)}<br>mean ${fmtMoney(means[r])}`;
  });
  overlay.addEventListener("mouseleave", () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
  });
  svg.appendChild(overlay);
};
