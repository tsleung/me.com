// porkchop.js — draw the 2D departure×arrival Δv grid (from transfer.porkchop):
// a heatmap + a few contour lines, the min marked (the efficient launch), and a
// vertical "now" marker sweeping the departure axis. Drawing only; the grid math
// + the click→cell mapping helper below are pure. House dark, reversed-viridis so
// the low-Δv "islands" (the launch windows) read bright.

const PAD_L = 30;
const PAD_R = 8;
const PAD_T = 16;
const PAD_B = 16;

// Reversed viridis: t=0 (near-min Δv) → bright yellow; t=1 (costly) → deep purple.
const STOPS = [
  [253, 231, 37],
  [94, 201, 98],
  [33, 145, 140],
  [59, 82, 139],
  [68, 1, 84],
];
function colormap(t) {
  const x = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  return `rgb(${Math.round(a[0] + f * (b[0] - a[0]))},${Math.round(a[1] + f * (b[1] - a[1]))},${Math.round(a[2] + f * (b[2] - a[2]))})`;
}

// Plot rectangle inside the canvas.
function plotRect(w, h) {
  return { x0: PAD_L, y0: PAD_T, pw: w - PAD_L - PAD_R, ph: h - PAD_T - PAD_B };
}

// Click/hover → grid cell. Returns { depIdx, arrIdx } or null (outside plot).
export function porkchopCellAt(pc, px, py, w, h) {
  if (!pc || !pc.depAxis) return null;
  const { x0, y0, pw, ph } = plotRect(w, h);
  if (px < x0 || px > x0 + pw || py < y0 || py > y0 + ph) return null;
  const R = pc.depAxis.length;
  const depIdx = Math.max(0, Math.min(R - 1, Math.round(((px - x0) / pw) * (R - 1))));
  const arrIdx = Math.max(0, Math.min(R - 1, Math.round((1 - (py - y0) / ph) * (R - 1))));
  return { depIdx, arrIdx };
}

export function drawPorkchop(ctx, opts) {
  if (!ctx || !opts || !opts.pc || !opts.pc.grid) return;
  const { pc, now, cap = 6, w, h } = opts;
  const R = pc.depAxis.length;
  const { x0, y0, pw, ph } = plotRect(w, h);
  const minDv = pc.min.dv;
  const cellX = (i) => x0 + (i / (R - 1)) * pw;
  const cellY = (j) => y0 + (1 - j / (R - 1)) * ph; // arrival up

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(10,12,18,0.94)";
  ctx.fillRect(0, 0, w, h);

  // heatmap (each cell a filled rect)
  const dx = pw / (R - 1);
  const dy = ph / (R - 1);
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < R; j++) {
      const v = pc.grid[i][j];
      const t = isFinite(v) ? (v - minDv) / cap : 1.2;
      ctx.fillStyle = colormap(t);
      ctx.fillRect(cellX(i) - dx / 2, cellY(j) - dy / 2, dx + 1, dy + 1);
    }
  }

  // contour lines (marching squares) at a few Δv levels above the min
  ctx.lineWidth = 1;
  for (const lvl of [minDv + 1, minDv + 2.5, minDv + 4.5]) {
    ctx.strokeStyle = "rgba(10,12,18,0.55)";
    contour(ctx, pc.grid, lvl, cellX, cellY, R);
  }

  // frame + labels
  ctx.strokeStyle = "rgba(51,55,67,0.9)";
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, pw, ph);
  ctx.fillStyle = "rgba(139,143,154,0.95)";
  ctx.font = "9px ui-monospace, Menlo, monospace";
  ctx.fillText("porkchop · total Δv → Mars (km/s)", x0, 11);
  ctx.save();
  ctx.translate(9, y0 + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("arrival →", 0, 0);
  ctx.restore();
  ctx.fillText("departure →", x0, h - 4);

  // "now" marker on the departure axis
  const t0 = pc.depAxis[0];
  const t1 = pc.depAxis[R - 1];
  if (now >= t0 && now <= t1) {
    const xn = x0 + ((now - t0) / (t1 - t0)) * pw;
    ctx.strokeStyle = "rgba(242,242,238,0.75)";
    ctx.beginPath();
    ctx.moveTo(xn, y0);
    ctx.lineTo(xn, y0 + ph);
    ctx.stroke();
  }

  // the minimum (the efficient launch)
  const mx = cellX(pc.min.depIdx);
  const my = cellY(pc.min.arrIdx);
  ctx.strokeStyle = "#f2f2ee";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(mx, my, 4, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.fillStyle = "#f2f2ee";
  ctx.fillText(`min ${minDv.toFixed(2)}`, Math.min(mx + 6, x0 + pw - 42), my - 5);
}

// Minimal marching squares: for each cell, draw the iso-`lvl` segment(s).
function contour(ctx, grid, lvl, cellX, cellY, R) {
  const interp = (va, vb) => (va === vb ? 0.5 : (lvl - va) / (vb - va));
  ctx.beginPath();
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < R - 1; j++) {
      const v00 = grid[i][j];
      const v10 = grid[i + 1][j];
      const v01 = grid[i][j + 1];
      const v11 = grid[i + 1][j + 1];
      if (![v00, v10, v01, v11].every(isFinite)) continue;
      const code =
        (v00 > lvl ? 1 : 0) | (v10 > lvl ? 2 : 0) | (v11 > lvl ? 4 : 0) | (v01 > lvl ? 8 : 0);
      if (code === 0 || code === 15) continue;
      // edge points: bottom(00-10), right(10-11), top(01-11), left(00-01)
      const b = [cellX(i + interp(v00, v10)), cellY(j)];
      const r = [cellX(i + 1), cellY(j + interp(v10, v11))];
      const tp = [cellX(i + interp(v01, v11)), cellY(j + 1)];
      const l = [cellX(i), cellY(j + interp(v00, v01))];
      const seg = (p, q) => {
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(q[0], q[1]);
      };
      switch (code) {
        case 1:
        case 14:
          seg(l, b);
          break;
        case 2:
        case 13:
          seg(b, r);
          break;
        case 3:
        case 12:
          seg(l, r);
          break;
        case 4:
        case 11:
          seg(r, tp);
          break;
        case 5:
          seg(l, tp);
          seg(b, r);
          break;
        case 6:
        case 9:
          seg(b, tp);
          break;
        case 7:
        case 8:
          seg(l, tp);
          break;
        case 10:
          seg(l, b);
          seg(r, tp);
          break;
        default:
          break;
      }
    }
  }
  ctx.stroke();
}
