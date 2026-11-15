import { trafficSummary, positionLabel } from './metrics.js';
import { createBaseMap, Marker, Popup } from './mapCore.js';
import { loadMapConfig } from './mapConfig.js';
import { corridorIndex, siteState } from './three/networkView.js';

/**
 * Geographic layer of the operations dashboard: OpenFreeMap vector tiles drawn by
 * MapLibre GL JS, with one traffic-light marker per intersection - the same
 * intersections, by the same ids, as the 3D street network. Clicking a marker selects
 * that intersection. A marker shows the lit aspect, the direction currently served and
 * (ring) the estimated congestion; hovering it lists the four signals, counts, data state
 * and whether the position is surveyed.
 *
 * The map is created once. The markers wait for it: the map style is fetched from the
 * backend's /api/client-config answer and OpenFreeMap, and a marker added earlier would
 * have no map to sit on.
 */

const DIRS = ['north', 'south', 'east', 'west'];
const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function markerHtml(info, selected) {
  const aspect = info.greenDirection ? (info.signals ? info.signals[info.greenDirection] : 'GREEN') : 'RED';
  const lit = { RED: 'r', YELLOW: 'y', GREEN: 'g' }[aspect] || 'r';
  const dirLetter = info.greenDirection ? info.greenDirection[0].toUpperCase() : '-';
  const classes = ['tl-marker', `cg-${info.summary ? info.summary.level : 'nodata'}`];
  // Same highlight state as the 3D ring (network decision of the active mode).
  if (info.decisionState && info.decisionState !== 'normal') classes.push(`nd-${info.decisionState}`);
  if (selected) classes.push('selected');
  if (info.dataMode === 'simulation') classes.push('sim');
  if (info.mode === 'EMERGENCY') classes.push('emergency');
  else if (info.mode === 'FALLBACK') classes.push('fallback');
  return `<div class="${classes.join(' ')}">
    <span class="tl-housing"><i class="r ${lit === 'r' ? 'on' : ''}"></i><i class="y ${lit === 'y' ? 'on' : ''}"></i><i class="g ${lit === 'g' ? 'on' : ''}"></i></span>
    <span class="tl-dir">${dirLetter}</span>
  </div>`;
}

function tooltipHtml(info) {
  const s = info.summary || trafficSummary(null);
  const signals = info.signals
    ? DIRS.map((d) => `<i class="tt-sig s-${esc(info.signals[d] || 'RED')}" title="${d}">${d[0].toUpperCase()}</i>`).join('')
    : '<span class="tt-muted">no signal state yet</span>';
  const numbers = s.vehicles === null
    ? `<div class="tt-row tt-muted">${esc(s.label)}</div>`
    : `<div class="tt-row"><b>${s.vehicles}</b> veh &middot; <b>${s.queued}</b> queued &middot; max wait <b>${s.maxWait}</b> s</div>
       <div class="tt-row">Congestion: <span class="tt-cg cg-${s.level}">${esc(s.label)}</span> <span class="tt-muted">(est. from longest queue: ${s.maxQueue})</span></div>`;
  const source = s.source === 'simulated' ? '<div class="tt-row tt-sim">SIMULATED DATA</div>' : '';
  const where = positionLabel(info);
  const decision = info.decisionAction
    ? `<div class="tt-row tt-decision"><b>AI:</b> ${esc(info.decisionAction)}</div>`
    : '';
  return `<div class="tt">
    <div class="tt-name">${esc(info.name)} <span class="tt-id">${esc(info.id)}</span></div>
    <div class="tt-row tt-signals">${signals}${info.mode ? ` <span class="tt-muted">${esc(info.mode)}</span>` : ''}</div>
    ${numbers}${decision}${source}
    ${where ? `<div class="tt-row tt-muted">${esc(where)}</div>` : ''}
  </div>`;
}

export class NetworkMap {
  constructor(element, intersections, onSelect) {
    this.element = element;
    this.onSelect = onSelect;
    this.connected = true;
    this.markers = new Map(); // id -> maplibre Marker
    this.info = new Map();
    this.keys = new Map();
    this.selectedId = null;
    this.map = null;
    this.hovered = null;
    this.tip = new Popup({
      closeButton: false, closeOnClick: false, className: 'tl-tooltip', offset: 16, maxWidth: '280px',
    });
    this.intersections = intersections;

    loadMapConfig().then((config) => {
      const base = createBaseMap(element, config, { navigation: true });
      if (!base) return;
      this.map = base.map;
      this.setIntersections(this.intersections);
    });
  }

  /**
   * Replaces the markers with one data mode's intersections (live and
   * simulation each have their own list) and fits the view to them.
   */
  setIntersections(intersections) {
    this.intersections = intersections;
    for (const marker of this.markers.values()) marker.remove();
    this.tip.remove();
    this.hovered = null;
    this.markers.clear();
    this.info.clear();
    this.keys.clear();
    for (const ix of intersections) this.info.set(ix.id, { ...ix });
    if (!this.map) return; // the map is not created yet: it calls this again when it is
    const located = intersections.filter((ix) => Number.isFinite(ix.lat) && Number.isFinite(ix.lng));
    for (const ix of located) this._addMarker(ix);

    if (!located.length) return; // none has a surveyed position: nothing to draw, the map keeps its view
    this._fit(located);
  }

  _addMarker(ix) {
    const el = document.createElement('div');
    el.className = 'tl-marker-wrap';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', ix.name);
    el.innerHTML = markerHtml(this.info.get(ix.id), ix.id === this.selectedId);
    const show = () => {
      this.hovered = ix.id;
      this.tip.setLngLat([ix.lng, ix.lat]).setHTML(tooltipHtml(this.info.get(ix.id))).addTo(this.map);
    };
    const hide = () => { if (this.hovered === ix.id) { this.hovered = null; this.tip.remove(); } };
    el.addEventListener('mouseenter', show);
    el.addEventListener('mouseleave', hide);
    el.addEventListener('focus', show);
    el.addEventListener('blur', hide);
    el.addEventListener('click', (e) => { e.stopPropagation(); this.onSelect(ix.id); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.onSelect(ix.id); }
    });
    this.markers.set(ix.id, new Marker({ element: el, anchor: 'center' }).setLngLat([ix.lng, ix.lat]).addTo(this.map));
  }

  /** A hidden container has no size: the map is resized and fitted once it has one. */
  _fit(located) {
    const lngs = located.map((i) => i.lng);
    const lats = located.map((i) => i.lat);
    const bounds = [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
    const fit = () => {
      this.map.resize();
      this.map.fitBounds(bounds, { padding: 36, maxZoom: 16, duration: 0 });
    };
    if (this.element.clientWidth > 0) { fit(); return; }
    const observer = new ResizeObserver(() => {
      if (this.element.clientWidth === 0) return;
      observer.disconnect();
      fit();
    });
    observer.observe(this.element);
  }

  _refresh(id) {
    const info = this.info.get(id);
    const key = [info.dataMode, info.mode, info.greenDirection, info.signals && info.greenDirection ? info.signals[info.greenDirection] : '',
      info.summary ? info.summary.level : '', info.decisionState || '', id === this.selectedId].join('|');
    const marker = this.markers.get(id);
    if (!marker) return; // no surveyed position: this intersection is not on the map
    // Tooltip text changes with every count; the icon only when its look does.
    const tip = tooltipHtml(info);
    if (tip !== info.tip) {
      info.tip = tip;
      if (this.hovered === id) this.tip.setHTML(tip);
    }
    if (this.keys.get(id) === key) return;
    this.keys.set(id, key);
    const el = marker.getElement();
    el.innerHTML = markerHtml(info, id === this.selectedId);
    el.style.zIndex = id === this.selectedId ? '10' : '';
  }

  update(snapshot) {
    const id = snapshot.intersectionId;
    if (!this.info.has(id)) return;
    Object.assign(this.info.get(id), {
      dataMode: snapshot.dataMode,
      mode: snapshot.mode,
      greenDirection: snapshot.greenDirection,
      signals: snapshot.signals,
      positionSource: snapshot.positionSource || this.info.get(id).positionSource,
      snapshot,
      summary: trafficSummary(snapshot, { connected: this.connected }),
    });
    this._refresh(id);
  }

  /** Highlights from the latest network decision of the active mode (or null). */
  setDecision(decision) {
    const corridors = corridorIndex(decision);
    const records = new Map(((decision && decision.intersections) || []).map((r) => [r.intersectionId, r]));
    for (const [id, info] of this.info) {
      const r = records.get(id);
      info.decisionState = decision ? siteState(r, corridors) : null;
      info.decisionAction = r ? r.action : null;
      this._refresh(id);
    }
  }

  /** Backend connection state: without it no marker shows data as current. */
  setConnected(connected) {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const [id, info] of this.info) {
      info.summary = trafficSummary(info.snapshot || null, { connected });
      this._refresh(id);
    }
  }

  /** Redraws every marker from one data mode's snapshots (used when switching modes). */
  setSnapshots(snapshots) {
    for (const [id, info] of this.info) {
      Object.assign(info, {
        dataMode: null, mode: null, greenDirection: null, signals: null, snapshot: null, summary: null,
      });
      this._refresh(id);
    }
    snapshots.forEach((snap) => this.update(snap));
  }

  select(id, { pan = false } = {}) {
    const prev = this.selectedId;
    this.selectedId = id;
    if (prev && this.info.has(prev)) this._refresh(prev);
    if (this.info.has(id)) {
      this._refresh(id);
      const { lat, lng } = this.info.get(id);
      if (pan && this.map && Number.isFinite(lat) && Number.isFinite(lng) && !this.map.getBounds().contains([lng, lat])) {
        this.map.easeTo({ center: [lng, lat], duration: 300 });
      }
    }
  }
}
