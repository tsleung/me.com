// chart.js — the Δv-over-time "metronome" chart: a small rolling line plot of
// departing-now Δv → Mars. DATA comes from transfer.dvSeries (pure + tested); this
// file is drawing only. It troughs to ~the Hohmann floor at each synodic window
// (~780 d) and rises steeply between — the metronome made visible.

// Linear-interpolate the series value at time t (for the "now" marker dot).
export function interpSeries(series, t) {
  if (!series || !series.length) return null;
  if (t <= series[0].t) return series[0].dv;
  if (t >= series[series.length - 1].t) return series[series.length - 1].dv;
  for (let i = 1; i < series.length; i++) {
    if (series[i].t >= t) {
      const a = series[i - 1];
      const b = series[i];
      const f = (t - a.t) / (b.t - a.t || 1);
      return a.dv + f * (b.dv - a.dv);
    }
  }
  return series[series.length - 1].dv;
}

// Draw the chart. opts = { series:[{t,dv}], minima:[idx], now, floor, cap, w, h }.
export function drawDvChart(ctx, opts) {
  if (!ctx || !opts || !opts.series || opts.series.length < 2) return;
  const { series, minima = [], now, floor = 2.945, cap = 12, w, h } = opts;
  const t0 = series[0].t;
  const t1 = series[series.length - 1].t;
  const span = t1 - t0 || 1;
  const X = (t) => ((t - t0) / span) * (w - 2) + 1;
  const Y = (dv) => h - 4 - (Math.min(Math.max(dv, 0), cap) / cap) * (h - 14);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(10,12,18,0.92)";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(51,55,67,0.9)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  ctx.font = "9px ui-monospace, Menlo, monospace";

  // Hohmann floor gridline.
  ctx.strokeStyle = "rgba(180,142,245,0.5)";
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(1, Y(floor));
  ctx.lineTo(w - 1, Y(floor));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(180,142,245,0.85)";
  ctx.fillText(`Hohmann floor ${floor.toFixed(2)}`, 4, Y(floor) - 3);

  // The Δv waveform (clipped at cap).
  ctx.strokeStyle = "#3ddc84";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  series.forEach((p, i) => {
    const x = X(p.t);
    const y = Y(p.dv);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.stroke();

  // Window minima marks.
  ctx.fillStyle = "#3ddc84";
  for (const i of minima) {
    const p = series[i];
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(X(p.t), Y(p.dv), 2.6, 0, 2 * Math.PI);
    ctx.fill();
  }

  // "now" marker + current value dot.
  if (now >= t0 && now <= t1) {
    const x = X(now);
    ctx.strokeStyle = "rgba(242,242,238,0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 2);
    ctx.lineTo(x, h - 2);
    ctx.stroke();
    const dv = interpSeries(series, now);
    if (dv != null) {
      ctx.fillStyle = "#f2f2ee";
      ctx.beginPath();
      ctx.arc(x, Y(dv), 3, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  // Title.
  ctx.fillStyle = "rgba(139,143,154,0.95)";
  ctx.fillText("departure Δv → Mars (km/s) · the metronome", 4, 10);
}
