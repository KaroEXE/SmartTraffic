/* global L */
import { trafficSummary, positionLabel } from './metrics.js';
import { corridorIndex, siteState } from './three/networkView.js';

/**
 * Geographic layer: OpenStreetMap tiles via Leaflet with one traffic-light
 * marker per intersection - the same intersections, by the same ids, as the
 * 3D street network. Clicking a marker selects that intersection.
 * Marker shows the lit aspect, the direction currently served and (ring)
 * the estimated congestion; its tooltip lists the four signals, counts,
 * data state and whether the position is surveyed.
 */

const DIRS = ['north', 'south', 'east', 'west'];
const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

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
    this.onSelect = onSelect;
    this.connected = true;
    this.markers = new Map();
    this.info = new Map();
    this.keys = new Map();
    this.selectedId = null;

    this.map = L.map(element, {
      zoomControl: true,
      attributionControl: true,
      zoomSnap: 0.5,
    });
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(this.map);

    this.element = element;
    this.pendingFit = null;
    this.setIntersections(intersections);

    // Leaflet needs a nudge when its container is resized by CSS grid. A fit
    // requested while the map was hidden (another view open) is done now.
    new ResizeObserver(() => {
      this.map.invalidateSize();
      if (this.pendingFit && element.clientWidth > 0) {
        const bounds = this.pendingFit;
        this.pendingFit = null;
        this.map.fitBounds(bounds, { padding: [36, 36], maxZoom: 16 });
      }
    }).observe(element);
  }

  /**
   * Replaces the markers with one data mode's intersections (live and
   * simulation each have their own list) and fits the view to them.
   */
  setIntersections(intersections) {
    for (const marker of this.markers.values()) marker.remove();
    this.markers.clear();
    this.info.clear();
    this.keys.clear();
    for (const ix of intersections) {
      this.info.set(ix.id, { ...ix });
      const marker = L.marker([ix.lat, ix.lng], {
        icon: this._icon(ix.id),
        title: ix.name,
        keyboard: true,
        riseOnHover: true,
      });
      marker.bindTooltip(tooltipHtml(this.info.get(ix.id)), { direction: 'top', offset: [0, -14], className: 'tl-tooltip' });
      marker.on('click', () => this.onSelect(ix.id));
      marker.addTo(this.map);
      this.markers.set(ix.id, marker);
    }

    const bounds = L.latLngBounds(intersections.map((i) => [i.lat, i.lng]));
    // A hidden container has no size: fitting now would pick a meaningless
    // zoom. A container that was just shown has a size Leaflet has not read
    // yet (its ResizeObserver runs later), so refresh it first.
    if (this.element && this.element.clientWidth === 0) {
      this.pendingFit = bounds;
    } else {
      this.map.invalidateSize();
      this.map.fitBounds(bounds, { padding: [36, 36], maxZoom: 16 });
    }
  }

  _icon(id) {
    const info = this.info.get(id);
    return L.divIcon({
      className: 'tl-marker-wrap',
      html: markerHtml(info, id === this.selectedId),
      iconSize: [0, 0],
    });
  }

  _refresh(id) {
    const info = this.info.get(id);
    const key = [info.dataMode, info.mode, info.greenDirection, info.signals && info.greenDirection ? info.signals[info.greenDirection] : '',
      info.summary ? info.summary.level : '', info.decisionState || '', id === this.selectedId].join('|');
    const marker = this.markers.get(id);
    // Tooltip text changes with every count; the icon only when its look does.
    const tip = tooltipHtml(info);
    if (tip !== info.tip) {
      info.tip = tip;
      marker.setTooltipContent(tip);
    }
    if (this.keys.get(id) === key) return;
    this.keys.set(id, key);
    marker.setIcon(this._icon(id));
    marker.setZIndexOffset(id === this.selectedId ? 1000 : 0);
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
      if (pan) {
        const { lat, lng } = this.info.get(id);
        if (!this.map.getBounds().pad(-0.15).contains([lat, lng])) this.map.panTo([lat, lng]);
      }
    }
  }
}
