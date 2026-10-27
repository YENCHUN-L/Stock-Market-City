import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const $ = (s, root = document) => root.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

// ---------- encoding ----------
const WORLD_W = 220, WORLD_D = 140;        // city footprint for ~500 stocks; scaled by √(count / 503)
const STREET = 2.2;                         // gap between sector districts
const GAP = 0.18;                           // share of a plot left empty around each building
const MAX_H = 16, MIN_H = 0.35, FLAT_H = 0.4;
// Return (in %) at which color saturates and height reaches MAX_H, per period.
const SAT = { '1d':3, '1w':6, '1m':10, '3m':20, 'ytd':40, '1y':40 };
const PERIOD_NAME = { '1d':'1 day', '1w':'1 week', '1m':'1 month', '3m':'3 months', 'ytd':'year to date', '1y':'1 year' };
const C_ZERO = new THREE.Color('#3a404d'), C_UP = new THREE.Color('#22c55e'), C_DOWN = new THREE.Color('#ef4444');
const C_GOLD = new THREE.Color('#f5b301'), C_CYAN = new THREE.Color('#22d3ee'), C_WHITE = new THREE.Color('#d1d5db');
const BEACON_H = 45;
const isHigh = s => s.val?.label === 'high';
// 13F managers come in two groups, shown one at a time: 👤 10 famous stock-pickers and 🏛 8 giant institutions.
const groupOf = i => i?.group || 'famous';
const isInst = () => state.invGroup === 'inst';
const groupRows = s => (s.inv?.rows || []).filter(r => groupOf(investor(r.key)) === state.invGroup);
// The rows for the selected manager, or for the whole group.
const invRows = s => { const rows = groupRows(s); return state.invKey ? rows.filter(r => r.key === state.invKey) : rows; };
const ADD = { new: 1, added: 1 }, CUT = { reduced: 1, sold: 1 };
const invNet = rows => rows.reduce((n, r) => n + (r.status in ADD) - (r.status in CUT), 0);
const heldBy = rows => rows.filter(r => r.status !== 'sold').length;
// Institutions own a slice of everything, so instead of "who holds it" they light up the stocks whose ownership
// (shares held ÷ shares outstanding, from market cap ÷ price) changed the most over the period's window.
// 13F is quarterly: 1D–3M = the last quarter, YTD = since the last year-end filing, 1Y = four quarters.
const INST_TOP = 150;
function windowStart(i) {
  if (!i) return null;
  const y = +i.report_date.slice(0, 4);
  return state.period === 'ytd' ? `${y - 1}-12-31` : state.period === '1y' ? `${y - 1}${i.report_date.slice(4)}` : i.prev_report_date;
}
function instBase(r) {  // shares at the start of the window (today's shares; 0 if not held then)
  const start = windowStart(investor(r.key));
  if (!r.back?.length || !start) return r.status === 'held' ? r.shares : r.prev_shares;
  let base = r.back[0][1];
  for (const [d, sh] of r.back) if (d <= start) base = sh;
  return base;
}
const instWindow = () => { const i = groupList()[0], st = windowStart(i);
  return i && st ? `${quarter(i.report_date)} vs ${quarter(st)}` : 'last two filings'; };
// A spin-off, merger, reverse split, new listing or new CUSIP moves every holder's share count at once. Vanguard's
// and BlackRock's index holdings otherwise drift a few % a quarter, so a 25%+ jump in their combined shares in a
// quarter inside the window flags the stock, and it's left out of the buying / selling rankings.
const TRACKERS = new Set(['vanguard', 'blackrock']), JUMP = 0.25;
function corpAction(s) {
  const by = new Map();
  for (const r of s.inv?.rows || []) if (TRACKERS.has(r.key)) for (const [d, sh] of r.back || []) by.set(d, (by.get(d) || 0) + sh);
  const start = windowStart(investor('vanguard')), q = [...by].sort((a, b) => a[0].localeCompare(b[0]));
  return q.some(([d, sh], k) => k && d > start && (q[k - 1][1] ? Math.abs(sh / q[k - 1][1] - 1) > JUMP : sh > 0));
}
function instStat(s) {
  let sh = 0, d = 0;
  for (const r of invRows(s)) { sh += r.shares; d += r.shares - instBase(r); }
  const out = s.cap / s.price, own = 100 * sh / out;
  // Over 100% means the share count doesn't match the class held (multi-class companies): leave it out.
  if (own > 100) return { own: NaN, d: 0, bad: true };
  return corpAction(s) ? { own, d: 0, event: true } : { own, d: 100 * d / out };
}
const fmtOwn = st => st.bad ? 'n/a (share classes)' : `${st.own.toFixed(1)}%`;
const fmtChange = st => st.event ? '<span class="mut" title="Vanguard\'s and BlackRock\'s shares jumped 25%+ in one quarter: an index addition or removal, spin-off, merger, reverse split or new listing, not stock-picking">index / corporate event</span>'
  : `<span class="${st.d >= 0 ? 'up' : 'down'}">${fmtPts(st.d)}</span>`;
let topCache = {};
function instTop() {  // the INST_TOP biggest ownership changes, recomputed when the data, city or chip changes
  const c = topCache;
  if (c.market === market && c.plots === city.plots && c.key === state.invKey && c.period === state.period) return c;
  const moves = city.plots.map(p => [p.stock.sym, instStat(p.stock).d]).filter(([, d]) => d)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, INST_TOP);
  return topCache = { market, plots: city.plots, key: state.invKey, period: state.period, set: new Map(moves), max: Math.abs(moves[0]?.[1] || 1) };
}
const invOn = () => state.inv && groupList().length > 0;  // the chosen group may still be loading
const isHeld = s => invOn() && (isInst() ? instTop().set.has(s.sym) : invRows(s).length > 0);
const isCombo = s => isHigh(s) && (isInst() ? instStat(s).d > 0 : invNet(invRows(s)) > 0);  // undervalued and being bought
const fmtPts = d => `${d >= 0 ? '+' : '−'}${Math.abs(d) < 0.1 ? Math.abs(d).toFixed(2) : Math.abs(d).toFixed(1)} pts`;

const saved = (() => { try { return JSON.parse(localStorage.getItem('marketcity') || '{}'); } catch { return {}; } })();
const params = new URLSearchParams(location.search);
// Shown indexes: any combination of 500 / 400 / 600 (?index=500,400 or ?index=all); at least one stays on.
const ALL_IDX = ['500', '400', '600'];
function parseIdxs(v) {
  const list = (Array.isArray(v) ? v : String(v || 'all').split(',')).flatMap(x => x === 'all' ? ALL_IDX : [x]);
  const out = ALL_IDX.filter(i => list.includes(i));
  return out.length ? out : ALL_IDX.slice();
}  // ?view=undervalued,investors&index=600&size=cap&focus=NVDA   (?view=institutions for the 🏛 group)
const viewParam = params.get('view');
const views = viewParam ? viewParam.split(',') : null;
const state = { period: saved.period || '1d', height: saved.height || 'return', legendHidden: !!saved.legendHidden,
                vpanelHidden: !!saved.vpanelHidden, ipanelHidden: !!saved.ipanelHidden,
                value: views ? views.includes('undervalued') : !!saved.value,
                inv: views ? views.includes('investors') || views.includes('institutions') : !!saved.inv, invKey: null, sector: null, selected: null,
                invGroup: views ? (views.includes('institutions') ? 'inst' : 'famous') : saved.invGroup || 'famous',
                flow: views ? views.includes('flow') : !!saved.flow, flowSrc: params.get('flow') || saved.flowSrc || 'market',
                fpanelHidden: !!saved.fpanelHidden, invTab: saved.invTab || 'holdings',
                idxs: parseIdxs(params.get('index') || saved.idxs), size: params.get('size') || saved.size || 'sqrt' };
const save = () => { try { localStorage.setItem('marketcity', JSON.stringify({ period: state.period, height: state.height,
                                                                             legendHidden: state.legendHidden, vpanelHidden: state.vpanelHidden, ipanelHidden: state.ipanelHidden,
                                                                             value: state.value, inv: state.inv, idxs: state.idxs, size: state.size,
                                                                             flow: state.flow, flowSrc: state.flowSrc, fpanelHidden: state.fpanelHidden,
                                                                             invTab: state.invTab, invGroup: state.invGroup })); } catch {} };
const INDEX_NAME = { '500,400,600': 'S&P 1500', '500,400': 'S&P 900', '400,600': 'S&P 1000', '500,600': 'S&P 500 + 600',
                     '500': 'S&P 500', '400': 'S&P 400', '600': 'S&P 600' };
const indexName = () => INDEX_NAME[state.idxs.join(',')];
const INDEX_DESC = { '500': 'S&P 500 · large cap', '400': 'S&P 400 · mid cap', '600': 'S&P 600 · small cap' };
const SIZE_DESC = { cap: 'market cap', sqrt: '√ market cap', equal: 'equal size' };
// Footprint: true market cap, √ market cap (small caps stay visible) or equal plots.
const sizeValue = s => state.size === 'cap' ? s.cap : state.size === 'equal' ? 1 : Math.sqrt(s.cap);

function colorFor(ret, period) {
  if (ret == null) return C_ZERO.clone();
  const t = Math.min(1, Math.abs(ret) / SAT[period]);
  return C_ZERO.clone().lerp(ret >= 0 ? C_UP : C_DOWN, Math.pow(t, 0.7));
}
function heightFor(ret, period) {
  if (state.height === 'flat' || ret == null) return FLAT_H;
  // sqrt keeps small moves visible; anything past 1.5× the saturation point is capped.
  return Math.max(MIN_H, MAX_H * Math.min(1.5, Math.sqrt(Math.abs(ret) / SAT[period])));
}
const fmtPct = x => x == null ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(2)}%`;
const fmtCap = x => x >= 1e12 ? `$${(x / 1e12).toFixed(2)}T` : x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : `$${(x / 1e6).toFixed(0)}M`;

// ---------- squarified treemap ----------
function worst(row, side, scale) {
  const s = row.reduce((a, r) => a + r.value, 0) * scale;
  const mx = Math.max(...row.map(r => r.value)) * scale, mn = Math.min(...row.map(r => r.value)) * scale;
  return Math.max(side * side * mx / (s * s), (s * s) / (side * side * mn));
}
function squarify(items, x, y, w, h) {
  const out = [], rest = items.filter(i => i.value > 0).sort((a, b) => b.value - a.value);
  const total = rest.reduce((a, r) => a + r.value, 0);
  if (!total) return out;
  const scale = (w * h) / total;
  while (rest.length) {
    const side = Math.min(w, h);
    let row = [], best = Infinity;
    while (rest.length) {
      const cand = [...row, rest[0]], r = worst(cand, side, scale);
      if (row.length && r > best) break;
      row = cand; best = r; rest.shift();
    }
    const thick = row.reduce((a, r) => a + r.value, 0) * scale / side;
    let pos = 0;
    for (const it of row) {
      const len = it.value * scale / thick;
      out.push(w >= h ? { item: it, x, y: y + pos, w: thick, h: len } : { item: it, x: x + pos, y, w: len, h: thick });
      pos += len;
    }
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
  }
  return out;
}

// ---------- scene ----------
const host = $('#scene');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
host.append(renderer.domElement);
const labels = new CSS2DRenderer();
labels.setSize(innerWidth, innerHeight);
Object.assign(labels.domElement.style, { position: 'absolute', top: '0', pointerEvents: 'none' });
host.append(labels.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0b0e14');
scene.fog = new THREE.Fog('#0b0e14', 420, 900);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.5, 2000);
// Orbit around the true center of the city; room for the legend comes from the view offset in frame().
const HOME = { pos: new THREE.Vector3(0, 180, 218), flat: new THREE.Vector3(0, 250, 30), target: new THREE.Vector3(0, 0, 12) };
// The overview to return to: angled in 3D, almost straight down in Flat (a map view).
const homePos = () => (state.height === 'flat' ? HOME.flat : HOME.pos).clone();
camera.position.copy(homePos());  // start in the view that matches the saved 3D / Flat mode
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME.target);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 3; controls.maxDistance = 600;
// Zoom towards whatever is under the cursor (not the fixed pivot), and pan along the ground like a map.
controls.zoomToCursor = true;
controls.screenSpacePanning = false;
controls.zoomSpeed = 1.4;
controls.keyPanSpeed = 25;
controls.listenToKeyEvents(window);  // arrow keys pan
controls.addEventListener('start', () => { flight = null; showPivot(true); });  // the user takes over from a fly-to
controls.addEventListener('end', () => showPivot(false));

// Ring on the ground at the orbit center, shown while dragging so it's clear what the view turns around.
const pivot = new THREE.Group();
for (const [r0, r1, op] of [[1.1, 1.5, 0.9], [0, 0.25, 0.9]]) {
  pivot.add(new THREE.Mesh(new THREE.RingGeometry(r0, r1, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: op, depthTest: false })));
}
pivot.renderOrder = 10; pivot.visible = false;
scene.add(pivot);
let pivotTimer = null;
function showPivot(on) {
  clearTimeout(pivotTimer);
  if (on) pivot.visible = true; else pivotTimer = setTimeout(() => { pivot.visible = false; }, 500);
}

// Shift the picture right by half the legend's width so the city is centred in the free space, without
// moving the orbit center (a view offset keeps picking, labels and zoom-to-cursor consistent).
function frame() {
  // Centre the city in the space left free by the legend (left) and an open side panel (right).
  const legend = document.getElementById('legend'), side = document.getElementById('side');
  const left = legend && legend.offsetParent && innerWidth > 900 ? legend.offsetWidth + 12 : 0;
  const right = side && side.style.display === 'block' && innerWidth > 900 ? side.offsetWidth + 12 : 0;
  const dx = (left - right) / 2;
  camera.aspect = innerWidth / innerHeight;
  if (dx) camera.setViewOffset(innerWidth, innerHeight, -dx, 0, innerWidth, innerHeight); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}

scene.add(new THREE.HemisphereLight('#c9d6ff', '#1a1d26', 0.9));
const sun = new THREE.DirectionalLight('#ffffff', 1.6);
sun.position.set(-90, 160, 110);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 110, bottom: -110, near: 10, far: 450 });
sun.shadow.bias = -0.0005;
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), new THREE.MeshStandardMaterial({ color: '#10141c', roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
scene.add(ground);

const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);  // origin at the base
const city = { group: null, mesh: null, plots: [], bySym: new Map(), sectors: [], anim: null };

function clearCity() {
  if (!city.group) return;
  city.group.traverse(o => { if (o.isCSS2DObject) o.element.remove(); if (o.material && o !== city.mesh) o.material.dispose?.(); });
  scene.remove(city.group);
  city.mesh?.dispose(); city.beacons?.dispose(); city.ibeacons?.dispose();
  Object.assign(city, { group: null, mesh: null, beacons: null, ibeacons: null, plots: [], bySym: new Map(), sectors: [], flow: null });
}

// Scale the city, camera, shadows and fog with the number of buildings so plots keep a similar size.
let worldScale = 1;
function setWorldScale(k) {
  worldScale = k;
  const c = k ** 0.85;  // a bigger city fills more of the view instead of shrinking into the distance
  HOME.pos.set(0, 180 * c, 218 * c); HOME.flat.set(0, 250 * c, 30 * c); HOME.target.set(0, 0, 12 * c);
  Object.assign(sun.shadow.camera, { left: -150 * k, right: 150 * k, top: 110 * k, bottom: -110 * k, far: 450 * k });
  sun.position.set(-90 * k, 160 * k, 110 * k); sun.shadow.camera.updateProjectionMatrix();
  scene.fog.near = 420 * k; scene.fog.far = 900 * k; controls.maxDistance = 600 * k;
}
function buildCity(stocks) {
  clearCity();
  const k = Math.max(1, Math.sqrt(stocks.length / 503)), rescaled = Math.abs(k - worldScale) > 0.01;
  setWorldScale(k);
  if (rescaled && !state.selected) { camera.position.copy(homePos()); controls.target.copy(HOME.target); }
  const group = new THREE.Group();
  const bySector = new Map();
  for (const s of stocks) {
    if (!bySector.has(s.sector)) bySector.set(s.sector, []);
    bySector.get(s.sector).push({ value: sizeValue(s), stock: s });
  }
  const sectorItems = [...bySector].map(([name, items]) => ({ name, items, value: items.reduce((a, i) => a + i.value, 0) }));
  const W = WORLD_W * k, D = WORLD_D * k;
  const districts = squarify(sectorItems, -W / 2, -D / 2, W, D);
  const plateMat = new THREE.MeshStandardMaterial({ color: '#171c27', roughness: 0.95 });
  const plots = [];
  for (const d of districts) {
    const x = d.x + STREET / 2, y = d.y + STREET / 2, w = Math.max(0.1, d.w - STREET), h = Math.max(0.1, d.h - STREET);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(w, 0.2, h), plateMat.clone());  // own material: flow pulses it
    plate.position.set(x + w / 2, 0.1, y + h / 2); plate.receiveShadow = true;
    group.add(plate);
    const el = document.createElement('div'); el.className = 'label sector'; el.textContent = d.item.name;
    // On the street along the district's front edge, so it doesn't float over the districts behind it.
    const lbl = new CSS2DObject(el); lbl.position.set(x + w / 2, 0.3, y + h + STREET / 2);
    group.add(lbl);
    city.sectors.push({ name: d.item.name, value: d.item.value, center: new THREE.Vector3(x + w / 2, 0, y + h / 2),
                        size: Math.max(w, h), label: lbl, plate });
    for (const c of squarify(d.item.items, x, y, w, h)) plots.push({ ...c, sector: d.item.name });
  }
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1 });
  const mesh = new THREE.InstancedMesh(boxGeo, mat, plots.length);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(plots.length * 3), 3);
  plots.forEach((p, i) => {
    const g = Math.min(p.w, p.h) * GAP;
    p.i = i; p.stock = p.item.stock;
    p.cx = p.x + p.w / 2; p.cz = p.y + p.h / 2; p.bw = Math.max(0.05, p.w - g); p.bd = Math.max(0.05, p.h - g);
    p.hNow = MIN_H; p.cNow = C_ZERO.clone();
    city.bySym.set(p.stock.sym, p);
  });
  // Tickers on the roofs of the ~100 largest plots (in any size mode), if they're big enough to read.
  plots.slice().sort((a, b) => Math.min(b.bw, b.bd) - Math.min(a.bw, a.bd)).slice(0, 100)
    .filter(p => Math.min(p.bw, p.bd) > 3).forEach(p => {
      const el = document.createElement('div'); el.className = 'label tick'; el.textContent = p.stock.sym;
      p.label = new CSS2DObject(el); group.add(p.label);
    });
  group.add(mesh);
  // Light beams over highly undervalued buildings: one instance per building, only the flagged ones drawn.
  const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true).translate(0, 0.5, 0);
  const beacons = new THREE.InstancedMesh(beamGeo, new THREE.MeshBasicMaterial({ color: C_GOLD, transparent: true, opacity: 0.3,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), plots.length);
  beacons.count = 0; beacons.frustumCulled = false;
  group.add(beacons);
  // Investor beams: colored per building by whether the tracked investors are adding or trimming.
  const ibeacons = new THREE.InstancedMesh(beamGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.32,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), plots.length);
  ibeacons.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(plots.length * 3), 3);
  ibeacons.count = 0; ibeacons.frustumCulled = false;
  group.add(ibeacons);
  scene.add(group);
  Object.assign(city, { group, mesh, beacons, ibeacons, plots });
  applyEncoding(false);
}

const tmpM = new THREE.Matrix4(), tmpC = new THREE.Color();
function writeInstance(p) {
  tmpM.makeScale(p.bw, p.hNow, p.bd).setPosition(p.cx, 0.2, p.cz);
  city.mesh.setMatrixAt(p.i, tmpM);
  tmpC.copy(p.cNow);
  if (state.flow && !state.value && !invOn()) tmpC.lerp(C_ZERO, 0.45);
  if (state.value || invOn()) {
    if (state.value && isHigh(p.stock)) tmpC.copy(C_GOLD);
    else if (!isHeld(p.stock)) tmpC.lerp(C_ZERO, 0.9).multiplyScalar(0.3);
  }
  if (state.sector && p.sector !== state.sector) tmpC.lerp(C_ZERO, 0.85).multiplyScalar(0.35);
  if (p === hovered || p === state.selected) tmpC.offsetHSL(0, 0, 0.18);
  city.mesh.setColorAt(p.i, tmpC);
  if (p.label) p.label.position.set(p.cx, 0.2 + p.hNow + 0.8, p.cz);
}

// Animate every building to the height and color of the current period.
function applyEncoding(animate = true) {
  for (const p of city.plots) {
    const r = p.stock.ret[state.period];
    p.hFrom = p.hNow; p.cFrom = p.cNow.clone();
    p.hTo = heightFor(r, state.period); p.cTo = colorFor(r, state.period);
  }
  updateLabels();
  city.anim = { start: performance.now(), dur: animate ? 650 : 0 };
  renderSummary(); renderLegend(); renderValuePanel(); renderInvPanel(); renderFlow();
  if (state.selected) renderSide(state.selected);
}
function stepAnim(now) {
  if (!city.anim || !city.mesh) return;
  const t = city.anim.dur ? Math.min(1, (now - city.anim.start) / city.anim.dur) : 1;
  const e = 1 - Math.pow(1 - t, 3);
  for (const p of city.plots) {
    p.hNow = p.hFrom + (p.hTo - p.hFrom) * e;
    p.cNow.copy(p.cFrom).lerp(p.cTo, e);
    writeInstance(p);
  }
  city.mesh.instanceMatrix.needsUpdate = true; city.mesh.instanceColor.needsUpdate = true;
  city.mesh.computeBoundingSphere();
  updateBeacons();
  if (t >= 1) city.anim = null;
}
function updateBeacons() {
  const b = city.beacons, ib = city.ibeacons; if (!b) return;
  let n = 0, m = 0;
  for (const p of city.plots) {
    if (state.sector && p.sector !== state.sector) continue;
    const r = Math.min(2, Math.max(0.35, Math.min(p.bw, p.bd) * 0.22));
    const combo = state.value && invOn() && isCombo(p.stock);
    if (state.value && isHigh(p.stock) && !combo) {
      tmpM.makeScale(r, BEACON_H, r).setPosition(p.cx, 0.2 + p.hNow, p.cz);
      b.setMatrixAt(n++, tmpM);
    }
    if (isHeld(p.stock)) {
      // Height = how many of the investors hold it (institutions: how much the ownership changed);
      // color = net direction (cyan = also undervalued).
      const rows = invRows(p.stock), top = isInst() && instTop(), d = top && top.set.get(p.stock.sym);
      const net = top ? d : invNet(rows), held = Math.max(1, heldBy(rows));
      const h = combo ? BEACON_H + 15 : top ? 14 + 50 * Math.abs(d) / top.max : 14 + 7 * held;
      tmpM.makeScale(r * (combo ? 1.1 : 0.8), h, r * (combo ? 1.1 : 0.8)).setPosition(p.cx, 0.2 + p.hNow, p.cz);
      ib.setMatrixAt(m, tmpM);
      ib.setColorAt(m++, combo ? C_CYAN : net > 0 ? C_UP : net < 0 ? C_DOWN : C_WHITE);
    }
  }
  b.count = n; b.instanceMatrix.needsUpdate = true;
  ib.count = m; ib.instanceMatrix.needsUpdate = true; ib.instanceColor.needsUpdate = true;
}
function repaint() {  // color-only refresh (hover, selection, sector isolation, undervalued view)
  if (!city.mesh) return;
  city.plots.forEach(writeInstance);
  city.mesh.instanceColor.needsUpdate = true;
  updateBeacons();
}

function updateLabels() {
  for (const p of city.plots) if (p.label)
    // CSS2DRenderer rewrites style.display every frame, so hide through the object instead.
    p.label.visible = !(state.sector && p.sector !== state.sector)
      && (!(state.value || invOn()) || (state.value && isHigh(p.stock)) || isHeld(p.stock));
}

// ---------- camera fly-to ----------
let flight = null;
function flyTo(target, dist) {
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.y < 0.35) dir.y = 0.35;
  dir.normalize();
  flight = { start: performance.now(), dur: 900, fromPos: camera.position.clone(), fromTarget: controls.target.clone(),
             toTarget: target.clone(), toPos: target.clone().add(dir.multiplyScalar(dist)) };
}
function flyHome() {
  flight = { start: performance.now(), dur: 900, fromPos: camera.position.clone(), fromTarget: controls.target.clone(),
             toTarget: HOME.target.clone(), toPos: homePos() };
}
function stepFlight(now) {
  if (!flight) return;
  const t = Math.min(1, (now - flight.start) / flight.dur), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  camera.position.lerpVectors(flight.fromPos, flight.toPos, e);
  controls.target.lerpVectors(flight.fromTarget, flight.toTarget, e);
  if (t >= 1) flight = null;
}
function focusPlot(p) {
  select(p);
  flyTo(new THREE.Vector3(p.cx, p.hTo / 2, p.cz), Math.max(28, Math.max(p.bw, p.bd) * 3 + p.hTo * 1.5));
}

// ---------- picking ----------
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
let hovered = null, pointer = null, downAt = null;
function pick(ev) {
  if (!city.mesh) return null;
  mouse.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObject(city.mesh)[0];
  return hit ? city.plots[hit.instanceId] : null;
}
renderer.domElement.addEventListener('pointermove', ev => { pointer = ev; });
renderer.domElement.addEventListener('pointerleave', () => { pointer = null; setHover(null); });
renderer.domElement.addEventListener('pointerdown', ev => { downAt = [ev.clientX, ev.clientY]; });
renderer.domElement.addEventListener('pointerup', ev => {
  if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5) return;  // a drag, not a click
  const p = pick(ev);
  if (p) focusPlot(p); else select(null);
});
// Double-click empty ground to fly there and zoom in halfway.
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
renderer.domElement.addEventListener('dblclick', ev => {
  if (pick(ev)) return;  // buildings already fly on single click
  mouse.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const at = ray.ray.intersectPlane(groundPlane, new THREE.Vector3());
  if (at) flyTo(at, Math.max(controls.minDistance * 4, camera.position.distanceTo(controls.target) / 2));
});
function setHover(p) {
  const tip = $('#tip');
  if (p !== hovered) { hovered = p; repaint(); }
  renderer.domElement.style.cursor = p ? 'pointer' : '';
  if (!p) { tip.style.display = 'none'; return; }
  const s = p.stock, r = s.ret[state.period];
  tip.innerHTML = `<b>${esc(s.sym)}</b> · ${esc(s.name)}<br><span class="mut">${esc(s.sector)} · ${esc(INDEX_DESC[s.idx] || '')}</span><br>`
    + `$${s.price.toFixed(2)} · <span class="${r >= 0 ? 'up' : 'down'}">${fmtPct(r)}</span> ${PERIOD_NAME[state.period]}`
    + ` · ${fmtCap(s.cap)}${s.cap_estimated ? ' (est.)' : ''}` + valTip(s.val) + invTip(s);
  tip.style.display = 'block';
  const x = Math.min(pointer.clientX + 14, innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`; tip.style.top = `${pointer.clientY + 14}px`;
}

// ---------- side panel ----------
function select(p) {
  state.selected = p; repaint();
  $('#side').style.display = p ? 'block' : 'none';
  frame(); updateHelp();
  if (p) renderSide(p);
  if (state.inv) { renderChips(); renderInvPanel(); }  // investors narrow down to this stock's holders
}
// The side panel stops above the undervalued list (it scrolls if needed); fold the list to give it room.
function fitSide() {
  const side = $('#side'), panels = [$('#vpanel'), $('#ipanel'), $('#fpanel')].filter(el => el.style.display === 'block');
  if (side.style.display === 'none') return;
  const bottom = panels.length ? $('#rightcol').getBoundingClientRect().top - 8 : innerHeight - 12;
  side.style.maxHeight = `${Math.max(160, bottom - side.getBoundingClientRect().top)}px`;
}
async function renderSide(p) {
  const s = p.stock, body = $('#side .body');
  const rows = Object.keys(SAT).map(k => `<tr><td>${PERIOD_NAME[k]}</td><td class="${s.ret[k] >= 0 ? 'up' : 'down'}">${fmtPct(s.ret[k])}</td></tr>`).join('');
  body.innerHTML = `<h2>${esc(s.sym)}</h2><div class="nm">${esc(s.name)} · ${esc(INDEX_DESC[s.idx] || '')}<br>${esc(s.sector)} · ${esc(s.industry)}</div>
    <div class="px">$${s.price.toFixed(2)} <span class="${s.ret['1d'] >= 0 ? 'up' : 'down'}" style="font-size:14px">${fmtPct(s.ret['1d'])}</span></div>
    <div class="mut">Market cap ${fmtCap(s.cap)}${s.cap_estimated ? ' (estimated: no SEC share count)' : ''} · close ${esc(s.date)}</div>
    <div class="chartwrap"><canvas></canvas><div class="xhair"></div><div class="cdot"></div><div class="ctip"></div></div><div class="cols">${state.inv && !state.value
      ? `<div>${invSection(s)}<h3 class="vh">Returns</h3><table>${rows}</table></div><div>${valSection(s.val)}</div>`
      : `<div>${valSection(s.val)}</div><div>${invSection(s)}<h3 class="vh">Returns</h3><table>${rows}</table></div>`}</div>`;
  fitSide();
  try {
    const r = await fetch(`/api/history/${encodeURIComponent(s.sym)}`);
    if (!r.ok || state.selected !== p) return;
    const h = await r.json();
    drawChart($('#side canvas'), h.bars, h.fair || [], s.val?.trend, h.investors || {});
  } catch {}
}
// Price over 3 years with axes, the fair-value range at each past quarter (gold steps) and its average (dashed),
// plus one lane per tracked investor showing when they held the stock (13F). Hovering shows the values that day.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}
const axisNum = v => v >= 10000 ? `${(v / 1000).toFixed(0)}k` : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
const fmtShares = n => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${(n / 1e3).toFixed(0)}K`;
function drawChart(cv, bars, fair, trend, inv = {}) {
  const t = d => Date.parse(d), t0 = t(bars[0][0]), t1 = t(bars.at(-1)[0]);
  // One lane per investor who held the stock at some point in the chart's window, under the price chart.
  const lanes = Object.entries(inv).map(([key, x]) => ({ key, who: investor(key), series: x.series || [] }))
    .filter(l => groupOf(l.who) === state.invGroup)
    .filter(l => l.series.some(([d, sh], k) => sh && t(l.series[k + 1]?.[0] ?? bars.at(-1)[0]) >= t0))
    .sort((a, b) => a.series.findIndex(q => q[1]) - b.series.findIndex(q => q[1]));
  // The chart grows with the (half-page) panel; lanes get taller too.
  const wide = cv.clientWidth > 500, fs = wide ? 12 : 10, font = `${fs}px system-ui`;
  const CH = Math.round(Math.min(420, Math.max(200, cv.clientWidth * 0.42))), LANE = wide ? 20 : 15, LANES_TOP = CH + 4;
  cv.style.height = `${CH + (lanes.length ? lanes.length * LANE + fs + 10 : 0)}px`;
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, H = cv.clientHeight, h = CH;
  cv.width = w * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr); g.font = font;
  // Each fair range applies from about when its filing came out until the next one (or today).
  const steps = fair.map((f, k) => ({ ...f, a: Math.max(t0, t(f.from)), b: k + 1 < fair.length ? t(fair[k + 1].from) : t1 }));
  // Today's estimate can start on the very last day; give it at least the last 2% of the width so it shows.
  const minA = t1 - (t1 - t0) * 0.02, cur = steps.at(-1);
  if (cur && cur.a > minA) { cur.a = minA; const prev = steps.at(-2); if (prev && prev.b > minA) prev.b = minA; }
  steps.splice(0, steps.length, ...steps.filter(f => f.b > t0 && f.a < t1));
  const v = bars.map(b => b[1]);
  const all = [...v, ...steps.flatMap(f => [f.low, f.high]), ...(trend ? [trend.avg] : [])];
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi > 4 * Math.max(...v)) hi = 4 * Math.max(...v);  // keep the price readable when fair value is far above it
  const step = niceStep((hi - lo) / (wide ? 6 : 4));
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const padT = 8, padB = fs + 10, padR = fs * 3.6, pw = w - padR, base = h - padB;
  const X = d => ((d - t0) / (t1 - t0 || 1)) * pw;
  const Y = x => padT + (1 - (Math.min(hi, Math.max(lo, x)) - lo) / (hi - lo || 1)) * (base - padT);

  // Axes: price gridlines on the right, dates along the bottom.
  g.textBaseline = 'middle'; g.textAlign = 'left';
  for (let y = lo; y <= hi + step / 2; y += step) {
    g.strokeStyle = '#ffffff12'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, Y(y)); g.lineTo(pw, Y(y)); g.stroke();
    g.fillStyle = '#8b93a5'; g.fillText(step >= 1 ? axisNum(Math.round(y)).replace(/\.0+$/, '') : y.toFixed(step >= 0.1 ? 1 : 2), pw + 5, Y(y));
  }
  g.textBaseline = 'alphabetic'; g.textAlign = 'center';
  const d0 = new Date(t0), every = wide ? 3 : 6;
  for (let y = d0.getUTCFullYear(), m = d0.getUTCMonth() + 1; ; m++) {
    if (m > 11) { m = 0; y++; }
    const tm = Date.UTC(y, m, 1);
    if (tm > t1) break;
    if (m % every) continue;
    const x = X(tm);
    g.strokeStyle = m === 0 ? '#ffffff22' : '#ffffff10'; g.beginPath(); g.moveTo(x, padT); g.lineTo(x, base); g.stroke();
    g.fillStyle = m === 0 ? '#c4cad6' : '#8b93a5';
    if (x > 14 && x < pw - 14) g.fillText(m === 0 ? String(y) : `${MON[m]} ${String(y).slice(2)}`, x, h - 3);
  }
  g.strokeStyle = '#ffffff33'; g.beginPath(); g.moveTo(0, base); g.lineTo(pw, base); g.moveTo(pw, padT); g.lineTo(pw, base); g.stroke();

  for (const f of steps) {
    const a = X(Math.max(f.a, t0)), b = X(Math.min(f.b, t1));
    g.fillStyle = '#f5b30126'; g.fillRect(a, Y(f.high), b - a, Y(f.low) - Y(f.high));
    g.strokeStyle = '#f5b301'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(a, Y(f.mid)); g.lineTo(b, Y(f.mid)); g.stroke();
  }
  if (steps.length) {  // label today's estimate at the right edge
    const cur = steps.at(-1);
    g.font = font; g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillStyle = '#f5b301';
    g.fillText(`now ${axisNum(cur.mid)}`, X(cur.a) - 3, Y(cur.mid) - 2); g.textBaseline = 'alphabetic';
  }
  if (trend && steps.length) {
    g.setLineDash([4, 3]); g.strokeStyle = '#f5d67a'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, Y(trend.avg)); g.lineTo(pw, Y(trend.avg)); g.stroke(); g.setLineDash([]);
  }
  g.beginPath(); bars.forEach((b, i) => i ? g.lineTo(X(t(b[0])), Y(b[1])) : g.moveTo(X(t(b[0])), Y(b[1])));
  g.strokeStyle = '#dde3ee'; g.lineWidth = 1.4; g.stroke();

  // A 13F entry/exit is the first/last quarter-end the position shows up; the trade was during that quarter.
  const indexAt = tt => { let a = 0, b = bars.length - 1;
    while (a < b) { const m = (a + b + 1) >> 1; if (t(bars[m][0]) <= tt) a = m; else b = m - 1; } return a; };
  const inside = d => t(d) >= t0 && t(d) <= t1;
  lanes.forEach((l, li) => {
    const y = LANES_TOP + li * LANE, max = Math.max(...l.series.map(q => q[1])) || 1;
    // Held from each quarter-end it was reported until the next filing (or today); brighter = more shares.
    l.series.forEach(([d, sh], k) => {
      if (!sh) return;
      const a = Math.max(t0, t(d)), b = k + 1 < l.series.length ? t(l.series[k + 1][0]) : t1;
      if (b <= t0) return;
      g.fillStyle = `rgba(34, 211, 238, ${(0.18 + 0.6 * sh / max).toFixed(2)})`;
      g.fillRect(X(a), y + 2, Math.max(1, X(Math.min(b, t1)) - X(a)), LANE - 5);
    });
    l.series.forEach(([d, sh], k) => {
      if (k === 0 || !inside(d)) return;
      const had = l.series[k - 1][1], x = X(t(d));
      if (sh && !had || !sh && had) {
        const col = sh ? '#22c55e' : '#ef4444';
        g.strokeStyle = col + '55'; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(x, padT); g.lineTo(x, y + LANE / 2); g.stroke(); g.setLineDash([]);
        g.fillStyle = col; g.textAlign = 'center';
        g.fillText(sh ? '▲' : '✕', x, y + LANE - 4);
        g.beginPath(); g.arc(x, Y(bars[indexAt(t(d))][1]), 3, 0, 2 * Math.PI); g.fill();  // the same mark on the price line
      }
    });
    // Institutions never really go in or out; mark each quarter they added or trimmed 5%+ instead.
    if (groupOf(l.who) === 'inst') l.series.forEach(([d, sh], k) => {
      const had = k && l.series[k - 1][1];
      if (!had || !sh || !inside(d) || Math.abs(sh / had - 1) < 0.05) return;
      g.fillStyle = sh > had ? '#22c55e' : '#ef4444'; g.textAlign = 'center';
      g.fillText(sh > had ? '▲' : '▼', X(t(d)), y + LANE - 4);
    });
    g.textAlign = 'left'; g.fillStyle = '#dde3ee';
    g.fillText(l.who ? shortName(l.who) : l.key, 3, y + LANE - 4);
  });
  if (lanes.length) {
    g.textAlign = 'left'; g.fillStyle = '#8b93a5';
    g.fillText(isInst() ? 'held (brighter = more shares) · ▲ added / ▼ trimmed 5%+ that quarter · 13F quarter-ends'
      : 'held (brighter = more shares) · ▲ went in · ✕ out · 13F quarter-ends', 3, H - 3);
  }
  // Legend, top-left.
  g.textAlign = 'left';
  const items = [['— price', '#dde3ee']].concat(steps.length ? [['— fair value (shaded = range)', '#f5b301']] : [],
    trend && steps.length ? [[`- - 3-yr average fair value ${axisNum(trend.avg)}`, '#f5d67a']] : []);
  items.forEach(([txt, col], k) => { g.fillStyle = col; g.fillText(txt, 6, padT + fs + k * (fs + 3)); });

  // Hover: crosshair, a dot on the price and the values for that day.
  const wrap = cv.parentElement, xhair = $('.xhair', wrap), dot = $('.cdot', wrap), tip = $('.ctip', wrap);
  const hide = () => { xhair.style.display = dot.style.display = tip.style.display = 'none'; };
  cv.onmouseleave = hide;
  cv.onmousemove = e => {
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left;
    if (mx < 0 || mx > pw) return hide();
    const i = indexAt(t0 + (mx / pw) * (t1 - t0)), [d, price] = bars[i], tt = t(d), x = X(tt);
    const f = steps.find(s => tt >= s.a && tt < s.b) || (tt >= t1 ? steps.at(-1) : null);
    const held = lanes.map(l => {
      const q = l.series.filter(([qd]) => qd <= d).at(-1);
      const name = esc(l.who ? shortName(l.who) : l.key);
      return q && q[1] ? `<span class="mv-add">${name}</span> ${fmtShares(q[1])} sh <span class="mut">(${quarter(q[0])})</span>`
                       : `<span class="mut">${name} —</span>`;
    });
    tip.innerHTML = `<b>${esc(d)}</b> · price <b>${price.toFixed(2)}</b>`
      + (f ? `<br><span style="color:#f5b301">fair ${f.low.toFixed(0)}–${f.high.toFixed(0)}</span> (mid ${f.mid.toFixed(0)},
             <span class="${f.mid >= price ? 'up' : 'down'}">${fmtPct(100 * (f.mid / price - 1))}</span> vs price)` : '')
      + (trend && steps.length ? `<br><span style="color:#f5d67a">3-yr avg ${trend.avg.toFixed(0)}</span>` : '')
      + (held.length ? `<br>${held.join('<br>')}` : '');
    xhair.style.cssText = `display:block; left:${x}px; height:${H}px`;
    dot.style.cssText = `display:block; left:${x}px; top:${Y(price)}px`;
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    tip.style.left = `${x + 12 + tw > pw ? x - tw - 12 : x + 12}px`; tip.style.top = `${padT}px`;
  };
}
// Closing the panel resets the view: back to the isolated sector, or to the whole city.
function closeSide() {
  select(null);
  const sec = state.sector && city.sectors.find(x => x.name === state.sector);
  if (sec) flyTo(sec.center, sec.size * 1.3 + 20); else flyHome();
}
$('#side .close').onclick = closeSide;
// The controls hint sits bottom-right; hide it whenever a panel or the side panel would cover it.
function updateHelp() {
  $('#help').style.display = state.value || state.inv || state.flow || state.selected ? 'none' : '';
}

// ---------- valuation ----------
const VAL_NAME = { high:'★ Highly undervalued', under:'Undervalued', fair:'Fairly valued', over:'Overvalued', 'n/a':'Not valued' };
function valTip(v) {
  if (!v) return '';
  const cls = v.label === 'high' || v.label === 'under' ? 'up' : v.label === 'over' ? 'down' : 'mut';
  return `<br><span class="${cls}">${VAL_NAME[v.label]}</span>` + (v.upside != null ? ` · DCF upside ${fmtPct(v.upside)}` : '');
}
function valSection(v) {
  if (!v) return '';
  if (!v.fair) return `<h3 class="vh">Valuation</h3><div class="mut">${VAL_NAME[v.label]}: ${esc(v.why)}</div>`;
  const chk = (ok, text) => `<tr><td>${esc(text)}</td><td class="${ok ? 'up' : 'down'}">${ok ? '✓' : '✗'}</td></tr>`;
  return `<h3 class="vh">Valuation <span class="vl ${v.label}">${VAL_NAME[v.label]}</span></h3>
    <div>Fair value <b>${v.fair.low.toFixed(0)}–${v.fair.high.toFixed(0)}</b> (mid ${v.fair.mid.toFixed(0)}, <span class="${v.upside >= 0 ? 'up' : 'down'}">${fmtPct(v.upside)}</span>)</div>
    <div class="mut" title="Reverse DCF: the constant 10-year cash-flow growth today's price assumes, vs the 10-year average if today's revenue growth (${v.g0}%/yr) halves every 3 years towards 3%">
      price implies <b>${v.implied_g}%/yr</b> vs <b>${v.fade_g}%/yr</b> if growth fades</div>
    ${v.trend ? `<div title="The same DCF recomputed at each of the last ${v.trend.quarters} quarters with only the filings known then (today's discount rate and share count)">
      fair value trend <b class="${v.trend.cagr >= 0 ? 'up' : 'down'}">${fmtPct(v.trend.cagr)}/yr</b> since ${esc(v.trend.since)} ·
      average <b>${v.trend.avg.toFixed(0)}</b> <span class="${v.trend.vs_avg >= 0 ? 'up' : 'down'}">(${fmtPct(v.trend.vs_avg)} vs price)</span></div>` : ''}
    ${v.backlog?.used ? `<div title="Remaining performance obligations: revenue already contracted but not yet recognized (SEC 10-Q/10-K). Bigger backlog vs revenue = more weight on backlog growth (up to 50%) and a slower growth fade (up to +2 years).">
      backlog (RPO) <b>${fmtCap(v.backlog.rpo)}</b> = ${v.backlog.coverage}× revenue${v.backlog.growth != null ? `, <span class="${v.backlog.growth >= 0 ? 'up' : 'down'}">${fmtPct(v.backlog.growth)}</span> in a year` : ''}
      → growth ${v.backlog.weight}% weighted to backlog, fades over ${v.backlog.half_life}y half-life</div>` : ''}
    <div class="mut" title="Shareholders of indebted companies take more risk, so the discount rate rises with net debt / market cap (9% when debt-free, max 16%). Debt is at least TTM interest ÷ 5%.">
      discount rate <b>${v.rate}%</b> · net ${v.net_debt >= 0 ? 'debt' : 'cash'} ${fmtCap(Math.abs(v.net_debt))} (${v.debt_to_cap}× market cap)</div>
    <div class="mut">revenue ${fmtPct(v.g1)} 1y · ${v.g3 == null ? '–' : fmtPct(v.g3) + '/yr 3y'} · margins FCF ${v.fcf_margin ?? '–'}% · op ${v.op_margin ?? '–'}%</div>
    <table>${chk(v.checks.fcf, 'Free cash flow positive (TTM)')}${chk(v.checks.growth, 'Revenue growing')}${chk(v.checks.margin, 'Margin not down >5 pts')}${chk(v.checks.fresh, 'Recent filing')}${v.checks.steady == null ? '' : chk(v.checks.steady, 'Steady growth (no merger/cycle jump)')}</table>
    <div class="mut" style="margin-top:4px">${esc(v.why)} · quarter ${esc(v.quarter)}</div>`;
}
function renderValuePanel() {
  const el = $('#vpanel'), all = city.plots.filter(p => isHigh(p.stock)).sort((a, b) => b.stock.val.upside - a.stock.val.upside);
  // The header counts the whole market; the list follows the isolated sector, like the city does.
  const flagged = state.sector ? all.filter(p => p.sector === state.sector) : all;
  $('#valCount').textContent = market?.stocks?.length ? `(${all.length})` : '';
  el.style.display = state.value ? 'block' : 'none';
  updateHelp();
  if (!state.value) return fitSide();
  el.classList.toggle('collapsed', state.vpanelHidden);
  el.innerHTML = `<h3 title="Show/hide">★ Highly undervalued · ${state.sector ? `${esc(state.sector)} · ` : ''}${flagged.length}
      <span>${state.vpanelHidden ? '▸' : '▾'}</span></h3>` + (flagged.length
    ? `<div class="list">${flagged.map((p, k) => { const v = p.stock.val;
        return `<div class="vrow" data-sym="${esc(p.stock.sym)}" title="${esc(p.stock.name)} · ${esc(p.sector)}"><span class="mut">${k + 1}</span><b>${esc(p.stock.sym)}${state.inv && isCombo(p.stock) ? ' <span class="combo" title="Also being bought by tracked investors">◆</span>' : ''}</b>
          <span class="up">${fmtPct(v.upside)}</span><span class="mut">${v.fair.low.toFixed(0)}–${v.fair.high.toFixed(0)}</span></div>`; }).join('')}</div>`
    : `<div class="mut" style="padding:4px 12px">${market?.progress?.fund_done < market?.progress?.fund_total ? 'Still loading SEC filings…'
        : state.sector in NOT_VALUED ? 'This sector is not valued: free-cash-flow DCFs don’t fit banks, insurers or REITs.'
        : state.sector ? 'No stock in this sector passes every rule right now.' : 'No stock passes every rule right now.'}</div>`)
    + `<div class="hint">price vs fair range · DCF at 9% ± 1 (higher for indebted companies)</div>`;
  el.querySelectorAll('.vrow').forEach(r => r.onclick = () => focusPlot(city.bySym.get(r.dataset.sym)));
  $('h3', el).onclick = () => { state.vpanelHidden = !state.vpanelHidden; save(); renderValuePanel(); };
  fitSide();
}
const NOT_VALUED = { 'Financials': 1, 'Real Estate': 1 };

// ---------- famous investors (13F) ----------
const STATUS = { new: ['↑', 'NEW', 'mv-add'], added: ['↑', '', 'mv-add'], reduced: ['↓', '', 'mv-cut'], sold: ['✕', 'SOLD', 'mv-cut'],
                 unchanged: ['=', '', 'mv-eq'], held: ['•', '', 'mv-eq'] };
const investorsList = () => market?.investors?.list || [];
const investor = key => investorsList().find(i => i.key === key);
const groupList = () => investorsList().filter(i => groupOf(i) === state.invGroup);
const GROUP_NAME = { famous: ['👤', 'Famous investors', 'investors'], inst: ['🏛', 'Institutions', 'institutions'] };
const groupIcon = () => GROUP_NAME[state.invGroup][0], groupTitle = () => GROUP_NAME[state.invGroup][1];
const groupCount = () => `${groupList().length || (isInst() ? 8 : 10)} ${GROUP_NAME[state.invGroup][2]}`;
const shortName = i => groupOf(i) === 'inst' || i.person === 'Li Lu' ? i.person : i.person.split(' ').at(-1);
const ownPct = (s, shares) => 100 * shares / (s.cap / s.price);
function move(r, withName = true) {
  const [arrow, word, cls] = STATUS[r.status] || STATUS.held, i = investor(r.key);
  const pct = word || (r.change_pct == null || r.status === 'unchanged' ? '' : `${r.change_pct > 0 ? '+' : ''}${Math.round(r.change_pct)}%`);
  return `<span class="${cls}">${arrow}${withName && i ? esc(shortName(i)) : ''}${pct ? ' ' + pct : ''}</span>`;
}
const quarter = d => `Q${Math.ceil(+d.slice(5, 7) / 3)} ${d.slice(0, 4)}`;
const since = r => !r.since ? '' : r.since_before ? `before ${quarter(r.since)}` : `since ${quarter(r.since)}`;
function invTip(s) {
  if (!state.inv || !s.inv) return '';
  const rows = invRows(s);
  if (!rows.length) return '';
  if (!isInst()) return `<br>👤 ${rows.map(r => move(r)).join(' ')}`;
  const st = instStat(s);
  return `<br>🏛 own ${fmtOwn(st)} · ${fmtChange(st)} <span class="mut">${esc(instWindow())}</span>`
    + (state.invKey ? ` ${move(rows[0], false)}` : '');
}
function invSection(s) {
  const rows = groupRows(s), inst = isInst();
  if (!rows.length) return '';
  const body = rows.slice().sort((a, b) => b.value - a.value).map(r => { const i = investor(r.key);
    const size = r.status === 'sold' ? `${(r.prev_shares / 1e6).toFixed(2)}M sh` : `${fmtCap(r.value)} · ${inst ? `owns ${ownPct(s, r.shares).toFixed(2)}%` : `${r.weight}%`}`;
    return `<tr title="${esc(i ? `${i.firm} · 13F for ${i.report_date}${i.prev_report_date ? ` vs ${i.prev_report_date}` : ''}` : '')}">
      <td>${esc(i ? i.person : r.key)}</td><td>${move(r, false)}</td>
      <td class="mut">${size}<br>${esc(r.status === 'sold' ? `held ${since(r).replace('since ', 'from ')}` : since(r))}</td></tr>`; }).join('');
  const st = inst && instStat(s);
  const badge = inst ? `own ${fmtOwn(st)} · ${st.event ? 'index / corporate event' : fmtPts(st.d)}`
    : `${heldBy(rows)}/${groupList().length} hold · ${rows.filter(r => r.status in ADD).length}↑ ${rows.filter(r => r.status in CUT).length}↓`;
  return `<h3 class="vh">${groupTitle()} <span class="vl">${badge}</span></h3>
    <table class="inv">${body}</table>
    <div class="mut" style="margin-top:4px">${inst
      ? 'Share-count change between each institution\'s last two 13F filings · value · share of the company they own'
      : 'Share-count change between each investor\'s last two 13F filings · value · share of their portfolio'}</div>`;
}
function renderChips() {
  const el = $('#invChips'), list = investorsList(), enabled = market?.investors?.enabled;
  $('#invBtn').disabled = market ? !enabled : false;
  for (const [src, what] of [['investors', 'the 10 famous investors'], ['institutions', 'the 8 biggest institutions (Vanguard, BlackRock…)']]) {
    const b = $(`#flowSeg button[data-src="${src}"]`);  // the 13F flow sources need --sec-agent
    b.disabled = market ? !enabled : false;
    b.title = b.disabled ? 'Start the server with --sec-agent "Your Name you@example.com" to load 13F filings'
      : `Flow source: dollars ${what} added or trimmed per sector (last 13F quarter)`;
  }
  $('#invBtn').title = enabled === false ? 'Start the server with --sec-agent "Your Name you@example.com" (SEC requires a contact for 13F downloads)'
    : 'Highlight what 10 famous investors hold (SEC 13F) and whether they are adding or trimming';
  const famous = list.some(i => groupOf(i) === 'famous'), inst = list.some(i => groupOf(i) === 'inst');
  $('#instBtn').disabled = market ? !enabled : false;
  $('#instBtn').title = enabled === false ? $('#invBtn').title
    : 'The 8 biggest asset managers (Vanguard, BlackRock, State Street, Fidelity…): how much of each company they own (SEC 13F) and where that changed most';
  el.style.display = state.inv && groupList().length ? 'flex' : 'none';
  // Same count as the panel: stocks the investors hold or sold out of in their latest quarter.
  $('#invCount').textContent = famous ? `(${city.plots.filter(p => p.stock.inv?.rows.some(r => groupOf(investor(r.key)) === 'famous')).length})` : '';
  $('#instCount').textContent = inst && state.inv && isInst() ? `(${instTop().set.size})` : '';
  // With a stock selected, its holders light up with their move and the others fade.
  const held = state.selected ? new Map(groupRows(state.selected.stock).map(r => [r.key, r])) : null;
  const html = groupList().map(i => { const r = held?.get(i.key);
    const cls = [state.invKey === i.key ? 'on' : '', held ? (r ? 'held' : 'dim') : ''].join(' ').trim();
    return `<button data-k="${esc(i.key)}" class="${cls}"
      title="${esc(`${i.person} · ${i.firm} · 13F for ${i.report_date} · ${fmtCap(i.total_value)} in ${i.positions} positions`)}">${esc(shortName(i))}${r ? ' ' + move(r, false) : ''}</button>`; }).join('');
  if (el.dataset.html !== html) {  // rebuild only when it changed, so a click isn't lost mid-poll
    el.dataset.html = html; el.innerHTML = html;
    el.querySelectorAll('button').forEach(b => b.onclick = () => {
      state.invKey = state.invKey === b.dataset.k ? null : b.dataset.k; refreshHighlights(); });
  }
}
// The 👤 list for one selected stock: who holds it and what they did; clicking an investor opens their portfolio.
function renderStockInvestors(el, s) {
  const rows = groupRows(s).sort((a, b) => b.value - a.value || (a.status === 'sold') - (b.status === 'sold')), inst = isInst();
  const st = inst && instStat(s);
  el.classList.toggle('collapsed', state.ipanelHidden);
  el.innerHTML = `<h3 title="Show/hide">${groupIcon()} ${inst ? 'Institutions' : 'Investors'} in ${esc(s.sym)} · ${
      !rows.length ? 'none' : inst ? `own ${fmtOwn(st)} · ${st.event ? 'index / corporate event' : fmtPts(st.d)}` : `${heldBy(rows)}/${groupList().length} hold`}
      <span>${state.ipanelHidden ? '▸' : '▾'}</span></h3>`
    + (rows.length ? `<div class="list">${rows.map(r => { const i = investor(r.key);
        return `<div class="irow wide" data-k="${esc(r.key)}" title="${esc(i ? `${i.firm} · 13F for ${i.report_date} · click to see the whole portfolio` : '')}">
          <b>${esc(i ? shortName(i) : r.key)}</b><span class="mut">${r.status === 'sold' ? '' : inst ? ownPct(s, r.shares).toFixed(2) + '%' : r.weight + '%'}</span>
          <span class="moves">${move(r, false)} · ${r.status === 'sold' ? `sold ${(r.prev_shares / 1e6).toFixed(2)}M sh` : fmtCap(r.value)} · ${esc(since(r))}</span></div>`; }).join('')}</div>`
      : `<div class="mut" style="padding:4px 12px">None of the ${groupCount()} held ${esc(s.sym)} in their last two filings.</div>`)
    + `<div class="hint">% = ${inst ? `share of ${esc(s.sym)} that institution owns` : "share of that investor's portfolio"} · click ${inst ? 'one' : 'an investor'} to see their portfolio · close the stock (✕ or Esc) for the full list</div>`;
  el.querySelectorAll('.irow').forEach(r => r.onclick = () => { state.invKey = r.dataset.k; refreshHighlights(); });
  $('h3', el).onclick = () => { state.ipanelHidden = !state.ipanelHidden; save(); renderInvPanel(); };
  fitSide();
}
function renderInvPanel() {
  const el = $('#ipanel');
  el.style.display = state.inv ? 'block' : 'none';
  updateHelp();
  if (!state.inv) return fitSide();
  if (state.selected && !state.invKey) return renderStockInvestors(el, state.selected.stock);
  if (isInst() && !groupList().length) {
    const pr = market?.progress || {};
    el.classList.remove('collapsed');
    el.innerHTML = `<h3>🏛 Institutions</h3><div class="mut" style="padding:4px 12px">${!market?.investors?.enabled
      ? 'Start the server with --sec-agent to load 13F filings.'
      : `Still loading: looking up the tickers of their holdings${pr.figi_total ? ` (${pr.figi_done}/${pr.figi_total})` : ''}. The city lights up as soon as the biggest positions are matched.`}</div>`;
    return fitSide();
  }
  if (isInst()) return renderInstPanel(el);
  if (state.invTab !== 'holdings') return renderInvMoves(el);
  const all = city.plots.filter(p => isHeld(p.stock)), sel = state.invKey && investor(state.invKey);
  const shown = (state.sector ? all.filter(p => p.sector === state.sector) : all).sort(sel
    ? (a, b) => (invRows(b.stock)[0].weight - invRows(a.stock)[0].weight) || (invRows(a.stock)[0].status === 'sold') - (invRows(b.stock)[0].status === 'sold')
    : (a, b) => (heldBy(invRows(b.stock)) - heldBy(invRows(a.stock))) || (invRows(b.stock).reduce((t, r) => t + r.value, 0) - invRows(a.stock).reduce((t, r) => t + r.value, 0)));
  el.classList.toggle('collapsed', state.ipanelHidden);
  const title = sel ? `👤 ${esc(sel.person)} · ${esc(sel.firm)}` : '👤 Famous investors';
  el.innerHTML = `<h3 title="Show/hide">${title} · ${state.sector ? `${esc(state.sector)} · ` : ''}${shown.length}
      <span>${state.ipanelHidden ? '▸' : '▾'}</span></h3>${invTabs()}`
    + (shown.length ? `<div class="list">${shown.map(p => { const s = p.stock, rows = invRows(s);
        const combo = state.value && isCombo(s) ? ' <span class="combo" title="Highly undervalued and being bought">◆</span>' : '';
        const mid = sel ? (rows[0].status === 'sold' ? 'sold' : `${rows[0].weight}%`) : `${heldBy(rows)}/${groupList().length}`;
        return `<div class="irow" data-sym="${esc(s.sym)}" title="${esc(s.name)} · ${esc(p.sector)}"><b>${esc(s.sym)}${combo}</b>
          <span class="mut">${mid}</span><span class="moves">${rows.map(r => move(r, !sel)).join(' ')}</span></div>`; }).join('')}</div>`
      : `<div class="mut" style="padding:4px 12px">${!market?.investors?.enabled ? 'Start the server with --sec-agent to load 13F filings.'
          : market?.progress?.inv_done < market?.progress?.inv_total ? 'Still loading 13F filings…' : 'No S&amp;P 500 holdings here.'}</div>`)
    + `<div class="hint">${sel ? `13F for ${esc(sel.report_date)} vs ${esc(sel.prev_report_date || '–')} · % = share of portfolio · ` : ''}↑ new/added ↓ reduced ✕ sold (share count, last two 13F filings)${state.value ? ' · ◆ undervalued and being bought' : ''}. 13F = quarter-end long positions, filed up to 45 days later. Not investment advice.</div>`;
  el.querySelectorAll('.irow').forEach(r => r.onclick = () => focusPlot(city.bySym.get(r.dataset.sym)));
  wireInvPanel(el);
}
// Tabs of the 👤 list: what they hold, or their latest buys / sells across all investors.
function invTabs() {
  const tabs = isInst() ? [['holdings', 'Ownership'], ['buys', '↑ Net buying'], ['sells', '↓ Net selling']]
    : [['holdings', 'Holdings'], ['buys', '↑ Recent buys'], ['sells', '↓ Recent sells']];
  return `<div class="itabs">${tabs
    .map(([k, label]) => `<button data-t="${k}" class="${state.invTab === k ? 'on' : ''}">${label}</button>`).join('')}</div>`;
}
function wireInvPanel(el) {
  el.querySelectorAll('.itabs button').forEach(b => b.onclick = () => { state.invTab = b.dataset.t; save(); renderInvPanel(); });
  $('h3', el).onclick = () => { state.ipanelHidden = !state.ipanelHidden; save(); renderInvPanel(); };
  fitSide();
}
// The 🏛 list: stocks by how much of them the institutions own, or by the biggest rise / fall in that share
// between their last two filings (ownership points, with the dollars at quarter-end prices).
const INST_LIST = 300;
function renderInstPanel(el) {
  const tab = state.invTab, sel = state.invKey && investor(state.invKey), top = instTop();
  const all = city.plots.filter(p => (!state.sector || p.sector === state.sector) && invRows(p.stock).length)
    .map(p => ({ p, ...instStat(p.stock) })).filter(x => !x.bad);
  const shown = tab === 'buys' ? all.filter(x => x.d > 0).sort((a, b) => b.d - a.d)
    : tab === 'sells' ? all.filter(x => x.d < 0).sort((a, b) => a.d - b.d) : all.sort((a, b) => b.own - a.own);
  const usd = p => invRows(p.stock).reduce((t, r) => t + (r.shares - instBase(r)) * (r.shares ? r.value / r.shares : p.stock.price), 0);
  el.classList.toggle('collapsed', state.ipanelHidden);
  el.innerHTML = `<h3 title="Show/hide">🏛 ${sel ? `${esc(sel.person)}` : 'Institutions'} · ${state.sector ? `${esc(state.sector)} · ` : ''}${
      tab === 'buys' ? 'net buying' : tab === 'sells' ? 'net selling' : 'ownership'} · ${esc(instWindow())} · ${shown.length}
      <span>${state.ipanelHidden ? '▸' : '▾'}</span></h3>${invTabs()}`
    + (shown.length ? `<div class="list">${shown.slice(0, INST_LIST).map(({ p, own, d, event }) => { const s = p.stock, v = usd(p);
        const combo = state.value && isCombo(s) ? ' <span class="combo" title="Highly undervalued and being bought">◆</span>' : '';
        return `<div class="mrow" data-sym="${esc(s.sym)}" title="${esc(`${s.name} · ${p.sector}`)}${top.set.has(s.sym) ? ' · lit: one of the biggest moves' : ''}">
          <b>${esc(s.sym)}${combo}</b><span class="mut">own ${own.toFixed(1)}%</span>
          ${event ? '<span class="mut" title="Index addition or removal, spin-off, merger, reverse split or new listing: not counted">event</span><span></span>'
            : `<span class="${d >= 0 ? 'up' : 'down'}">${fmtPts(d).replace(' pts', '')}</span>
          <span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : '−'}${fmtCap(Math.abs(v))}</span>`}<span class="mut">${top.set.has(s.sym) ? '●' : ''}</span></div>`; }).join('')}</div>`
      : `<div class="mut" style="padding:4px 12px">${!market?.investors?.enabled ? 'Start the server with --sec-agent to load 13F filings.'
          : market?.progress?.inv_done < market?.progress?.inv_total ? 'Still loading 13F filings…' : 'Nothing here.'}</div>`)
    + `<div class="hint">own = ${sel ? esc(sel.person) : `the ${groupList().length} combined`}: shares held ÷ shares outstanding · pts = change over ${esc(instWindow())} (13F is quarterly: 1D–3M = last quarter, YTD = since year-end, 1Y = four quarters), with the dollars at quarter-end prices · ● lit in the city: the ${INST_TOP} biggest changes. Stocks with an index change or corporate action in the window (S&amp;P addition, spin-off, merger, reverse split) aren't ranked.
        Index funds (Vanguard, BlackRock, State Street, Norges) buy and sell with fund flows and index changes, so their moves show where money is going more than an opinion; pick an active manager's chip for stock-picking. Not investment advice.</div>`;
  el.querySelectorAll('.mrow').forEach(r => r.onclick = () => focusPlot(city.bySym.get(r.dataset.sym)));
  wireInvPanel(el);
}
// Every position opened or added to (or trimmed / sold) in each investor's latest 13F, newest filing first,
// then by dollars moved. Dollars = change in shares × quarter-end price (today's price for sold-out ones).
function renderInvMoves(el) {
  const buys = state.invTab === 'buys';
  const moves = city.plots.filter(p => !state.sector || p.sector === state.sector).flatMap(p => invRows(p.stock)
    .filter(r => buys ? r.status in ADD : r.status in CUT)
    .map(r => ({ p, r, who: investor(r.key), usd: Math.abs(r.shares - r.prev_shares) * (r.shares ? r.value / r.shares : p.stock.price) })))
    .sort((a, b) => (b.who?.report_date || '').localeCompare(a.who?.report_date || '') || b.usd - a.usd);
  const total = moves.reduce((t, m) => t + m.usd, 0), sel = state.invKey && investor(state.invKey);
  el.classList.toggle('collapsed', state.ipanelHidden);
  el.innerHTML = `<h3 title="Show/hide">👤 ${sel ? esc(sel.person) : 'Famous investors'} · ${buys ? 'recent buys' : 'recent sells'} · ${moves.length}
      <span>${state.ipanelHidden ? '▸' : '▾'}</span></h3>${invTabs()}`
    + (moves.length ? `<div class="list">${moves.map(({ p, r, who, usd }) => `<div class="mrow" data-sym="${esc(p.stock.sym)}"
          title="${esc(`${p.stock.name} · ${who ? `${who.person} (${who.firm}) · 13F for ${who.report_date}, filed ${who.filed}` : ''}`)}">
          <b>${esc(p.stock.sym)}${state.value && isCombo(p.stock) ? ' <span class="combo">◆</span>' : ''}</b>
          <span>${esc(who ? shortName(who) : r.key)}</span>${move(r, false)}
          <span class="${buys ? 'up' : 'down'}">${fmtCap(usd)}</span><span class="mut">${who ? quarter(who.report_date).replace(' 20', "'") : ''}</span></div>`).join('')}</div>`
      : `<div class="mut" style="padding:4px 12px">No ${buys ? 'buys' : 'sells'} in the latest filings${state.sector ? ' in this sector' : ''}.</div>`)
    + `<div class="hint">${buys ? 'New positions and adds' : 'Trims and full exits'} in each investor's latest 13F (${fmtCap(total)} in total), newest filing first, then by size.
       The trades happened during that quarter; filings arrive up to 45 days after it ends. Pick an investor chip for one investor.</div>`;
  el.querySelectorAll('.mrow').forEach(r => r.onclick = () => focusPlot(city.bySym.get(r.dataset.sym)));
  wireInvPanel(el);
}

// ---------- sector flow ----------
// Where value is moving between sectors, drawn as arcs with particles from losing to gaining districts.
//  market:    each sector's market-value change over the period *relative to the whole market*, so the
//             flows balance (underperformers -> outperformers); the market's own move is shown apart.
//  investors / institutions: dollars the 10 famous investors or the 8 institutions added or trimmed per sector
//             between their last two 13F filings (a chip of that group narrows it to one manager).
const C_FLOW_OUT = new THREE.Color('#ef4444'), C_FLOW_IN = new THREE.Color('#22c55e'), C_PLATE = new THREE.Color('#171c27');
const FLOW_MAX = 14;
const FLOW_GROUP = { investors: 'famous', institutions: 'inst' };
const flowGroup = () => FLOW_GROUP[state.flowSrc];
function flowRows(s) {
  const g = flowGroup(), rows = (s.inv?.rows || []).filter(r => groupOf(investor(r.key)) === g);
  const one = state.invKey && groupOf(investor(state.invKey)) === g;
  return one ? rows.filter(r => r.key === state.invKey) : rows;
}
function sectorNets() {
  const nets = new Map(city.sectors.map(sec => [sec.name, 0]));
  if (flowGroup()) {
    const inst = flowGroup() === 'inst', held = new Map();
    for (const p of city.plots) for (const r of flowRows(p.stock)) {
      if (!inst && (r.status === 'held' || r.status === 'unchanged') || inst && corpAction(p.stock)) continue;
      const px = r.shares ? r.value / r.shares : p.stock.price;  // quarter-end price, or today's for sold-out
      nets.set(p.sector, nets.get(p.sector) + (r.shares - (inst ? instBase(r) : r.prev_shares)) * px);
      held.set(p.sector, (held.get(p.sector) || 0) + r.value);
    }
    if (!inst) return { nets, market: null };
    // Index giants buy every sector at once as money flows in, so (like the market source) each sector is taken
    // relative to their overall buying, spread by what they hold: what's left is where they tilted.
    const total = [...nets.values()].reduce((a, v) => a + v, 0), heldSum = [...held.values()].reduce((a, v) => a + v, 0) || 1;
    for (const [name, v] of nets) nets.set(name, v - (held.get(name) || 0) / heldSum * total);
    return { nets, market: total };
  }
  const change = new Map(), caps = new Map();
  let total = 0, capSum = 0;
  for (const p of city.plots) {
    const r = p.stock.ret[state.period];
    if (r == null) continue;
    const dv = p.stock.cap * (1 - 1 / (1 + r / 100));  // value now minus value at the start of the period
    change.set(p.sector, (change.get(p.sector) || 0) + dv); caps.set(p.sector, (caps.get(p.sector) || 0) + p.stock.cap);
    total += dv; capSum += p.stock.cap;
  }
  for (const name of nets.keys()) nets.set(name, (change.get(name) || 0) - (caps.get(name) || 0) / (capSum || 1) * total);
  return { nets, market: total, change };
}
function flowsFrom(nets) {
  const gain = [...nets].filter(([, v]) => v > 0), loss = [...nets].filter(([, v]) => v < 0);
  const sg = gain.reduce((a, [, v]) => a + v, 0), sl = -loss.reduce((a, [, v]) => a + v, 0), total = Math.min(sg, sl);
  if (!total) return [];
  // Each losing sector's outflow is shared among gaining sectors in proportion to their gains.
  const flows = loss.flatMap(([from, lv]) => gain.map(([to, gv]) => ({ from, to, amount: (-lv / sl) * (gv / sg) * total })));
  return flows.filter(f => f.amount > total * 0.02 && (!state.sector || f.from === state.sector || f.to === state.sector))
    .sort((a, b) => b.amount - a.amount).slice(0, FLOW_MAX);
}
function renderFlow() {
  if (!city.group) return;
  if (city.flow) {  // clear the previous arcs
    city.flow.group.traverse(o => { if (o.isCSS2DObject) o.element.remove(); o.geometry?.dispose(); o.material?.dispose(); });
    city.group.remove(city.flow.group); city.flow = null;
  }
  for (const sec of city.sectors) sec.plate.material.color.copy(C_PLATE);
  renderFlowPanel();
  if (!state.flow) return;
  const { nets } = sectorNets(), flows = flowsFrom(nets);
  const group = new THREE.Group(), byName = new Map(city.sectors.map(sec => [sec.name, sec]));
  const maxA = flows[0]?.amount || 1, parts = [];
  flows.forEach((f, k) => {
    const a = byName.get(f.from).center.clone().setY(1), b = byName.get(f.to).center.clone().setY(1);
    const mid = a.clone().lerp(b, 0.5); mid.y = 12 * worldScale + a.distanceTo(b) * 0.35;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b), share = f.amount / maxA;
    group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 48, (0.2 + 0.9 * Math.sqrt(share)) * worldScale, 8, false),
      new THREE.MeshBasicMaterial({ color: '#5eead4', transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false })));
    // Particles: more and faster on bigger flows; each fades from red (source) to green (destination).
    const n = 6 + Math.round(34 * share);
    for (let j = 0; j < n; j++) parts.push({ curve, t: j / n, speed: 0.12 + 0.16 * share });
    if (k < 6) {
      const el = document.createElement('div'); el.className = 'label flowlbl'; el.textContent = fmtCap(f.amount);
      el.title = `${f.from} → ${f.to}`;
      const lbl = new CSS2DObject(el); lbl.position.copy(curve.getPoint(0.5)); group.add(lbl);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(parts.length * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(parts.length * 3), 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 2 * worldScale, vertexColors: true, transparent: true,
    opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
  points.frustumCulled = false;
  group.add(points);
  city.group.add(group);
  const maxNet = Math.max(...[...nets.values()].map(Math.abs), 1);
  city.flow = { group, parts, points, nets, maxNet, last: performance.now() };
}
const tmpV = new THREE.Vector3(), tmpFC = new THREE.Color();
function stepFlow(now) {
  const f = city.flow; if (!f) return;
  const dt = Math.min(0.1, (now - f.last) / 1000); f.last = now;
  const pos = f.points.geometry.attributes.position.array, col = f.points.geometry.attributes.color.array;
  f.parts.forEach((p, i) => {
    p.t = (p.t + p.speed * dt) % 1;
    p.curve.getPoint(p.t, tmpV); pos.set([tmpV.x, tmpV.y, tmpV.z], i * 3);
    tmpFC.copy(C_FLOW_OUT).lerp(C_FLOW_IN, p.t); col.set([tmpFC.r, tmpFC.g, tmpFC.b], i * 3);
  });
  f.points.geometry.attributes.position.needsUpdate = true; f.points.geometry.attributes.color.needsUpdate = true;
  // Districts pulse: green when gaining, red when losing, stronger for bigger moves.
  const wave = 0.5 + 0.5 * Math.sin(now / 380);
  for (const sec of city.sectors) {
    const v = f.nets.get(sec.name) || 0;
    sec.plate.material.color.copy(C_PLATE).lerp(v > 0 ? C_FLOW_IN : C_FLOW_OUT, (0.15 + 0.45 * wave) * Math.abs(v) / f.maxNet);
  }
}
function renderFlowPanel() {
  const el = $('#fpanel');
  el.style.display = state.flow ? 'block' : 'none';
  updateHelp();
  if (!state.flow) return fitSide();
  const g = flowGroup(), inv = !!g, enabled = market?.investors?.enabled;
  const [, , gName] = GROUP_NAME[g || 'famous'], gSize = investorsList().filter(i => groupOf(i) === g).length;
  const loading = inv && enabled && !gSize;
  const { nets, market: mkt } = city.sectors.length ? sectorNets() : { nets: new Map() };
  const rows = [...nets].sort((a, b) => b[1] - a[1]), flows = flowsFrom(nets), netInv = g === 'inst' ? mkt || 0 : rows.reduce((a, [, v]) => a + v, 0);
  const who = state.invKey && groupOf(investor(state.invKey)) === g && investor(state.invKey);
  const winFor = () => { const i = investorsList().find(x => groupOf(x) === 'inst'), st = windowStart(i);
    return i && st ? `${quarter(i.report_date)} vs ${quarter(st)}` : 'last 13F quarter'; };
  const what = inv ? `${who ? esc(who.person) : `${gSize || (g === 'inst' ? 8 : 10)} ${gName}`} · ${g === 'inst'
    ? `${esc(winFor())} (follows the period)` : "last 13F quarter (period buttons don't apply)"}` : `${PERIOD_NAME[state.period]} · vs market`;
  el.classList.toggle('collapsed', state.fpanelHidden);
  el.innerHTML = `<h3 title="Show/hide">⇄ ${inv ? (g === 'inst' ? 'Institution' : 'Investor') : 'Market'} flow · ${what} <span>${state.fpanelHidden ? '▸' : '▾'}</span></h3>`
    + (inv && !enabled ? `<div class="mut" style="padding:4px 12px">13F data is off (start the server with --sec-agent).</div>`
      : loading ? `<div class="mut" style="padding:4px 12px">Still loading the ${gName}' 13F holdings (see the progress bar at the top).</div>` : `<div class="list">`
      + rows.map(([name, v]) => `<div class="frow ${state.sector === name ? 'on' : ''}" data-s="${esc(name)}"><span>${esc(name)}</span>
          <span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : '−'}${fmtCap(Math.abs(v))}</span></div>`).join('')
      + (flows.length ? `<div class="fsub">Top flows</div>` + flows.slice(0, 8).map(f => `<div class="frow" data-s="${esc(f.to)}">
          <span><span class="down">${esc(f.from)}</span> → <span class="up">${esc(f.to)}</span></span><span>${fmtCap(f.amount)}</span></div>`).join('') : '')
      + `</div>`)
    + `<div class="hint">${inv
      ? (g === 'inst'
        ? `Overall the ${who ? esc(who.person) : gName} were net ${netInv >= 0 ? 'buyers' : 'sellers'} of ${fmtCap(Math.abs(netInv))} over the window (1D–3M = last quarter, YTD = since year-end, 1Y = four quarters), at quarter-end prices. Index funds buy every sector at once as money flows in, so each sector is shown relative to that, in proportion to what they hold: + = bought more than its share, − = less. Arcs show that tilt. Pick a chip in 🏛 to see one firm.`
        : `Dollars the ${gName} added (+) or trimmed (−) per sector between their last two 13F filings, at quarter-end prices (net ${netInv >= 0 ? 'buying' : 'selling'} ${fmtCap(Math.abs(netInv))}; arcs show the matched part). Pick a chip in 👤 to see just one.`)
      : `Each sector's change in market value relative to the whole market${mkt != null ? ` (the market itself ${mkt >= 0 ? '+' : '−'}${fmtCap(Math.abs(mkt))})` : ''}. Flows split each laggard's shortfall across the leaders in proportion; they show rotation, not traced trades.`}</div>`;
  el.querySelectorAll('.frow').forEach(r => r.onclick = () => isolate(r.dataset.s));
  $('h3', el).onclick = () => { state.fpanelHidden = !state.fpanelHidden; save(); renderFlowPanel(); };
  fitSide();
}

// ---------- summary + legend ----------
function capWeighted(stocks) {
  let num = 0, den = 0;
  for (const s of stocks) { const r = s.ret[state.period]; if (r != null) { num += r * s.cap; den += s.cap; } }
  return den ? num / den : null;
}
function renderSummary() {
  const stocks = city.plots.map(p => p.stock);
  if (!stocks.length) { $('#summary').innerHTML = ''; return; }
  const r = capWeighted(stocks), up = stocks.filter(s => s.ret[state.period] > 0).length, down = stocks.filter(s => s.ret[state.period] < 0).length;
  $('#summary').innerHTML = `<span title="Market-cap-weighted return of the stocks shown">${esc(indexName())} ${PERIOD_NAME[state.period]}:
      <b class="${r >= 0 ? 'up' : 'down'}">${fmtPct(r)}</b></span> · <span class="up">${up} up</span> · <span class="down">${down} down</span>`
    + (market?.as_of ? ` <span class="mut">· close ${esc(market.as_of)}</span>` : '');
}
function renderLegend() {
  const rows = city.sectors.map(sec => {
    const stocks = city.plots.filter(p => p.sector === sec.name).map(p => p.stock), r = capWeighted(stocks);
    return { ...sec, r, n: stocks.length, stars: stocks.filter(isHigh).length, held: stocks.filter(isHeld).length };
  }).sort((a, b) => b.value - a.value);
  const star = s => !state.value ? '' : s.name in NOT_VALUED ? ' <span class="mut" title="Not valued">·</span>'
    : s.stars ? ` <span style="color:#f5b301" title="Highly undervalued companies in this sector">★${s.stars}</span>` : '';
  const sat = SAT[state.period];
  $('#legend').classList.toggle('collapsed', !!state.legendHidden);
  $('#legend').innerHTML = `<h3 title="Show/hide">Sectors · ${PERIOD_NAME[state.period]} (cap-weighted) <span>${state.legendHidden ? '▸' : '▾'}</span></h3>`
    + rows.map(s => `<div class="row ${state.sector === s.name ? 'on' : state.sector ? 'dim' : ''}" data-s="${esc(s.name)}">
        <span>${esc(s.name)} <span class="mut">${s.n}</span>${star(s)}${state.inv && s.held ? ` <span class="combo" title="${isInst() ? 'Stocks among the biggest institutional ownership changes' : 'Stocks the tracked investors hold or just sold'}">${groupIcon()}${s.held}</span>` : ''}</span><span class="${s.r >= 0 ? 'up' : 'down'}">${fmtPct(s.r)}</span></div>`).join('')
    + `<div class="scale"><span>−${sat}%</span><div class="grad"></div><span>+${sat}%</span></div>
       <div class="hint">footprint = ${SIZE_DESC[state.size]} · height = size of the move · click a sector to isolate it</div>`
    + (state.value ? `<div class="hint gold">★ gold = highly undervalued: price below the pessimistic DCF, ≥30% upside, passes quality checks (positive FCF, steady revenue growth, stable margin). Financials and Real Estate aren't valued. Not investment advice.</div>` : '');
  document.querySelectorAll('#legend .row').forEach(el => el.onclick = () => isolate(el.dataset.s));
  $('#legend h3').onclick = () => { state.legendHidden = !state.legendHidden; save(); renderLegend(); };
  frame();
}
function isolate(name) {
  state.sector = state.sector === name ? null : name;
  updateLabels();
  for (const s of city.sectors) s.label.element.style.opacity = state.sector && s.name !== state.sector ? '0.3' : '1';
  repaint(); renderLegend(); renderValuePanel(); renderInvPanel(); renderFlow();
  const sec = city.sectors.find(s => s.name === state.sector);
  if (sec) flyTo(sec.center, sec.size * 1.3 + 20); else flyHome();
}

// ---------- controls ----------
function markButtons() {
  document.querySelectorAll('#periods button').forEach(b => b.classList.toggle('on', b.dataset.p === state.period));
  document.querySelectorAll('#heightMode button').forEach(b => b.classList.toggle('on', b.dataset.h === state.height));
  document.querySelectorAll('#indexSeg button').forEach(b => b.classList.toggle('on',
    b.dataset.i === 'all' ? state.idxs.length === ALL_IDX.length : state.idxs.includes(b.dataset.i)));
  document.querySelectorAll('#sizeSeg button').forEach(b => b.classList.toggle('on', b.dataset.s === state.size));
  $('#valBtn').classList.toggle('on', state.value);
  $('#invBtn').classList.toggle('on', state.inv && !isInst());
  $('#instBtn').classList.toggle('on', state.inv && isInst());
  $('#flowBtn').classList.toggle('on', state.flow);
  document.querySelectorAll('#flowSeg button[data-src]').forEach(b => {
    b.classList.toggle('sel', b.dataset.src === state.flowSrc); b.classList.toggle('on', state.flow && b.dataset.src === state.flowSrc); });
}
document.querySelectorAll('#periods button').forEach(b => b.onclick = () => { state.period = b.dataset.p; save(); markButtons(); applyEncoding(); });
document.querySelectorAll('#indexSeg button').forEach(b => b.onclick = () => {
  const i = b.dataset.i, on = state.idxs.includes(i);
  if (i === 'all') state.idxs = ALL_IDX.slice();
  else if (!on) state.idxs = ALL_IDX.filter(x => x === i || state.idxs.includes(x));
  else if (state.idxs.length > 1) state.idxs = state.idxs.filter(x => x !== i);  // the last one stays on
  else return;
  save(); markButtons(); rebuild();
});
document.querySelectorAll('#sizeSeg button').forEach(b => b.onclick = () => { state.size = b.dataset.s; save(); markButtons(); rebuild(); });
document.querySelectorAll('#heightMode button').forEach(b => b.onclick = () => {
  state.height = b.dataset.h; save(); markButtons(); applyEncoding();
  if (!state.selected) flyHome();  // Flat flies to the map view, 3D back to the angled overview
});
markButtons();
$('#valBtn').onclick = () => { state.value = !state.value; save(); markButtons(); refreshHighlights(); };
// 👤 and 🏛 each switch the investors view to their group; pressing the one that's on turns it off.
function toggleGroup(g) {
  if (state.inv && state.invGroup === g) state.inv = false; else { state.inv = true; state.invGroup = g; }
  state.invKey = null; save(); markButtons(); refreshHighlights();
  if (state.selected) renderSide(state.selected);  // its investor table and chart lanes follow the group
}
$('#invBtn').onclick = () => toggleGroup('famous');
$('#instBtn').onclick = () => toggleGroup('inst');
function refreshHighlights() { repaint(); updateLabels(); renderValuePanel(); renderInvPanel(); renderLegend(); renderChips(); renderFlow(); }
$('#flowBtn').onclick = () => { state.flow = !state.flow; save(); markButtons(); repaint(); renderFlow(); };
// Picking a source turns the flow on with it.
document.querySelectorAll('#flowSeg button[data-src]').forEach(b => b.onclick = () => {
  state.flowSrc = b.dataset.src; state.flow = true; save(); markButtons(); repaint(); renderFlow(); });
$('#search').addEventListener('keydown', e => e.stopPropagation());  // arrow keys edit the text, not pan
$('#search').addEventListener('change', e => {
  const p = city.bySym.get(e.target.value.trim().toUpperCase().replace('.', '-'));
  if (p) { if (state.sector && p.sector !== state.sector) isolate(state.sector); focusPlot(p); e.target.value = ''; e.target.blur(); }
});
addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (state.selected) closeSide(); else if (state.sector) isolate(state.sector); else flyHome(); }
});
addEventListener('resize', () => {
  frame(); fitSide();
  renderer.setSize(innerWidth, innerHeight); labels.setSize(innerWidth, innerHeight);
});

// ---------- data ----------
let market = null, builtKey = '';
// Rebuild the city for the chosen index and size mode, keeping the selection and sector when they still exist.
function rebuild() {
  if (!market?.stocks?.length) return;
  const stocks = market.stocks.filter(s => state.idxs.includes(s.idx));
  const sel = state.selected?.stock.sym;
  buildCity(stocks);
  builtKey = `${market.stocks.length}|${state.idxs}|${state.size}`;
  $('#symbols').innerHTML = stocks.map(s => `<option value="${esc(s.sym)}">${esc(s.name)}</option>`).join('');
  if (state.sector && !city.sectors.some(s => s.name === state.sector)) state.sector = null;
  if (sel && city.bySym.get(sel)) select(city.bySym.get(sel)); else if (sel) select(null);
  renderChips();
}
async function load() {
  let next = 5 * 60 * 1000;
  try {
    const r = await fetch('/api/market'); market = await r.json();
    // Prices first; the server keeps running afterwards for SEC filings and 13F, shown separately below.
    const pr = market.progress, loading = !market.stocks.length || (pr.running && pr.done < pr.total);
    $('#progress').innerHTML = loading && pr.total
      ? `Loading prices ${pr.done}/${pr.total}<span class="bar"><i style="width:${(100 * pr.done / pr.total).toFixed(0)}%"></i></span>`
      : loading ? 'Loading S&amp;P 1500 list…'
      : pr.fund_total && pr.fund_done < pr.fund_total
      ? `Loading SEC filings ${pr.fund_done}/${pr.fund_total}<span class="bar"><i style="width:${(100 * pr.fund_done / pr.fund_total).toFixed(0)}%"></i></span>`
      : pr.inv_total && pr.inv_done < pr.inv_total
      ? `Loading 13F filings ${pr.inv_done}/${pr.inv_total}<span class="bar"><i style="width:${(100 * pr.inv_done / pr.inv_total).toFixed(0)}%"></i></span>`
      : pr.running && pr.figi_total && pr.figi_done < pr.figi_total
      ? `<span title="13F lists CUSIPs; each is matched to a ticker once (OpenFIGI), biggest positions first. Institutions appear after the first ones.">Looking up 13F tickers ${pr.figi_done}/${pr.figi_total}</span><span class="bar"><i style="width:${(100 * pr.figi_done / pr.figi_total).toFixed(0)}%"></i></span>`
      : market.errors ? `<span title="Tickers whose prices could not be fetched">${market.errors} tickers missing</span>` : '';
    if (market.stocks.length && `${market.stocks.length}|${state.idxs}|${state.size}` !== builtKey) {
      const first = !builtKey;
      rebuild();
      const focus = params.get('focus');  // ?focus=NVDA opens that stock
      if (first && focus && city.bySym.get(focus.toUpperCase())) focusPlot(city.bySym.get(focus.toUpperCase()));
    } else if (market.stocks.length) {
      // Same companies, new prices: update each building in place and re-animate.
      for (const s of market.stocks) { const p = city.bySym.get(s.sym); if (p) p.stock = s; }
      applyEncoding();
    }
    renderChips();
    if (loading || pr.running) next = loading ? 3000 : 8000;
  } catch { next = 10000; }
  setTimeout(load, next);
}
load();

renderer.setAnimationLoop(now => {
  stepFlight(now); stepAnim(now); stepFlow(now);
  if (city.beacons?.count) city.beacons.material.opacity = 0.22 + 0.12 * Math.sin(now / 450);
  if (city.ibeacons?.count) city.ibeacons.material.opacity = 0.24 + 0.12 * Math.sin(now / 450 + 1.5);
  controls.update();
  if (pivot.visible) { pivot.position.copy(controls.target).setY(0.35); pivot.scale.setScalar(camera.position.distanceTo(controls.target) * 0.012); }
  if (pointer && !flight) setHover(pick(pointer));
  renderer.render(scene, camera); labels.render(scene, camera);
});
