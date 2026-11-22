import { corridorIndex, siteState, summarize } from './three/networkView.js';

/**
 * AI network decision panel (3D viewport overlay). It shows exactly what
 * the backend's network coordinator reported for its latest cycle
 * (`networkDecision`): which intersections were evaluated, their measured
 * queues, the action chosen, the coordinator's own reason, and whether the
 * signal controller applied it. Nothing is computed or reworded here beyond
 * formatting.
 */

const $ = (id) => document.getElementById(id);
const esc = (text) => String(text === null || text === undefined ? '' : text)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const up = (d) => (d ? d.toUpperCase() : '-');
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false });

const STATE_LABEL = {
  normal: 'Normal',
  congested: 'Congestion',
  action: 'Action selected',
  emergency: 'Emergency corridor',
  stale: 'Data stale',
  nodata: 'No data',
};
const SOURCE_LABEL = {
  simulation: 'simulated vehicle (simulated GPS)',
  camera: 'camera detection - route assumed straight ahead, ETA estimated',
  gps: 'GPS feed',
};

let onSelect = () => {};
let names = new Map();

export function initDecisionPanel({ select }) {
  onSelect = select;
  const panel = $('vp-decision');
  if (!panel) return;
  const toggle = $('vd-toggle');
  // The viewer's last choice wins; otherwise open only when the map has room for it.
  const KEY = 'smarttraffic.decisionPanel.open';
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* storage unavailable */ }
  const viewport = $('viewport');
  const roomy = (viewport ? viewport.clientWidth : window.innerWidth) >= 1100;
  const setOpen = (open, remember = false) => {
    panel.classList.toggle('collapsed', !open);
    toggle.setAttribute('aria-expanded', String(open));
    if (remember) {
      try { localStorage.setItem(KEY, open ? '1' : '0'); } catch { /* storage unavailable */ }
    }
  };
  setOpen(saved === null ? roomy : saved === '1');
  toggle.addEventListener('click', () => setOpen(panel.classList.contains('collapsed'), true));
  $('vd-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-id]');
    if (item) onSelect(item.dataset.id);
  });
}

/** Intersection names of the active mode (ids in decisions are shown by name). */
export function setNames(intersections) {
  names = new Map((intersections || []).map((i) => [i.id, i.name || i.id]));
}

const name = (id) => names.get(id) || id;

export function renderDecision(decision, { mode, selectedId, connected = true } = {}) {
  const panel = $('vp-decision');
  if (!panel) return;
  const meta = $('vd-meta');
  const summary = $('vd-summary');
  const list = $('vd-list');
  const corridorsEl = $('vd-corridors');
  panel.dataset.mode = mode;

  if (!decision) {
    meta.textContent = connected ? 'waiting for the first cycle' : 'offline';
    summary.textContent = 'The network coordinator has not reported a decision yet.';
    list.innerHTML = '';
    corridorsEl.innerHTML = '';
    return;
  }
  const s = summarize(decision);
  meta.textContent = `cycle ${decision.cycle} · ${clock(decision.at)}${decision.dataMode === 'simulation' ? ' · SIMULATED' : ''}${connected ? '' : ' · OFFLINE'}`;
  summary.innerHTML = decision.enabled
    ? `<b>${s.evaluated}</b> of ${s.total} evaluated together · network changed <b>${s.networkChanged}</b> choice${s.networkChanged === 1 ? '' : 's'} · <b>${s.congestedLinks}</b> congested road${s.congestedLinks === 1 ? '' : 's'}${s.corridors ? ` · <b class="vd-em">${s.corridors}</b> emergency corridor${s.corridors === 1 ? '' : 's'}` : ''}`
    : 'Network optimisation is <b>off</b> - every intersection decides from its own data.';

  const corridors = corridorIndex(decision);
  list.innerHTML = decision.intersections.map((r) => {
    const state = siteState(r, corridors);
    const m = r.measurements;
    const data = m ? `${m.vehicles} veh · ${m.queued} queued` : 'no measurements';
    const considered = r.considered && r.considered.length > 1
      ? ` · used data from ${r.considered.filter((id) => id !== r.intersectionId).map(name).join(', ')}`
      : '';
    const applied = r.applied && r.applied !== 'n/a'
      ? `<span class="vd-applied ${r.applied === 'applied' ? 'ok' : r.applied.startsWith('overridden') ? 'ovr' : 'pend'}" title="Did the signal controller follow it?">${esc(r.applied)}</span>`
      : '';
    return `<li class="vd-item st-${state}${r.intersectionId === selectedId ? ' selected' : ''}" data-id="${esc(r.intersectionId)}" tabindex="0" title="${esc(STATE_LABEL[state])} - select ${esc(name(r.intersectionId))}">
      <div class="vd-row"><span class="vd-dot"></span><b class="vd-name">${esc(name(r.intersectionId))}</b><span class="vd-state">${esc(STATE_LABEL[state])}</span>${applied}</div>
      <div class="vd-action">${esc(r.action)}</div>
      <div class="vd-reason">${esc(r.reason)}</div>
      <div class="vd-data mono">${esc(data)}${esc(considered)}</div>
    </li>`;
  }).join('');

  corridorsEl.innerHTML = (decision.corridors || []).map((c) => `
    <div class="vd-corridor">
      <div class="vd-c-head"><b>${esc(up(c.type))}</b> <span class="mono">${esc(c.vehicleId)}</span>${c.rerouted ? ' <span class="vd-applied pend">rerouted</span>' : ''}</div>
      <div class="vd-c-src">${esc(SOURCE_LABEL[c.source] || c.source)} · heading ${esc(c.heading || '-')}</div>
      <div class="vd-c-route">${(c.route || []).map((id) => `<span class="${c.passed.includes(id) ? 'passed' : ''}">${esc(name(id))}</span>`).join(' &rarr; ')}</div>
      <ol class="vd-c-entries">${c.entries.map((e) => `<li class="cs-${esc(e.status)}">
        <b>${esc(name(e.intersectionId))}</b> ${esc(up(e.approach))} approach · ETA ${e.etaSeconds === null ? '--' : `${Math.round(e.etaSeconds)} s`}${e.etaEstimated ? ' (est.)' : ''}
        · <span class="vd-stage st-${esc(e.stage)}">${esc(up(e.stage))}</span>${e.stage === 'planned' ? ' (no signal change yet)' : ''}
        ${e.reason ? `<div class="vd-reason">${esc(e.reason)}</div>` : ''}</li>`).join('')}</ol>
    </div>`).join('');
}
