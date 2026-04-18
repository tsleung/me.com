import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';

const CITIES = ['taipei', 'sf', 'nyc', 'tokyo'];
const MAX_TRANSFERS_TRACKED = 5;
const WALK_SPEED_MPS = 1.4;
const STATION_BASE_R = 1.5;      // base dot radius at zoom 1
const LONG_EDGE_METERS = 6000;   // edges longer than this are treated as long-distance

// -------- URL state --------
const url = new URL(location.href);
let currentCity = url.searchParams.get('city');
if (!CITIES.includes(currentCity)) currentCity = 'taipei';

// -------- DOM --------
const svg = d3.select('#map');
const tooltip = d3.select('#tooltip');
const destLabel = document.getElementById('dest-label');
const threshold = document.getElementById('threshold');
const thresholdValue = document.getElementById('threshold-value');
const transfersSel = document.getElementById('transfers');
const stats = document.getElementById('stats');
const search = document.getElementById('search');
const searchResults = document.getElementById('search-results');
const scaleBar = document.getElementById('scale-bar');
const scaleLabel = document.getElementById('scale-label');
const scaleTrack = scaleBar?.querySelector('.scale-track');
const clearBtn = document.getElementById('clear-dest');
const hoverLines = document.getElementById('hover-lines');
const historyBox = document.getElementById('history');
const historyList = document.getElementById('history-list');
const historyToggle = document.getElementById('history-toggle');

const HISTORY_KEY = 'transit-history-v1';
const HISTORY_MAX = 10;
const HISTORY_COLLAPSED = 3;
let historyItems = [];

// -------- State --------
let graph = null;
let stationById = new Map();
let adjacency = new Map();
let destId = null;
let destMeta = null; // { clickLatLng, walkSecs } — null if dest is an exact station
let distances = null;
let layout = null;
let hoveredId = null;
let stationPositions = null; // Map<id, [x, y]> in pre-zoom SVG coords
let delaunay = null;
let stationIndex = null; // array, index aligned with Delaunay
let anchors = [];         // [{ stationId, name, lines, rank }]
let lineAnchors = [];     // [{ lineId, line, stationId }] — one per line, for on-select labels

// -------- Load & render --------
init();

async function init() {
  setupTabs();
  setupControls();
  loadHistory();
  renderHistory();
  await loadCity(currentCity);
}

function loadHistory() {
  try { historyItems = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch { historyItems = []; }
  if (!Array.isArray(historyItems)) historyItems = [];
}

function saveHistory() {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(historyItems)); } catch {}
}

function pushHistory(city, stationId, stationName) {
  historyItems = historyItems.filter(h => !(h.city === city && h.stationId === stationId));
  historyItems.unshift({ city, stationId, stationName, ts: Date.now() });
  historyItems = historyItems.slice(0, HISTORY_MAX);
  saveHistory();
  renderHistory();
}

function renderHistory() {
  if (!historyBox) return;
  if (!historyItems.length) { historyBox.hidden = true; return; }
  historyBox.hidden = false;
  historyList.innerHTML = '';
  historyItems.forEach((h, i) => {
    const li = document.createElement('li');
    if (i >= HISTORY_COLLAPSED) li.classList.add('hidden-expandable');
    li.innerHTML = `<span class="history-name"></span><span class="history-city"></span>`;
    li.querySelector('.history-name').textContent = h.stationName;
    li.querySelector('.history-city').textContent = h.city;
    li.addEventListener('click', () => replayHistory(h));
    historyList.appendChild(li);
  });
  historyToggle.hidden = historyItems.length <= HISTORY_COLLAPSED;
  historyToggle.textContent = historyList.classList.contains('expanded') ? 'less' : 'more';
}

async function replayHistory(h) {
  if (h.city !== currentCity) {
    currentCity = h.city;
    const u = new URL(location.href);
    u.searchParams.set('city', h.city);
    window.history.replaceState(null, '', u);
    document.querySelectorAll('.city-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.city === h.city);
    });
    await loadCity(h.city);
  }
  if (stationById.has(h.stationId)) selectDest(h.stationId);
}

function setupTabs() {
  document.querySelectorAll('.city-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const city = btn.dataset.city;
      if (city !== currentCity) {
        currentCity = city;
        const u = new URL(location.href);
        u.searchParams.set('city', city);
        window.history.replaceState(null, '', u);
        destId = null;
        loadCity(city);
      }
    });
  });
}

function setupControls() {
  threshold.addEventListener('input', () => {
    thresholdValue.textContent = threshold.value;
    repaint();
  });
  transfersSel.addEventListener('change', repaint);
  search.addEventListener('input', onSearchInput);
  search.addEventListener('keydown', onSearchKey);
  search.addEventListener('focus', () => { if (search.value.trim()) onSearchInput(); });
  document.addEventListener('click', (e) => {
    if (!searchResults.contains(e.target) && e.target !== search) closeSearch();
  });
  clearBtn?.addEventListener('click', clearDest);
  historyToggle?.addEventListener('click', () => {
    historyList.classList.toggle('expanded');
    historyToggle.textContent = historyList.classList.contains('expanded') ? 'less' : 'more';
  });
}

function clearDest() {
  destId = null;
  destMeta = null;
  distances = null;
  destLabel.textContent = 'click a station';
  destLabel.classList.add('muted');
  clearBtn.hidden = true;
  const sel = svg.node().__sel;
  if (sel?.clickGroup) sel.clickGroup.attr('visibility', 'hidden');
  repaint();
  writeStats();
}

async function loadCity(city) {
  document.querySelectorAll('.city-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.city === city);
  });
  stats.textContent = 'loading…';
  try {
    const r = await fetch(`./data/${city}.json`);
    graph = await r.json();
  } catch (e) {
    stats.textContent = `failed to load ${city}: ${e.message}`;
    return;
  }
  stationById = new Map(graph.stations.map(s => [s.id, s]));
  adjacency = buildAdjacency(graph);
  computeLayout();
  renderGraph();
  distances = null;
  destId = null;
  destMeta = null;
  destLabel.textContent = 'click a station';
  destLabel.classList.add('muted');
  if (clearBtn) clearBtn.hidden = true;
  writeStats();
  repaint();
}

function buildAdjacency(g) {
  const adj = new Map();
  for (const s of g.stations) adj.set(s.id, []);
  for (const e of g.edges) {
    adj.get(e.from).push({ to: e.to, seconds: e.seconds, lineId: e.lineId, kind: e.kind });
    adj.get(e.to).push({ to: e.from, seconds: e.seconds, lineId: e.lineId, kind: e.kind });
  }
  return adj;
}

// -------- Layout (Web Mercator) --------
function computeLayout() {
  const rect = svg.node().getBoundingClientRect();
  const W = rect.width, H = rect.height;
  const [w, s, e, n] = graph.bbox;
  const project = (lat, lng) => {
    const x = (lng - w) / (e - w);
    const mercLat = (l) => Math.log(Math.tan(Math.PI / 4 + (l * Math.PI / 180) / 2));
    const y = 1 - (mercLat(lat) - mercLat(s)) / (mercLat(n) - mercLat(s));
    return [x, y]; // unit square
  };
  // Scale to fit with padding, preserving aspect.
  const pad = 40;
  const unitToPx = Math.min((W - 2 * pad), (H - 2 * pad));
  layout = { project, W, H, pad, unitToPx };
}

function projectStation(s) {
  const [ux, uy] = layout.project(s.lat, s.lng);
  const xOff = (layout.W - 2 * layout.pad - layout.unitToPx) / 2;
  const yOff = (layout.H - 2 * layout.pad - layout.unitToPx) / 2;
  return [
    layout.pad + ux * layout.unitToPx + xOff,
    layout.pad + uy * layout.unitToPx + yOff,
  ];
}

function unproject(sx, sy) {
  const xOff = (layout.W - 2 * layout.pad - layout.unitToPx) / 2;
  const yOff = (layout.H - 2 * layout.pad - layout.unitToPx) / 2;
  const ux = (sx - layout.pad - xOff) / layout.unitToPx;
  const uy = (sy - layout.pad - yOff) / layout.unitToPx;
  const [w, s, e, n] = graph.bbox;
  const lng = w + ux * (e - w);
  const mercLat = l => Math.log(Math.tan(Math.PI / 4 + (l * Math.PI / 180) / 2));
  const ms = mercLat(s), mn = mercLat(n);
  const merc = ms + (1 - uy) * (mn - ms);
  const lat = 2 * (Math.atan(Math.exp(merc)) - Math.PI / 4) * 180 / Math.PI;
  return { lat, lng };
}

function metersPerPixel() {
  // Meters per unzoomed SVG pixel at the center latitude of the current city.
  if (!layout || !graph) return 0;
  const [w, s, e, n] = graph.bbox;
  const centerLat = (s + n) / 2;
  const a1 = { lat: centerLat, lng: w };
  const a2 = { lat: centerLat, lng: e };
  const widthMeters = haversineM(a1, a2);
  // The horizontal extent of the projected city, in pre-zoom SVG pixels, is
  // layout.unitToPx (the side of the square we fit the bbox into).
  return widthMeters / layout.unitToPx;
}

function updateAnchors(k) {
  const anchorG = svg.node().__sel?.anchorG;
  if (!anchorG) return;
  // Top 4 visible at base zoom; more as you zoom in.
  // k=1 → 4 labels, k=3 → 7, k=6 → 10, k>=10 → all 14
  const visibleCount = Math.min(anchors.length, Math.max(4, Math.round(4 + Math.log2(k) * 3)));
  anchorG.selectAll('.anchor-label')
    .attr('font-size', 12 / k)
    .attr('visibility', (d, i) => i < visibleCount ? 'visible' : 'hidden');
}

function updateScaleBar(k) {
  if (!scaleTrack || !scaleLabel) return;
  const mpp = metersPerPixel() / (k || 1);
  if (!isFinite(mpp) || mpp === 0) return;
  // Pick a "nice" round distance that fits ~80 px
  const niceSteps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
  let target = 80;
  let chosen = niceSteps[0];
  for (const s of niceSteps) {
    if (s / mpp >= target) { chosen = s; break; }
    chosen = s;
  }
  const px = chosen / mpp;
  const label = chosen >= 1000 ? `${chosen / 1000} km` : `${chosen} m`;
  scaleTrack.style.width = `${px.toFixed(0)}px`;
  scaleLabel.textContent = label;
}

function haversineM(a, b) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// -------- Render --------
let gRoot = null;
let zoomBehavior = null;

function renderGraph() {
  svg.selectAll('*').remove();
  const rect = svg.node().getBoundingClientRect();
  svg.attr('viewBox', `0 0 ${rect.width} ${rect.height}`);
  gRoot = svg.append('g');

  // Water layer (beneath everything else)
  if (graph.water?.length) {
    const xOff = (layout.W - 2 * layout.pad - layout.unitToPx) / 2;
    const yOff = (layout.H - 2 * layout.pad - layout.unitToPx) / 2;
    const projectLL = (lng, lat) => {
      const [ux, uy] = layout.project(lat, lng);
      return [
        layout.pad + ux * layout.unitToPx + xOff,
        layout.pad + uy * layout.unitToPx + yOff,
      ];
    };
    const toPath = (ring) => {
      let d = '';
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = projectLL(ring[i][0], ring[i][1]);
        d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
      }
      return d + 'Z';
    };
    gRoot.append('g').attr('class', 'water')
      .selectAll('path')
      .data(graph.water)
      .join('path')
      .attr('d', toPath)
      .attr('fill', 'var(--water)')
      .attr('stroke', 'var(--water-edge)')
      .attr('stroke-width', 0.5);

    if (graph.land?.length) {
      gRoot.append('g').attr('class', 'land')
        .selectAll('path')
        .data(graph.land)
        .join('path')
        .attr('d', toPath)
        .attr('fill', 'var(--bg)')
        .attr('stroke', 'var(--water-edge)')
        .attr('stroke-width', 0.5);
    }
  }

  // Compute positions (stations and cluster offsets for visual stacking)
  stationPositions = new Map();
  for (const c of graph.clusters) {
    const [cx, cy] = projectStation(c);
    const multi = c.stationIds.length > 1;
    c.stationIds.forEach((sid, i) => {
      if (multi) {
        const offset = (i - (c.stationIds.length - 1) / 2) * 5;
        stationPositions.set(sid, [cx, cy + offset]);
      } else {
        stationPositions.set(sid, [cx, cy]);
      }
    });
  }

  // Cluster halos
  gRoot.append('g').attr('class', 'halos')
    .selectAll('circle')
    .data(graph.clusters.filter(c => c.stationIds.length > 1))
    .join('circle')
    .attr('class', 'cluster-halo')
    .attr('cx', c => projectStation(c)[0])
    .attr('cy', c => projectStation(c)[1])
    .attr('r', c => 4 + c.stationIds.length * 2);

  // Edges — classify long-distance (Shinkansen etc.) as `.long` so we can
  // de-weight them: they're real routes but overwhelm the commuter graph.
  const lineById = new Map(graph.lines.map(l => [l.id, l]));
  const isLong = (e) => {
    const a = stationById.get(e.from), b = stationById.get(e.to);
    if (!a || !b) return false;
    return haversineM(a, b) > LONG_EDGE_METERS;
  };
  const edgeSel = gRoot.append('g').attr('class', 'edges')
    .selectAll('line')
    .data(graph.edges)
    .join('line')
    .attr('class', e => `edge ${e.kind}${isLong(e) ? ' long' : ''}`)
    .attr('stroke', e => e.kind === 'travel' ? (lineById.get(e.lineId)?.color || '#888') : '#555')
    .attr('x1', e => stationPositions.get(e.from)?.[0])
    .attr('y1', e => stationPositions.get(e.from)?.[1])
    .attr('x2', e => stationPositions.get(e.to)?.[0])
    .attr('y2', e => stationPositions.get(e.to)?.[1]);

  // Stations — no per-station handlers; Voronoi on the svg handles all hit-testing.
  const stationSel = gRoot.append('g').attr('class', 'stations')
    .selectAll('circle')
    .data(graph.stations)
    .join('circle')
    .attr('class', 'station')
    .attr('r', STATION_BASE_R)
    .attr('cx', s => stationPositions.get(s.id)[0])
    .attr('cy', s => stationPositions.get(s.id)[1])
    .attr('fill', 'var(--ink-muted)');

  // Hover ring (hidden until hover)
  const hoverRing = gRoot.append('circle')
    .attr('class', 'hover-ring')
    .attr('r', 9)
    .attr('visibility', 'hidden');

  // Click-point marker + leash to snapped station
  const clickGroup = gRoot.append('g').attr('class', 'click-marker').attr('visibility', 'hidden');
  const clickLeash = clickGroup.append('line').attr('class', 'click-leash');
  const clickDot = clickGroup.append('circle').attr('class', 'click-dot').attr('r', 4);

  // Delaunay for snap-to-nearest on click or hover
  stationIndex = graph.stations.map(s => ({ id: s.id, x: stationPositions.get(s.id)[0], y: stationPositions.get(s.id)[1] }));
  delaunay = d3.Delaunay.from(stationIndex, d => d.x, d => d.y);
  updateScaleBar(1);

  // (Line labels render on hover only — see mousemove.lineHover handler
  // below; labels drawn at each line's median station are too noisy.)

  // Anchor labels — top major interchanges by (# lines × √cluster size).
  anchors = computeAnchors();
  const anchorG = gRoot.append('g').attr('class', 'anchor-labels');
  anchorG.selectAll('text')
    .data(anchors)
    .join('text')
    .attr('class', 'anchor-label')
    .attr('x', a => stationPositions.get(a.stationId)[0])
    .attr('y', a => stationPositions.get(a.stationId)[1] - 8)
    .attr('data-rank', a => a.rank)
    .text(a => a.name);
  updateAnchors.latest = anchorG;

  // Zoom
  zoomBehavior = d3.zoom()
    .scaleExtent([0.5, 60])
    .filter((ev) => {
      // Let clicks (mousedown + mouseup without movement) pass through to our click handler.
      // d3.zoom defaults: blocks everything that's a pointer event it wants. Allow wheel + drag only.
      if (ev.type === 'mousedown' || ev.type === 'touchstart' || ev.type === 'pointerdown') return !ev.ctrlKey && ev.button === 0;
      return true;
    })
    .on('zoom', (ev) => {
      gRoot.attr('transform', ev.transform);
      const k = ev.transform.k;
      gRoot.selectAll('.station').attr('r', STATION_BASE_R / k);
      gRoot.selectAll('.edge').attr('stroke-width', 1.2 / k);
      gRoot.selectAll('.cluster-halo').attr('stroke-width', 1 / k);
      hoverRing.attr('stroke-width', 1.5 / k).attr('r', 9 / k);
      clickDot.attr('r', 4 / k);
      clickLeash.attr('stroke-width', 1 / k);
      updateScaleBar(k);
      updateAnchors(k);
    });
  svg.call(zoomBehavior);

  // Voronoi-based hover and click — mouse events on the SVG, translated into pre-zoom coords.
  svg.on('mousemove.voronoi', (event) => {
    const [sx, sy] = d3.pointer(event, gRoot.node());
    const idx = delaunay.find(sx, sy);
    if (idx < 0) return;
    const s = graph.stations[idx];
    hoveredId = s.id;
    const [hx, hy] = stationPositions.get(s.id);
    const k = d3.zoomTransform(svg.node()).k;
    hoverRing
      .attr('visibility', 'visible')
      .attr('cx', hx).attr('cy', hy)
      .attr('r', 9 / k);
    showTooltip(event, s);
  });
  svg.on('mouseleave.voronoi', () => {
    hoverRing.attr('visibility', 'hidden');
    hoveredId = null;
    hideTooltip();
    hideHoverLines();
  });
  // Line-name hover: when the cursor is near a visible travel edge, show the
  // line's name as a chip near the cursor. Multiple lines stack vertically
  // via the flex-column layout on .hover-lines.
  svg.on('mousemove.lineHover', (event) => showHoverLines(event));
  // Guard against drag-vs-click ambiguity: remember mousedown position, only treat as click if it didn't move much.
  let downAt = null;
  svg.on('mousedown.snap', (event) => {
    downAt = { x: event.clientX, y: event.clientY };
  });
  svg.on('click.snap', (event) => {
    if (downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 4) {
      downAt = null;
      return;
    }
    const [sx, sy] = d3.pointer(event, gRoot.node());
    const idx = delaunay.find(sx, sy);
    if (idx < 0) return;
    const s = graph.stations[idx];
    const clickLatLng = unproject(sx, sy);
    const walkMeters = haversineM(clickLatLng, s);
    const walkSecs = walkMeters / WALK_SPEED_MPS;
    // Show click marker
    const [hx, hy] = stationPositions.get(s.id);
    clickGroup.attr('visibility', 'visible');
    clickDot.attr('cx', sx).attr('cy', sy);
    clickLeash
      .attr('x1', sx).attr('y1', sy)
      .attr('x2', hx).attr('y2', hy);
    selectDest(s.id, { clickLatLng, walkSecs, clickSvg: [sx, sy] });
  });
  // Double-click anywhere on the map clears the destination. Also suppress
  // d3.zoom's default dblclick-to-zoom so the two don't fight.
  svg.on('dblclick.zoom', null);
  svg.on('dblclick.clear', () => { if (destId) clearDest(); });

  // Save references
  svg.node().__sel = { edgeSel, stationSel, positions: stationPositions, hoverRing, clickGroup, clickDot, clickLeash, anchorG: updateAnchors.latest };
  updateAnchors(1);
}

function selectDest(id, meta = null) {
  destId = id;
  destMeta = meta; // { clickLatLng, walkSecs, clickSvg } — walking offset, if any
  const s = stationById.get(id);
  const walkMins = meta?.walkSecs ? meta.walkSecs / 60 : 0;
  const walkStr = walkMins >= 0.5
    ? `<span class="dest-walk">+ ${walkMins.toFixed(1)} min walk from pin</span>`
    : '';
  destLabel.innerHTML = `<strong>${escapeHtml(s.name)}</strong>${walkStr}`;
  if (clearBtn) clearBtn.hidden = false;
  pushHistory(currentCity, id, s.name);
  destLabel.classList.remove('muted');
  // Hide click marker if this came from search (no clickSvg)
  if (!meta?.clickSvg) {
    const sel = svg.node().__sel;
    if (sel?.clickGroup) sel.clickGroup.attr('visibility', 'hidden');
  }
  closeSearch();
  search.value = '';
  runDijkstra(id);
  repaint();
  writeStats();
}

// -------- Dijkstra with per-transfer-count bests --------
function runDijkstra(sourceId) {
  // Min-heap keyed on time.
  const heap = new BinaryHeap((a, b) => a.t - b.t);
  // best[stationId][transferCount] = min time
  distances = new Map();
  for (const s of graph.stations) {
    distances.set(s.id, new Array(MAX_TRANSFERS_TRACKED + 1).fill(Infinity));
  }
  distances.get(sourceId).fill(0);
  // State key includes transfer count so faster high-transfer paths don't
  // block slower low-transfer paths.
  const stateKey = (sid, line, tsf) => sid + '|' + (line || '') + '|' + tsf;
  const seen = new Map();
  heap.push({ t: 0, sid: sourceId, line: null, tsf: 0 });
  seen.set(stateKey(sourceId, null, 0), 0);

  while (heap.size) {
    const cur = heap.pop();
    if (cur.t > (seen.get(stateKey(cur.sid, cur.line, cur.tsf)) ?? Infinity)) continue;
    for (const e of adjacency.get(cur.sid) || []) {
      let newLine, added;
      if (e.kind === 'transfer') {
        newLine = null;
        added = 1;
      } else {
        newLine = e.lineId;
        added = (cur.line != null && cur.line !== e.lineId) ? 1 : 0;
      }
      const newT = cur.t + e.seconds;
      const newTsf = cur.tsf + added;
      if (newTsf > MAX_TRANSFERS_TRACKED) continue;
      const nextKey = stateKey(e.to, newLine, newTsf);
      const prev = seen.get(nextKey);
      if (prev != null && prev <= newT) continue;
      seen.set(nextKey, newT);
      const arr = distances.get(e.to);
      if (newT < arr[newTsf]) arr[newTsf] = newT;
      heap.push({ t: newT, sid: e.to, line: newLine, tsf: newTsf });
    }
  }
}

class BinaryHeap {
  constructor(cmp) { this.h = []; this.cmp = cmp; }
  get size() { return this.h.length; }
  push(v) { this.h.push(v); this._up(this.h.length - 1); }
  pop() {
    const top = this.h[0];
    const last = this.h.pop();
    if (this.h.length) { this.h[0] = last; this._down(0); }
    return top;
  }
  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(this.h[i], this.h[p]) < 0) { [this.h[i], this.h[p]] = [this.h[p], this.h[i]]; i = p; }
      else break;
    }
  }
  _down(i) {
    const n = this.h.length;
    for (;;) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let k = i;
      if (l < n && this.cmp(this.h[l], this.h[k]) < 0) k = l;
      if (r < n && this.cmp(this.h[r], this.h[k]) < 0) k = r;
      if (k === i) break;
      [this.h[i], this.h[k]] = [this.h[k], this.h[i]];
      i = k;
    }
  }
}

// -------- Repaint (coloring based on distances + filters) --------
function timeBand(minutes) {
  if (minutes <= 15) return 'band-15';
  if (minutes <= 30) return 'band-30';
  if (minutes <= 45) return 'band-45';
  if (minutes <= 60) return 'band-60';
  return 'band-out';
}
function bandColor(band) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${band}`).trim();
}

// Trip time only — does NOT include walking from a clicked point to the
// snapped station. We don't know how the user would actually cover that
// (walk / bike / taxi / ride-share), so we keep it out of the reachability
// math and just show it separately.
function effectiveTime(sid) {
  const arr = distances?.get(sid);
  if (!arr) return Infinity;
  const cap = +transfersSel.value;
  let best = Infinity;
  for (let k = 0; k <= Math.min(cap, MAX_TRANSFERS_TRACKED); k++) {
    if (arr[k] < best) best = arr[k];
  }
  return best;
}

function repaint() {
  const sel = svg.node()?.__sel;
  if (!sel) return;
  const thresholdSec = +threshold.value * 60;
  const hasDest = destId != null && distances;

  // Stations
  const k = d3.zoomTransform(svg.node()).k;
  const baseR = STATION_BASE_R / k;
  sel.stationSel
    .attr('fill', s => {
      if (!hasDest) return getComputedStyle(document.documentElement).getPropertyValue('--ink-muted').trim();
      const t = effectiveTime(s.id);
      if (!isFinite(t) || t > thresholdSec) return bandColor('band-out');
      return bandColor(timeBand(t / 60));
    })
    .attr('r', s => {
      if (s.id === destId) return baseR * 3;
      if (!hasDest) return baseR;
      const t = effectiveTime(s.id);
      if (!isFinite(t) || t > thresholdSec) return baseR * 0.6;
      return baseR * 1.4;
    })
    .classed('dest', s => s.id === destId);

  // Edges: dim if either endpoint is outside threshold.
  // Long edges: default hidden; reveal as dotted only when BOTH endpoints reach.
  sel.edgeSel.attr('class', e => {
    const long = isLongEdge(e) ? ' long' : '';
    let cls = `edge ${e.kind}${long}`;
    if (!hasDest) return cls;
    const ta = effectiveTime(e.from);
    const tb = effectiveTime(e.to);
    const bothReach = isFinite(ta) && isFinite(tb) && ta <= thresholdSec && tb <= thresholdSec;
    if (!bothReach) cls += ' dim';
    else if (long) cls += ' reveal';
    return cls;
  });
}

function isLongEdge(e) {
  const a = stationById.get(e.from), b = stationById.get(e.to);
  if (!a || !b) return false;
  return haversineM(a, b) > LONG_EDGE_METERS;
}

// Distance squared from point (px,py) to segment (ax,ay)-(bx,by).
function pointSegDistSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return (px - ax) ** 2 + (py - ay) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const nx = ax + t * dx, ny = ay + t * dy;
  return (px - nx) ** 2 + (py - ny) ** 2;
}

function hideHoverLines() {
  if (hoverLines) { hoverLines.hidden = true; hoverLines.innerHTML = ''; }
}

let hoverLinesRaf = 0;
let lastHoverEvent = null;
function showHoverLines(event) {
  lastHoverEvent = event;
  if (hoverLinesRaf) return;
  hoverLinesRaf = requestAnimationFrame(() => {
    hoverLinesRaf = 0;
    const ev = lastHoverEvent;
    if (!ev || !graph || !stationPositions) return;
    const [sx, sy] = d3.pointer(ev, gRoot.node());
    const k = d3.zoomTransform(svg.node()).k;
    const PX = 8; // "near" threshold in screen pixels
    const thrSvg = PX / k;
    const thrSq = thrSvg * thrSvg;
    const hits = new Map(); // lineId -> minDistSq
    for (const e of graph.edges) {
      if (e.kind !== 'travel' || !e.lineId) continue;
      if (isLongEdge(e)) continue; // hidden lines stay hidden on hover too
      const a = stationPositions.get(e.from);
      const b = stationPositions.get(e.to);
      if (!a || !b) continue;
      const minX = Math.min(a[0], b[0]) - thrSvg;
      const maxX = Math.max(a[0], b[0]) + thrSvg;
      const minY = Math.min(a[1], b[1]) - thrSvg;
      const maxY = Math.max(a[1], b[1]) + thrSvg;
      if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue;
      const d = pointSegDistSq(sx, sy, a[0], a[1], b[0], b[1]);
      if (d <= thrSq) {
        const prev = hits.get(e.lineId);
        if (prev == null || d < prev) hits.set(e.lineId, d);
      }
    }
    if (hits.size === 0) { hideHoverLines(); return; }
    // Sort by proximity so the closest line is on top
    const sorted = [...hits.entries()].sort((a, b) => a[1] - b[1]).slice(0, 6);
    const lineById = new Map(graph.lines.map(l => [l.id, l]));
    hoverLines.innerHTML = '';
    for (const [lineId] of sorted) {
      const line = lineById.get(lineId);
      if (!line) continue;
      const chip = document.createElement('div');
      chip.className = 'hover-line-chip';
      const sw = document.createElement('span');
      sw.className = 'line-swatch';
      sw.style.background = line.color || '#888';
      chip.appendChild(sw);
      const lbl = document.createElement('span');
      const label = line.ref && line.ref !== line.name
        ? `${line.ref} · ${line.name}`
        : (line.ref || line.name || lineId);
      lbl.textContent = label.length > 36 ? label.slice(0, 35) + '…' : label;
      chip.appendChild(lbl);
      hoverLines.appendChild(chip);
    }
    hoverLines.hidden = false;
    const wrap = svg.node().parentElement.getBoundingClientRect();
    hoverLines.style.left = (ev.clientX - wrap.left + 14) + 'px';
    hoverLines.style.top = (ev.clientY - wrap.top + 14) + 'px';
  });
}

// For each line, pick the station closest to the geographic centroid of all
// its stations — a reasonable "middle" for a label. Skips all-long-edge
// lines (Shinkansen etc.) since those are hidden from the default render.
function computeLineAnchors() {
  const lineStations = new Map();
  const allLongByLine = new Map();
  for (const e of graph.edges) {
    if (e.kind !== 'travel' || !e.lineId) continue;
    if (!lineStations.has(e.lineId)) { lineStations.set(e.lineId, new Set()); allLongByLine.set(e.lineId, { n: 0, long: 0 }); }
    lineStations.get(e.lineId).add(e.from);
    lineStations.get(e.lineId).add(e.to);
    const bucket = allLongByLine.get(e.lineId);
    bucket.n++;
    if (isLongEdge(e)) bucket.long++;
  }
  const out = [];
  for (const [lineId, sIds] of lineStations) {
    const line = graph.lines.find(l => l.id === lineId);
    if (!line) continue;
    // Skip lines where every edge is long (Shinkansen, long-distance)
    const b = allLongByLine.get(lineId);
    if (b.long === b.n) continue;
    const stations = [...sIds].map(id => stationById.get(id)).filter(Boolean);
    if (stations.length < 2) continue;
    let lat = 0, lng = 0;
    for (const s of stations) { lat += s.lat; lng += s.lng; }
    lat /= stations.length; lng /= stations.length;
    let best = stations[0], bestD = Infinity;
    for (const s of stations) {
      const d = (s.lat - lat) ** 2 + (s.lng - lng) ** 2;
      if (d < bestD) { bestD = d; best = s; }
    }
    out.push({ lineId, line, stationId: best.id });
  }
  return out;
}

// Pick anchor stations: the biggest interchanges per city. Score each cluster
// by distinct-line count weighted by station membership. One representative
// station per cluster (the first one, arbitrary but stable).
function computeAnchors() {
  const scored = [];
  for (const c of graph.clusters) {
    const lines = new Set();
    for (const sid of c.stationIds) {
      for (const e of adjacency.get(sid) || []) {
        if (e.lineId) lines.add(e.lineId);
      }
    }
    if (lines.size < 2) continue; // not an interchange
    const rep = stationById.get(c.stationIds[0]);
    if (!rep) continue;
    scored.push({
      stationId: rep.id,
      name: rep.name,
      lineCount: lines.size,
      clusterSize: c.stationIds.length,
      score: lines.size * 2 + Math.sqrt(c.stationIds.length),
    });
  }
  scored.sort((a, b) => b.score - a.score);

  // Featured stations from the pipeline config come FIRST, regardless of
  // topology score — they're the icons locals would recognize (Ginza, Asakusa,
  // Times Sq, Taipei 101) that don't always have the highest line count.
  const out = [];
  const seen = new Set();
  for (const fid of (graph.featured || [])) {
    const s = stationById.get(fid);
    if (!s) continue;
    const key = s.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      stationId: fid,
      name: s.name,
      lineCount: 0,
      clusterSize: 0,
      score: Infinity,
      featured: true,
      rank: out.length,
    });
  }
  for (const a of scored) {
    const key = a.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...a, rank: out.length });
    if (out.length >= 14) break;
  }
  return out;
}

// -------- Tooltip --------
function showTooltip(event, s) {
  const t = effectiveTime(s.id);
  const nativeStr = s.nameNative ? `<span class="tt-native">${escapeHtml(s.nameNative)}</span>` : '';
  let html = `<div class="tt-name">${escapeHtml(s.name)} ${nativeStr}</div>`;
  if (destId && destId === s.id) {
    if (destMeta?.walkSecs > 20) {
      const walkMins = (destMeta.walkSecs / 60).toFixed(1);
      html += `<div class="tt-time">destination · +${walkMins} min walk from pin</div>`;
    } else {
      html += `<div class="tt-time">destination</div>`;
    }
  } else if (destId && isFinite(t)) {
    const mins = (t / 60).toFixed(1);
    const tsf = bestTransfersAt(s.id);
    html += `<div class="tt-time">${mins} min trip · ${tsf} transfer${tsf === 1 ? '' : 's'}</div>`;
  } else if (!destId) {
    html += `<div class="tt-hint">click to set destination</div>`;
  }
  const lines = linesAt(s.id);
  if (lines.length) html += `<div class="tt-lines">${lines.map(l => escapeHtml(l.ref || l.name)).join(' · ')}</div>`;
  tooltip.html(html);
  tooltip.node().hidden = false;
  moveTooltip(event);
}
function moveTooltip(event) {
  const rect = svg.node().getBoundingClientRect();
  tooltip.style('left', (event.clientX - rect.left + 12) + 'px');
  tooltip.style('top', (event.clientY - rect.top + 12) + 'px');
}
function hideTooltip() { tooltip.node().hidden = true; }
function bestTransfersAt(sid) {
  const arr = distances?.get(sid) || [];
  const cap = +transfersSel.value;
  let bestTime = Infinity, bestK = 0;
  for (let k = 0; k <= Math.min(cap, MAX_TRANSFERS_TRACKED); k++) {
    if (arr[k] < bestTime) { bestTime = arr[k]; bestK = k; }
  }
  return bestK;
}
function linesAt(sid) {
  const lines = new Set();
  for (const e of adjacency.get(sid) || []) if (e.lineId) lines.add(e.lineId);
  return [...lines].map(id => graph.lines.find(l => l.id === id)).filter(Boolean);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// -------- Search --------
let searchFocusIdx = -1;
function onSearchInput() {
  const q = search.value.trim().toLowerCase();
  searchResults.innerHTML = '';
  searchFocusIdx = -1;
  if (!q) { closeSearch(); return; }
  const matches = graph.stations
    .filter(s => s.name.toLowerCase().includes(q))
    .slice(0, 20);
  // Dedupe by cluster for cleanliness
  const seenCluster = new Set();
  const unique = [];
  for (const s of matches) {
    if (seenCluster.has(s.clusterId)) continue;
    seenCluster.add(s.clusterId);
    unique.push(s);
    if (unique.length >= 8) break;
  }
  if (!unique.length) { closeSearch(); return; }
  for (const s of unique) {
    const li = document.createElement('li');
    li.textContent = s.name;
    li.dataset.id = s.id;
    li.addEventListener('click', () => selectDest(s.id));
    searchResults.appendChild(li);
  }
  searchResults.classList.add('open');
}
function onSearchKey(e) {
  const items = [...searchResults.children];
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchFocusIdx = Math.min(items.length - 1, searchFocusIdx + 1);
    updateSearchFocus(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchFocusIdx = Math.max(0, searchFocusIdx - 1);
    updateSearchFocus(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const pick = searchFocusIdx >= 0 ? items[searchFocusIdx] : items[0];
    if (pick) selectDest(pick.dataset.id);
  } else if (e.key === 'Escape') {
    closeSearch();
  }
}
function updateSearchFocus(items) {
  items.forEach((el, i) => el.classList.toggle('focus', i === searchFocusIdx));
}
function closeSearch() { searchResults.classList.remove('open'); searchFocusIdx = -1; }

// -------- Stats panel --------
function writeStats() {
  if (!graph) { stats.textContent = ''; return; }
  const lines = [
    `${graph.name}`,
    `${graph.stations.length} stations · ${graph.lines.length} lines`,
    `${graph.edges.filter(e => e.kind === 'travel').length} travel edges`,
  ];
  if (destId && distances) {
    const cap = +transfersSel.value;
    const thresholdSec = +threshold.value * 60;
    let reachable = 0;
    for (const s of graph.stations) {
      const t = effectiveTime(s.id);
      if (isFinite(t) && t <= thresholdSec) reachable++;
    }
    lines.push('');
    lines.push(`reachable within ${threshold.value} min @ ≤${cap === 99 ? '∞' : cap} xfers:`);
    lines.push(`  ${reachable} / ${graph.stations.length} stations`);
  } else {
    lines.push('');
    lines.push('click a station or search to set destination');
  }
  stats.textContent = lines.join('\n');
}

// Re-render on resize.
window.addEventListener('resize', () => {
  if (!graph) return;
  computeLayout();
  renderGraph();
  repaint();
});

threshold.addEventListener('input', writeStats);
transfersSel.addEventListener('change', writeStats);
