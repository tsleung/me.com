// The HUD as a value: hudOf(world) is everything the page shows besides the canvas.
import { T_CLOSE, fmt, tide, gifted, machines, byId, alive, say, apply, makeWorld } from './sim.js';
import { COL } from './draw.js';
const PHASE_TXT = { stage: 'STAGING · THE CLOCK RUNS FAST', breach: 'THE BREACH', plant: 'TO THE CORE', hold: 'HOLD THE HALL', exfil: 'GET EVERYONE OUT', failed: 'NO CHARGES LEFT' };
const KIND_TXT = { commit: 'WHEN TO COMMIT', stance: 'HOW HARD TO DRAW', escort: 'THE WORKERS', carry: 'SOMEONE IS DOWN', fab: 'WHAT TO BUILD', oc: 'OVERCLOCK', mtarget: 'WHAT THE FRAME HUNTS', mcivil: 'THE WORKERS' };
function hudOf(w, speed, paused) {
  const B = w.mode === 'burning';
  const g = gifted(w).filter(a => a.kind !== 'companion'), comp = byId(w, w.compId);
  const rowOf = a => ({ name: a.name + ' · ' + a.kind.toUpperCase(), c: COL[a.kind], a: Math.round(100 * Math.max(0, a.hp) / a.max), ac: COL[a.kind], b: Math.round(Math.min(130, a.heat) / 1.3), bc: a.heat > 100 ? '#ff6b3a' : '#ffb347',
    st: a.st === 'down' ? 'DOWN ' + Math.ceil(a.bleed) + 's' : a.st === 'dead' ? 'DEAD' : a.st === 'out' ? 'OUT' : a.st === 'dormant' ? 'DORMANT' : a.st === 'away' ? 'NOT YET' : a.heat > 100 ? 'BURNING' : a.planting ? 'SETTING' : a.carrying ? 'CARRYING' : '', sc: a.st === 'down' || a.heat > 100 ? '#ff6b6b' : '#8d8a80', op: a.st === 'dead' ? 0.4 : 1 });
  let rows;
  if (B) rows = g.map(rowOf);
  else { const f = byId(w, w.frameId); rows = [{ name: 'YOU · FRAME', c: '#c9a7ff', a: f && alive(f) ? Math.round(100 * f.hp / f.max) : 0, ac: '#c9a7ff', b: Math.round(w.integ), bc: '#efe6ff', st: w.transferT > 0 ? 'TRANSFER' : w.oc ? 'OVERCLOCK' : 'SELF ' + Math.round(w.integ) + '%', sc: w.oc ? '#c9a7ff' : '#8d8a80', op: 1 },
    { name: 'COMPUTE · MACHINES', c: '#ff9a9a', a: Math.min(100, Math.round(w.compute)), ac: '#ff9a9a', b: Math.round(100 * machines(w).length / 14), bc: '#ff6b6b', st: Math.round(w.compute) + ' · ' + machines(w).length, sc: '#8d8a80', op: 1 },
    ...(comp ? [rowOf(comp)] : []), ...g.map(rowOf)].slice(0, 6); }
  const d = w.decisions[w.decisions.length - 1];
  const vmax = d ? Math.max(...d.options.map(o => o.v), 0.01) : 1, vmin = d ? Math.min(...d.options.map(o => o.v), 0) : 0;
  const decOpts = d ? d.options.map(o => ({ label: (o.id === d.pick ? '▸ ' : '  ') + o.label, v: Math.round(100 * (o.v - vmin + 0.02) / (vmax - vmin + 0.02)), c: o.id === d.pick ? (B ? '#ffd166' : '#c9a7ff') : '#6d6a62' })) : [];
  const tidePts = Array.from({ length: 56 }, (_, i) => { const t = i / 55 * T_CLOSE; return (t / T_CLOSE * 365).toFixed(1) + ',' + (29 - tide(t) * 27).toFixed(1); }).join(' ');
  const bn = w.banner; const banOp = bn ? Math.min(1, bn.t / 0.15, (bn.dur - bn.t) / 0.4) : 0;
  const init = w.init;
  const m = w.m;
  const ev = {}; for (const b of m.bins) for (const k in b) ev[k] = (ev[k] || 0) + b[k];
  const nEv = Object.values(ev).reduce((a, b) => a + b, 0);
  const endStats = w.end ? [w.end.why + ' · ' + fmt(w.end.t) + ' · seed ' + w.seed + ' · score ' + w.end.score + ' (kills are not in it)',
    'Kills: ' + Object.entries(m.kills).filter(([, v]) => v).map(([k, v]) => v + ' ' + k).join(', ') + ' · limbs taken ' + m.limbs + ' · dodges ' + m.dodges,
    'Down ' + m.downs + '× · revived ' + m.revives + ' · dead ' + m.deaths + ' · burned out ' + m.burnouts + (B ? '' : ' · frames lost ' + m.transfers + ' · self left ' + Math.round(w.integ) + '%'),
    'Workers out ' + m.civOut + ' · killed in the crossfire ' + m.civLost + ' · committed at tide ' + Math.round(w.tideAtCommit * 100) + '%'].join('\n') : '';
  const funRows = w.end ? [
    { k: 'Decisions, and how many were close calls', v: w.decisions.length + ' · ' + m.contested },
    { k: 'Momentum swings · comebacks', v: m.swings + ' · ' + m.comebacks },
    { k: 'Kinds of thing that happened', v: Object.keys(ev).length },
    { k: 'Kills as a share of everything that happened', v: Math.round(100 * (ev.kill || 0) / Math.max(1, nEv)) + '%' },
    { k: 'Longest stretch with nothing happening', v: Math.round(m.longestLull) + ' s' },
  ] : [];
  return {
    accent: B ? '#ffd166' : '#c9a7ff',
    title: B ? 'THE BURNING · HAKODATE NORTH HALL' : 'THE MIND · HAKODATE NORTH HALL',
    clock: fmt(w.t) + ' · ' + PHASE_TXT[w.phase] + ' · ×' + (paused ? 0 : speed * (w.phase === 'stage' ? 6 : 1)) + (w.slow > 0 ? ' · SLOW' : '') + ' · ' + machines(w).length + ' MACHINES',
    hasBanner: !!bn, banOp: banOp.toFixed(2), banText: bn ? bn.text : '', banSub: bn ? bn.sub : '', banC: bn ? bn.c : '#fff', banSize: bn ? bn.size : 20,
    tideTxt: Math.round(tide(w.t) * 100) + '%', windowTxt: 'WINDOW CLOSES IN ' + fmt(Math.max(0, T_CLOSE - w.t)), tidePts, nowX: (Math.min(w.t, T_CLOSE) / T_CLOSE * 365).toFixed(1), commitX: (Math.max(0, w.commitT) / T_CLOSE * 365).toFixed(1), commitOp: w.commitT >= 0 ? 1 : 0,
    initTxt: (init >= 0 ? 'STRIKE ' : 'MIND ') + Math.round(Math.abs(init) * 100), initL: init >= 0 ? 50 : 50 + init * 50, initW: Math.abs(init) * 50, initC: init >= 0 ? '#ffd166' : '#ff6b6b',
    rows, decKicker: d ? fmt(d.t) + ' · ' + KIND_TXT[d.kind] + ' · ' + (d.by === 'you' ? 'YOUR CALL' : 'THE PILOT') : 'NO DECISION YET', closeTxt: d && d.contested ? 'CLOSE CALL' : '', closeC: '#ff9a5a', decBc: d && d.contested ? '#ff9a5a' : '#262b36', decOpts,
    log: w.log.slice(-5).map(l => ({ text: l.text, c: l.c })),
    ended: !!w.end, endTitle: w.end ? w.end.why : '', endC: w.end && w.end.win ? (B ? '#ffd166' : '#c9a7ff') : '#ff6b6b', endStats, funRows, moments: w.moments.slice(-12).map(x => ({ text: x.text, c: x.c })),
  };
}
function withCall(w0, kind, id) {
  const w = structuredClone(w0);
  if (id === 'auto') { delete w.override[kind]; say(w, fmt(w.t) + ' the pilot has the call again', '#8d8a80'); return w; }
  w.override[kind] = id; apply(w, kind, id, {}); return w;
}

export { hudOf, withCall };
