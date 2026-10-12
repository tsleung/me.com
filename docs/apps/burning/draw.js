// Canvas renderer for the street fight: an oblique three-quarter view.
import { MAPW, MAPH, BLOCKS, CORE, KINDS, clamp, D, tide, alive, byId, gifted, up } from './sim.js';
// Canvas renderer: oblique 3/4 view in metres, Hades-like framing (~22 m of
// street across a phone), limbs on every figure, ink outlines, additive light.
const S = 26, KY = 0.7, KZ = 0.85, VW = 390, VH = 500;
const COL = { blade: '#ffcf5a', arc: '#7fe3ff', shield: '#8dffb0', bow: '#d6a8ff', companion: '#fff6d6', humanoid: '#8b919c', heavy: '#7d828c', frame: '#2a2333', drone: '#9aa0aa', loiterer: '#c2c6cc', civ: '#c9b9a0' };
function proj(cam, x, y, z) { return [(x - cam.x) * S + VW / 2, (y - cam.y) * S * KY - (z || 0) * S * KZ + VH / 2]; }
function hash(n) { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15); return (n >>> 0) / 4294967296; }
function line(c, pts, w, col, ink) {
  if (ink) { c.strokeStyle = '#06070a'; c.lineWidth = w + 2.6; c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]))); c.stroke(); }
  c.strokeStyle = col; c.lineWidth = w; c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]))); c.stroke();
}
function circle(c, x, y, r, fill, ink) { c.beginPath(); c.arc(x, y, r, 0, 7); if (ink) { c.fillStyle = '#06070a'; c.beginPath(); c.arc(x, y, r + 1.4, 0, 7); c.fill(); c.beginPath(); c.arc(x, y, r, 0, 7); } c.fillStyle = fill; c.fill(); }
function shade(hex, k) { const n = parseInt(hex.slice(1), 16); let r = n >> 16, g = (n >> 8) & 255, b = n & 255; r = Math.round(r * k); g = Math.round(g * k); b = Math.round(b * k); return 'rgb(' + Math.min(255, r) + ',' + Math.min(255, g) + ',' + Math.min(255, b) + ')'; }

function drawWorld(c, w, cam, now) {
  c.save();
  c.fillStyle = '#0a0b10'; c.fillRect(0, 0, VW, VH);
  // sky: the city burning beyond the towers
  const sky = c.createLinearGradient(0, 0, 0, VH * 0.5);
  sky.addColorStop(0, '#120a10'); sky.addColorStop(0.55, '#3a160e'); sky.addColorStop(1, '#0a0b10');
  c.fillStyle = sky; c.fillRect(0, 0, VW, VH);
  for (let i = 0; i < 9; i++) { const fx = ((i * 97 + 40) % 460) - 35 - (cam.x * 3) % 60; const fy = proj(cam, 0, -6, 0)[1] - 40 - (i % 3) * 18; const g = c.createRadialGradient(fx, fy, 0, fx, fy, 60 + (i % 4) * 14); g.addColorStop(0, 'rgba(255,120,40,' + (0.22 + 0.08 * Math.sin(now * 2 + i)) + ')'); g.addColorStop(1, 'rgba(255,90,30,0)'); c.fillStyle = g; c.fillRect(fx - 90, fy - 90, 180, 180); }
  // flares from the other strike teams across the city
  for (let i = 0; i < 3; i++) { const ph = (now * 0.25 + i * 0.37) % 1; const fx = 60 + i * 130 - (cam.x * 2) % 40, fy = proj(cam, 0, -8, 0)[1] - 60 - ph * 80; c.globalAlpha = 1 - ph; circle(c, fx, fy, 2.2, '#ffe9a8'); c.globalAlpha = (1 - ph) * 0.3; circle(c, fx, fy, 9, '#ffcf6b'); c.globalAlpha = 1; }
  // ground
  const [gx0, gy0] = proj(cam, 0, 0, 0), [gx1, gy1] = proj(cam, MAPW, MAPH, 0);
  c.fillStyle = '#16171c'; c.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
  // the street, lanes and kerbs
  c.fillStyle = '#1c1d23'; const [sx0, sy0] = proj(cam, 0, 9.5, 0), [sx1, sy1] = proj(cam, 51, 35.5, 0); c.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
  c.strokeStyle = 'rgba(230,210,150,.16)'; c.lineWidth = 2; c.setLineDash([18, 22]); c.beginPath(); const [lx0, ly] = proj(cam, 0, 22.5, 0), [lx1] = proj(cam, 51, 22.5, 0); c.moveTo(lx0, ly); c.lineTo(lx1, ly); c.stroke(); c.setLineDash([]);
  // courtyard flagstones
  c.fillStyle = '#1b1a1f'; const [cx0, cy0] = proj(cam, 52.2, 9, 0), [cx1, cy1] = proj(cam, 71, 36, 0); c.fillRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
  c.strokeStyle = 'rgba(255,255,255,.035)'; c.lineWidth = 1; for (let x = 53; x < 71; x += 2) { const [a, b] = proj(cam, x, 9, 0), [, d] = proj(cam, x, 36, 0); c.beginPath(); c.moveTo(a, b); c.lineTo(a, d); c.stroke(); } for (let y = 10; y < 36; y += 2) { const [a, b] = proj(cam, 52.2, y, 0), [d] = proj(cam, 71, y, 0); c.beginPath(); c.moveTo(a, b); c.lineTo(d, b); c.stroke(); }
  // the core: a hardened pillar of light in the courtyard
  if (!w.coreBurned) { const [px, py] = proj(cam, CORE.x, CORE.y, 0); const pulse = 0.6 + 0.4 * Math.sin(now * 3); c.globalCompositeOperation = 'lighter'; const g = c.createRadialGradient(px, py, 0, px, py, 70); g.addColorStop(0, 'rgba(120,230,255,' + 0.35 * pulse + ')'); g.addColorStop(1, 'rgba(60,140,255,0)'); c.fillStyle = g; c.beginPath(); c.ellipse(px, py, 70, 70 * KY, 0, 0, 7); c.fill(); c.globalCompositeOperation = 'source-over'; }
  // scorch decals
  for (const sc of w.scorch) { const [x, y] = proj(cam, sc.x, sc.y, 0); c.fillStyle = 'rgba(0,0,0,' + 0.3 * Math.max(0, 1 - sc.t / 90) + ')'; c.beginPath(); c.ellipse(x, y, sc.r * S * 0.6, sc.r * S * 0.6 * KY, 0, 0, 7); c.fill(); }
  // telegraphs on the ground (wind-ups)
  for (const a of w.actors) {
    if (a.st !== 'wind' && a.st !== 'aim' && !(a.kind === 'loiterer' && a.dive && a.dive.warn > 0)) continue;
    c.save();
    if (a.kind === 'heavy') { const [x, y] = proj(cam, a.x, a.y, 0); c.fillStyle = 'rgba(255,70,50,.18)'; c.strokeStyle = 'rgba(255,90,60,.7)'; c.lineWidth = 1.5; c.beginPath(); if (a.move === 'stomp') c.ellipse(x, y, 3.4 * S, 3.4 * S * KY, 0, 0, 7); else { const ang = Math.atan2(a.aim.y - a.y, a.aim.x - a.x); c.moveTo(x, y); for (let k = -1.25; k <= 1.25; k += 0.1) c.lineTo(x + Math.cos(ang + k) * 5.2 * S, y + Math.sin(ang + k) * 5.2 * S * KY); c.closePath(); } c.fill(); c.stroke(); }
    if (a.kind === 'humanoid' && a.st === 'aim') { const t = byId(w, a.tgt); if (t) { const p1 = proj(cam, a.x, a.y, 1.5), p2 = proj(cam, t.x, t.y, 1.2); c.strokeStyle = 'rgba(255,40,40,.75)'; c.lineWidth = 1; line(c, [p1, p2], 1, 'rgba(255,50,50,.8)'); } }
    if (a.kind === 'loiterer') { const p1 = proj(cam, a.x, a.y, a.z), p2 = proj(cam, a.dive.x, a.dive.y, 0); c.setLineDash([5, 5]); line(c, [p1, p2], 1.5, 'rgba(255,60,40,.9)'); c.setLineDash([]); c.strokeStyle = 'rgba(255,60,40,.8)'; c.beginPath(); c.ellipse(p2[0], p2[1], 3.2 * S, 3.2 * S * KY, 0, 0, 7); c.stroke(); }
    if (a.kind === 'companion' && a.move === 'lance' && a.aim) { const d = D(a, a.aim) || 1; const p1 = proj(cam, a.x, a.y, 1.3), p2 = proj(cam, a.x + (a.aim.x - a.x) / d * 16, a.y + (a.aim.y - a.y) / d * 16, 1.3); line(c, [p1, p2], 2, 'rgba(255,246,214,.55)'); }
    if (a.kind === 'frame' && (a.move === 'lunge' || a.move === 'shot')) { const t = a.tgt === -2 ? w.charge : byId(w, a.tgt); if (t) { const p1 = proj(cam, a.x, a.y, 1.4), p2 = proj(cam, t.x, t.y, 1.2); line(c, [p1, p2], 1.5, 'rgba(201,167,255,.7)'); } }
    c.restore();
  }
  // shadows
  for (const a of w.actors) { if (a.st === 'out' || a.st === 'away') continue; const [x, y] = proj(cam, a.x, a.y, 0); const r = KINDS[a.kind].r * S * (a.kind === 'heavy' ? 1.3 : 1.4); c.fillStyle = 'rgba(0,0,0,' + (a.z ? 0.25 : 0.5) + ')'; c.beginPath(); c.ellipse(x, y, r, r * 0.45, 0, 0, 7); c.fill(); }
  // charge
  if (w.charge) { const [x, y] = proj(cam, w.charge.x, w.charge.y, 0.4); const k = w.charge.t / w.charge.dur; c.globalCompositeOperation = 'lighter'; const g = c.createRadialGradient(x, y, 0, x, y, 30 + 30 * k); g.addColorStop(0, 'rgba(255,220,120,' + (0.6 + 0.4 * Math.sin(now * (6 + 14 * k))) + ')'); g.addColorStop(1, 'rgba(255,140,40,0)'); c.fillStyle = g; c.fillRect(x - 70, y - 70, 140, 140); c.globalCompositeOperation = 'source-over'; c.fillStyle = '#ffd166'; c.fillRect(x - 5, y - 6, 10, 9); c.strokeStyle = '#06070a'; c.lineWidth = 2; c.strokeRect(x - 5, y - 6, 10, 9); }
  // depth-sorted: buildings and bodies together
  const items = [];
  for (const b of BLOCKS) items.push({ key: b.y2, b });
  for (const a of w.actors) if (a.st !== 'out' && a.st !== 'away') items.push({ key: a.y + (a.z ? 0.01 : 0), a });
  for (const p of w.proj) items.push({ key: p.y, p });
  items.sort((p, q) => p.key - q.key);
  const focus = byId(w, focusId(w));
  for (const it of items) { if (it.b) drawBlock(c, cam, it.b, now, focus); else if (it.a) drawActor(c, w, cam, it.a, now); else drawProj(c, cam, it.p); }
  drawFx(c, w, cam, now);
  // numbers
  c.textAlign = 'center';
  for (const n of w.nums) { const k = n.t / 1.1; const [x, y] = proj(cam, n.x, n.y, 2.4 + k * 2); c.globalAlpha = Math.max(0, 1 - k * k); c.font = (n.big ? '700 17px' : '600 11px') + ' "IBM Plex Mono", monospace'; c.fillStyle = '#06070a'; c.fillText(n.v, x + 1, y + 1); c.fillStyle = n.c; c.fillText(n.v, x, y); }
  c.globalAlpha = 1;
  // embers drifting up through the whole frame
  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 26; i++) { const h = hash(i * 31 + 7); const x = (h * VW * 1.3 + now * 12 * (0.5 + h) - cam.x * 4) % VW; const y = VH - ((now * (14 + 20 * hash(i)) + h * VH) % VH); c.fillStyle = 'rgba(255,' + (120 + 80 * hash(i + 3) | 0) + ',60,' + (0.25 + 0.4 * hash(i + 9)) + ')'; c.fillRect((x + VW) % VW, y, 1.6, 1.6); }
  c.globalCompositeOperation = 'source-over';
  // vignette and flash
  const v = c.createRadialGradient(VW / 2, VH / 2, VH * 0.3, VW / 2, VH / 2, VH * 0.75); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.55)'); c.fillStyle = v; c.fillRect(0, 0, VW, VH);
  if (w.flash > 0) { c.fillStyle = 'rgba(255,240,210,' + Math.min(0.85, w.flash * 0.7) + ')'; c.fillRect(0, 0, VW, VH); }
  c.restore();
}
function drawBlock(c, cam, b, now, focus) {
  const [x0, yb] = proj(cam, b.x1, b.y2, 0), [x1] = proj(cam, b.x2, b.y2, 0), [, yt] = proj(cam, b.x1, b.y1, 0), hp = b.h * S * KZ;
  let alpha = 1;
  if (focus && b.h > 1.8 && focus.y < b.y1 && focus.x > b.x1 - 1 && focus.x < b.x2 + 1 && proj(cam, focus.x, focus.y, 0)[1] > yt - hp - 10) alpha = 0.35;
  c.globalAlpha = alpha;
  const base = b.k === 'hall' ? '#2a2c38' : b.k === 'tower' ? '#25232a' : b.k === 'car' ? '#3a2f2a' : b.k === 'barricade' ? '#3b3530' : '#2c2a2a';
  // front face
  c.fillStyle = shade(base.length === 7 ? base : '#2c2a2a', 0.8); c.fillRect(x0, yb - hp, x1 - x0, hp);
  // top face
  c.fillStyle = shade(base, 1.25); c.fillRect(x0, yt - hp, x1 - x0, yb - yt);
  c.strokeStyle = '#06070a'; c.lineWidth = 2; c.strokeRect(x0, yt - hp, x1 - x0, yb - yt + hp);
  // windows, some burning
  if (b.k === 'tower' || b.k === 'hall') {
    for (let fy = 1; fy < b.h - 1; fy += 2.6) for (let fx = b.x1 + 1; fx < b.x2 - 1; fx += 2.2) {
      const h = hash(Math.round(fx * 13 + fy * 7 + b.x1 * 3)); const [wx] = proj(cam, fx, b.y2, 0), wy = yb - fy * S * KZ - 10;
      if (b.k === 'hall') { c.fillStyle = 'rgba(110,220,255,' + (0.25 + 0.2 * Math.sin(now * 2 + h * 6)) + ')'; c.fillRect(wx, wy, 14, 5); continue; }
      if (h < 0.18) { const f = 0.6 + 0.4 * Math.sin(now * 9 + h * 40); c.fillStyle = 'rgba(255,' + (110 + 60 * f | 0) + ',40,' + (0.7 + 0.3 * f) + ')'; c.fillRect(wx, wy, 16, 10); c.globalCompositeOperation = 'lighter'; c.fillStyle = 'rgba(255,120,40,.18)'; c.fillRect(wx - 8, wy - 14, 32, 30); c.globalCompositeOperation = 'source-over'; }
      else if (h < 0.4) { c.fillStyle = 'rgba(255,214,150,.22)'; c.fillRect(wx, wy, 16, 10); }
      else { c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(wx, wy, 16, 10); }
    }
  }
  if (b.k === 'hall') { c.font = '600 9px "IBM Plex Mono", monospace'; c.fillStyle = 'rgba(160,230,255,.55)'; c.textAlign = 'left'; c.fillText('HAKODATE NORTH HALL · COMPUTE', x0 + 10, yt - hp + 14); }
  c.globalAlpha = 1;
}
function figure(c, x, y, H, o) {
  // a person (or a person-shaped machine) with legs, arms, a head, and a weapon
  const f = o.face || 1, ink = true;
  if (o.pose === 'down') { const p = [[x - H * 0.45, y - 3], [x + H * 0.4, y - 3]]; line(c, p, H * 0.13, o.col, ink); circle(c, x + H * 0.48 * f, y - 4, H * 0.08, o.skin || o.col, ink); return; }
  let crouch = o.pose === 'dodge' ? 0.72 : o.pose === 'plant' || o.pose === 'revive' ? 0.78 : 1;
  const Hh = H * crouch;
  const lean = { run: 0.12, wind: -0.14, strike: 0.3, dodge: 0.4, stagger: -0.3, aim: 0 }[o.pose] || 0;
  const hip = [x, y - Hh * 0.5], sh = [x + f * lean * Hh * 0.35, y - Hh * 0.8], head = [x + f * lean * Hh * 0.42, y - Hh * 0.93];
  const st = o.pose === 'run' || o.pose === 'dodge' ? Math.sin(o.ph) * Hh * 0.22 : 0;
  const lift = o.pose === 'run' ? Math.abs(Math.cos(o.ph)) * Hh * 0.06 : 0;
  const k1 = [x + f * (st * 0.5 + Hh * 0.04), y - Hh * 0.26 - lift], k2 = [x - f * (st * 0.5 - Hh * 0.04), y - Hh * 0.26];
  const legW = o.legW || Math.max(2, H * 0.085);
  if (!o.noLegs) { line(c, [hip, k2, [x - f * st, y]], legW, shade(o.col, 0.75), ink); line(c, [hip, k1, [x + f * st, y - lift]], legW, o.col, ink); }
  // torso
  line(c, [hip, sh], o.torsoW || Math.max(3, H * 0.16), o.body || o.col, ink);
  // arms
  const arm = Hh * 0.36;
  let hand = [sh[0] + f * Hh * 0.08, sh[1] + Hh * 0.3];
  if (o.pose === 'run') hand = [sh[0] - f * Math.sin(o.ph) * Hh * 0.18, sh[1] + Hh * 0.28];
  if (o.pose === 'wind') hand = [sh[0] - f * arm * 0.85, sh[1] - Hh * 0.18];
  if (o.pose === 'strike') hand = [sh[0] + f * arm * 1.15, sh[1] + Hh * 0.04];
  if (o.pose === 'aim') hand = [sh[0] + f * arm * 1.05, sh[1] + Hh * 0.02];
  if (o.pose === 'plant' || o.pose === 'revive') hand = [sh[0] + f * arm * 0.7, sh[1] + Hh * 0.42];
  const back = [sh[0] + f * Math.sin(o.ph) * Hh * 0.15 - f * Hh * 0.05, sh[1] + Hh * 0.3];
  const armW = o.armW || Math.max(2, H * 0.07);
  if (!o.noArmB) line(c, [sh, [(sh[0] + back[0]) / 2 - f * 2, (sh[1] + back[1]) / 2], back], armW, shade(o.col, 0.7), ink);
  if (!o.noArmF) line(c, [sh, [(sh[0] + hand[0]) / 2, (sh[1] + hand[1]) / 2 + 2], hand], armW, o.col, ink);
  // head
  circle(c, head[0], head[1], o.headR || H * 0.085, o.skin || o.col, ink);
  if (o.eye) { c.fillStyle = o.eye; c.fillRect(head[0] + f * H * 0.03 - 2, head[1] - 1.5, 4, 2.5); }
  // weapon
  if (o.weapon && !o.noArmF) {
    const wl = o.weapon.len * H, wa = o.pose === 'wind' ? -2.2 : o.pose === 'strike' ? 0.1 : o.pose === 'aim' ? 0 : 1.1;
    const tip = [hand[0] + f * Math.cos(wa) * wl, hand[1] + Math.sin(wa) * wl];
    if (o.weapon.k === 'blade') { if (o.pose === 'strike' || o.glow) { c.globalCompositeOperation = 'lighter'; line(c, [hand, tip], 6, 'rgba(255,220,140,.35)'); c.globalCompositeOperation = 'source-over'; } line(c, [hand, tip], 2.4, o.weapon.c, true); }
    if (o.weapon.k === 'bow') { c.strokeStyle = '#06070a'; c.lineWidth = 4; c.beginPath(); c.arc(hand[0], hand[1], H * 0.32, f > 0 ? -1.2 : 1.94, f > 0 ? 1.2 : 4.34); c.stroke(); c.strokeStyle = o.weapon.c; c.lineWidth = 2; c.stroke(); }
    if (o.weapon.k === 'shield') { c.fillStyle = '#06070a'; c.fillRect(hand[0] + f * 1 - 5, hand[1] - H * 0.28, 10, H * 0.42); c.fillStyle = o.weapon.c; c.fillRect(hand[0] + f * 1 - 3.5, hand[1] - H * 0.26, 7, H * 0.38); }
    if (o.weapon.k === 'arc') { c.globalCompositeOperation = 'lighter'; const g = c.createRadialGradient(hand[0], hand[1], 0, hand[0], hand[1], 10); g.addColorStop(0, 'rgba(180,240,255,.95)'); g.addColorStop(1, 'rgba(80,200,255,0)'); c.fillStyle = g; c.fillRect(hand[0] - 10, hand[1] - 10, 20, 20); c.globalCompositeOperation = 'source-over'; }
    if (o.weapon.k === 'rifle') line(c, [hand, [hand[0] + f * H * 0.32, hand[1] - 1]], 3, '#3a3d44', true);
    if (o.weapon.k === 'armblade') { line(c, [hand, tip], 3, '#efe6ff', true); if (o.pose === 'strike') { c.globalCompositeOperation = 'lighter'; line(c, [hand, tip], 8, 'rgba(201,167,255,.4)'); c.globalCompositeOperation = 'source-over'; } }
  }
}
function drawActor(c, w, cam, a, now) {
  const H = KINDS[a.kind].H * S * KZ;
  const [x, y] = proj(cam, a.x, a.y, a.z);
  let alpha = a.st === 'dead' ? Math.max(0, 1 - a.stT / (a.kind === 'heavy' ? 6 : 1.6)) : 1;
  if (a.st === 'dormant') alpha = 0.6;
  c.globalAlpha = alpha;
  const pose = a.st === 'dead' ? 'down' : a.st === 'down' || a.st === 'dormant' ? 'down' : a.st === 'wind' ? 'wind' : a.st === 'strike' ? 'strike' : a.st === 'aim' ? 'aim' : a.st === 'dodge' ? 'dodge' : a.st === 'stagger' ? 'stagger' : a.st === 'plant' ? 'plant' : a.st === 'revive' ? 'revive' : Math.hypot(a.vx, a.vy) > 0.4 ? 'run' : 'idle';
  const hitFlash = a.hit > 0;
  if (a.side === 'g') {
    // gifted: light around the body that grows with the draw; heat shows as fire
    const glow = a.kind === 'companion' ? 1 : 0.4 + 0.6 * tide(w.t);
    c.globalCompositeOperation = 'lighter'; const g = c.createRadialGradient(x, y - H * 0.55, 0, x, y - H * 0.55, H * (a.kind === 'companion' ? 1.6 : 0.9)); g.addColorStop(0, hexA(COL[a.kind], 0.28 * glow)); g.addColorStop(1, hexA(COL[a.kind], 0)); c.fillStyle = g; c.fillRect(x - H * 1.6, y - H * 2.2, H * 3.2, H * 3.2);
    if (a.heat > 70) { const k = Math.min(1, (a.heat - 70) / 60); const g2 = c.createRadialGradient(x, y - H * 0.5, 0, x, y - H * 0.5, H * 0.9); g2.addColorStop(0, 'rgba(255,110,30,' + 0.5 * k + ')'); g2.addColorStop(1, 'rgba(255,60,20,0)'); c.fillStyle = g2; c.fillRect(x - H, y - H * 1.5, H * 2, H * 2); }
    c.globalCompositeOperation = 'source-over';
    if (a.dome > 0) { c.strokeStyle = 'rgba(141,255,176,.7)'; c.fillStyle = 'rgba(141,255,176,.08)'; c.lineWidth = 2; c.beginPath(); c.ellipse(x, y - 4, 3.5 * S, 3.5 * S * KY, 0, Math.PI, 0); c.lineTo(x + 3.5 * S, y - 4); c.ellipse(x, y - 4, 3.5 * S, 3.5 * S * 1.1, 0, 0, Math.PI, true); c.fill(); c.stroke(); }
    if (a.kind === 'companion' && a.st !== 'dormant') { c.strokeStyle = 'rgba(255,246,214,.12)'; c.lineWidth = 1; c.beginPath(); c.ellipse(x, y, 10 * S, 10 * S * KY, 0, 0, 7); c.stroke(); circle(c, x, y - H * 1.08, 3, 'rgba(255,246,214,.9)'); }
    const wp = { blade: { k: 'blade', len: 0.55, c: '#fff1c4' }, arc: { k: 'arc' }, shield: { k: 'shield', c: '#8dffb0' }, bow: { k: 'bow', c: '#e3c8ff' }, companion: { k: 'blade', len: 0.6, c: '#ffffff' } }[a.kind];
    figure(c, x, y, H, { face: a.face, pose, ph: a.ph, col: hitFlash ? '#ffffff' : shade(COL[a.kind], 0.85), body: hitFlash ? '#fff' : '#2b2730', skin: '#e8cfb0', weapon: wp, glow: a.kind === 'blade' && w.stance === 'push' });
  } else if (a.kind === 'civ') {
    figure(c, x, y, H, { face: a.face, pose: a.st === 'hide' ? 'idle' : pose, ph: a.ph, col: hitFlash ? '#fff' : '#8a7f70', body: '#5d5448', skin: '#d8c2a6' });
  } else if (a.kind === 'humanoid') {
    figure(c, x, y, H, { face: a.face, pose, ph: a.ph, col: hitFlash ? '#fff' : '#7e848f', body: '#4a4f58', skin: '#9aa0aa', headR: H * 0.07, eye: '#ff3b3b', weapon: { k: 'rifle' } });
  } else if (a.kind === 'frame') {
    const mine = w.mode === 'mind';
    if (mine) { c.globalCompositeOperation = 'lighter'; const g = c.createRadialGradient(x, y - H * 0.5, 0, x, y - H * 0.5, H); g.addColorStop(0, 'rgba(201,167,255,' + (w.oc ? 0.4 : 0.2) + ')'); g.addColorStop(1, 'rgba(120,80,255,0)'); c.fillStyle = g; c.fillRect(x - H, y - H * 1.6, H * 2, H * 2); c.globalCompositeOperation = 'source-over'; }
    figure(c, x, y, H, { face: a.face, pose, ph: a.ph, col: hitFlash ? '#fff' : '#3b3346', body: '#1d1824', skin: '#2e2738', headR: H * 0.075, eye: '#efe6ff', weapon: { k: 'armblade', len: 0.6 }, armW: H * 0.08, legW: H * 0.09 });
  } else if (a.kind === 'heavy') {
    const L = a.lim;
    c.globalCompositeOperation = 'lighter'; const core = a.lim.la <= 0 || a.lim.ra <= 0; const g = c.createRadialGradient(x, y - H * 0.66, 0, x, y - H * 0.66, H * 0.3); g.addColorStop(0, core ? 'rgba(255,90,60,.9)' : 'rgba(255,60,40,.35)'); g.addColorStop(1, 'rgba(255,40,20,0)'); c.fillStyle = g; c.fillRect(x - H * 0.4, y - H, H * 0.8, H * 0.8); c.globalCompositeOperation = 'source-over';
    figure(c, x, y, H, { face: a.face, pose: pose === 'aim' ? 'idle' : pose, ph: a.ph * 0.6, col: hitFlash ? '#fff' : '#6e737d', body: '#4a4e57', skin: '#5b606a', headR: H * 0.06, eye: '#ff4a2a', torsoW: H * 0.26, armW: H * 0.1, legW: H * 0.12, noArmF: a.face > 0 ? L.ra <= 0 : L.la <= 0, noArmB: a.face > 0 ? L.la <= 0 : L.ra <= 0, noLegs: false });
    if (L.legs <= 0) { c.fillStyle = 'rgba(255,140,60,.8)'; c.fillRect(x - 6, y - H * 0.3, 12, 4); }
  } else if (a.kind === 'drone') {
    const [sx, sy] = [x, y]; const tilt = clamp(a.vx / 9, -1, 1) * 3;
    line(c, [[sx - 9, sy + tilt], [sx + 9, sy - tilt]], 3, '#5d626b', true); line(c, [[sx - 6, sy - 5], [sx + 6, sy + 5]], 2, '#5d626b', true);
    c.fillStyle = 'rgba(200,210,220,.25)'; for (const [dx, dy] of [[-9, tilt], [9, -tilt]]) { c.beginPath(); c.ellipse(sx + dx, sy + dy - 2, 7, 2.2, 0, 0, 7); c.fill(); }
    circle(c, sx, sy, 3.5, hitFlash ? '#fff' : '#9aa0aa', true); c.fillStyle = '#ff3b3b'; c.fillRect(sx - 1, sy - 1, 2, 2);
  } else if (a.kind === 'loiterer') {
    const ang = Math.atan2(a.vy * KY - (a.dive && a.dive.warn <= 0 ? 6 : 0), a.vx || 1);
    c.save(); c.translate(x, y); c.rotate(ang); c.fillStyle = '#06070a'; c.beginPath(); c.moveTo(10, 0); c.lineTo(-7, -7); c.lineTo(-4, 0); c.lineTo(-7, 7); c.closePath(); c.fill(); c.fillStyle = hitFlash ? '#fff' : '#c2c6cc'; c.beginPath(); c.moveTo(8, 0); c.lineTo(-5, -5); c.lineTo(-3, 0); c.lineTo(-5, 5); c.closePath(); c.fill(); c.restore();
    if (a.dive && a.dive.warn <= 0) { c.globalCompositeOperation = 'lighter'; circle(c, x, y, 6, 'rgba(255,90,40,.5)'); c.globalCompositeOperation = 'source-over'; }
  }
  // bars and names for the people who matter
  if (alive(a) && a.side !== 'c' && a.kind !== 'drone' && a.kind !== 'loiterer') {
    const bw = a.kind === 'heavy' ? 46 : 26, by = y - H - 10;
    c.fillStyle = 'rgba(0,0,0,.6)'; c.fillRect(x - bw / 2, by, bw, 3);
    c.fillStyle = a.side === 'g' ? COL[a.kind] : a.kind === 'frame' && w.mode === 'mind' ? '#c9a7ff' : '#ff6b6b'; c.fillRect(x - bw / 2, by, bw * Math.max(0, a.hp / a.max), 3);
    if (a.side === 'g' && a.kind !== 'companion') { c.fillStyle = a.heat > 100 ? '#ff6b3a' : '#ffb347'; c.fillRect(x - bw / 2, by + 4, bw * Math.min(1.3, a.heat / 100) / 1.3, 2); }
    if (a.name && (a.side === 'g' || a.kind === 'frame')) { c.font = '600 8px "IBM Plex Mono", monospace'; c.textAlign = 'center'; c.fillStyle = '#06070a'; c.fillText(a.name, x + 1, by - 3); c.fillStyle = a.side === 'g' ? COL[a.kind] : '#c9a7ff'; c.fillText(a.name, x, by - 4); }
  }
  if (a.st === 'down' && a.side === 'g') { c.font = '600 8px "IBM Plex Mono", monospace'; c.textAlign = 'center'; c.fillStyle = '#ff6b6b'; c.fillText(a.name + ' DOWN ' + Math.ceil(a.bleed) + 's', x, y - 14); }
  c.globalAlpha = 1;
}
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }
function drawProj(c, cam, p) {
  if (p.delay > 0) return;
  if (p.k === 'gren') { const [x, y] = proj(cam, p.x, p.y, p.z); circle(c, x, y, 2.5, '#ffb347', true); return; }
  const [x, y] = proj(cam, p.x, p.y, p.z || 1.4), [x2, y2] = proj(cam, p.x - p.vx * 0.04, p.y - p.vy * 0.04, p.z || 1.4);
  const col = p.k === 'bolt' ? 'rgba(230,200,255,.95)' : p.k === 'shot' ? 'rgba(201,167,255,.95)' : 'rgba(255,90,70,.9)';
  c.globalCompositeOperation = 'lighter'; line(c, [[x2, y2], [x, y]], p.k === 'bolt' ? 3 : 2, col); c.globalCompositeOperation = 'source-over';
}
function drawFx(c, w, cam, now) {
  c.globalCompositeOperation = 'lighter';
  for (const e of w.fx) {
    const k = e.t / e.dur;
    if (e.k === 'slash') { const [x, y] = proj(cam, e.x, e.y, e.z); const r = e.r * S; c.save(); c.translate(x, y); c.scale(1, KY); const a0 = e.a - e.arc / 2, a1 = e.a + e.arc / 2; const sweep = Math.min(1, k * 2.5); c.strokeStyle = e.c; c.globalAlpha = 1 - k; c.lineWidth = e.w * (1 - k * 0.6); c.beginPath(); if (e.flip) c.arc(0, 0, r, a1, a1 - (a1 - a0) * sweep, true); else c.arc(0, 0, r, a0, a0 + (a1 - a0) * sweep); c.stroke(); c.lineWidth = e.w * 3; c.globalAlpha = (1 - k) * 0.25; c.stroke(); c.restore(); c.globalAlpha = 1; }
    if (e.k === 'zap') { c.strokeStyle = e.c; for (let pass = 0; pass < 2; pass++) { c.lineWidth = pass ? 1.5 : 5; c.globalAlpha = (1 - k) * (pass ? 1 : 0.35); c.beginPath(); for (let i = 0; i < e.pts.length - 1; i++) { const [ax, ay, az] = e.pts[i], [bx, by, bz] = e.pts[i + 1]; const p0 = proj(cam, ax, ay, az), p1 = proj(cam, bx, by, bz); if (!i) c.moveTo(p0[0], p0[1]); for (let s = 1; s <= 6; s++) { const f = s / 6, j = s < 6 ? (hash(e.seed * 17 + i * 31 + s + Math.floor(now * 30)) - 0.5) * 14 : 0; c.lineTo(p0[0] + (p1[0] - p0[0]) * f + j, p0[1] + (p1[1] - p0[1]) * f + j * 0.6); } } c.stroke(); } c.globalAlpha = 1; }
    if (e.k === 'boom') { const [x, y] = proj(cam, e.x, e.y, e.z || 0); const r = (e.r0 + (e.r1 - e.r0) * Math.sqrt(k)) * S; const g = c.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, 'rgba(255,255,230,' + (1 - k) + ')'); g.addColorStop(0.35, hexA(e.c, 0.8 * (1 - k))); g.addColorStop(1, hexA(e.c, 0)); c.fillStyle = g; c.beginPath(); c.ellipse(x, y, r, r * 0.85, 0, 0, 7); c.fill(); }
    if (e.k === 'ring') { const [x, y] = proj(cam, e.x, e.y, 0.1); const r = (e.r0 + (e.r1 - e.r0) * k) * S; c.strokeStyle = e.c; c.globalAlpha = 1 - k; c.lineWidth = 3 * (1 - k) + 1; c.beginPath(); c.ellipse(x, y, r, r * KY, 0, 0, 7); c.stroke(); c.globalAlpha = 1; }
    if (e.k === 'spark') { for (let i = 0; i < e.n; i++) { const a = hash(e.seed * 7 + i) * 6.28, sp = 2 + hash(e.seed + i * 3) * 5; const [x, y] = proj(cam, e.x + Math.cos(a) * sp * k * 0.6, e.y + Math.sin(a) * sp * k * 0.4, e.z + 2.5 * k - 4 * k * k); c.fillStyle = e.c; c.globalAlpha = 1 - k; c.fillRect(x - 1, y - 1, 2.5, 2.5); } c.globalAlpha = 1; }
    if (e.k === 'ember') { const [x, y] = proj(cam, e.x, e.y, e.z + k * 1.5); c.fillStyle = 'rgba(255,140,50,' + (1 - k) + ')'; c.fillRect(x, y, 2, 2); }
    if (e.k === 'dash') { const p0 = proj(cam, e.x1, e.y1, 1), p1 = proj(cam, e.x2, e.y2, 1); c.globalAlpha = 1 - k; line(c, [p0, p1], 10 * (1 - k), hexA(e.c, 0.35)); line(c, [p0, p1], 2, e.c); c.globalAlpha = 1; }
    if (e.k === 'beam') { const p0 = proj(cam, e.x1, e.y1, e.h), p1 = proj(cam, e.x2, e.y2, e.h); c.globalAlpha = 1 - k; line(c, [p0, p1], 22 * (1 - k * 0.5), 'rgba(255,230,160,.25)'); line(c, [p0, p1], 6, 'rgba(255,250,230,.9)'); c.globalAlpha = 1; }
    if (e.k === 'pillar') { const [x, y] = proj(cam, e.x, e.y, 0); const wd = 30 * (1 - k) + 8; const g = c.createLinearGradient(x - wd, 0, x + wd, 0); g.addColorStop(0, hexA(e.c, 0)); g.addColorStop(0.5, hexA(e.c, 0.85 * (1 - k))); g.addColorStop(1, hexA(e.c, 0)); c.fillStyle = g; c.fillRect(x - wd, 0, wd * 2, y); }
    if (e.k === 'ghost') { c.globalAlpha = 0.35 * (1 - k); const [x, y] = proj(cam, e.x, e.y, 0); const H = KINDS[e.kind].H * S * KZ; c.globalCompositeOperation = 'source-over'; figure(c, x, y, H, { face: e.face, pose: 'dodge', ph: 0, col: '#9fe8ff', body: '#9fe8ff', skin: '#9fe8ff' }); c.globalCompositeOperation = 'lighter'; c.globalAlpha = 1; }
  }
  c.globalCompositeOperation = 'source-over';
  for (const e of w.fx) { if (e.k !== 'limb') continue; const [x, y] = proj(cam, e.x, e.y, e.z); c.save(); c.translate(x, y); c.rotate(e.rot); line(c, [[-14, 0], [14, 0]], 9, e.c, true); c.restore(); }
}
function focusId(w) {
  if (w.mode === 'mind') return w.frameId;
  const g = gifted(w).filter(up);
  const ren = g.find(a => a.kind === 'blade');
  return (ren || g[0] || gifted(w)[0]).id;
}
function camStep(w, cam, real) {
  const f = byId(w, focusId(w));
  let tx = cam.x, ty = cam.y;
  if (f) { const t = f.tgt > 0 ? byId(w, f.tgt) : null; tx = f.x + (t ? (t.x - f.x) * 0.3 : f.face * 2); ty = f.y + (t ? (t.y - f.y) * 0.3 : 0) - 1; }
  const k = 1 - Math.pow(0.02, real);
  cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
  cam.x = clamp(cam.x, VW / 2 / S, MAPW - VW / 2 / S); cam.y = clamp(cam.y, 9, MAPH - VH / 2 / (S * KY) + 1);
  const sh = w.shake > 0 ? w.shake / S : 0;
  return { x: cam.x + (sh ? Math.sin(w.t * 90) * sh : 0), y: cam.y + (sh ? Math.cos(w.t * 77) * sh : 0) };
}

export { S, KY, KZ, VW, VH, COL, drawWorld, camStep, focusId };
