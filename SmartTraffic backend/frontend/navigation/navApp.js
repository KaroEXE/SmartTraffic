import { NAV_CONFIG } from './config.js';
import { NavMap } from './navMap.js';
import { LayersPanel } from './layersPanel.js';
import { RoutePanel } from './routePanel.js';
import { SearchBox } from './searchBox.js';
import { createStatus } from './status.js';
import { createGeocoder } from './geocoder.js';
import { planRoutes, findMoreRoutes, RouteError } from './routeService.js';
import { estimateRoute, orderRoutes, liveStatus } from './routeRanking.js';
import { matchRouteToTraffic, findRerouteSuggestion } from './routeTraffic.js';
import { createHazardProvider, createHazardLoader } from './hazardService.js';
import { createTrafficStore } from './trafficStore.js';
import { connectTrafficFeed, disconnectTrafficFeed, feedDiagnostics } from './trafficFeed.js';
import { formatCoords } from './format.js';
import { bboxContains } from './geo.js';

/**
 * Driver navigation page (navigation.html): wires the map, search, routing,
 * live traffic feed and hazard layers together. Runs once per page load.
 */

const cfg = NAV_CONFIG;
const $ = (id) => document.getElementById(id);
const wideQuery = window.matchMedia('(min-width: 768px)');

const state = {
  start: null, // { point, label }
  destination: null, // { point, label }
  routes: [],
  selectedId: null,
  userSelected: false, // false: the selection follows the best route
  order: [], // route ids, best first
  estimates: new Map(), // route id -> estimateRoute()
  liveState: 'not-on-route',
  searching: false, // extra alternatives still being requested
  trafficRouting: 'not-configured',
  snapWarnings: [],
  routeKey: null,
  routeController: null,
  matches: new Map(),
  seenAlerts: new Set(),
  dismissed: new Set(),
  lastTrafficRefresh: 0,
};

let map;
let store;
let panel;
let layers;
let search;
let status;
let hazardLoader;
let hazardState = { status: 'idle', hazards: [] };
let hazardKinds = [];
let renderTimer = null;

// --------------------------------------------------------------- layout

function updateInsets() {
  const top = $('nv-top').getBoundingClientRect();
  const sheet = $('nv-sheet').getBoundingClientRect();
  const sheetHeight = Math.max(0, Math.round(window.innerHeight - sheet.top));
  document.body.style.setProperty('--nv-top-h', `${Math.round(top.bottom)}px`);
  document.body.style.setProperty('--nv-sheet-h', `${sheetHeight}px`);
  if (wideQuery.matches) map.setInsets({ top: 0, bottom: 0, left: Math.round(Math.max(top.right, sheet.right)) });
  else map.setInsets({ top: Math.round(top.bottom), bottom: sheetHeight, left: 0 });
}

// ---------------------------------------------------------- start point

function setStart(point, label) {
  state.start = { point, label };
  map.setStart(point);
  $('nv-from-value').textContent = label;
  $('nv-from-value').classList.remove('nv-placeholder');
  requestRoutes();
}

function setDestination(point, label) {
  state.destination = { point, label };
  map.setDestination(point, label);
  requestRoutes();
}

function clearDestination() {
  if (!state.destination) return;
  state.destination = null;
  map.setDestination(null);
  clearRoutes();
  prompt();
}

const GEO_ERRORS = {
  1: 'Location permission was denied. You can still tap the map or use the map centre to set a start point.',
  2: 'Your position is not available right now. Tap the map to set a start point instead.',
  3: 'Finding your position took too long. Try again, or tap the map to set a start point.',
};

function locate({ asStart }) {
  if (!('geolocation' in navigator)) {
    status.notify('This browser cannot share your location. Tap the map to set a start point.', { tone: 'warn' });
    return;
  }
  if (!window.isSecureContext) {
    status.notify('Location needs a secure (HTTPS) connection. Tap the map to set a start point instead.', { tone: 'warn', timeoutMs: 8000 });
    return;
  }
  const buttons = [$('nv-locate'), $('nv-from-locate')];
  buttons.forEach((b) => b.setAttribute('aria-busy', 'true'));
  navigator.geolocation.getCurrentPosition((pos) => {
    buttons.forEach((b) => b.removeAttribute('aria-busy'));
    const point = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const accuracy = Math.round(pos.coords.accuracy || 0);
    map.showUserLocation(point, accuracy);
    if (asStart) setStart(point, `Your location${accuracy ? ` (within ${accuracy} m)` : ''}`);
    if (!asStart || !state.destination) map.fitPoints([[point.lat, point.lng]]);
  }, (err) => {
    buttons.forEach((b) => b.removeAttribute('aria-busy'));
    status.notify(GEO_ERRORS[err.code] || 'Your location could not be determined.', { tone: 'warn', timeoutMs: 8000 });
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}

// --------------------------------------------------------------- routes

function prompt() {
  if (!state.start && !state.destination) panel.showMessage('Search for a destination or tap the map. Set your start with "my location", the map centre, or a tap on the map.');
  else if (!state.start) panel.showMessage('Now choose a start point: your location, the map centre, or tap the map.');
  else if (!state.destination) panel.showMessage('Now search for a destination or tap the map to choose one.');
}

function clearRoutes() {
  if (state.routeController) state.routeController.abort();
  state.routes = [];
  state.selectedId = null;
  state.userSelected = false;
  state.order = [];
  state.estimates = new Map();
  state.searching = false;
  state.routeKey = null;
  state.matches = new Map();
  map.setRoutes([], null);
}

/**
 * Ranks the current routes from the routing times plus the live AI data
 * already in the traffic store. Never requests routes. `fresh` drops the
 * previous order (new route set); otherwise near-ties keep their places.
 * Returns true when anything shown (order or times) changed.
 */
function rerank({ fresh = false } = {}) {
  const views = store.list();
  const estimates = new Map(state.routes.map((r) => [r.id, estimateRoute(r, views, cfg.traffic)]));
  const order = orderRoutes(state.routes, estimates, fresh ? null : state.order, {
    hysteresisSeconds: cfg.traffic.rankHysteresisSeconds,
  });
  const signature = (o, e) => o.map((id) => `${id}:${Math.round(e.get(id).duration)}`).join('|');
  const changed = fresh || signature(order, estimates) !== signature(state.order, state.estimates)
    || liveStatus(estimates) !== state.liveState;
  state.estimates = estimates;
  state.order = order;
  state.liveState = liveStatus(estimates);
  if (!state.userSelected && order.length) state.selectedId = order[0];
  return changed;
}

function ranking() {
  return { order: state.order, estimates: state.estimates, liveState: state.liveState, searching: state.searching };
}

function drawRoutes() {
  map.setRoutes(state.routes, state.selectedId, { order: state.order, estimates: state.estimates });
}

async function requestRoutes({ force = false } = {}) {
  if (!state.start || !state.destination) { prompt(); return; }
  const key = `${formatCoords(state.start.point)}>${formatCoords(state.destination.point)}`;
  if (!force && key === state.routeKey && state.routes.length) return; // same request, nothing to do

  if (state.routeController) state.routeController.abort();
  const controller = new AbortController();
  state.routeController = controller;
  state.routeKey = key;
  const keepIndex = force ? (state.routes.find((r) => r.id === state.selectedId) || {}).index : undefined;
  if (!force) {
    map.setRoutes([], null);
    panel.showMessage('Finding routes...', { busy: true });
  }

  try {
    const result = await planRoutes(state.start.point, state.destination.point, { signal: controller.signal });
    if (controller.signal.aborted) return;
    state.routes = result.routes;
    state.trafficRouting = result.trafficRouting;
    state.snapWarnings = result.snapWarnings;
    const kept = keepIndex !== undefined ? result.routes.find((r) => r.index === keepIndex) : null;
    state.userSelected = Boolean(kept && state.userSelected);
    state.searching = !force && state.routes.length < cfg.routing.maxRoutes;
    rerank({ fresh: true });
    if (kept) state.selectedId = kept.id;

    drawRoutes();
    panel.showRoutes({
      routes: state.routes,
      selectedId: state.selectedId,
      ...ranking(),
      trafficRouting: state.trafficRouting,
      snapWarnings: state.snapWarnings,
    });
    markCurrentAlertsSeen();
    renderTraffic();
    if (!force) {
      panel.setExpanded(true);
      updateInsets(); // the sheet just changed height; fit the route into the visible map
      map.fitRoutes(state.routes);
    }
    if (state.searching) await addAlternatives(controller);
  } catch (err) {
    if (controller.signal.aborted || (err instanceof RouteError && err.code === 'aborted')) return;
    state.routeKey = null;
    if (force) return; // background refresh: keep showing the current routes
    panel.showMessage(err instanceof RouteError ? err.message : 'Route planning failed.', { tone: 'error', retry: err.code !== 'invalid-input' });
  }
}

/**
 * Fewer routes than wanted: ask the routing service for real alternatives
 * through via points (spaced to respect its rate limit) and add each one as
 * it arrives. Stops when enough are found or the route request changes.
 */
async function addAlternatives(controller) {
  try {
    await findMoreRoutes(state.start.point, state.destination.point, state.routes, {
      signal: controller.signal,
      onRoute: (route) => {
        if (controller.signal.aborted) return;
        state.routes = [...state.routes, route];
        rerank({ fresh: true });
        drawRoutes();
        panel.addRoute(route, ranking());
        panel.select(state.selectedId);
      },
    });
  } catch (err) {
    if (controller.signal.aborted || (err instanceof RouteError && err.code === 'aborted')) return;
  }
  if (controller.signal.aborted) return;
  state.searching = false;
  panel.rank(ranking());
  computeMatches();
  panel.updateTraffic(state.matches);
  map.fitRoutes(state.routes);
}

function selectRoute(id) {
  if (!state.routes.some((r) => r.id === id) || id === state.selectedId) return;
  state.selectedId = id;
  state.userSelected = true;
  drawRoutes();
  panel.select(id);
  panel.clearSuggestion();
  markCurrentAlertsSeen();
}

function markCurrentAlertsSeen() {
  computeMatches();
  const m = state.matches.get(state.selectedId);
  if (m) m.alerts.forEach((a) => state.seenAlerts.add(a.key));
}

function computeMatches() {
  const views = store.list();
  state.matches = new Map(state.routes.map((r) => [r.id, matchRouteToTraffic(r, views, cfg.traffic)]));
}

// -------------------------------------------------------------- traffic

function scheduleTrafficRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; renderTraffic(); }, 250);
}

function renderTraffic() {
  const views = store.list();
  const located = views.filter((v) => v.located);
  const live = located.filter((v) => v.status === 'live').length;
  map.setIntersections(views);
  panel.setFeed({ connection: store.connection, total: located.length, live });

  let text;
  if (store.connection === 'unavailable') text = 'Live feed unavailable';
  else if (store.connection !== 'connected') text = 'Disconnected - showing last known data';
  else if (!located.length) text = 'No monitored intersections with known positions';
  else text = `${live} of ${located.length} reporting live`;
  layers.setStatus('traffic', text);

  if (!state.routes.length) return;
  computeMatches();
  panel.updateTraffic(state.matches);

  // Live traffic changed: re-rank from the data already here (no route
  // requests). Lines and list items are restyled and moved in place.
  if (rerank()) {
    drawRoutes();
    panel.rank(ranking());
    panel.select(state.selectedId);
  }

  const suggestion = findRerouteSuggestion({
    routes: state.routes,
    selectedId: state.selectedId,
    matches: state.matches,
    seenAlertKeys: state.seenAlerts,
  });
  if (suggestion && !state.dismissed.has(suggestion.key)) {
    panel.showSuggestion(suggestion);
    if (suggestion.alert) state.seenAlerts.add(suggestion.alert.key);
  }

  // Backend-evaluated routes are refreshed when traffic changes (throttled).
  if (state.trafficRouting === 'backend' && Date.now() - state.lastTrafficRefresh > cfg.routing.trafficRefreshMs) {
    state.lastTrafficRefresh = Date.now();
    requestRoutes({ force: true });
  }
}

async function loadIntersections() {
  try {
    const res = await fetch('/api/intersections', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { intersections } = await res.json();
    store.setIntersections(intersections);
    const pts = intersections.filter((i) => Number.isFinite(i.lat) && Number.isFinite(i.lng)).map((i) => [i.lat, i.lng]);
    if (pts.length && !state.routes.length) map.fitPoints(pts, 15);
  } catch {
    // The map stays on the configured fallback view; routing still works.
  }
}

// -------------------------------------------------------------- hazards

const HAZARD_IDS = ['speed_camera', 'speed_bump', 'road_closure'];

function hazardLayersOn() {
  return hazardKinds.some((id) => layers.isOn(id));
}

function onHazardState(next) {
  hazardState = next;
  map.setHazards(next.hazards);
  const view = map.getView();
  for (const id of hazardKinds) { // unsupported kinds keep "No data source connected"
    if (!layers.isOn(id) && next.status !== 'ready') continue;
    let text;
    switch (next.status) {
      case 'zoom-in': text = 'Zoom in to load'; break;
      case 'loading': text = 'Loading...'; break;
      case 'offline': text = 'Offline'; break;
      case 'error': text = next.hazards.length
        ? 'Could not load this area - showing earlier results only'
        : 'Unavailable - data service not reachable'; break;
      case 'ready': {
        const n = next.hazards.filter((h) => h.kind === id && bboxContains(view.bbox, { south: h.lat, north: h.lat, west: h.lng, east: h.lng })).length;
        text = n ? `${n} in view (OpenStreetMap)` : 'None mapped in this area';
        break;
      }
      default: text = '';
    }
    layers.setStatus(id, text);
  }
}

function onViewChanged(view) {
  if (hazardLayersOn()) hazardLoader.request(view);
  else if (hazardState.status === 'ready') onHazardState(hazardState);
}

function onLayerToggle(id, visible) {
  map.setLayerVisible(id, visible);
  if (HAZARD_IDS.includes(id) && visible) hazardLoader.requestNow(map.getView());
}

// ----------------------------------------------------------------- boot

function boot() {
  if (window.smartTrafficNav) return; // one page, one app instance
  status = createStatus({ banner: $('nv-offline'), toast: $('nv-toast') });
  store = createTrafficStore({ staleAfterSeconds: cfg.traffic.staleAfterSeconds });

  map = new NavMap($('nv-map'), {
    onPointChosen: (kind, point) => {
      const label = `Map point ${formatCoords(point)}`;
      if (kind === 'start') setStart(point, label);
      else { search.setValue(label); setDestination(point, label); }
    },
    onRouteSelected: selectRoute,
    onViewChanged,
  });

  const provider = createHazardProvider();
  hazardKinds = provider.kinds;
  layers = new LayersPanel({
    root: $('nv-layers'),
    button: $('nv-layers-btn'),
    supported: ['traffic', ...provider.kinds],
    onToggle: onLayerToggle,
  });
  for (const id of HAZARD_IDS) map.setLayerVisible(id, layers.isOn(id));
  hazardLoader = createHazardLoader({ provider, onState: onHazardState, isOnline: () => navigator.onLine });

  panel = new RoutePanel({
    root: $('nv-sheet'),
    toggle: $('nv-sheet-toggle'),
    feed: $('nv-feed'),
    body: $('nv-sheet-body'),
    onSelect: selectRoute,
    onRetry: () => requestRoutes({ force: false }),
    onSwitch: (id) => selectRoute(id),
    onDismiss: (key) => { if (key) state.dismissed.add(key); },
  });

  search = new SearchBox({
    form: $('nv-search'),
    input: $('nv-dest'),
    results: $('nv-results'),
    message: $('nv-search-msg'),
    geocoder: createGeocoder(),
    getViewbox: () => map.getView().bbox,
    onSelect: (place) => setDestination({ lat: place.lat, lng: place.lng }, place.name),
    onCleared: clearDestination,
  });

  $('nv-locate').addEventListener('click', () => locate({ asStart: false }));
  $('nv-from-locate').addEventListener('click', () => locate({ asStart: true }));
  $('nv-from-center').addEventListener('click', () => {
    const c = map.getCenter();
    setStart(c, `Map centre ${formatCoords(c)}`);
  });

  const ro = new ResizeObserver(updateInsets);
  ro.observe($('nv-top'));
  ro.observe($('nv-sheet'));
  window.addEventListener('resize', updateInsets);
  updateInsets();

  status.setOffline(!navigator.onLine);
  window.addEventListener('offline', () => status.setOffline(true));
  window.addEventListener('online', () => {
    status.setOffline(false);
    if (hazardLayersOn()) hazardLoader.retry(map.getView());
  });

  store.subscribe(scheduleTrafficRender);
  connectTrafficFeed(store);
  loadIntersections();
  setInterval(renderTraffic, 5000); // keeps "updated N s ago" and staleness current

  // Release the connection when the page is hidden for good / restored from cache.
  window.addEventListener('pagehide', () => { disconnectTrafficFeed(store); hazardLoader.cancel(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) connectTrafficFeed(store); });

  prompt();
  renderTraffic();
  if (hazardLayersOn()) hazardLoader.request(map.getView());

  window.smartTrafficNav = Object.freeze({
    diagnostics: () => ({
      ...map.diagnostics(),
      feed: feedDiagnostics(),
      storeListeners: store.listenerCount(),
      routes: state.routes.length,
      selectedRoute: state.selectedId,
      ranking: state.order.map((id, i) => ({
        rank: i + 1, id, minutes: +(state.estimates.get(id).duration / 60).toFixed(2),
        liveDelaySeconds: Math.round(state.estimates.get(id).delay),
      })),
      liveState: state.liveState,
      hazardStatus: hazardState.status,
    }),
  });
}

boot();
