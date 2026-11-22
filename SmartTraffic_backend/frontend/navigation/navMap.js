import { NAV_CONFIG } from './config.js';
import { VERIFICATION_TEXT } from './hazardService.js';
import { RANK_COLORS, rankColor, rankLabel } from './routeRanking.js';
import { distanceToPolylineMeters } from './geo.js';
import {
  directionLabel, escapeHtml, formatAge, formatCoords, formatDistance, formatDuration,
} from './format.js';
import {
  createBaseMap, addHawrIcons, Marker, Popup,
} from '../mapCore.js';
import {
  boundsCenter, circlePolygon, featureCollection, latLngsToLngLats,
} from '../mapConfig.js';

/**
 * MapLibre map of the driver navigation page (OpenFreeMap vector tiles). Created once per
 * page; routes, hazards, reports and places live in GeoJSON sources that are updated with
 * setData, so traffic updates never rebuild the map. The few monitored intersections
 * are DOM markers (their look changes with live data).
 *
 * The page works with { lat, lng } points and [lat, lng] route lines; this module converts
 * to MapLibre's [lng, lat] at the edge and nowhere else.
 *
 * Layers that can be toggled: 'traffic' (AI-monitored intersections), 'speed_camera',
 * 'speed_bump', 'road_closure', 'report' (driver reports), 'place' (Hawr places).
 * Routes, endpoints and the user's position are always shown.
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
  report: '<span class="nv-hz nv-hz-report">!</span>',
  place: '<span class="nv-hz nv-hz-place"><i></i></span>',
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
// Map layer groups. Road features, driver reports and Hawr places share one GeoJSON source.
const GROUPS = ['speed_camera', 'speed_bump', 'road_closure', 'report', 'place'];
const GROUP_LABEL = {
  speed_camera: 'Speed camera', speed_bump: 'Speed bump', road_closure: 'Road closure', report: 'Driver report', place: 'Place',
};

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

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

/** Popup of a hazard, report or place, built from text nodes: names and notes may come from users. */
function hazardPopup(h) {
  const box = element('div', 'nv-pop');
  box.append(element('div', 'nv-pop-title', h.label || GROUP_LABEL[h.kind]));
  const add = (cls, text) => { if (text) box.append(element('div', cls, text)); };
  if (h.details && h.details.description) add('', h.details.description);
  if (h.details && h.details.reportedAt) add('nv-pop-sub', `Reported ${new Date(h.details.reportedAt).toLocaleString()}`);
  if (h.details && h.details.maxspeed) add('', `Speed limit: ${h.details.maxspeed}`);
  if (h.details && h.details.votes) add('', h.details.votes);
  if (h.details && h.details.expiresAt) add('nv-pop-sub', `Shown until ${new Date(h.details.expiresAt).toLocaleString()}`);
  add('nv-pop-sub', `Source: ${h.source}`);
  add('nv-pop-note', VERIFICATION_TEXT[h.verification] || 'Unverified');
  return box;
}

export class NavMap {
  constructor(el, {
    mapConfig, onPointChosen, onRouteSelected, onViewChanged,
  }) {
    if (el._navMap) throw new Error('NavMap already created for this element');
    el._navMap = this;
    this.element = el;
    this.onPointChosen = onPointChosen;
    this.onRouteSelected = onRouteSelected;
    this.onViewChanged = onViewChanged;
    this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    this.longQueue = NAV_CONFIG.traffic.longQueueVehicles;
    this.area = mapConfig ? mapConfig.map.bounds : null;
    this.ready = false;
    this.visible = Object.fromEntries([...GROUPS, 'traffic'].map((g) => [g, true]));
    this.intersectionMarkers = new Map(); // id -> { marker, popup, key, popupHtml }
    this.routeLabels = new Map(); // route id -> { marker, key }
    this.hazardById = new Map();
    this.state = { routes: null, hazards: [], user: null };
    this.startMarker = null;
    this.destMarker = null;
    this.userMarker = null;
    this.menu = null;
    this.routeSetKey = '';

    const base = createBaseMap(el, mapConfig, { navigation: true });
    this.map = base ? base.map : null;
    if (!this.map) return;
    this.map.on('moveend', () => this.onViewChanged(this.getView()));
    this.map.on('click', (e) => this._onClick(e));
    base.loaded.then(() => this._onReady());
  }

  // ------------------------------------------------------------------ setup

  _onReady() {
    const { map } = this;
    addHawrIcons(map);
    // Routes go under the style's labels so street names stay readable on top of them.
    const firstLabel = map.getStyle().layers.find((l) => l.type === 'symbol');
    const before = firstLabel ? firstLabel.id : undefined;
    map.addSource('routes', { type: 'geojson', data: featureCollection([]) });
    map.addSource('accuracy', { type: 'geojson', data: featureCollection([]) });
    map.addSource('hazards', { type: 'geojson', data: featureCollection([]) });
    map.addLayer({ id: 'accuracy-fill', type: 'fill', source: 'accuracy', paint: { 'fill-color': '#4f8df7', 'fill-opacity': 0.15 } }, before);
    map.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'routes',
      filter: ['==', ['get', 'selected'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0a0c0e', 'line-width': 11, 'line-opacity': 0.9 },
    }, before);
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['case', ['get', 'selected'], 7, 5],
        'line-opacity': ['case', ['any', ['get', 'selected'], ['==', ['get', 'position'], 0]], 1, 0.8],
      },
    }, before);
    for (const group of GROUPS) {
      map.addLayer({
        id: `hz-${group}`,
        type: 'symbol',
        source: 'hazards',
        filter: ['==', ['get', 'group'], group],
        layout: {
          'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true, visibility: this.visible[group] ? 'visible' : 'none',
        },
      });
      map.on('click', `hz-${group}`, (e) => this._onHazardClick(e));
      map.on('mouseenter', `hz-${group}`, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', `hz-${group}`, () => { map.getCanvas().style.cursor = ''; });
    }
    map.on('click', 'route-line', (e) => {
      const feature = e.features && e.features[0];
      if (feature) this.onRouteSelected(feature.properties.id);
    });
    map.on('mouseenter', 'route-line', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'route-line', () => { map.getCanvas().style.cursor = ''; });
    this.ready = true;
    this._applyRoutes();
    this._applyHazards();
    this._applyUser();
    this.onViewChanged(this.getView());
  }

  _onClick(e) {
    const layers = ['route-line', ...GROUPS.map((g) => `hz-${g}`)].filter((id) => this.map.getLayer(id));
    if (layers.length && this.map.queryRenderedFeatures(e.point, { layers }).length) return; // a route or a marker was clicked
    this.openPointMenu({ lat: e.lngLat.lat, lng: e.lngLat.lng });
  }

  _onHazardClick(e) {
    const feature = e.features && e.features[0];
    const h = feature && this.hazardById.get(feature.properties.id);
    if (!h) return;
    new Popup({ className: 'nv-popup', maxWidth: '260px', offset: 14 }).setLngLat([h.lng, h.lat]).setDOMContent(hazardPopup(h)).addTo(this.map);
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
      top: this.insets.top + p, bottom: this.insets.bottom + p, left: this.insets.left + p, right: this.insets.right + p + 56,
    };
  }

  /** Fits [lat, lng] pairs; a single point is centred at a street-level zoom. */
  fitPoints(latlngs, maxZoom = 16) {
    if (!this.map || !latlngs.length) return;
    if (latlngs.length === 1) {
      this.map.easeTo({ center: [latlngs[0][1], latlngs[0][0]], zoom: Math.max(this.map.getZoom(), 14), duration: 400 });
      return;
    }
    const lngLats = latLngsToLngLats(latlngs);
    const west = Math.min(...lngLats.map((c) => c[0]));
    const east = Math.max(...lngLats.map((c) => c[0]));
    const south = Math.min(...lngLats.map((c) => c[1]));
    const north = Math.max(...lngLats.map((c) => c[1]));
    this.map.fitBounds([[west, south], [east, north]], { padding: this._fitPadding(), maxZoom, duration: 500 });
  }

  getView() {
    if (!this.map) return { bbox: { south: 0, west: 0, north: 0, east: 0 }, zoom: 0 };
    const b = this.map.getBounds();
    return { bbox: { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }, zoom: this.map.getZoom() };
  }

  getCenter() {
    const c = this.map ? this.map.getCenter() : boundsCenter(this.area || { south: 0, north: 0, west: 0, east: 0 });
    return { lat: c.lat, lng: c.lng };
  }

  // -------------------------------------------------------- point picking

  openPointMenu(point) {
    if (!this.map) return;
    if (this.menu) this.menu.remove();
    const el = element('div', 'nv-pop nv-point-menu');
    el.append(element('div', 'nv-pop-sub', formatCoords(point)));
    const button = (kind, text, cls = 'nv-btn') => {
      const b = element('button', cls, text);
      b.type = 'button';
      b.dataset.kind = kind;
      el.append(b);
      return b;
    };
    button('start', 'Start here');
    button('destination', 'Destination here', 'nv-btn nv-btn-primary');
    button('report', 'Report an incident here');
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-kind]');
      if (!btn || btn.disabled) return;
      el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      this.menu.remove();
      this.onPointChosen(btn.dataset.kind, point);
    });
    this.menu = new Popup({ className: 'nv-popup', closeButton: true, maxWidth: '280px' }).setLngLat([point.lng, point.lat]).setDOMContent(el).addTo(this.map);
    const first = el.querySelector('button');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 0);
  }

  // --------------------------------------------------------- endpoints

  _marker(html, anchor) {
    const el = element('div', 'nv-icon');
    el.innerHTML = html;
    return new Marker({ element: el, anchor });
  }

  setStart(point) {
    if (this.startMarker) { this.startMarker.remove(); this.startMarker = null; }
    if (!point || !this.map) return;
    this.startMarker = this._marker(ICON_HTML.start, 'center').setLngLat([point.lng, point.lat]).addTo(this.map);
    this.startMarker.getElement().title = 'Start';
  }

  setDestination(point, label) {
    if (this.destMarker) { this.destMarker.remove(); this.destMarker = null; }
    if (!point || !this.map) return;
    this.destMarker = this._marker(ICON_HTML.destination, 'bottom').setLngLat([point.lng, point.lat]).addTo(this.map);
    this.destMarker.getElement().title = label || 'Destination';
  }

  showUserLocation(point, accuracyMeters) {
    this.state.user = { point, accuracyMeters };
    this._applyUser();
  }

  _applyUser() {
    const { user } = this.state;
    if (!this.map || !user) return;
    const { point, accuracyMeters } = user;
    if (!this.userMarker) {
      this.userMarker = this._marker(ICON_HTML.user, 'center').setLngLat([point.lng, point.lat]).addTo(this.map);
      this.userMarker.getElement().title = 'Your location';
      this.userMarker.getElement().style.pointerEvents = 'none';
    } else {
      this.userMarker.setLngLat([point.lng, point.lat]);
    }
    if (this.ready) {
      const geometry = circlePolygon(point, Math.max(1, accuracyMeters || 1));
      this.map.getSource('accuracy').setData(featureCollection([{ type: 'Feature', properties: {}, geometry }]));
    }
  }

  // ----------------------------------------------------------------- routes

  /**
   * Draws the routes ranked best to worst: colours from green (best) to red (worst), the best
   * route on top, the selected route highlighted with a casing and brought to the front.
   *   order: route ids best first; estimates: id -> { duration } (optional)
   */
  setRoutes(routes, selectedId, { order = null, estimates = null } = {}) {
    this.state.routes = { routes, selectedId, order, estimates };
    this._applyRoutes();
  }

  _applyRoutes() {
    const { map } = this;
    if (!map || !this.state.routes) return;
    const { routes, selectedId, order, estimates } = this.state.routes;
    const ids = order || routes.map((r) => r.id);
    const byId = new Map(routes.map((r) => [r.id, r]));

    for (const [id, label] of this.routeLabels) {
      if (!byId.has(id)) { label.marker.remove(); this.routeLabels.delete(id); }
    }
    const setKey = [...byId.keys()].sort().join(',');
    const relabel = setKey !== this.routeSetKey;
    this.routeSetKey = setKey;

    // Worst first, so the best ends up on top; the selected one last of all.
    const drawOrder = [...ids].reverse().sort((a, b) => (a === selectedId) - (b === selectedId));
    const features = [];
    for (const id of drawOrder) {
      const route = byId.get(id);
      if (!route) continue;
      const position = ids.indexOf(id);
      const color = rankColor(position, ids.length);
      const selected = id === selectedId;
      features.push({
        type: 'Feature',
        properties: { id, color, selected, position },
        geometry: { type: 'LineString', coordinates: latLngsToLngLats(route.coordinates) },
      });
      const duration = estimates && estimates.get && estimates.get(id) ? estimates.get(id).duration : route.duration;
      const text = `Route ${position + 1} — ${rankLabel(position, ids.length)}: ${formatDuration(duration)}, ${formatDistance(route.distance)}`;
      const key = `${color}|${selected}|${text}`;
      let label = this.routeLabels.get(id);
      if (!label) {
        const at = this._labelPoint(route, routes);
        const el = element('button', 'nv-route-label');
        el.type = 'button';
        el.addEventListener('click', (ev) => { ev.stopPropagation(); this.onRouteSelected(id); });
        label = { marker: new Marker({ element: el, anchor: 'center' }).setLngLat([at[1], at[0]]).addTo(map), key: null };
        this.routeLabels.set(id, label);
      } else if (relabel) {
        const at = this._labelPoint(route, routes);
        label.marker.setLngLat([at[1], at[0]]);
      }
      if (label.key !== key) {
        label.key = key;
        const el = label.marker.getElement();
        el.title = `${text}${selected ? '' : ' (tap to select)'}`;
        el.innerHTML = `<span class="nv-route-tag${selected ? ' nv-route-tag-on' : ''}" style="--rank:${color}"><b>${position + 1}</b>${formatDuration(duration)}</span>`;
        el.style.zIndex = selected ? '6' : String(5 - position);
      }
    }
    if (this.ready) map.getSource('routes').setData(featureCollection(features));
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
    if (pts.length) this.fitPoints(pts, 16);
  }

  // -------------------------------------------------------------- traffic

  setIntersections(views) {
    if (!this.map) return;
    const seen = new Set();
    for (const ix of views) {
      if (!ix.located) continue;
      seen.add(ix.id);
      const look = intersectionLook(ix, this.longQueue);
      const popupHtml = intersectionPopup(ix, this.longQueue);
      let entry = this.intersectionMarkers.get(ix.id);
      if (!entry) {
        const marker = this._marker(look.html, 'center').setLngLat([ix.lng, ix.lat]);
        marker.getElement().title = `${ix.name} - AI-monitored intersection`;
        marker.getElement().style.display = this.visible.traffic ? '' : 'none';
        const popup = new Popup({ className: 'nv-popup', maxWidth: '300px', offset: 18 }).setHTML(popupHtml);
        marker.setPopup(popup).addTo(this.map);
        entry = { marker, popup, key: look.key, popupHtml };
        this.intersectionMarkers.set(ix.id, entry);
        continue;
      }
      if (entry.key !== look.key) {
        entry.marker.getElement().innerHTML = look.html;
        entry.key = look.key;
      }
      if (entry.popupHtml !== popupHtml) {
        entry.popup.setHTML(popupHtml);
        entry.popupHtml = popupHtml;
      }
    }
    for (const [id, entry] of this.intersectionMarkers) {
      if (!seen.has(id)) { entry.marker.remove(); this.intersectionMarkers.delete(id); }
    }
  }

  // -------------------------------------------------------------- hazards

  /** Road features, driver reports and Hawr places: [{ id, kind, icon, lat, lng, label, source, verification, details }]. */
  setHazards(hazards) {
    this.state.hazards = hazards;
    this._applyHazards();
  }

  _applyHazards() {
    if (!this.map || !this.ready) return;
    this.hazardById = new Map();
    const features = [];
    for (const h of this.state.hazards) {
      if (!GROUPS.includes(h.kind)) continue;
      this.hazardById.set(h.id, h);
      features.push({
        type: 'Feature', properties: { id: h.id, group: h.kind, icon: `hawr-${h.icon || h.kind}` }, geometry: { type: 'Point', coordinates: [h.lng, h.lat] },
      });
    }
    this.map.getSource('hazards').setData(featureCollection(features));
  }

  // --------------------------------------------------------------- layers

  setLayerVisible(name, visible) {
    if (!(name in this.visible)) return;
    this.visible[name] = visible;
    if (name === 'traffic') {
      for (const entry of this.intersectionMarkers.values()) entry.marker.getElement().style.display = visible ? '' : 'none';
    } else if (this.ready) {
      this.map.setLayoutProperty(`hz-${name}`, 'visibility', visible ? 'visible' : 'none');
    }
  }

  diagnostics() {
    return {
      mapContainers: this.element.querySelectorAll('canvas.maplibregl-canvas').length,
      intersectionMarkers: this.intersectionMarkers.size,
      hazardMarkers: this.hazardById.size,
      routeLines: this.routeLabels.size,
    };
  }
}
