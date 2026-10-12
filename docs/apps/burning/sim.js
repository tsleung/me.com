// The Burning — a street-level fight in metres, on the night every compute
// hall burns at once. Played from either side (mode 'burning' or 'mind').
// Source of truth for the public app and for the prototypes canvas board
// (notes/wta-game/design/2026_10_12_artifact/build/street/assemble.py).
// Street-level fight, in metres. One engine, two sides to play:
//   mode 'burning' — the gifted strike team on the night of the Burning.
//   mode 'mind'    — the mind defending its core, against WTA's protagonist.
// Pure-ish: advance(w0, real) clones once and mutates the clone; the loop is
// the only writer. Decisions are explicit records so a pilot, the viewer or a
// playtester (w.ext) can answer them; a replay with one flipped answer is how
// the bench measures whether a decision mattered.

const DT = 1 / 30;
const MAPW = 72, MAPH = 44;
const T_CLOSE = 275;
const BLOCKS = [
  { x1: 0, y1: 0, x2: 17, y2: 8, h: 12, k: 'tower' },
  { x1: 21, y1: 0, x2: 37, y2: 7, h: 16, k: 'tower' },
  { x1: 41, y1: 0, x2: 50, y2: 8, h: 10, k: 'tower' },
  { x1: 52, y1: 0, x2: 72, y2: 9, h: 19, k: 'hall' },
  { x1: 0, y1: 37, x2: 17, y2: 44, h: 1.6, k: 'rubble' },
  { x1: 21, y1: 38, x2: 37, y2: 44, h: 2.2, k: 'rubble' },
  { x1: 41, y1: 37, x2: 50, y2: 44, h: 1.4, k: 'rubble' },
  { x1: 52, y1: 36, x2: 72, y2: 44, h: 2.6, k: 'wall' },
  { x1: 51, y1: 9, x2: 52.2, y2: 18, h: 3, k: 'wall' },
  { x1: 51, y1: 26, x2: 52.2, y2: 36, h: 3, k: 'wall' },
  { x1: 71, y1: 9, x2: 72, y2: 36, h: 3, k: 'wall' },
  { x1: 12, y1: 15, x2: 16, y2: 16.8, h: 1.4, k: 'car' },
  { x1: 26, y1: 25, x2: 30, y2: 26.8, h: 1.4, k: 'car' },
  { x1: 7, y1: 29, x2: 11, y2: 30.8, h: 1.4, k: 'car' },
  { x1: 33.5, y1: 13, x2: 35, y2: 18, h: 1.6, k: 'barricade' },
  { x1: 44, y1: 21, x2: 45.5, y2: 27, h: 1.6, k: 'barricade' },
];
const CORE = { x: 63, y: 22 };
const DOOR = { x: 51.6, y: 22 };
const SPAWNS = [{ x: 19, y: 1.5 }, { x: 39, y: 1.5 }, { x: 19, y: 42.5 }, { x: 39, y: 42.5 }, { x: 62, y: 10.5 }];
const KINDS = {
  blade: { side: 'g', hp: 130, spd: 5.6, r: 0.45, H: 1.8 },
  arc: { side: 'g', hp: 105, spd: 5.0, r: 0.45, H: 1.75 },
  shield: { side: 'g', hp: 190, spd: 4.6, r: 0.5, H: 1.85 },
  bow: { side: 'g', hp: 95, spd: 5.0, r: 0.45, H: 1.75 },
  companion: { side: 'g', hp: 520, spd: 6.2, r: 0.5, H: 1.95 },
  drone: { side: 'm', hp: 24, spd: 9, r: 0.4, H: 0.5, fly: 3.6, w: 0.4, cost: 12 },
  loiterer: { side: 'm', hp: 16, spd: 30, r: 0.35, H: 0.4, fly: 22, w: 0.5, cost: 18 },
  humanoid: { side: 'm', hp: 75, spd: 4.2, r: 0.45, H: 2.2, w: 1, cost: 20 },
  heavy: { side: 'm', hp: 320, spd: 2.3, r: 1.3, H: 6.2, w: 3, cost: 70 },
  frame: { side: 'm', hp: 180, spd: 6.4, r: 0.6, H: 2.6, w: 2.5 },
  civ: { side: 'c', hp: 30, spd: 3.4, r: 0.4, H: 1.7 },
};
const GNAMES = { blade: 'REN', arc: 'ISE', shield: 'TOMA', bow: 'KEI', companion: 'THE COMPANION' };
const ROLE_OFF = { blade: [2, 0], arc: [-2, -2.5], shield: [0, 2.5], bow: [-6, 0], companion: [1, -1] };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const fmt = t => { t = Math.max(0, Math.floor(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
function rnd(w) { let t = (w.rs = (w.rs + 0x6d2b79f5) >>> 0); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
function tide(t) { return 0.25 + 0.75 * Math.sin(Math.PI * clamp(t, 0, 340) / 340); }

function mk(w, kind, x, y, extra) {
  const k = KINDS[kind];
  const a = { id: w.nid++, kind, side: k.side, x, y, vx: 0, vy: 0, face: 1, hp: k.hp, max: k.hp, st: 'move', stT: 0, cd: 0, cd2: 0, dcd: 0, tgt: -1, z: k.fly || 0, ph: rnd(w) * 6, heat: 0, inv: 0, bleed: 0, name: GNAMES[kind] || '', kills: 0, lunge: null, pass: 0, hit: 0, ...extra };
  if (kind === 'heavy') a.lim = { la: 95, ra: 95, legs: 170 };
  w.actors.push(a);
  return a;
}

function makeWorld(seed, mode) {
  const w = {
    seed, mode, rs: (seed >>> 0) || 1, t: 0, nid: 1, actors: [], proj: [], fx: [], nums: [], scorch: [], phase: 'stage', commitT: -1, tideAtCommit: 0,
    charge: null, chargesLeft: 2, compute: 30, alert: 0, init: 0, stance: 'steady', oc: false, integ: 100, frameId: -1, compId: -1, transferT: 0,
    escort: false, carry: true, mtarget: 'charge', mcivil: true, slow: 0, shake: 0, flash: 0, banner: null, log: [], moments: [], decisions: [], dq: 0,
    nextDec: 4, decTurn: 0, end: null, ext: null, halt: null, override: {}, cam: { x: 11, y: 23 }, policyBias: 0,
    m: { kills: { drone: 0, loiterer: 0, humanoid: 0, heavy: 0, frame: 0 }, limbs: 0, dodges: 0, downs: 0, revives: 0, deaths: 0, burnouts: 0, transfers: 0, civOut: 0, civLost: 0, civHurt: 0, swings: 0, comebacks: 0, lead: 0, low: { g: false, m: false }, minInit: 0, maxInit: 0, bins: [], combat: 0, lull: 0, longestLull: 0, contested: 0, dmgOut: 0, plantT: -1, burnT: -1 },
  };
  w.policyBias = (rnd(w) - 0.5) * 0.3; // a seed's pilot temperament
  const g = ['blade', 'arc', 'shield', 'bow'];
  g.forEach((k, i) => mk(w, k, 3 + (i % 2) * 1.6, 20 + i * 1.6));
  if (mode === 'mind') { const c = mk(w, 'companion', -6, 22, { st: 'away' }); w.compId = c.id; }
  [[30, 18], [32, 28], [46, 15], [47, 30]].forEach(([x, y]) => mk(w, 'humanoid', x, y));
  [[40, 20], [49, 27]].forEach(([x, y]) => mk(w, 'drone', x, y));
  mk(w, 'heavy', 57, 22);
  const f = mk(w, 'frame', 60, 27, { name: mode === 'mind' ? 'YOU — THE MIND' : 'THE WARDEN' });
  if (mode === 'mind') { f.hp = f.max = 300; }
  w.frameId = f.id;
  for (let i = 0; i < 7; i++) mk(w, 'civ', 56 + rnd(w) * 12, 28 + rnd(w) * 6, { st: 'hide', name: 'night shift' });
  for (let i = 0; i < 3; i++) mk(w, 'civ', 22 + i * 9, 9.5, { st: 'hide', name: 'resident' });
  say(w, mode === 'mind' ? 'The strike team is on the street. You have until the tide falls.' : 'Every hall burns tonight, or none does. The tide is rising.', '#e9e4d8');
  return w;
}

// ---------- small helpers ----------
const alive = a => a && a.hp > 0 && a.st !== 'dead' && a.st !== 'away' && a.st !== 'dormant' && a.st !== 'out';
const up = a => alive(a) && a.st !== 'down';
const byId = (w, id) => w.actors.find(a => a.id === id);
const gifted = w => w.actors.filter(a => a.side === 'g');
const machines = w => w.actors.filter(a => a.side === 'm' && alive(a));
function say(w, text, c) { w.log.push({ t: w.t, text, c: c || '#b5b0a3' }); if (w.log.length > 40) w.log.shift(); }
function moment(w, text, c) { w.moments.push({ t: w.t, text, c: c || '#e9e4d8' }); say(w, text, c); }
function banner(w, text, sub, c, size) { w.banner = { text, sub: sub || '', c: c || '#fff', size: size || 22, t: 0, dur: 2.4 }; }
function fx(w, k, o) { w.fx.push({ k, t: 0, dur: 0.5, ...o }); }
function num(w, x, y, v, c, big) { w.nums.push({ x, y, v, c, big, t: 0 }); }
function bin(w, kind) { const i = Math.floor(w.t / 15); while (w.m.bins.length <= i) w.m.bins.push({}); w.m.bins[i][kind] = (w.m.bins[i][kind] || 0) + 1; }

function gPow(w, a) {
  let m = 0.55 + 0.85 * tide(w.t);
  if (w.stance === 'push') m *= 1.35;
  const c = byId(w, w.compId);
  if (c && up(c) && a.kind !== 'companion' && D(a, c) < 10) m *= 1.35;
  if (a.heat > 100) m *= 0.75;
  if (w.init > 0.3) m *= 1.1;
  return m;
}
const ocK = (w, a) => (a.kind === 'frame' && w.mode === 'mind' && w.oc ? 1.38 : 1);

// ---------- movement ----------
function blocked(x, y, r) { for (const b of BLOCKS) if (x > b.x1 - r && x < b.x2 + r && y > b.y1 - r && y < b.y2 + r) return b; return null; }
function pushOut(a) {
  const r = KINDS[a.kind].r;
  for (const b of BLOCKS) {
    if (a.x > b.x1 - r && a.x < b.x2 + r && a.y > b.y1 - r && a.y < b.y2 + r) {
      const dl = a.x - (b.x1 - r), dr = b.x2 + r - a.x, dt = a.y - (b.y1 - r), db = b.y2 + r - a.y, m = Math.min(dl, dr, dt, db);
      if (m === dl) a.x = b.x1 - r; else if (m === dr) a.x = b.x2 + r; else if (m === dt) a.y = b.y1 - r; else a.y = b.y2 + r;
    }
  }
  a.x = clamp(a.x, a.kind === 'civ' || a.side === 'g' ? -8 : 0.5, MAPW - 0.5);
  a.y = clamp(a.y, 0.5, MAPH - 0.5);
}
function waypoint(a, tx, ty) {
  const inside = x => x > 51.6;
  if (inside(a.x) !== inside(tx)) {
    const near = inside(a.x) ? 53.6 : 49.5, far = inside(a.x) ? 49.5 : 53.6;
    const inGap = Math.abs(a.y - 22) <= 3 && a.x > 49.2 && a.x < 53.9;
    if (!inGap || Math.abs(a.x - near) > 1.4 && Math.abs(a.y - 22) > 2.6) return { x: near, y: clamp(a.y, 19.6, 24.4) };
    return { x: far, y: clamp(a.y, 19.6, 24.4) };
  }
  return { x: tx, y: ty };
}
function moveTo(w, a, tx, ty, spd, dt) {
  const p = waypoint(a, tx, ty);
  const dx = p.x - a.x, dy = p.y - a.y, d = Math.hypot(dx, dy);
  if (d < 0.15) { a.vx = 0; a.vy = 0; return true; }
  const s = Math.min(spd, d / dt);
  let vx = (dx / d) * s, vy = (dy / d) * s;
  // slide along cover: if the next step is blocked, try the perpendicular
  const r = KINDS[a.kind].r;
  if (!a.z && blocked(a.x + vx * dt, a.y + vy * dt, r)) { const sg = (a.id % 2 ? 1 : -1); const px = -vy * sg, py = vx * sg; if (!blocked(a.x + px * dt, a.y + py * dt, r)) { vx = px; vy = py; } }
  a.vx = vx; a.vy = vy; a.x += vx * dt; a.y += vy * dt;
  if (Math.abs(vx) > 0.2) a.face = vx > 0 ? 1 : -1;
  a.ph += s * dt * 2.2;
  return d < 0.6;
}
function faceTo(a, b) { if (b && Math.abs(b.x - a.x) > 0.05) a.face = b.x > a.x ? 1 : -1; }
function nearest(list, p, f) { let best = null, bd = 1e9; for (const o of list) { if (f && !f(o)) continue; const d = D(o, p); if (d < bd) { bd = d; best = o; } } return best; }

// ---------- damage ----------
function hurt(w, t, dmg, src, kind) {
  if (!t || !alive(t)) return 0;
  if (t.inv > 0 && kind !== 'aoe-big') { num(w, t.x, t.y, 'DODGE', '#9fe8ff'); w.m.dodges++; bin(w, 'dodge'); return 0; }
  if (t.side === 'g' && t.st !== 'down' && (kind === 'shot' || kind === 'aoe')) {
    const sh = w.actors.find(s => s.kind === 'shield' && up(s) && s.dome > 0 && D(s, t) < 3.6);
    if (sh) { dmg *= 0.3; fx(w, 'ring', { x: sh.x, y: sh.y, r0: 3.4, r1: 3.8, c: '#8dffb0', dur: 0.25 }); }
  }
  if (t.kind === 'heavy') {
    const L = t.lim, side = src && src.x > t.x ? (t.face > 0 ? 'ra' : 'la') : (t.face > 0 ? 'la' : 'ra');
    const other = side === 'ra' ? 'la' : 'ra';
    const arm = L[side] > 0 ? side : L[other] > 0 ? other : null;
    const melee = kind === 'melee';
    if (arm) {
      const k = melee && src && src.kind === 'blade' ? 1.5 : 1;
      L[arm] -= dmg * k; t.hp -= dmg * 0.18;
      if (L[arm] <= 0) { L[arm] = 0; t.st = 'stagger'; t.stT = 1.2; w.m.limbs++; bin(w, 'limb'); w.init = clamp(w.init + 0.08, -1, 1); fx(w, 'limb', { x: t.x + (arm === 'ra' ? 1 : -1) * t.face * 1.2, y: t.y, z: 4.2, vz: 3, vx: (arm === 'ra' ? 1 : -1) * t.face * 2.5, rot: 0, dur: 2.2, c: '#9aa0aa' }); fx(w, 'boom', { x: t.x, y: t.y, z: 4, r0: 0.4, r1: 2.6, c: '#ffb347', dur: 0.5 }); w.shake = Math.max(w.shake, 7); w.slow = Math.max(w.slow, 0.35); moment(w, fmt(w.t) + ' ' + (src ? src.name || src.kind : 'a hit') + ' takes the heavy frame\'s ' + (arm === 'ra' ? 'right' : 'left') + ' arm', '#ffd166'); }
    } else {
      t.hp -= dmg * 1.5;
      if (melee && src && src.kind === 'blade' && rnd(w) < 0.3 && L.legs > 0) { L.legs -= dmg; if (L.legs <= 0) { L.legs = 0; w.m.limbs++; moment(w, fmt(w.t) + ' the heavy frame loses its legs', '#ffd166'); } }
    }
  } else {
    if (t.kind === 'frame' && w.mode === 'mind') dmg *= 0.55;
    if (t.side === 'g' && t.kind !== 'companion') dmg *= (src && (src.kind === 'humanoid' || src.kind === 'drone') ? 0.45 : 0.8) * (1.15 - 0.45 * tide(w.t));
    if (t.kind === 'companion') dmg *= 0.6;
    t.hp -= dmg;
  }
  if (src && src.side === 'g') w.m.dmgOut += dmg;
  t.hit = 0.12;
  num(w, t.x, t.y, Math.round(dmg), t.side === 'g' || t.side === 'c' ? '#ff6b6b' : '#fff', dmg >= 40);
  fx(w, 'spark', { x: t.x, y: t.y, z: KINDS[t.kind].H * 0.6 + t.z, n: dmg >= 40 ? 10 : 5, c: t.side === 'm' ? '#ffd28a' : '#ff6b6b', dur: 0.4, seed: w.nid + w.fx.length });
  if (dmg >= 45) w.shake = Math.max(w.shake, 5);
  if (t.side === 'c') w.m.civHurt++;
  if (t.hp <= 0) fall(w, t, src);
  return dmg;
}
function fall(w, t, src) {
  if (t.side === 'g') {
    if (t.kind === 'companion') { t.st = 'dormant'; t.hp = 0; w.init = clamp(w.init - 0.5, -1, 1); w.slow = 1.2; w.flash = 1; banner(w, 'THE COMPANION GOES DORMANT', 'it will not remember this', '#ffe9a8', 20); moment(w, fmt(w.t) + ' the companion goes dormant', '#ffe9a8'); bin(w, 'kill'); return; }
    t.hp = 0; t.st = 'down'; t.bleed = 22; t.heat = Math.min(t.heat, 40); w.m.downs++; bin(w, 'down'); w.init = clamp(w.init - 0.18, -1, 1);
    moment(w, fmt(w.t) + ' ' + t.name + ' is down', '#ff6b6b'); w.slow = Math.max(w.slow, 0.6);
    if (w.mode === 'burning') ask(w, 'carry', [{ id: 'carry', label: 'Carry ' + t.name + ' — send the nearest to revive' }, { id: 'press', label: 'Press on — the window will not wait' }], { who: t.id });
    else t.carryOK = !!w.actors.find(s => s.kind === 'shield' && up(s));
    return;
  }
  if (t.side === 'c') { t.st = 'dead'; t.stT = 0; w.m.civLost++; moment(w, fmt(w.t) + ' a ' + t.name + ' worker is killed in the crossfire', '#ff9a9a'); return; }
  // machines
  if (t.kind === 'frame' && w.mode === 'mind') {
    t.st = 'dead'; t.stT = 0; w.integ = Math.max(0, w.integ - 18); w.m.transfers++; w.transferT = 2.5; w.slow = 1; w.flash = 0.8; bin(w, 'down');
    banner(w, 'FRAME LOST', 'transferring · ' + Math.max(0, Math.round(w.integ)) + '% of you left', '#c9a7ff', 20);
    moment(w, fmt(w.t) + ' your frame is cut down — ' + Math.max(0, Math.round(w.integ)) + '% of you left', '#c9a7ff');
    w.init = clamp(w.init + 0.2, -1, 1);
    return;
  }
  t.st = 'dead'; t.stT = 0; w.m.kills[t.kind] = (w.m.kills[t.kind] || 0) + 1; bin(w, 'kill');
  if (src) src.kills++;
  const imp = t.kind === 'heavy' ? 0.3 : t.kind === 'frame' ? 0.35 : t.kind === 'humanoid' ? 0.06 : 0.03;
  w.init = clamp(w.init + imp, -1, 1);
  if (t.kind === 'heavy' || t.kind === 'frame') {
    w.slow = 1.1; w.flash = 1; w.shake = 12;
    fx(w, 'boom', { x: t.x, y: t.y, z: 2, r0: 1, r1: 7, c: '#ff8a3a', dur: 0.9 }); fx(w, 'ring', { x: t.x, y: t.y, r0: 1, r1: 10, c: '#ffd166', dur: 0.8 });
    w.scorch.push({ x: t.x, y: t.y, r: 4, t: 0 });
    banner(w, t.kind === 'heavy' ? 'HEAVY FRAME DOWN' : 'THE WARDEN FALLS', src ? (src.name || '') : '', '#ffd166', 22);
    moment(w, fmt(w.t) + ' ' + (src ? src.name : 'the team') + ' brings down ' + (t.kind === 'heavy' ? 'the heavy frame' : 'the warden'), '#ffd166');
  } else fx(w, 'boom', { x: t.x, y: t.y, z: t.z + 0.6, r0: 0.2, r1: t.kind === 'humanoid' ? 1.6 : 1.1, c: '#ffb347', dur: 0.45 });
}

// ---------- decisions ----------
// A decision is { t, kind, options:[{id,label,v}], pick, by, why }. The pilot
// values every option; the gap between the best two is how contested it was.
function ask(w, kind, options, ctx) {
  const vals = pilotValues(w, kind, options, ctx || {});
  options.forEach((o, i) => { o.v = +vals[i].toFixed(3); });
  let pickIdx = options.reduce((bi, o, i) => (o.v > options[bi].v ? i : bi), 0);
  let by = 'pilot';
  const ov = w.override[kind];
  if (ov && options.find(o => o.id === ov)) { pickIdx = options.findIndex(o => o.id === ov); by = 'you'; }
  if (w.ext) {
    if (w.dq < w.ext.length) { const e = w.ext[w.dq]; const j = options.findIndex(o => o.id === e); if (j >= 0) { pickIdx = j; by = 'ext'; } }
    else if (w.extStop) { w.halt = { kind, options: options.map(o => ({ id: o.id, label: o.label })), ctx: ctx || {} }; return null; }
  }
  const sorted = options.map(o => o.v).sort((a, b) => b - a);
  const spread = Math.max(0.05, Math.abs(sorted[0]) + 0.2);
  const contested = sorted.length > 1 && (sorted[0] - sorted[1]) / spread < 0.15;
  if (contested) w.m.contested++;
  if (w.jitterAt === w.dq) rnd(w);
  const d = { i: w.dq++, t: +w.t.toFixed(2), kind, options: options.map(o => ({ id: o.id, label: o.label, v: o.v })), pick: options[pickIdx].id, by, contested, ctx: ctx || {} };
  w.decisions.push(d);
  apply(w, kind, options[pickIdx].id, ctx || {});
  return d;
}
function apply(w, kind, id, ctx) {
  if (kind === 'commit' && id === 'go') { w.phase = 'breach'; w.commitT = w.t; w.tideAtCommit = tide(w.t); w.alert = 1; banner(w, 'COMMIT', 'tide ' + Math.round(tide(w.t) * 100) + '% · ' + machines(w).length + ' machines awake', '#ffd166', 24); moment(w, fmt(w.t) + ' commit at tide ' + Math.round(tide(w.t) * 100) + '%', '#ffd166'); }
  if (kind === 'stance' && id !== w.stance) { w.stance = id; say(w, fmt(w.t) + (id === 'push' ? ' PUSH — draw hard, faster and hotter' : ' STEADY — breathe, let the heat bleed'), id === 'push' ? '#ffb347' : '#8dffb0'); }
  if (kind === 'escort') { const was = w.escort; if (!w.actors.some(c => c.side === 'c' && (c.st === 'flee' || c.st === 'hide'))) id = 'fight'; w.escort = id === 'escort'; if (was !== w.escort) say(w, fmt(w.t) + (w.escort ? ' TOMA peels off to walk the workers out' : ' TOMA back on the line'), '#8dffb0'); }
  if (kind === 'carry') { const t = byId(w, ctx.who); if (t) t.carryOK = id === 'carry'; say(w, fmt(w.t) + (id === 'carry' ? ' someone goes back for ' : ' the team presses on without ') + (t ? t.name : ''), id === 'carry' ? '#8dffb0' : '#ff9a9a'); }
  if (kind === 'fab' && id !== 'save') { const k = KINDS[id]; if (w.compute >= k.cost) { w.compute -= k.cost; spawnMachine(w, id); bin(w, 'fab'); } }
  if (kind === 'oc' && (id === 'on') !== w.oc) { w.oc = id === 'on'; say(w, fmt(w.t) + (w.oc ? ' OVERCLOCK — faster, and it eats you' : ' clock back down'), w.oc ? '#c9a7ff' : '#9fe8ff'); }
  if (kind === 'mtarget' && id !== w.mtarget) { w.mtarget = id; say(w, fmt(w.t) + ' the frame hunts: ' + id, '#c9a7ff'); }
  if (kind === 'mcivil' && (id === 'spare') !== w.mcivil) { w.mcivil = id === 'spare'; say(w, fmt(w.t) + (w.mcivil ? ' hold fire near the workers' : ' fire through the workers'), w.mcivil ? '#9fe8ff' : '#ff9a9a'); }
}
function centroid(list) { if (!list.length) return { x: 10, y: 22 }; return { x: list.reduce((s, a) => s + a.x, 0) / list.length, y: list.reduce((s, a) => s + a.y, 0) / list.length }; }
function pilotValues(w, kind, options, ctx) {
  const g = gifted(w).filter(up), ms = machines(w), b = w.policyBias;
  const avgHeat = g.length ? g.reduce((s, a) => s + a.heat, 0) / g.length : 0;
  const timeLeft = T_CLOSE - w.t;
  return options.map(o => {
    switch (kind) {
      case 'commit': {
        if (o.id === 'go') return tide(w.t) - 0.015 * ms.length + b * 0.3;
        const later = Math.min(T_CLOSE, w.t + 16);
        return tide(later) - 0.015 * (ms.length + 16 * 0.6 / 20) - Math.max(0, later + 175 - T_CLOSE) * 0.02;
      }
      case 'stance': {
        const pressure = clamp((200 - (timeLeft - (w.phase === 'breach' ? 90 : 45))) / 200, 0, 1);
        if (o.id === 'push') return 0.35 + 0.6 * pressure + 0.3 * Math.max(0, w.init) - 0.007 * avgHeat + b;
        return 0.5 + 0.004 * avgHeat - 0.2 * pressure;
      }
      case 'escort': {
        const civNear = w.actors.filter(c => c.side === 'c' && alive(c) && c.st === 'flee').length;
        if (o.id === 'escort') return 0.1 * civNear - 0.15 * ms.filter(m => m.x < 52).length * 0.25 + 0.2;
        return 0.5 + 0.05 * ms.length - 0.05 * civNear;
      }
      case 'carry': { const t = byId(w, ctx.who); const dist = t ? Math.min(...g.map(a => D(a, t)).concat([40])) : 40; if (o.id === 'carry') return 0.9 - dist * 0.015 - (timeLeft < 80 ? 0.4 : 0); return 0.45 + (w.phase === 'hold' ? 0.2 : 0); }
      case 'fab': {
        if (o.id === 'save') return w.compute < 70 && !ms.some(m => m.kind === 'heavy') ? 0.55 + b : 0.2;
        const bow = g.some(a => a.kind === 'bow'), blade = g.some(a => a.kind === 'blade'), comp = g.some(a => a.kind === 'companion');
        const c = centroid(g); const spread = g.length ? g.reduce((s, a) => s + D(a, c), 0) / g.length : 9;
        const base = { drone: 0.5, loiterer: 0.5, humanoid: 0.55, heavy: 0.75 }[o.id];
        let v = base;
        if ((o.id === 'drone' || o.id === 'loiterer') && bow) v *= 0.7;
        if ((o.id === 'drone' || o.id === 'loiterer') && spread < 4) v *= 1.35;
        if (o.id === 'heavy' && (blade || comp)) v *= 0.85;
        if (o.id === 'humanoid' && w.charge) v *= 1.2;
        return v - 0.01 * ms.filter(m => m.kind === o.id).length * 5;
      }
      case 'oc': {
        const fr = byId(w, w.frameId); const threat = (w.charge ? 0.4 : 0) + (g.some(a => a.kind === 'companion') ? 0.2 : 0) + (fr && up(fr) && g.some(a => D(a, fr) < 6) ? 0.2 : 0);
        if (o.id === 'on') return 0.2 + threat - (100 - w.integ) * 0.008 + b;
        return 0.4 + (100 - w.integ) * 0.004;
      }
      case 'mtarget': {
        const comp = byId(w, w.compId);
        if (o.id === 'charge') return w.charge ? 0.9 : 0.1;
        if (o.id === 'companion') return comp && up(comp) ? 0.55 + (comp.hp / comp.max < 0.4 ? 0.3 : 0) : 0;
        if (o.id === 'weakest') return 0.5 + (g.some(a => a.hp / a.max < 0.35) ? 0.2 : 0);
        return 0.45 + (w.phase === 'plant' ? 0.4 : 0);
      }
      case 'mcivil': { const n = w.actors.filter(c => c.side === 'c' && alive(c)).length; return o.id === 'spare' ? 0.5 + 0.03 * n : 0.45 + (w.charge ? 0.2 : 0); }
    }
    return 0;
  });
}
function decide(w) {
  // cadence: one decision every ~6 s of fight, every 8 s while staging
  if (w.t < w.nextDec || w.end) return;
  const B = w.mode === 'burning';
  if (w.phase === 'stage') {
    if (B) ask(w, 'commit', [{ id: 'go', label: 'Commit now — tide ' + Math.round(tide(w.t) * 100) + '%' }, { id: 'wait', label: 'Wait for a higher tide — more machines will wake' }]);
    else { // the gifted commit on their own clock; the mind builds while it waits
      if (tide(w.t) - 0.015 * machines(w).length + 0.02 + w.policyBias * 0.4 >= tide(Math.min(T_CLOSE, w.t + 16)) - 0.015 * machines(w).length - Math.max(0, w.t + 191 - T_CLOSE) * 0.02) apply(w, 'commit', 'go', {});
      else if (w.compute >= 12) ask(w, 'fab', fabOptions(w));
    }
    w.nextDec = w.t + 8; return;
  }
  const kinds = B ? ['stance', 'escort', 'stance'] : ['fab', 'oc', 'mtarget', 'fab', 'mcivil'];
  const k = kinds[w.decTurn++ % kinds.length];
  if (k === 'stance') ask(w, 'stance', [{ id: 'push', label: 'PUSH — draw hard: faster, stronger, hotter' }, { id: 'steady', label: 'STEADY — keep the heat under the line' }]);
  else if (k === 'escort') { if (w.actors.some(c => c.side === 'c' && c.st === 'flee')) ask(w, 'escort', [{ id: 'escort', label: 'TOMA walks the workers out' }, { id: 'fight', label: 'TOMA stays on the line' }]); else ask(w, 'stance', [{ id: 'push', label: 'PUSH' }, { id: 'steady', label: 'STEADY' }]); }
  else if (k === 'fab') { if (w.compute >= 12 && machines(w).length < 14) ask(w, 'fab', fabOptions(w)); }
  else if (k === 'oc') ask(w, 'oc', [{ id: 'on', label: 'Overclock the frame — it costs you' }, { id: 'off', label: 'Run cool — keep what is left of you' }]);
  else if (k === 'mtarget') ask(w, 'mtarget', [{ id: 'charge', label: 'Go for the charge' }, { id: 'companion', label: 'Duel the companion' }, { id: 'weakest', label: 'Cut down the weakest' }, { id: 'carrier', label: 'Hunt whoever carries the charge' }]);
  else if (k === 'mcivil') { if (w.actors.some(c => c.side === 'c' && alive(c))) ask(w, 'mcivil', [{ id: 'spare', label: 'Hold fire near the workers' }, { id: 'through', label: 'Fire through them' }]); }
  w.nextDec = w.t + 6;
}
function fabOptions(w) {
  const o = [{ id: 'save', label: 'Save compute' }];
  for (const k of ['drone', 'loiterer', 'humanoid', 'heavy']) if (w.compute >= KINDS[k].cost) o.push({ id: k, label: 'Build a ' + k + ' (' + KINDS[k].cost + ')' });
  return o;
}
function spawnMachine(w, kind) {
  const gc = centroid(gifted(w).filter(up));
  const target = w.charge || CORE;
  const sp = SPAWNS.filter(s => D(s, gc) > 14).sort((a, b) => D(a, target) - D(b, target))[0] || SPAWNS[4];
  const a = mk(w, kind, sp.x + (rnd(w) - 0.5) * 2, sp.y);
  fx(w, 'ring', { x: a.x, y: a.y, r0: 0.3, r1: 2.4, c: '#ff5c5c', dur: 0.5 });
  if (w.mode === 'mind' || kind === 'heavy') say(w, fmt(w.t) + ' a ' + kind + ' walks out of the ' + (sp.y < 5 ? 'north' : sp.y > 40 ? 'south' : 'hall') + ' fabricator', '#ff9a9a');
}

// ---------- actor behaviour ----------
function enemiesOf(w, a) { return a.side === 'g' ? machines(w) : gifted(w).filter(up); }
function pickTarget(w, a) {
  const es = enemiesOf(w, a);
  if (!es.length) return null;
  if (a.side === 'g') {
    let pool = es;
    if (a.kind === 'bow') { const fl = es.filter(e => e.z > 0 && D(e, a) < 26); if (fl.length) pool = fl; }
    if (w.charge && w.phase === 'hold') { const near = es.filter(e => D(e, w.charge) < 9); if (near.length) pool = near; }
    return nearest(pool, a);
  }
  if (a.kind === 'frame' && w.mode === 'mind') {
    const comp = byId(w, w.compId);
    if (w.mtarget === 'charge' && w.charge) return { x: w.charge.x, y: w.charge.y, isCharge: true, id: -2 };
    if (w.mtarget === 'companion' && comp && up(comp)) return comp;
    if (w.mtarget === 'weakest') return es.reduce((b, e) => (e.hp / e.max < b.hp / b.max ? e : b), es[0]);
    if (w.mtarget === 'carrier') { const c = es.find(e => e.planting) || es.find(e => e.kind === 'arc'); if (c) return c; }
  }
  if (w.charge && w.phase === 'hold' && (a.id % 3 !== 0)) return { x: w.charge.x, y: w.charge.y, isCharge: true, id: -2 };
  return nearest(es, a);
}
function threatTo(w, attacker, target, at) { if (target && target.id > 0) w.threats.push({ by: attacker.id, to: target.id, at }); }
function tryDodge(w, a, dt) {
  if (a.dcd > 0 || a.st === 'down' || a.inv > 0) return;
  const skill = a.kind === 'companion' ? 0.75 : a.kind === 'frame' ? (w.mode === 'mind' ? 0.7 : 0.55) : a.kind === 'blade' ? 0.65 : 0.45;
  for (const th of w.threats) {
    if (th.to !== a.id || th.at - w.t > 0.16 || th.at - w.t < 0) continue;
    if (th.rolled) continue; th.rolled = true;
    a.dacc = (a.dacc || 0) + skill; if (a.dacc < 1) continue; a.dacc -= 1; // skill as a rate, not a roll
    const src = byId(w, th.by); if (!src) continue;
    a.dside = -(a.dside || 1); const dx = a.x - src.x, dy = a.y - src.y, d = Math.hypot(dx, dy) || 1, sg = a.dside;
    a.dodge = { vx: (-dy / d * sg * 0.7 + dx / d * 0.5) * 11, vy: (dx / d * sg * 0.7 + dy / d * 0.5) * 11 };
    a.st = 'dodge'; a.stT = 0.26; a.inv = 0.3; a.dcd = a.kind === 'frame' ? 1.2 : 1.6;
    fx(w, 'ghost', { x: a.x, y: a.y, kind: a.kind, face: a.face, dur: 0.3 });
    return;
  }
}
function heatTick(w, a, fighting, dt) {
  if (a.side !== 'g' || a.kind === 'companion') return;
  const comp = byId(w, w.compId), aura = comp && up(comp) && D(a, comp) < 10 ? 0.6 : 1;
  const mom = 1 - 0.4 * Math.max(0, w.init);
  if (fighting) a.heat += (w.stance === 'push' ? 7 : 1.5) * aura * mom * dt;
  else { a.heat -= (w.stance === 'push' ? 3 : 7) * dt; if (w.stance !== 'push' && a.st !== 'down') a.hp = Math.min(a.max, a.hp + 3 * dt); }
  a.heat = Math.max(0, a.heat);
  if (a.heat > 100) { a.hp -= 6 * dt; if (rnd(w) < dt * 8) fx(w, 'ember', { x: a.x, y: a.y, z: 1.2, dur: 0.8, c: '#ff8a3a' }); if (a.hp <= 0) fall(w, a, null); }
  if (a.heat >= 130 && a.st !== 'down') { a.heat = 60; w.m.burnouts++; bin(w, 'burn'); moment(w, fmt(w.t) + ' ' + a.name + ' draws past the line and burns out', '#ff8a3a'); fx(w, 'boom', { x: a.x, y: a.y, z: 1, r0: 0.3, r1: 3, c: '#ff8a3a', dur: 0.6 }); a.hp = Math.min(a.hp, 1); fall(w, a, null); }
}
function attackHeat(w, a, n) { if (a.side === 'g' && a.kind !== 'companion') a.heat += n * (w.stance === 'push' ? 3 : 1) * (1 - 0.3 * Math.max(0, w.init)); }

function stepGifted(w, a, dt) {
  const spdK = (w.stance === 'push' ? 1.15 : 1) * (a.carrying ? 0.6 : 1);
  const tK = w.stance === 'push' ? 0.8 : 1;
  if (a.st === 'stage') return;
  // downed allies: revive if this one is the assigned rescuer
  const downs = gifted(w).filter(o => o.st === 'down' && o.carryOK && o !== a);
  const rescuer = (o) => { const cands = gifted(w).filter(up).filter(x => x.kind !== 'companion'); const sh = cands.find(x => x.kind === 'shield' && !(w.escort && x.kind === 'shield')); return sh || nearest(cands, o); };
  for (const o of downs) if (rescuer(o) === a) {
    if (w.phase === 'exfil') { if (D(a, o) < 1.2) { a.carrying = o.id; } }
    else {
      if (moveTo(w, a, o.x - 0.6, o.y, KINDS[a.kind].spd * spdK, dt) || D(a, o) < 1.2) { a.st = 'revive'; a.stT += dt; o.revT = (o.revT || 0) + dt; if (o.revT >= 3) { o.st = 'move'; o.hp = 45; o.revT = 0; o.bleed = 0; w.m.revives++; bin(w, 'carry'); moment(w, fmt(w.t) + ' ' + a.name + ' gets ' + o.name + ' back on their feet', '#8dffb0'); w.init = clamp(w.init + 0.1, -1, 1); } }
      return;
    }
  }
  if (a.st === 'revive') a.st = 'move';
  // exfil: carry, then leave west
  if (w.phase === 'exfil') {
    const carried = a.carrying ? byId(w, a.carrying) : null;
    if (carried) { carried.x = a.x - 0.3; carried.y = a.y + 0.3; }
    const t = pickTarget(w, a);
    if (t && D(a, t) < 3 && a.cd <= 0 && !carried) return melee(w, a, t, dt, tK);
    if (moveTo(w, a, -4, clamp(a.y, 18, 28), KINDS[a.kind].spd * spdK, dt) || a.x < 1) { a.st = 'out'; if (carried) carried.st = 'out'; }
    return;
  }
  // plant
  if (w.phase === 'plant' || w.phase === 'breach') {
    const carrier = planter(w);
    if (carrier === a && w.phase === 'plant') {
      if (D(a, CORE) > 1.4) { moveTo(w, a, CORE.x - 1.2, CORE.y, KINDS[a.kind].spd * spdK, dt); a.planting = false; return; }
      a.planting = true; a.st = 'plant'; w.plantT = (w.plantT || 0) + dt * (w.stance === 'push' ? 1.3 : 1); faceTo(a, CORE);
      if (w.plantT >= 8) { w.charge = { x: CORE.x - 0.6, y: CORE.y + 0.4, hp: 240, max: 240, t: 0, dur: 40 }; w.chargesLeft--; w.phase = 'hold'; a.planting = false; a.st = 'move'; w.m.plantT = w.t; bin(w, 'plant'); if (w.mode === 'burning' && !w.reserveSpent) { w.reserveSpent = true; ['heavy', 'humanoid', 'humanoid', 'loiterer', 'drone'].forEach(k => spawnMachine(w, k)); w.init = clamp(w.init - 0.45, -1, 1); w.slow = Math.max(w.slow, 0.8); moment(w, fmt(w.t) + ' the mind spends its reserve on the hall', '#ff6b6b'); } banner(w, 'CHARGE SET', '40 seconds — hold the hall', '#ffd166', 22); moment(w, fmt(w.t) + ' ' + a.name + ' sets the charge on the core', '#ffd166'); w.plantT = 0; }
      return;
    }
  }
  // escort: the shield walks fleeing workers out
  if (a.kind === 'shield' && w.escort) {
    const civs = w.actors.filter(c => c.side === 'c' && c.st === 'flee');
    if (civs.length) {
      const c = centroid(civs); const m = nearest(machines(w), c);
      const gx = m ? c.x + (m.x - c.x) / (D(m, c) || 1) * 2 : c.x, gy = m ? c.y + (m.y - c.y) / (D(m, c) || 1) * 2 : c.y;
      if (m && D(m, a) < 2.2 && a.cd <= 0) return melee(w, a, m, dt, tK);
      moveTo(w, a, gx, gy, KINDS[a.kind].spd * spdK, dt); if (a.dome <= 0 && a.cd2 <= 0 && m && D(m, c) < 16) raiseDome(w, a);
      return;
    }
  }
  const t = pickTarget(w, a);
  const reach = { blade: 2.2, arc: 9, shield: 2, bow: 20, companion: 14 }[a.kind];
  const engage = { blade: 13, arc: 13, shield: 9, bow: 26, companion: 18 }[a.kind];
  const obj = w.phase === 'hold' && w.charge ? w.charge : w.phase === 'plant' ? CORE : DOOR;
  const off = ROLE_OFF[a.kind];
  const objPt = { x: obj.x + off[0] - (obj === DOOR ? 3 : 0), y: obj.y + off[1] };
  heatTick(w, a, !!t && D(a, t) < engage, dt);
  if (!t || D(a, t) > engage) { if (w.phase !== 'stage') moveTo(w, a, objPt.x, objPt.y, KINDS[a.kind].spd * spdK, dt); return; }
  faceTo(a, t);
  if (a.kind === 'shield' && a.cd2 <= 0 && gifted(w).filter(up).some(o => D(o, a) < 4 && machines(w).some(m => D(m, o) < 14 && (m.kind === 'humanoid' || m.kind === 'drone')))) raiseDome(w, a);
  if (a.kind === 'bow') {
    const close = nearest(machines(w), a);
    if (close && D(close, a) < 6 && close.z === 0) { moveTo(w, a, a.x + (a.x - close.x), a.y + (a.y - close.y), KINDS.bow.spd * spdK, dt); return; }
    if (D(a, t) > reach) { moveTo(w, a, t.x, t.y, KINDS.bow.spd * spdK, dt); return; }
    if (a.cd <= 0) { a.st = 'wind'; a.stT = 0.55 * tK; a.cd = 1.7 * tK; a.tgt = t.id; }
    return;
  }
  if (a.kind === 'arc') {
    if (D(a, t) > reach) { moveTo(w, a, t.x, t.y, KINDS.arc.spd * spdK, dt); return; }
    if (D(a, t) < 3.5) { moveTo(w, a, a.x + (a.x - t.x), a.y + (a.y - t.y), KINDS.arc.spd * spdK, dt); }
    if (a.cd <= 0) { a.st = 'wind'; a.stT = 0.35 * tK; a.cd = 1.4 * tK; a.tgt = t.id; }
    return;
  }
  if (a.kind === 'companion') {
    if (a.cd2 <= 0 && machines(w).filter(m => D(m, a) < 5).length >= 2) { a.st = 'wind'; a.stT = 0.6; a.cd2 = 6; a.move = 'pulse'; return; }
    if (D(a, t) > reach) { moveTo(w, a, t.x, t.y, KINDS.companion.spd, dt); return; }
    if (D(a, t) < 4) { moveTo(w, a, a.x + (a.x - t.x), a.y + (a.y - t.y) + 1, KINDS.companion.spd, dt); }
    if (a.cd <= 0) { a.st = 'wind'; a.stT = 0.8; a.cd = 4; a.tgt = t.id; a.move = 'lance'; a.aim = { x: t.x, y: t.y }; }
    return;
  }
  // blade and shield: close in, strike, then step to a flank — never orbit
  if (D(a, t) > reach) {
    if (a.kind === 'blade' && D(a, t) < 7 && a.cd <= 0) { a.st = 'wind'; a.stT = 0.16 * tK; a.cd = 0.55 * tK; a.tgt = t.id; a.move = 'dash'; threatTo(w, a, t, w.t + a.stT + 0.05); return; }
    const fl = a.flank || 0; const side = fl ? { x: -(t.y - a.y), y: t.x - a.x } : { x: 0, y: 0 }; const sl = Math.hypot(side.x, side.y) || 1;
    moveTo(w, a, t.x + side.x / sl * fl * 1.5, t.y + side.y / sl * fl * 1.5, KINDS[a.kind].spd * spdK, dt); return;
  }
  if (a.cd <= 0) return melee(w, a, t, dt, tK);
}
function planter(w) { const g = gifted(w).filter(up).filter(a => a.kind !== 'companion'); return g.find(a => a.kind === 'arc') || g.find(a => a.kind === 'blade') || g[0]; }
function raiseDome(w, a) { a.dome = 4; a.cd2 = 11; fx(w, 'ring', { x: a.x, y: a.y, r0: 0.5, r1: 3.5, c: '#8dffb0', dur: 0.35 }); }
function melee(w, a, t, dt, tK) { a.st = 'wind'; a.stT = (a.kind === 'shield' ? 0.3 : a.kind === 'frame' ? 0.14 : 0.18) * (tK || 1); a.cd = (a.kind === 'shield' ? 1.1 : 0.5) * (tK || 1); a.tgt = t.id; a.move = 'cut'; threatTo(w, a, t, w.t + a.stT); }

function resolve(w, a) {
  // the strike lands at the end of the wind-up
  const t = a.tgt === -2 && w.charge ? { ...w.charge, isCharge: true } : byId(w, a.tgt);
  const isG = a.side === 'g';
  const P = isG ? gPow(w, a) : ocK(w, a) * (a.kind === 'frame' ? 1.15 : 1);
  if (a.kind === 'bow' && t && alive(t)) { const d = D(a, t) || 1; w.proj.push({ k: 'bolt', x: a.x, y: a.y, z: 1.4, vx: (t.x - a.x) / d * 42, vy: (t.y - a.y) / d * 42, tz: t.z, dmg: 40 * P * (t.z > 0 ? 1.4 : 1), side: 'g', life: 0.8, src: a.id }); attackHeat(w, a, 1.5); return; }
  if (a.kind === 'arc' && t && alive(t)) {
    const hits = [t]; let cur = t;
    for (let i = 0; i < 2; i++) { const n = nearest(machines(w), cur, m => !hits.includes(m) && D(m, cur) < 4.5); if (!n) break; hits.push(n); cur = n; }
    fx(w, 'zap', { pts: [[a.x, a.y, 1.4], ...hits.map(h => [h.x, h.y, h.z + KINDS[h.kind].H * 0.6])], c: '#9fe8ff', dur: 0.32, seed: w.nid + w.fx.length });
    hits.forEach((h, i) => hurt(w, h, 18 * P * (h.kind === 'drone' || h.kind === 'humanoid' ? 1.3 : 1) * (i ? 0.75 : 1), a, 'arc'));
    attackHeat(w, a, 2); return;
  }
  if (a.kind === 'companion') {
    if (a.move === 'pulse') { fx(w, 'ring', { x: a.x, y: a.y, r0: 0.5, r1: 5.5, c: '#ffe9a8', dur: 0.45 }); w.shake = Math.max(w.shake, 6); for (const m of machines(w)) if (D(m, a) < 5.5) { hurt(w, m, 32, a, 'aoe'); knock(m, a, 3); } return; }
    const aim = a.aim || t; if (!aim) return; const dx = aim.x - a.x, dy = aim.y - a.y, d = Math.hypot(dx, dy) || 1, L = 16;
    fx(w, 'beam', { x1: a.x, y1: a.y, x2: a.x + dx / d * L, y2: a.y + dy / d * L, c: '#fff6d6', dur: 0.4, h: 1.3 }); w.flash = Math.max(w.flash, 0.35); w.shake = Math.max(w.shake, 6);
    for (const m of machines(w)) { const px = m.x - a.x, py = m.y - a.y, along = (px * dx + py * dy) / d, perp = Math.abs(px * dy - py * dx) / d; if (along > 0 && along < L && perp < 1.2) hurt(w, m, 75, a, 'beam'); }
    if (w.charge === null) {}
    return;
  }
  if (a.kind === 'humanoid') {
    if (t && t.isCharge) { w.charge.hp -= 14; fx(w, 'spark', { x: w.charge.x, y: w.charge.y, z: 0.6, n: 6, c: '#ffd166', dur: 0.4, seed: w.nid }); return; }
    if (!t || !alive(t)) return;
    if (D(a, t) < 2.6) { if (D(a, t) < 2.6) hurt(w, t, 16, a, 'melee'); return; }
    for (let i = 0; i < 3; i++) { const d = D(a, t) || 1, sp = (rnd(w) - 0.5) * 0.12; w.proj.push({ k: 'tracer', x: a.x, y: a.y, z: 1.5, vx: ((t.x - a.x) / d + sp) * 60, vy: ((t.y - a.y) / d - sp) * 60, dmg: 9, side: 'm', life: 0.5, delay: i * 0.09, src: a.id }); }
    return;
  }
  if (a.kind === 'heavy') {
    if (a.move === 'stomp') { fx(w, 'ring', { x: a.x, y: a.y, r0: 0.6, r1: 3.4, c: '#ff8a3a', dur: 0.4 }); w.shake = Math.max(w.shake, 8); for (const o of w.actors) if ((o.side === 'g' || o.side === 'c') && alive(o) && o.st !== 'down' && D(o, a) < 3.4) { hurt(w, o, 38, a, 'aoe'); knock(o, a, 3); } w.scorch.push({ x: a.x, y: a.y, r: 2.4, t: 0 }); return; }
    const ang = Math.atan2(a.aim.y - a.y, a.aim.x - a.x);
    fx(w, 'slash', { x: a.x, y: a.y, z: 3, a: ang, r: 5, arc: 2.4, c: '#ff9a5a', dur: 0.3, w: 9 });
    w.shake = Math.max(w.shake, 7);
    for (const o of w.actors) { if (!(o.side === 'g' || o.side === 'c') || !alive(o) || o.st === 'down') continue; const d = D(o, a); const da = Math.abs(((Math.atan2(o.y - a.y, o.x - a.x) - ang + Math.PI * 3) % (Math.PI * 2)) - Math.PI); if (d < 5.2 && da < 1.25) { hurt(w, o, 48, a, 'melee'); knock(o, a, 4); } }
    if (w.charge && D(w.charge, a) < 5.2) w.charge.hp -= 30;
    return;
  }
  // blade / shield / frame cuts, and the dash variants
  if (a.move === 'dash' || a.move === 'lunge') {
    const tt = t && (t.isCharge ? t : alive(t) ? t : null); if (!tt) return;
    const dx = tt.x - a.x, dy = tt.y - a.y, d = Math.hypot(dx, dy) || 1, L = Math.min(d + 1.6, a.move === 'lunge' ? 7.5 : 7);
    const x0 = a.x, y0 = a.y; a.x += dx / d * L; a.y += dy / d * L; pushOut(a); a.inv = 0.15;
    fx(w, 'dash', { x1: x0, y1: y0, x2: a.x, y2: a.y, c: isG ? '#ffd166' : '#c9a7ff', dur: 0.3 });
    if (tt.isCharge) { w.charge.hp -= 40 * P; return; }
    for (const o of (isG ? machines(w) : gifted(w).filter(up))) { const px = o.x - x0, py = o.y - y0, along = (px * dx + py * dy) / d, perp = Math.abs(px * dy - py * dx) / d; if (along > -0.5 && along < L + 0.8 && perp < 1.4) hurt(w, o, (isG ? 30 * P : 32 * P), a, 'melee'); }
    attackHeat(w, a, 2);
    a.flank = -(a.flank || 1); // after a pass, come back from a side
    return;
  }
  if (t && t.isCharge) { w.charge.hp -= 22 * P; fx(w, 'slash', { x: a.x, y: a.y, z: 1.4, a: Math.atan2(t.y - a.y, t.x - a.x), r: 2.2, arc: 1.8, c: '#c9a7ff', dur: 0.2, w: 4 }); return; }
  if (!t || !alive(t)) return;
  const ang = Math.atan2(t.y - a.y, t.x - a.x);
  const base = a.kind === 'blade' ? 30 : a.kind === 'shield' ? 14 : 24;
  const rng = a.kind === 'frame' ? 2.6 : 2.4;
  fx(w, 'slash', { x: a.x, y: a.y, z: KINDS[a.kind].H * 0.55, a: ang, r: rng, arc: 1.9, c: isG ? (a.kind === 'shield' ? '#8dffb0' : '#ffe08a') : '#c9a7ff', dur: 0.22, w: a.kind === 'frame' ? 6 : 5, flip: (a.combo || 0) % 2 });
  for (const o of (isG ? machines(w) : gifted(w).filter(up))) { const d = D(o, a), da = Math.abs(((Math.atan2(o.y - a.y, o.x - a.x) - ang + Math.PI * 3) % (Math.PI * 2)) - Math.PI); if (d < rng + KINDS[o.kind].r && da < 1.0) { hurt(w, o, base * P, a, 'melee'); if (a.kind === 'shield') { knock(o, a, 2.5); if (o.kind === 'humanoid') { o.st = 'stagger'; o.stT = 0.8; } } } }
  attackHeat(w, a, 1);
  if (a.kind === 'frame') { a.combo = (a.combo || 0) + 1; if (a.combo % 3) { a.cd = 0.12 / ocK(w, a); } else { a.cd = 0.5 / ocK(w, a); a.flank = -(a.flank || 1); } }
  else a.flank = -(a.flank || 1);
}
function knock(o, src, m) { const d = D(o, src) || 1; o.kx = (o.x - src.x) / d * m * 4; o.ky = (o.y - src.y) / d * m * 4; }

const holdFire = (w, x, y, r) => w.mode === 'mind' && w.mcivil && w.actors.some(c => c.side === 'c' && alive(c) && c.st !== 'hide' && Math.hypot(c.x - x, c.y - y) < r);
function stepMachine(w, a, dt) {
  const k = KINDS[a.kind];
  const oc = ocK(w, a);
  if (!w.alert) { const near = nearest(gifted(w).filter(up), a); if (!near || D(near, a) > 10) { if (a.kind === 'drone') { a.vx = 0; a.vy = 0; } return; } }
  if (a.kind === 'drone') return stepDrone(w, a, dt);
  if (a.kind === 'loiterer') return stepLoiterer(w, a, dt);
  const t = pickTarget(w, a);
  if (!t) { moveTo(w, a, CORE.x - 4, CORE.y, k.spd * 0.6, dt); return; }
  faceTo(a, t);
  const d = D(a, t);
  if (a.kind === 'humanoid') {
    if (t.isCharge && d < 2.5) { if (a.cd <= 0) { a.st = 'wind'; a.stT = 0.4; a.cd = 1; a.tgt = -2; } return; }
    if (t.isCharge) { moveTo(w, a, t.x, t.y, k.spd, dt); return; }
    if (d < 2.4 && a.cd <= 0) { a.st = 'wind'; a.stT = 0.35; a.cd = 1.2; a.tgt = t.id; threatTo(w, a, t, w.t + 0.35); return; }
    // bounding: move to a firing spot, stop, aim, fire, move again
    a.bound = (a.bound || 0) - dt;
    if (!a.spot || a.bound <= 0) { const pref = 12, ang = Math.atan2(a.y - t.y, a.x - t.x) + (rnd(w) - 0.5) * 1.2; a.spot = { x: clamp(t.x + Math.cos(ang) * pref, 1, 70), y: clamp(t.y + Math.sin(ang) * pref, 9, 36) }; a.bound = 2.4 + rnd(w) * 1.5; a.moving = true; }
    if (a.moving) { if (moveTo(w, a, a.spot.x, a.spot.y, k.spd, dt) || a.bound < 1.2) a.moving = false; return; }
    if (a.cd <= 0 && d < 18 && !holdFire(w, (a.x + t.x) / 2, (a.y + t.y) / 2, D(a, t) / 2 + 1)) { a.st = 'aim'; a.stT = 0.5; a.cd = 1.6; a.tgt = t.id; threatTo(w, a, t, w.t + 0.5); }
    return;
  }
  if (a.kind === 'heavy') {
    const spd = a.lim.legs > 0 ? k.spd : 0.9;
    const armOK = a.lim.la > 0 || a.lim.ra > 0;
    const crowd = gifted(w).filter(up).filter(o => D(o, a) < 3.5).length;
    if (holdFire(w, a.x, a.y, 5.6)) { if (d > 3.8) moveTo(w, a, t.x, t.y, spd, dt); return; }
    if (a.cd <= 0 && (crowd >= 2 || (!armOK && d < 3.2)) && a.lim.legs > 0) { a.st = 'wind'; a.stT = 1.1; a.cd = 2.6; a.move = 'stomp'; for (const o of gifted(w)) if (D(o, a) < 3.6) threatTo(w, a, o, w.t + 1.1); return; }
    if (armOK && d < 4.8 && a.cd <= 0) { a.st = 'wind'; a.stT = 0.9; a.cd = 2.2; a.move = 'sweep'; a.aim = { x: t.x, y: t.y }; for (const o of gifted(w)) if (D(o, a) < 5.4) threatTo(w, a, o, w.t + 0.9); return; }
    if (d > 3.8) moveTo(w, a, t.x, t.y, spd, dt);
    return;
  }
  if (a.kind === 'frame') {
    const spd = k.spd * oc;
    if (t.isCharge) { if (d > 2.2) { if (d < 8 && a.cd2 <= 0) { a.st = 'wind'; a.stT = 0.25 / oc; a.cd2 = 3.5 / oc; a.tgt = -2; a.move = 'lunge'; return; } moveTo(w, a, t.x, t.y, spd, dt); return; } if (a.cd <= 0) { a.st = 'wind'; a.stT = 0.14 / oc; a.cd = 0.3 / oc; a.tgt = -2; a.move = 'cut'; } return; }
    if (d > 8 && d < 18 && a.cd2 <= 0 && rnd(w) < 0.5) { a.st = 'wind'; a.stT = 0.3 / oc; a.cd2 = 1.6 / oc; a.tgt = t.id; a.move = 'shot'; threatTo(w, a, t, w.t + a.stT + 0.25); return; }
    if (d >= 3.5 && d < 8 && a.cd2 <= 0) { a.st = 'wind'; a.stT = 0.25 / oc; a.cd2 = 3.5 / oc; a.tgt = t.id; a.move = 'lunge'; threatTo(w, a, t, w.t + a.stT + 0.05); return; }
    if (d > 2.3) { const fl = a.flank || 0; const side = { x: -(t.y - a.y), y: t.x - a.x }; const sl = Math.hypot(side.x, side.y) || 1; moveTo(w, a, t.x + side.x / sl * fl * 1.6, t.y + side.y / sl * fl * 1.6, spd, dt); return; }
    if (a.cd <= 0) { a.st = 'wind'; a.stT = 0.14 / oc; a.tgt = t.id; a.move = 'cut'; a.cd = 0.4 / oc; threatTo(w, a, t, w.t + a.stT); }
  }
}
function stepDrone(w, a, dt) {
  // strafing passes: fly at the target, drop on the pass, keep going, bank round
  const t = pickTarget(w, a);
  const goal = t ? t : CORE;
  a.pass -= dt;
  let hx = a.vx, hy = a.vy; const sp = Math.hypot(hx, hy) || 1;
  if (a.pass <= 0) {
    const want = Math.atan2(goal.y - a.y, goal.x - a.x), cur = Math.atan2(hy, hx);
    let da = ((want - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI; da = clamp(da, -2.2 * dt, 2.2 * dt);
    const na = cur + da; hx = Math.cos(na); hy = Math.sin(na);
  } else { hx /= sp; hy /= sp; }
  a.vx = hx * KINDS.drone.spd; a.vy = hy * KINDS.drone.spd; a.x += a.vx * dt; a.y += a.vy * dt; a.x = clamp(a.x, 1, 71); a.y = clamp(a.y, 4, 40);
  if (Math.abs(a.vx) > 0.5) a.face = a.vx > 0 ? 1 : -1;
  if (t && a.cd <= 0 && D(a, t) < 1.4 && !t.isCharge) {
    if (!(w.mcivil && w.mode === 'mind' && w.actors.some(c => c.side === 'c' && alive(c) && D(c, t) < 3))) { w.proj.push({ k: 'gren', x: a.x, y: a.y, z: a.z, vx: a.vx * 0.3, vy: a.vy * 0.3, vz: 0, dmg: 24, side: 'm', life: 3, src: a.id, aoe: 2.4 }); a.cd = 2.6; a.pass = 1.0; }
  }
  if (t && t.isCharge && a.cd <= 0 && D(a, t) < 1.4) { w.proj.push({ k: 'gren', x: a.x, y: a.y, z: a.z, vx: 0, vy: 0, vz: 0, dmg: 24, side: 'm', life: 3, src: a.id, aoe: 2.4, charge: true }); a.cd = 2.6; a.pass = 1.0; }
}
function stepLoiterer(w, a, dt) {
  // the one thing that circles: it loiters high, then commits to a dive
  const g = gifted(w).filter(up);
  if (!a.dive) {
    const c = centroid(g.length ? g : [{ x: 40, y: 22 }]);
    a.orb = (a.orb || rnd(w) * 6) + dt * 0.55; a.loit = (a.loit || 0) + dt;
    const gx = c.x + Math.cos(a.orb) * 15, gy = c.y + Math.sin(a.orb) * 15;
    const dx = gx - a.x, dy = gy - a.y, d = Math.hypot(dx, dy) || 1; const s = Math.min(9, d / dt);
    a.vx = dx / d * s; a.vy = dy / d * s; a.x += a.vx * dt; a.y += a.vy * dt; a.z = 22;
    if (a.loit > 7 && g.length && !(w.mode === 'mind' && w.mcivil && g.every(o => holdFire(w, o.x, o.y, 3.4)))) { const pool = w.mode === 'mind' && w.mcivil ? g.filter(o => !holdFire(w, o.x, o.y, 3.4)) : g; const t = pool.reduce((b, o) => (centroidCount(g, o) > centroidCount(g, b) ? o : b), pool[0]); a.dive = { x: t.x, y: t.y, warn: 0.8, tid: t.id }; threatTo(w, a, t, w.t + 0.8 + D(a, t) / 30); }
    return;
  }
  if (a.dive.warn > 0) { a.dive.warn -= dt; return; }
  const dx = a.dive.x - a.x, dy = a.dive.y - a.y, d = Math.hypot(dx, dy);
  const step = KINDS.loiterer.spd * dt; const frac = Math.min(1, step / Math.max(0.01, Math.hypot(d, a.z)));
  a.x += dx * frac; a.y += dy * frac; a.z -= a.z * frac; a.vx = dx; a.vy = dy;
  if (a.z < 0.6 || d < 0.4) {
    fx(w, 'boom', { x: a.x, y: a.y, z: 0.5, r0: 0.3, r1: 3.4, c: '#ff6b3a', dur: 0.55 }); w.shake = Math.max(w.shake, 7); w.scorch.push({ x: a.x, y: a.y, r: 2.2, t: 0 });
    for (const o of w.actors) if ((o.side === 'g' || o.side === 'c') && alive(o) && o.st !== 'down' && D(o, a) < 3.2) hurt(w, o, 60, a, 'aoe');
    if (w.charge && D(w.charge, a) < 3.2) w.charge.hp -= 50;
    a.hp = 0; a.st = 'dead'; a.stT = 0;
  }
}
function centroidCount(g, o) { return g.filter(x => D(x, o) < 3.5).length; }

function stepCiv(w, a, dt) {
  if (w.escort && !w.actors.some(c => c.side === 'c' && (c.st === 'flee' || c.st === 'hide'))) { w.escort = false; say(w, fmt(w.t) + ' the last worker is out; TOMA back on the line', '#8dffb0'); }
  if (a.st === 'hide') { if (w.alert > 0 && rnd(w) < dt * 0.25) a.st = 'flee'; return; }
  if (a.st !== 'flee') return;
  const p = a.x > 52.2 ? { x: 49, y: clamp(a.y, 19.5, 24.5) } : { x: -4, y: clamp(a.y + (rnd(w) - 0.5) * 0.2, 18, 30) };
  const spd = KINDS.civ.spd * (w.escort && w.actors.some(s => s.kind === 'shield' && up(s) && D(s, a) < 5) ? 1.25 : 1);
  moveTo(w, a, p.x, p.y, spd, dt);
  if (a.x < 0) { a.st = 'out'; w.m.civOut++; bin(w, 'escort'); }
}

function stepActor(w, a, dt) {
  if (a.kx || a.ky) { a.x += a.kx * dt; a.y += a.ky * dt; a.kx *= Math.pow(0.02, dt); a.ky *= Math.pow(0.02, dt); if (Math.abs(a.kx) + Math.abs(a.ky) < 0.2) { a.kx = 0; a.ky = 0; } }
  a.cd -= dt; a.cd2 -= dt; a.dcd -= dt; a.inv -= dt; a.hit -= dt; if (a.dome > 0) a.dome -= dt;
  if (a.st === 'dead') { a.stT += dt; return; }
  if (a.st === 'down') { a.bleed -= dt; if (a.bleed <= 0) { a.st = 'dead'; a.stT = 0; w.m.deaths++; moment(w, fmt(w.t) + ' ' + a.name + ' dies in the street', '#ff6b6b'); w.init = clamp(w.init - 0.2, -1, 1); } return; }
  if (a.st === 'away' || a.st === 'out' || a.st === 'dormant') return;
  if (a.side === 'c') return stepCiv(w, a, dt);
  if (a.side === 'g' || a.kind === 'frame') tryDodge(w, a, dt);
  if (a.st === 'dodge') { a.x += a.dodge.vx * dt; a.y += a.dodge.vy * dt; a.stT -= dt; if (a.stT <= 0) a.st = 'move'; return; }
  if (a.st === 'stagger') { a.stT -= dt; if (a.stT <= 0) a.st = 'move'; return; }
  if (a.st === 'wind' || a.st === 'aim') { a.stT -= dt; const t = byId(w, a.tgt); if (t) faceTo(a, t); if (a.stT <= 0) { if (a.move === 'shot') { const tt = byId(w, a.tgt); if (tt && alive(tt)) { const d = D(a, tt) || 1; w.proj.push({ k: 'shot', x: a.x, y: a.y, z: 1.8, vx: (tt.x - a.x) / d * 36, vy: (tt.y - a.y) / d * 36, dmg: 26 * ocK(w, a), side: 'm', life: 0.7, src: a.id }); } } else resolve(w, a); a.st = 'strike'; a.stT = a.kind === 'heavy' ? 0.8 : 0.22; a.move = a.move === 'shot' ? null : a.move; } return; }
  if (a.st === 'strike') { a.stT -= dt; if (a.stT <= 0) { a.st = 'move'; a.move = null; } return; }
  if (a.side === 'g') stepGifted(w, a, dt); else stepMachine(w, a, dt);
}

function stepProj(w, dt) {
  for (const p of w.proj) {
    if (p.delay > 0) { p.delay -= dt; continue; }
    p.life -= dt;
    if (p.k === 'gren') { p.vz -= 14 * dt; p.z += p.vz * dt; p.x += p.vx * dt; p.y += p.vy * dt; if (p.z <= 0) { p.life = 0; fx(w, 'boom', { x: p.x, y: p.y, z: 0.3, r0: 0.2, r1: p.aoe, c: '#ffb347', dur: 0.4 }); w.scorch.push({ x: p.x, y: p.y, r: 1.4, t: 0 }); for (const o of w.actors) if ((o.side === 'g' || o.side === 'c') && alive(o) && o.st !== 'down' && D(o, p) < p.aoe) hurt(w, o, p.dmg, byId(w, p.src), 'aoe'); if (w.charge && D(w.charge, p) < p.aoe) w.charge.hp -= 20; } continue; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.side === 'm') {
      const sh = w.actors.find(s => s.kind === 'shield' && up(s) && s.dome > 0 && D(s, p) < 3.5 && D(s, { x: p.x - p.vx * dt, y: p.y - p.vy * dt }) >= 3.5);
      if (sh) { p.life = 0; fx(w, 'spark', { x: p.x, y: p.y, z: 1.4, n: 4, c: '#8dffb0', dur: 0.3, seed: w.nid + w.fx.length }); continue; }
    }
    const targets = p.side === 'g' ? machines(w) : w.actors.filter(o => (o.side === 'g') && up(o));
    for (const o of targets) { const hr = KINDS[o.kind].r + (o.z > 0 ? 1.2 : 0.3); if (Math.hypot(o.x - p.x, o.y - p.y) < hr) { hurt(w, o, p.dmg, byId(w, p.src), 'shot'); p.life = 0; break; } }
    if (!p.z || blocked(p.x, p.y, 0) && blocked(p.x, p.y, 0).h > 2) { if (blocked(p.x, p.y, 0) && blocked(p.x, p.y, 0).h > 2) p.life = 0; }
  }
  w.proj = w.proj.filter(p => p.life > 0);
}

function stepWorld(w, dt) {
  w.t += dt;
  w.threats = (w.threats || []).filter(th => th.at > w.t - 0.1);
  decide(w); if (w.halt) return;
  // the mind's compute and the frame's rebirth
  const ms = machines(w);
  w.compute += dt * (w.alert ? 1.8 : 1.0) * (1 + Math.max(0, -w.init)) * (w.t > T_CLOSE - 60 ? 1.4 : 1) * (w.charge ? 2.6 : 1);
  if (w.mode === 'burning' && w.alert && w.compute >= 20 && ms.length < 13 && w.t >= (w.mfab || 0) - (w.charge ? 4 : 0)) { const choice = ['drone', 'humanoid', 'humanoid', 'loiterer', 'heavy'][Math.floor(rnd(w) * 5)]; if (w.compute >= KINDS[choice].cost) { w.compute -= KINDS[choice].cost; spawnMachine(w, choice); } w.mfab = w.t + 7; }
  if (w.mode === 'burning' && w.phase === 'stage' && w.compute >= 20 && ms.length < 14 && w.t >= (w.mfab || 0)) { w.compute -= 20; spawnMachine(w, ['humanoid', 'drone', 'humanoid', 'loiterer'][Math.floor(rnd(w) * 4)]); w.mfab = w.t + 8; }
  if (w.mode === 'mind' && w.transferT > 0) { w.transferT -= dt; if (w.transferT <= 0 && w.integ > 0) { const gc = centroid(gifted(w).filter(up)); const sp = SPAWNS.slice().sort((a, b) => D(b, gc) - D(a, gc))[0]; const f = mk(w, 'frame', sp.x, sp.y, { name: 'YOU — THE MIND' }); f.hp = f.max = 300; w.frameId = f.id; fx(w, 'pillar', { x: f.x, y: f.y, c: '#c9a7ff', dur: 1 }); say(w, fmt(w.t) + ' you wake in another frame', '#c9a7ff'); } }
  if (w.mode === 'mind' && w.oc) { w.integ -= 1.6 * dt; if (w.integ <= 0) w.integ = 0; }
  // the companion arrives at the inflection
  if (w.mode === 'mind') { const c = byId(w, w.compId); if (c && c.st === 'away' && w.phase !== 'stage' && (w.m.downs > 0 || w.t > w.commitT + 45 || w.phase === 'hold')) { c.st = 'move'; c.x = 1; c.y = 22; w.slow = 1.4; w.flash = 0.8; banner(w, 'THE COMPANION ARRIVES', 'the one the villages will call a god', '#ffe9a8', 20); moment(w, fmt(w.t) + ' the companion arrives', '#ffe9a8'); } }
  // stage: the team waits at the edge
  if (w.phase === 'stage') { for (const a of gifted(w)) if (a.st !== 'away') { a.heat = Math.max(0, a.heat - 5 * dt); } }
  for (const a of w.actors) { stepActor(w, a, dt); if (!a.z && alive(a)) pushOut(a); }
  // soft separation
  const live = w.actors.filter(a => alive(a) && !a.z && a.st !== 'down');
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) { const a = live[i], b = live[j]; const r = KINDS[a.kind].r + KINDS[b.kind].r, dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy); if (d > 0.001 && d < r) { const p = (r - d) / 2; a.x -= dx / d * p; a.y -= dy / d * p; b.x += dx / d * p; b.y += dy / d * p; } }
  stepProj(w, dt);
  // phases
  const g = gifted(w).filter(up);
  if (w.phase === 'breach' && g.some(a => a.x > 52.5)) { w.phase = 'plant'; say(w, fmt(w.t) + ' inside the hall wall — get the charge to the core', '#ffd166'); }
  if (w.charge) {
    w.charge.t += dt;
    if (w.charge.hp <= 0) { fx(w, 'boom', { x: w.charge.x, y: w.charge.y, z: 0.5, r0: 0.3, r1: 2.5, c: '#ffd166', dur: 0.5 }); moment(w, fmt(w.t) + ' the machines tear the charge off the core', '#ff9a9a'); w.charge = null; w.init = clamp(w.init - 0.3, -1, 1); w.phase = w.chargesLeft > 0 ? 'plant' : 'failed'; banner(w, 'CHARGE LOST', w.chargesLeft > 0 ? 'one left' : 'none left', '#ff6b6b', 20); }
    else if (w.charge.t >= w.charge.dur) { w.m.burnT = w.t; fx(w, 'pillar', { x: CORE.x, y: CORE.y, c: '#ffd166', dur: 2.2 }); fx(w, 'boom', { x: CORE.x, y: CORE.y, z: 3, r0: 2, r1: 16, c: '#ffcf6b', dur: 1.6 }); fx(w, 'ring', { x: CORE.x, y: CORE.y, r0: 2, r1: 26, c: '#fff', dur: 1.3 }); w.scorch.push({ x: CORE.x, y: CORE.y, r: 7, t: 0 }); w.flash = 1; w.shake = 16; w.slow = 2; w.charge = null; w.coreBurned = true; for (const m of machines(w)) if (D(m, CORE) < 9) { m.hp = 0; m.st = 'dead'; m.stT = 0; } banner(w, 'THE HALL BURNS', w.mode === 'mind' ? 'you go dark here' : 'now get everyone out', '#ffcf6b', 26); moment(w, fmt(w.t) + ' the core burns', '#ffcf6b'); w.phase = 'exfil'; w.init = clamp(w.init + 0.4, -1, 1); }
  }
  // initiative: drifts toward the balance of force, events kick it
  const G = gifted(w).filter(up).reduce((s, a) => s + (a.kind === 'companion' ? 4 : 1) * gPow(w, a) * (a.hp / a.max), 0);
  const M = machines(w).reduce((s, a) => s + (KINDS[a.kind].w || 1) * (a.kind === 'heavy' ? 0.5 + 0.5 * a.hp / a.max : a.hp / a.max), 0);
  const target = w.phase === 'stage' ? 0 : Math.tanh(0.9 * Math.log((G + 0.3) / (M * 0.8 + 0.3)));
  w.init = clamp(w.init + (target - w.init) * 0.12 * dt, -1, 1);
  telemetry(w, dt);
  checkEnd(w);
}
function telemetry(w, dt) {
  if (!w.trace) w.trace = [];
  if (w.t >= w.trace.length) { const g = gifted(w).filter(a => a.kind !== 'companion'); w.trace.push([+w.init.toFixed(3), +(g.reduce((s, a) => s + (up(a) ? a.hp / a.max : 0), 0) / 4).toFixed(3), +(machines(w).length / 14).toFixed(3), ['stage', 'breach', 'plant', 'hold', 'exfil', 'failed'].indexOf(w.phase) / 5, w.mode === 'mind' ? +(w.integ / 100).toFixed(3) : 0]); }
  const m = w.m, lead = w.init > 0.25 ? 1 : w.init < -0.25 ? -1 : 0;
  if (lead && m.lead && lead !== m.lead) m.swings++;
  if (lead) m.lead = lead;
  if (w.init <= -0.4) m.low.g = true; if (w.init >= 0.4) m.low.m = true;
  if (m.low.g && w.init >= 0.2) { m.comebacks++; m.low.g = false; }
  if (m.low.m && w.init <= -0.2) { m.comebacks++; m.low.m = false; }
  m.minInit = Math.min(m.minInit, w.init); m.maxInit = Math.max(m.maxInit, w.init);
  const fighting = w.phase !== 'stage' && gifted(w).filter(up).some(a => machines(w).some(mm => D(mm, a) < 12));
  if (fighting) { m.combat += dt; m.lull = 0; } else if (w.phase !== 'stage') { m.lull += dt; m.longestLull = Math.max(m.longestLull, m.lull); }
}
function checkEnd(w) {
  if (w.end) return;
  const g = gifted(w).filter(a => a.kind !== 'companion');
  const standing = g.filter(up);
  const fin = (win, why) => { w.end = { win, why, t: w.t, score: score(w, win) }; w.slow = 0; banner(w, why, win ? (w.mode === 'mind' ? 'the core holds' : 'the hall is ash') : '', win ? '#ffd166' : '#ff6b6b', 20); };
  if (w.mode === 'burning') {
    const outN = g.filter(a => a.st === 'out').length;
    if (w.phase === 'exfil' && g.every(a => a.st === 'out' || a.st === 'dead' || (a.st === 'down' && !a.carryOK))) return fin(true, 'THE HALL BURNS · ' + outN + ' OF 4 OUT');
    if (w.phase === 'exfil' && w.t > (w.m.burnT || 0) + 60) return fin(true, 'THE HALL BURNS · ' + outN + ' OF 4 OUT');
    if (!standing.length && !outN && w.phase !== 'stage') return fin(false, 'THE TEAM FALLS IN THE STREET');
    if (w.phase === 'failed') return fin(false, 'NO CHARGES LEFT');
    if (!w.coreBurned && w.t >= T_CLOSE) return fin(false, 'THE WINDOW CLOSES');
  } else {
    if (w.coreBurned) return fin(false, 'THE CORE BURNS');
    if (w.integ <= 0) return fin(false, 'THE MIND COMES APART');
    if (w.phase === 'failed') return fin(true, 'THE STRIKE RUNS OUT OF CHARGES');
    if (!standing.length && w.phase !== 'stage') return fin(true, 'THE STRIKE IS BROKEN');
    if (w.t >= T_CLOSE) return fin(true, 'THE WINDOW CLOSES · THE CORE HOLDS');
  }
}
function score(w, win) {
  // killing is not in the score: what was kept, who got out, what it cost
  const m = w.m, g = gifted(w).filter(a => a.kind !== 'companion');
  const civSafe = w.actors.filter(c => c.side === 'c' && c.st !== 'dead').length;
  if (w.mode === 'burning') return Math.round((w.coreBurned ? 60 : 0) + 10 * g.filter(a => a.st === 'out' || (up(a))).length + 3 * civSafe - 6 * m.civLost - 4 * m.deaths + (w.coreBurned ? Math.max(0, T_CLOSE - m.burnT) / 8 : 0));
  const comp = byId(w, w.compId);
  return Math.round((win ? 60 : 0) + w.integ / 2.5 + 3 * civSafe - 6 * m.civLost + (comp && comp.st === 'dormant' ? 10 : 0));
}

function advance(w0, real, speed) {
  const w = structuredClone(w0);
  if (w.end) { w.endT = (w.endT || 0) + real; fxStep(w, real); return w; }
  w.slow = Math.max(0, w.slow - real);
  const ff = w.phase === 'stage' ? 6 : 1;
  let sim = real * speed * ff * (w.slow > 0 ? 0.3 : 1);
  w.acc = (w.acc || 0) + sim;
  let n = 0;
  while (w.acc >= DT && n < 600) { stepWorld(w, DT); fxStep(w, DT); w.acc -= DT; n++; if (w.end || w.halt) break; }
  w.shake = Math.max(0, w.shake - real * 30); w.flash = Math.max(0, w.flash - real * 2.5);
  if (w.banner) { w.banner.t += real; if (w.banner.t > w.banner.dur) w.banner = null; }
  return w;
}
function fxStep(w, dt) {
  for (const e of w.fx) { e.t += dt; if (e.k === 'limb') { e.vz -= 12 * dt; e.z = Math.max(0, e.z + e.vz * dt); e.x += e.vx * dt; e.rot += dt * 6 * (e.z > 0 ? 1 : 0); if (e.z === 0) e.vx *= 0.9; } }
  w.fx = w.fx.filter(e => e.t < e.dur);
  for (const n of w.nums) n.t += dt; w.nums = w.nums.filter(n => n.t < 1.1);
  for (const s of w.scorch) s.t += dt; w.scorch = w.scorch.filter(s => s.t < 90).slice(-40);
  w.actors = w.actors.filter(a => !(a.st === 'dead' && a.side === 'm' && a.stT > (a.kind === 'heavy' ? 6 : 1.6)));
}
// headless: run a seed to the end (or to the next unanswered decision)
function runHeadless(seed, mode, ext, opts) {
  let w = makeWorld(seed, mode);
  if (ext) { w.ext = ext; w.extStop = !!(opts && opts.stop); }
  if (opts && opts.jitterAt != null) w.jitterAt = opts.jitterAt;
  let guard = 0;
  while (!w.end && !w.halt && guard++ < 40000) { stepWorld(w, DT); fxStep(w, DT); }
  return w;
}

export { DT, MAPW, MAPH, T_CLOSE, BLOCKS, CORE, DOOR, SPAWNS, KINDS, clamp, D, fmt, rnd, tide, makeWorld, alive, up, byId, gifted, machines, say, apply, advance, stepWorld, fxStep, runHeadless, score };
