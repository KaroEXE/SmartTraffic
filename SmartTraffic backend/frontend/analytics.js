import { formatImprovement } from './metrics.js';

/**
 * Analytics view: fixed-time, per-intersection adaptive and network-aware
 * control on identical SIMULATED network demand
 * (POST /api/simulation/benchmark, backend/services/simulationBenchmark.js).
 *
 * Every number shown here comes from the measured runs in the backend's
 * result; improvements are the backend's, computed as
 *   lower is better   (baseline - optimized) / baseline x 100
 *   throughput        (optimized - baseline) / baseline x 100
 * and "n/a" when the baseline is 0 or the value was not measured. Nothing is
 * shown before a run exists, and every result is labelled simulated.
 */

const API = '/api/simulation/benchmark';
const $ = (id) => document.getElementById(id);
const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const fmt = (n, digits = 1) => (n === null || n === undefined ? '--' : Number(n).toFixed(digits));

const SERIES = [
  { key: 'fixed', label: 'Fixed-time', cls: 'base' },
  { key: 'local', label: 'Local adaptive', cls: 'opt' },
  { key: 'network', label: 'Network-aware', cls: 'net' },
];

// metric key, label, unit, decimals, higher is better, shown when
const CARDS = [
  ['averageWaitSeconds', 'Average delay per vehicle', 's queued, all junctions', 1, false],
  ['totalWaitVehicleHours', 'Total waiting time', 'vehicle-hours', 2, false],
  ['averageQueue', 'Average queue', 'vehicles per approach', 2, false],
  ['maxQueue', 'Maximum queue', 'vehicles', 0, false],
  ['throughputVehicles', 'Throughput', 'vehicles that left the network', 0, true],
  ['spillbackSeconds', 'Queue spillback', 'approach-seconds of blocked green', 0, false],
  ['spillbackIncidents', 'Spillback incidents', 'times a road ahead filled up', 0, false],
  ['clearSeconds', 'Congestion clearing', 's after the surge to pre-surge queues', 0, false, (r) => r.parameters.profile === 'surge'],
  ['emergencyStops', 'Ambulance stops', 'stops on its route', 0, false, (r) => r.parameters.ambulance],
  ['emergencyDelaySeconds', 'Ambulance delay', 's vs free-flow travel', 1, false, (r) => r.parameters.ambulance],
];

const state = { loaded: false, busy: false, result: null };

// ---------------------------------------------------------------- render

function changeText(pct, higherIsBetter) {
  if (pct === null || pct === undefined) return { text: 'n/a', tone: 'na', word: '' };
  if (pct === 0) return { text: '0.0%', tone: 'same', word: 'same' };
  const better = pct > 0;
  return {
    text: formatImprovement(pct),
    tone: better ? 'better' : 'worse',
    word: better ? (higherIsBetter ? 'more' : 'lower') : (higherIsBetter ? 'fewer' : 'higher'),
  };
}

function renderCards(r) {
  const minutes = Math.round(r.parameters.measuredSeconds / 60);
  $('an-cards').innerHTML = CARDS.filter((c) => !c[5] || c[5](r)).map(([key, label, unit, digits, higher]) => {
    const values = SERIES.map((s) => `<div><dt><i class="sw ${s.cls}"></i>${s.label}</dt><dd class="mono">${fmt(r.policies[s.key].network[key], digits)}</dd></div>`).join('');
    const vsLocal = changeText(r.improvementPercent.networkVsLocal[key], higher);
    const vsFixed = changeText(r.improvementPercent.networkVsFixed[key], higher);
    const extra = key === 'clearSeconds'
      ? SERIES.filter((s) => r.policies[s.key].network.clearedWithinRun === false).map((s) => `${s.label}: not cleared within the run`).join('; ')
      : '';
    return `<div class="an-card">
      <div class="an-card-label">${esc(label)}</div>
      <div class="an-card-unit">${esc(unit)} &middot; ${minutes} min measured</div>
      <dl class="an-card-values">${values}</dl>
      <div class="an-change ${vsLocal.tone}">Network vs local: <span class="mono">${esc(vsLocal.text)}</span> ${esc(vsLocal.word)}</div>
      <div class="an-change ${vsFixed.tone}">Network vs fixed: <span class="mono">${esc(vsFixed.text)}</span> ${esc(vsFixed.word)}</div>
      ${extra ? `<div class="an-card-unit">${esc(extra)}</div>` : ''}
    </div>`;
  }).join('');

  const i = r.improvementPercent.networkVsLocal;
  const delay = changeText(i.totalWaitVehicleHours, false);
  const spill = changeText(i.spillbackSeconds, false);
  const em = r.parameters.ambulance ? r.policies : null;
  $('an-hero').innerHTML = `
    <div class="an-hero-cell"><div class="an-hero-value mono ${delay.tone}">${esc(delay.text)}</div><div class="an-hero-label">Total delay</div><div class="an-hero-sub">network-aware vs local adaptive</div></div>
    <div class="an-hero-cell"><div class="an-hero-value mono ${spill.tone}">${esc(spill.text)}</div><div class="an-hero-label">Queue spillback</div><div class="an-hero-sub">network-aware vs local adaptive</div></div>
    ${em ? `<div class="an-hero-cell"><div class="an-hero-value mono">${SERIES.map((s) => fmt(em[s.key].emergency && em[s.key].emergency.stops, 0)).join(' / ')}</div><div class="an-hero-label">Ambulance stops</div><div class="an-hero-sub">fixed / local / network on ${esc((r.parameters.emergencyRoute || []).join(' > '))}</div></div>` : ''}
    <div class="an-hero-note">${esc(r.parameters.scenarioLabel)} scenario, ${esc(r.parameters.profile)} demand, ${Math.round(r.parameters.measuredSeconds / 60)} min measured. Simulated - positive = better than the comparison policy, negative = worse.</div>`;
}

function renderParams(r) {
  const p = r.parameters;
  $('an-params').textContent = `${p.scenarioLabel} · ${p.profile} demand · ${p.intersectionIds.length} intersections, ${p.topology.links} directed roads · `
    + `${Math.round(p.durationSeconds / 60)} min run, first ${p.warmupSeconds} s warm-up excluded · `
    + `${p.vehiclesEntered} vehicles entered · seed ${p.seed} · ${new Date(r.generatedAt).toLocaleString()}`;
}

function renderTable(r) {
  const cols = [
    ['averageQueue', 'Avg queue (veh)', 2],
    ['maxQueue', 'Max queue (veh)', 0],
    ['spillbackSeconds', 'Spillback (approach-s)', 0],
  ];
  const head = `<thead><tr><th rowspan="2">Intersection</th>${cols.map(([, l]) => `<th colspan="3">${esc(l)}</th>`).join('')}</tr>
    <tr>${cols.map(() => SERIES.map((s) => `<th>${esc(s.label)}</th>`).join('')).join('')}</tr></thead>`;
  const rows = r.perIntersection.map((ix) => `<tr><th scope="row">${esc(ix.name)}</th>${cols.map(([k, , d]) => SERIES.map((s) => `<td class="mono">${fmt(ix[s.key][k], d)}</td>`).join('')).join('')}</tr>`).join('');
  $('an-table').innerHTML = head + `<tbody>${rows}</tbody>`;
}

function renderMethod(r) {
  const w = r.parameters.weights || {};
  const t = r.parameters.timing;
  const n = r.parameters.network || {};
  const items = [
    ['Fixed-time', r.method.fixed],
    ['Local adaptive', `${r.method.local} Priority score per approach = ${w.vehicles} x vehicles + ${w.waiting} x average wait (s) + ${w.queueLength} x queue; `
      + `${t.MIN_GREEN_TIME}-${t.MAX_GREEN_TIME} s green; no approach with demand waits more than ${t.MAX_RED_TIME} s.`],
    ['Network-aware', `${r.method.network} Network score = local score x capacity factor - ${n.DOWNSTREAM_WEIGHT} x queue at the road's far end + `
      + `${n.UPSTREAM_WEIGHT} x vehicles arriving from upstream; the capacity factor falls from 1 to 0 as the road ahead fills from ${Math.round((n.SPILLBACK_START || 0) * 100)}% to ${Math.round((n.SPILLBACK_BLOCK || 0) * 100)}%. `
      + `Emergency corridor: the next ${n.CORRIDOR_LENGTH} intersections, preparing within ${n.CORRIDOR_PREPARE_SECONDS} s, holding within ${n.CORRIDOR_HOLD_SECONDS} s.`],
    ['Demand and roads', r.method.demand],
    ['Average delay', 'Total time vehicles spent queued (all junctions) divided by the vehicles that entered the network in the measured window.'],
    ['Improvement', '(comparison - network) / comparison x 100 for delay, queues, spillback, clearing time and ambulance stops/delay; (network - comparison) / comparison x 100 for throughput. n/a when the comparison value is 0 or not measured.'],
    ['Not modelled', r.method.notModelled],
  ];
  $('an-method').innerHTML = items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}

// ----------------------------------------------------------------- chart

/**
 * Line chart (one y axis) with legend, direct end labels and a crosshair
 * tooltip, as inline SVG.
 */
function lineChart(container, r, field, unit) {
  const width = Math.max(280, container.clientWidth || 560);
  const height = 220;
  const m = { top: 14, right: 104, bottom: 28, left: 46 };
  const pw = width - m.left - m.right;
  const ph = height - m.top - m.bottom;
  const data = SERIES.map((s) => ({ ...s, points: r.policies[s.key].series.map((p) => ({ x: p.t, y: p[field] })) }));
  const xMax = Math.max(1, ...data[0].points.map((p) => p.x));
  const rawMax = Math.max(1, ...data.flatMap((s) => s.points.map((p) => p.y)));
  const step = 10 ** Math.floor(Math.log10(rawMax));
  const yMax = Math.ceil(rawMax / step) * step;
  const sx = (x) => m.left + (x / xMax) * pw;
  const sy = (y) => m.top + ph - (y / yMax) * ph;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const xTicks = Array.from({ length: 5 }, (_, i) => (i / 4) * xMax);
  const grid = yTicks.map((v) => `<line class="an-grid" x1="${m.left}" x2="${m.left + pw}" y1="${sy(v)}" y2="${sy(v)}"/>
    <text class="an-axis" x="${m.left - 6}" y="${sy(v) + 3}" text-anchor="end">${Number.isInteger(v) ? v : v.toFixed(1)}</text>`).join('');
  const xAxis = xTicks.map((v) => `<text class="an-axis" x="${sx(v)}" y="${height - 8}" text-anchor="middle">${mmss(v)}</text>`).join('');
  const lines = data.map((s) => `<path class="an-line ${s.cls}" d="${s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('')}"/>`).join('');
  // Direct labels at the line ends, spread apart when they would collide (with leader lines).
  const ends = data.map((s) => ({ s, y: sy(s.points[s.points.length - 1].y) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i += 1) ends[i].labelY = Math.max(ends[i].y, (ends[i - 1].labelY ?? ends[i - 1].y) + 12);
  const labels = ends.map((e) => `<line class="an-leader" x1="${m.left + pw + 2}" x2="${m.left + pw + 8}" y1="${e.y}" y2="${e.labelY ?? e.y}"/>
    <text class="an-endlabel" x="${m.left + pw + 10}" y="${(e.labelY ?? e.y) + 3}">${e.s.label}</text>`).join('');

  container.innerHTML = `
    <div class="an-legend">${SERIES.map((s) => `<span><i class="sw ${s.cls}"></i>${s.label}</span>`).join('')}<span class="an-legend-unit">x: time measured (m:ss)</span></div>
    <svg class="an-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(container.closest('figure').querySelector('figcaption').textContent)}">
      ${grid}${xAxis}${lines}${labels}
      <line class="an-cross" y1="${m.top}" y2="${m.top + ph}" visibility="hidden"/>
      ${data.map((s) => `<circle class="an-dot ${s.cls}" r="4" visibility="hidden"/>`).join('')}
      <rect class="an-hit" x="${m.left}" y="${m.top}" width="${pw}" height="${ph}"/>
    </svg>
    <div class="an-tip" hidden></div>
    <details class="an-data"><summary>Data table</summary>
      <table class="an-table"><thead><tr><th>Time</th>${SERIES.map((s) => `<th>${s.label} (${esc(unit)})</th>`).join('')}</tr></thead>
      <tbody>${data[0].points.map((p, i) => `<tr><td class="mono">${mmss(p.x)}</td>${data.map((s) => `<td class="mono">${s.points[i].y}</td>`).join('')}</tr>`).join('')}</tbody></table>
    </details>`;

  const svg = container.querySelector('svg');
  const cross = svg.querySelector('.an-cross');
  const dots = [...svg.querySelectorAll('.an-dot')];
  const tip = container.querySelector('.an-tip');
  const hit = svg.querySelector('.an-hit');
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    tip.hidden = true;
  };
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * width;
    const xv = ((x - m.left) / pw) * xMax;
    const pts = data[0].points;
    let i = 0;
    for (let k = 1; k < pts.length; k += 1) if (Math.abs(pts[k].x - xv) < Math.abs(pts[i].x - xv)) i = k;
    const px = sx(pts[i].x);
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    cross.setAttribute('visibility', 'visible');
    data.forEach((s, k) => {
      dots[k].setAttribute('cx', px);
      dots[k].setAttribute('cy', sy(s.points[i].y));
      dots[k].setAttribute('visibility', 'visible');
    });
    tip.innerHTML = `<div class="mono">${mmss(pts[i].x)}</div>${data.map((s) => `<div><i class="sw ${s.cls}"></i>${s.label} <b class="mono">${s.points[i].y}</b> ${esc(unit)}</div>`).join('')}`;
    tip.hidden = false;
    const left = (px / width) * box.width;
    tip.style.left = `${Math.min(left + 12, box.width - 190)}px`;
  });
  hit.addEventListener('pointerleave', hide);
}

function renderCharts(r) {
  lineChart($('an-chart-queue'), r, 'queued', 'veh');
  lineChart($('an-chart-wait'), r, 'averageQueuedWaitSeconds', 's');
  lineChart($('an-chart-spill'), r, 'spillbackSecondsCumulative', 'approach-s');
}

function render(r) {
  if (!r || !r.policies) return; // a result from an older backend version
  state.result = r;
  $('an-empty').hidden = true;
  $('an-results').hidden = false;
  renderParams(r);
  renderCards(r);
  renderTable(r);
  renderMethod(r);
  renderCharts(r);
}

// ------------------------------------------------------------------ data

function setStatus(text, tone = '') {
  const el = $('an-status');
  el.textContent = text;
  el.className = `an-status ${tone}`;
}

async function loadScenarios() {
  try {
    const res = await fetch('/api/simulation/status', { cache: 'no-store' });
    const status = await res.json();
    $('an-scenario').innerHTML = status.scenarios
      // Emergency / pedestrian scenarios are not demand profiles (the ambulance run is a separate option).
      .filter((s) => !/ambulance|police|emergency|pedestrian/.test(s.id))
      .map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('');
  } catch {
    $('an-scenario').innerHTML = '<option value="normal">Normal traffic</option>';
  }
}

async function loadLatest() {
  try {
    const res = await fetch(API, { cache: 'no-store' });
    const { benchmark } = await res.json();
    if (res.ok && benchmark) render(benchmark);
  } catch { /* no result yet / offline: the empty state stays */ }
}

async function run(event) {
  event.preventDefault();
  if (state.busy) return;
  state.busy = true;
  $('an-run').disabled = true;
  setStatus('Running three policies...');
  const body = {
    scenario: $('an-scenario').value,
    durationSeconds: Number($('an-duration').value),
    seed: Math.max(0, Math.floor(Number($('an-seed').value) || 0)),
    profile: $('an-profile').value,
    ambulance: $('an-ambulance').checked,
  };
  try {
    const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error((data.details || [data.error]).join('; '));
    render(data.benchmark);
    setStatus(`Done in ${data.benchmark.runtimeMs} ms`, 'ok');
  } catch (err) {
    setStatus(`Benchmark failed: ${err.message}`, 'bad');
  } finally {
    state.busy = false;
    $('an-run').disabled = false;
  }
}

export function initAnalytics() {
  if (!$('analytics')) return;
  $('an-form').addEventListener('submit', run);
  document.addEventListener('viewchange', (e) => {
    if (e.detail.view !== 'analytics') return;
    if (!state.loaded) {
      state.loaded = true;
      loadScenarios();
      loadLatest();
    } else if (state.result) renderCharts(state.result); // width may have changed while hidden
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.result && !$('analytics').hidden) renderCharts(state.result); }, 150);
  });
}
