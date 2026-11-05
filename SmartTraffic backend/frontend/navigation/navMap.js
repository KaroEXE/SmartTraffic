/* global L */
import { NAV_CONFIG } from './config.js';
import { VERIFICATION_TEXT } from './hazardService.js';
import { RANK_COLORS, rankColor, rankLabel } from './routeRanking.js';
import { distanceToPolylineMeters } from './geo.js';
import {
  directionLabel, escapeHtml, formatAge, formatCoords, formatDistance, formatDuration,
} from './format.js';

/**
 * Leaflet map for the driver navigation page. Created once per page; layers
 * are updated in place (markers are re-iconed only when their look changes),
 * so traffic updates never rebuild the map.
 *
 * Layers that can be toggled: 'traffic' (AI-monitored intersections),
 * 'speed_camera', 'speed_bump'. Routes, endpoints and the user's position
 * are always shown.
 */

const svg = (body, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
const CAMERA_SVG = svg('<rect x="3" y="7" width="13" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 11l5-3v8l-5-3z" fill="currentColor"/>', 14);
const BUMP_SVG = svg('<path d="M3 17h18M6 17c1.5-6 10.5-6 12 0" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>', 14);

/** Marker/legend markup, shared with the layers panel legend. */
export const ICON_HTML = {
  start: '<span class="nv-pin-start"></span>',
  destination: '<span class="nv-pin-dest"><span></span></span>',
  user: '<span class="nv-user-dot"></span>',
  speed_camera: `<span class="nv-hz nv-hz-camera">${CAMERA_SVG}</span>`,
  speed_bump: `<span class="nv-hz nv-hz-bump"><span>${BUMP_SVG}</span></span>`,
  road_closure: '<span class="nv-hz nv-hz-closure">!</span>',
  intersection: (cls = 'nv-ix-live', badge = '') => `<span class="nv-ix ${cls}"><span class="nv-ix-lamps"><i></i><i></i><i></i></span>${badge}</span>`,
  routeSelected: '<span class="nv-line nv-line-selected"></span>',
  routeAlternative: '<span class="nv-line nv-line-alt"></span>',
  routeRank: (position) => `<span class="nv-line" style="border-top-color:${RANK_COLORS[position]}"></span>`,
};

const STATUS_TEXT = {
  live: 'Live AI observation',
  stale: 'No recent data (feed stale)',
  'no-data': 'No AI observation received yet',
  offline: 'Last known data - connection to SmartTraffic lost',
};

const TYPE_LABEL = { ambulance: 'Ambulance', police: 'Police', fire_truck: 'Fire truck' };
const HAZARD_LAYERS = ['speed_camera', 'speed_bump', 'road_closure'];
const HAZARD_LABEL = { speed_camera: 'Speed camera', speed_bump: 'Speed bump', road_closure: 'Road closure' };

function divIcon(html, size, anchor) {
  return L.divIcon({ className: 'nv-icon', html, iconSize: size, iconAnchor: anchor || [size[0] / 2, size[1] / 2] });
}

function intersectionLook(ix, longQueue) {
  const classes = [`nv-ix-${ix.status}`];
  const queued = ix.status === 'live' && ix.longestQueue && ix.longestQueue.vehicles >= longQueue;
  if (queued) classes.push('nv-ix-queue');
  if (ix.emergency) classes.push('nv-ix-emergency');
  const badge = ix.status === 'live' && ix.longestQueue
    ? `<b class="nv-ix-badge">${ix.longestQueue.vehicles}</b>`
    : '';
  return { key: `${classes.join(' ')}|${badge}`, html: ICON_HTML.intersection(classes.join(' '), badge) };
}

function intersectionPopup(ix, longQueue) {
  const head = `<div class="nv-pop-title">${escapeHtml(ix.name)}</div>
    <div class="nv-pop-sub">AI-monitored intersection &middot; <span class="nv-st nv-st-${ix.status}">${STATUS_TEXT[ix.status]}</span>${ix.lastUpdate ? ` &middot; ${formatAge(ix.ageSeconds)}` : ''}</div>`;
  if (!ix.approaches) return `<div class="nv-pop">${head}</div>`;

  const rows = ['north', 'south', 'east', 'west'].map((d) => {
    const a = ix.approaches[d];
    const long = a.queueLength !== null && a.queueLength >= longQueue;
    const v = (n, unit = '') => (n === null ? '-' : `${Math.round(n)}${unit}`);
    return `<tr${long ? ' class="nv-long"' : ''}><th scope="row">${directionLabel(d)}</th><td>${v(a.vehicles)}</td><td>${v(a.queueLength)}</td><td>${v(a.waitingTime, ' s')}</td></tr>`;
  }).join('');
  const em = ix.emergency
    ? `<div class="nv-pop-alert">Emergency vehicle priority: ${escapeHtml(TYPE_LABEL[ix.emergency.type] || ix.emergency.type || 'emergency vehicle')} on the ${directionLabel(ix.emergency.direction)} approach (${Math.round((ix.emergency.confidence || 0) * 100)}% detection confidence). Expect signal changes.</div>`
    : '';
  return `<div class="nv-pop">${head}
    <table class="nv-pop-table"><thead><tr><th scope="col">Approach</th><th scope="col">Vehicles</th><th scope="col">Queue</th><th scope="col">Wait</th></tr></thead><tbody>${rows}</tbody></table>
    ${em}
    <div class="nv-pop-note">Counts from the SmartTraffic AI camera at this junction only.</div></div>`;
}

function hazardPopup(h) {
  const parts = [`<div class="nv-pop-title">${escapeHtml(h.label || HAZARD_LABEL[h.kind])}</div>`];
  if (h.details && h.details.reportedAt) parts.push(`<div class="nv-pop-sub">Reported ${escapeHtml(new Date(h.details.reportedAt).toLocaleString())}</div>`);
  if (h.details && h.details.maxspeed) parts.push(`<div>Speed limit: ${escapeHtml(h.details.maxspeed)}</div>`);
  parts.push(`<div class="nv-pop-sub">Source: ${escapeHtml(h.source)}</div>`);
  parts.push(`<div class="nv-pop-note">${escapeHtml(VERIFICATION_TEXT[h.verification] || 'Unverified')}</div>`);
  if (h.url) parts.push(`<a class="nv-pop-link" href="${escapeHtml(h.url)}" target="_blank" rel="noopener">View in OpenStreetMap</a>`);
  return `<div class="nv-pop">${parts.join('')}</div>`;
}

export class NavMap {
  constructor(element, { onPointChosen, onRouteSelected, onViewChanged }) {
    if (element._navMap) throw new Error('NavMap already created for this element');
    element._navMap = this;
    this.element = element;
    this.onPointChosen = onPointChosen;
    this.onRouteSelected = onRouteSelected;
    this.onViewChanged = onViewChanged;
    this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    this.longQueue = NAV_CONFIG.traffic.longQueueVehicles;

    const cfg = NAV_CONFIG.map;
    this.map = L.map(element, { zoomControl: false, attributionControl: true, zoomSnap: 0.5 });
    L.tileLayer(cfg.tileUrl, { maxZoom: cfg.maxZoom, attribution: cfg.attribution }).addTo(this.map);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    this.map.setView([cfg.fallbackView.lat, cfg.fallbackView.lng], cfg.fallbackView.zoom);

    this.groups = {
      routes: L.layerGroup().addTo(this.map),
      endpoints: L.layerGroup().addTo(this.map),
      user: L.layerGroup().addTo(this.map),
      traffic: L.layerGroup().addTo(this.map),
      speed_camera: L.layerGroup().addTo(this.map),
      speed_bump: L.layerGroup().addTo(this.map),
      road_closure: L.layerGroup().addTo(this.map),
    };
    this.intersectionMarkers = new Map(); // id -> { marker, key, popupKey }
    this.routeLayers = new Map(); // route id -> { casing, line, label, key }
    this.startMarker = null;
    this.destMarker = null;
    this.userMarker = null;
    this.userAccuracy = null;

    this.map.on('click', (e) => this.openPointMenu(e.latlng));
    this.map.on('moveend', () => this.onViewChanged(this.getView()));
    new ResizeObserver(() => this.map.invalidateSize()).observe(element);
  }

  // ------------------------------------------------------------- viewport

  /** Space covered by page chrome, in px; used for controls and fitting. */
  setInsets(insets) {
    this.insets = { ...this.insets, ...insets };
    const s = this.element.style;
    s.setProperty('--nv-inset-top', `${this.insets.top}px`);
    s.setProperty('--nv-inset-bottom', `${this.insets.bottom}px`);
    s.setProperty('--nv-inset-left', `${this.insets.left}px`);
  }

  _fitPadding() {
    const p = 24;
    return {
      paddingTopLeft: [this.insets.left + p, this.insets.top + p],
      paddingBottomRight: [this.insets.right + p + 56, this.insets.bottom + p],
    };
  }

  fitPoints(latlngs, maxZoom = 16) {
    if (!latlngs.length) return;
    if (latlngs.length === 1) { this.map.setView(latlngs[0], Math.max(this.map.getZoom(), 15)); return; }
    this.map.fitBounds(L.latLngBounds(latlngs), { ...this._fitPadding(), maxZoom });
  }

  getView() {
    const b = this.map.getBounds();
    return { bbox: { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }, zoom: this.map.getZoom() };
  }

  getCenter() {
    const c = this.map.getCenter();
    return { lat: c.lat, lng: c.lng };
  }

  // -------------------------------------------------------- point picking

  openPointMenu(latlng) {
    const point = { lat: latlng.lat, lng: latlng.lng };
    const el = document.createElement('div');
    el.className = 'nv-pop nv-point-menu';
    el.innerHTML = `<div class="nv-pop-sub">${formatCoords(point)}</div>
      <button type="button" class="nv-btn" data-kind="start">Start here</button>
      <button type="button" class="nv-btn nv-btn-primary" data-kind="destination">Destination here</button>`;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-kind]');
      if (!btn || btn.disabled) return;
      // The closed popup fades out for a moment; it must not take a second tap.
      el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      this.map.closePopup();
      this.onPointChosen(btn.dataset.kind, point);
    });
    L.popup({ className: 'nv-popup', closeButton: true, autoPanPadding: [60, 60] })
      .setLatLng(latlng).setContent(el).openOn(this.map);
    const first = el.querySelector('button');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 0);
  }

  // --------------------------------------------------------- endpoints

  setStart(point) {
    if (this.startMarker) { this.groups.endpoints.removeLayer(this.startMarker); this.startMarker = null; }
    if (!point) return;
    this.startMarker = L.marker([point.lat, point.lng], {
      icon: divIcon(ICON_HTML.start, [20, 20]), keyboard: false, title: 'Start', zIndexOffset: 900,
    }).addTo(this.groups.endpoints);
  }

  setDestination(point, label) {
    if (this.destMarker) { this.groups.endpoints.removeLayer(this.destMarker); this.destMarker = null; }
    if (!point) return;
    this.destMarker = L.marker([point.lat, point.lng], {
      icon: divIcon(ICON_HTML.destination, [28, 36], [14, 34]), keyboard: false, title: label || 'Destination', zIndexOffset: 1000,
    }).addTo(this.groups.endpoints);
  }

  showUserLocation(point, accuracyMeters) {
    const ll = [point.lat, point.lng];
    if (!this.userMarker) {
      this.userAccuracy = L.circle(ll, { radius: accuracyMeters, interactive: false, className: 'nv-accuracy', weight: 1 }).addTo(this.groups.user);
      this.userMarker = L.marker(ll, { icon: divIcon(ICON_HTML.user, [18, 18]), keyboard: false, title: 'Your location', interactive: false }).addTo(this.groups.user);
    } else {
      this.userMarker.setLatLng(ll);
      this.userAccuracy.setLatLng(ll).setRadius(accuracyMeters);
    }
  }

  // ----------------------------------------------------------------- routes

  /**
   * Draws the routes ranked best to worst: colours from green (best) to red
   * (worst), the best route on top, the selected route highlighted with a
   * casing and brought to the front. Lines are kept per route id and only
   * restyled when the ranking changes, so live re-ranking never flickers.
   *   order: route ids best first; estimates: id -> { duration } (optional)
   */
  setRoutes(routes, selectedId, { order = null, estimates = null } = {}) {
    const ids = order || routes.map((r) => r.id);
    const byId = new Map(routes.map((r) => [r.id, r]));
    for (const [id, layers] of this.routeLayers) {
      if (!byId.has(id)) {
        layers.group.remove();
        this.routeLayers.delete(id);
      }
    }
    // A new route can change where the others are easiest to label.
    const setKey = [...byId.keys()].sort().join(',');
    const relabel = setKey !== this.routeSetKey;
    this.routeSetKey = setKey;
    // Worst first, so the best ends up on top; the selected one last of all.
    const drawOrder = [...ids].reverse().sort((a, b) => (a === selectedId) - (b === selectedId));
    for (const id of drawOrder) {
      const route = byId.get(id);
      if (!route) continue;
      const position = ids.indexOf(id);
      const color = rankColor(position, ids.length);
      const selected = id === selectedId;
      const duration = estimates && estimates.get(id) ? estimates.get(id).duration : route.duration;
      const text = `Route ${position + 1} — ${rankLabel(position, ids.length)}: ${formatDuration(duration)}, ${formatDistance(route.distance)}`;
      let layers = this.routeLayers.get(id);
      if (!layers) {
        const group = L.layerGroup().addTo(this.groups.routes);
        const casing = L.polyline(route.coordinates, { color: '#0a0c0e', weight: 11, opacity: 0, interactive: false }).addTo(group);
        const line = L.polyline(route.coordinates, { weight: 6, opacity: 0.9, bubblingMouseEvents: false, className: 'nv-route-line' }).addTo(group);
        line.on('click', () => this.onRouteSelected(id));
        line.bindTooltip('', { sticky: true });
        const label = L.marker(this._labelPoint(route, routes), {
          icon: divIcon('', [0, 0]), keyboard: false, interactive: true, zIndexOffset: 400,
        }).addTo(group);
        label.on('click', () => this.onRouteSelected(id));
        layers = { group, casing, line, label, key: null };
        this.routeLayers.set(id, layers);
      }
      if (relabel) layers.label.setLatLng(this._labelPoint(route, routes));
      const key = `${color}|${selected}|${text}`;
      if (layers.key !== key) {
        layers.key = key;
        layers.casing.setStyle({ opacity: selected ? 0.9 : 0 });
        layers.line.setStyle({ color, weight: selected ? 7 : 5, opacity: selected || position === 0 ? 1 : 0.8 });
        layers.line.setTooltipContent(`${text}${selected ? '' : ' (tap to select)'}`);
        layers.label.setIcon(divIcon(
          `<span class="nv-route-tag${selected ? ' nv-route-tag-on' : ''}" style="--rank:${color}"><b>${position + 1}</b>${formatDuration(duration)}</span>`,
          [0, 0], [0, 0],
        ));
        layers.label.setZIndexOffset(selected ? 600 : 400 - position);
      }
      // Re-stack every time: the order can change without the style changing.
      layers.casing.bringToFront();
      layers.line.bringToFront();
    }
  }

  /** Where a route's label goes: its point farthest from the other routes. */
  _labelPoint(route, routes) {
    const others = routes.filter((r) => r.id !== route.id);
    const coords = route.coordinates;
    let best = coords[Math.floor(coords.length / 2)];
    let bestDistance = -1;
    const step = Math.max(1, Math.floor(coords.length / 60));
    for (let i = Math.floor(coords.length * 0.15); i < coords.length * 0.85; i += step) {
      const p = { lat: coords[i][0], lng: coords[i][1] };
      const d = others.length ? Math.min(...others.map((o) => distanceToPolylineMeters(p, o.coordinates))) : 0;
      if (d > bestDistance) { bestDistance = d; best = coords[i]; }
    }
    return best;
  }

  fitRoutes(routes) {
    const pts = routes.flatMap((r) => r.coordinates);
    if (pts.length) this.fitPoints(pts, 17);
  }

  // -------------------------------------------------------------- traffic

  setIntersections(views) {
    const seen = new Set();
    for (const ix of views) {
      if (!ix.located) continue;
      seen.add(ix.id);
      const look = intersectionLook(ix, this.longQueue);
      const popupHtml = intersectionPopup(ix, this.longQueue);
      let entry = this.intersectionMarkers.get(ix.id);
      if (!entry) {
        const marker = L.marker([ix.lat, ix.lng], {
          icon: divIcon(look.html, [30, 30]), title: `${ix.name} - AI-monitored intersection`, riseOnHover: true, zIndexOffset: 500,
        });
        marker.bindPopup(popupHtml, { className: 'nv-popup', maxWidth: 300 });
        marker.addTo(this.groups.traffic);
        entry = { marker, key: look.key, popupHtml };
        this.intersectionMarkers.set(ix.id, entry);
        continue;
      }
      if (entry.key !== look.key) {
        entry.marker.setIcon(divIcon(look.html, [30, 30]));
        entry.key = look.key;
      }
      if (entry.popupHtml !== popupHtml) {
        entry.marker.setPopupContent(popupHtml);
        entry.popupHtml = popupHtml;
      }
    }
    for (const [id, entry] of this.intersectionMarkers) {
      if (!seen.has(id)) {
        this.groups.traffic.removeLayer(entry.marker);
        this.intersectionMarkers.delete(id);
      }
    }
  }

  // -------------------------------------------------------------- hazards

  setHazards(hazards) {
    for (const kind of HAZARD_LAYERS) this.groups[kind].clearLayers();
    for (const h of hazards) {
      if (!HAZARD_LAYERS.includes(h.kind)) continue;
      const icon = divIcon(ICON_HTML[h.kind], [26, 26]);
      L.marker([h.lat, h.lng], { icon, title: h.label || HAZARD_LABEL[h.kind], keyboard: false })
        .bindPopup(hazardPopup(h), { className: 'nv-popup', maxWidth: 260 })
        .addTo(this.groups[h.kind]);
    }
  }

  // --------------------------------------------------------------- layers

  setLayerVisible(name, visible) {
    const group = this.groups[name];
    if (!group) return;
    if (visible && !this.map.hasLayer(group)) group.addTo(this.map);
    if (!visible && this.map.hasLayer(group)) this.map.removeLayer(group);
  }

  diagnostics() {
    return {
      mapContainers: document.querySelectorAll('.leaflet-container').length,
      intersectionMarkers: this.intersectionMarkers.size,
      hazardMarkers: HAZARD_LAYERS.reduce((n, k) => n + this.groups[k].getLayers().length, 0),
      routeLines: this.routeLayers.size,
    };
  }
}
