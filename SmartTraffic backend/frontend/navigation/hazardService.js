import { NAV_CONFIG } from './config.js';
import { bboxContains, isValidLatLng, padBBox } from './geo.js';

/**
 * Road hazard data (no DOM). The map only sees normalised hazards, so the
 * data source can be replaced without touching the UI.
 *
 * Hazard:
 *   { id, kind: 'speed_camera' | 'speed_bump' | 'road_closure', lat, lng,
 *     source, verification: 'community' | 'verified' | 'unverified',
 *     label, details: { maxspeed?, direction?, reportedAt? }, url? }
 *
 * Provider: { name, kinds: string[], fetchHazards(bbox, { signal }) -> Promise<Hazard[]> }
 *
 * Two providers, both served by the SmartTraffic backend:
 *   createOverpassProvider  OpenStreetMap speed cameras / bumps, via the
 *                           backend's Overpass proxy (GET /api/osm/hazards)
 *   createBackendProvider   drivers' reports approved on admin.html (GET /api/hazards)
 */

export const HAZARD_KINDS = ['speed_camera', 'speed_bump', 'road_closure'];

export const VERIFICATION_TEXT = {
  community: 'Mapped by OpenStreetMap contributors - not verified by SmartTraffic',
  verified: 'Verified',
  unverified: 'Unverified user report',
};

// traffic_calming=yes: calming of an unstated type, in practice almost always a bump.
const CALMING_TYPES = {
  bump: 'Speed bump', hump: 'Speed hump', yes: 'Speed bump', table: 'Speed table', cushion: 'Speed cushion',
};

export class HazardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // network | provider | timeout | aborted | offline
  }
}

// ------------------------------------------------------------------ overpass

export function buildOverpassQuery(bbox, maxResults = NAV_CONFIG.hazards.maxResults) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const calming = `"traffic_calming"~"^(${Object.keys(CALMING_TYPES).join('|')})$"`;
  return `[out:json][timeout:20];(node["highway"="speed_camera"](${b});node[${calming}](${b});way[${calming}](${b}););out center tags ${maxResults};`;
}

/** Overpass JSON -> Hazard[]. Elements without a position or a known kind are skipped. */
export function parseOverpass(json) {
  const out = [];
  for (const el of (json && json.elements) || []) {
    const tags = el.tags || {};
    const lat = Number.isFinite(el.lat) ? el.lat : el.center && el.center.lat;
    const lng = Number.isFinite(el.lon) ? el.lon : el.center && el.center.lon;
    if (!isValidLatLng({ lat, lng })) continue;

    let kind = null;
    let label = null;
    const details = {};
    if (tags.highway === 'speed_camera') {
      kind = 'speed_camera';
      label = 'Speed camera';
      if (tags.maxspeed) details.maxspeed = String(tags.maxspeed);
      if (tags.direction) details.direction = String(tags.direction);
    } else if (CALMING_TYPES[tags.traffic_calming]) {
      kind = 'speed_bump';
      label = CALMING_TYPES[tags.traffic_calming];
    }
    if (!kind) continue;
    out.push({
      id: `osm-${el.type}-${el.id}`,
      kind,
      lat,
      lng,
      source: 'OpenStreetMap',
      verification: 'community',
      label,
      details,
      url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    });
  }
  return out;
}

/**
 * Overpass JSON ({ elements }) for one layer and area from the backend's
 * OpenStreetMap proxy (backend/routes/osmRoutes.js). The backend builds the
 * query, identifies itself to Overpass and caches answers; public Overpass
 * instances refuse many anonymous browser clients.
 */
export async function fetchOsmLayer(url, bbox, { signal, timeoutMs = 30000 } = {}) {
  const params = new URLSearchParams({ south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east });
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    let res;
    try {
      res = await fetch(`${url}?${params}`, { signal: controller.signal });
    } catch {
      if (signal && signal.aborted) throw new HazardError('aborted', 'Request cancelled.');
      throw new HazardError(timedOut ? 'timeout' : 'network', timedOut ? 'Map data service timed out.' : 'Map data service could not be reached.');
    }
    if (!res.ok) throw new HazardError('provider', `Map data service answered HTTP ${res.status}.`);
    const json = await res.json().catch(() => null);
    if (!json || !Array.isArray(json.elements)) throw new HazardError('provider', 'Map data service returned unreadable data.');
    return json;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export function createOverpassProvider(cfg = NAV_CONFIG.hazards) {
  return {
    name: 'OpenStreetMap',
    kinds: ['speed_camera', 'speed_bump'],
    async fetchHazards(bbox, { signal } = {}) {
      return parseOverpass(await fetchOsmLayer(cfg.osmUrl, bbox, { signal, timeoutMs: cfg.timeoutMs }));
    },
  };
}

// ------------------------------------------------------------------- backend

/** Validates a project-backend answer { hazards: [...] } -> Hazard[]. */
export function parseBackendHazards(json) {
  const out = [];
  for (const h of (json && json.hazards) || []) {
    if (!h || !HAZARD_KINDS.includes(h.kind) || !isValidLatLng(h) || typeof h.id !== 'string') continue;
    const verification = ['verified', 'unverified', 'community'].includes(h.verification) ? h.verification : 'unverified';
    out.push({
      id: `backend-${h.id}`,
      kind: h.kind,
      lat: h.lat,
      lng: h.lng,
      source: typeof h.source === 'string' && h.source ? h.source : 'SmartTraffic',
      verification,
      label: typeof h.label === 'string' && h.label ? h.label : null,
      details: { reportedAt: Number.isFinite(Date.parse(h.reportedAt)) ? h.reportedAt : undefined },
      url: null,
    });
  }
  return out;
}

export function createBackendProvider(cfg = NAV_CONFIG.reports) {
  return {
    name: 'Driver reports',
    kinds: [...HAZARD_KINDS],
    async fetchHazards(bbox, { signal } = {}) {
      const params = new URLSearchParams({ south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east });
      let res;
      try {
        res = await fetch(`${cfg.backendUrl}?${params}`, { signal, cache: 'no-store' });
      } catch {
        if (signal && signal.aborted) throw new HazardError('aborted', 'Request cancelled.');
        throw new HazardError('network', 'Hazard service could not be reached.');
      }
      if (!res.ok) throw new HazardError('provider', `Hazard service answered HTTP ${res.status}.`);
      return parseBackendHazards(await res.json().catch(() => null));
    },
  };
}

// -------------------------------------------------------------------- loader

// ------------------------------------------------------------ operator data

const FEATURE_LABEL = { speed_camera: 'Speed camera', speed_bump: 'Speed bump', road_closure: 'Road closure' };

/**
 * Operator-managed road features (GET /api/v1/road-features, stored in the
 * backend's database, no OpenStreetMap needed) -> Hazard[]. Kinds the map
 * has no layer for (roadworks) are skipped.
 */
export function parseRoadFeatures(json) {
  const out = [];
  for (const f of (json && json.features) || []) {
    if (!f || !HAZARD_KINDS.includes(f.kind) || !isValidLatLng(f) || typeof f.id !== 'string') continue;
    const details = {};
    if (Number.isFinite(f.speedLimitKmh)) details.maxspeed = String(f.speedLimitKmh);
    if (Number.isFinite(Date.parse(f.updatedAt))) details.reportedAt = f.updatedAt;
    out.push({
      id: `operator-${f.id}`,
      kind: f.kind,
      lat: f.lat,
      lng: f.lng,
      source: typeof f.source === 'string' && f.source ? f.source : 'SmartTraffic operator',
      verification: 'verified',
      label: typeof f.name === 'string' && f.name ? f.name : FEATURE_LABEL[f.kind],
      details,
      url: null,
    });
  }
  return out;
}

export function createRoadFeatureProvider(cfg = NAV_CONFIG.roadFeatures) {
  return {
    name: 'Operator road features',
    kinds: [...HAZARD_KINDS],
    async fetchHazards(bbox, { signal } = {}) {
      const params = new URLSearchParams({
        south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east, sources: 'operator', kinds: HAZARD_KINDS.join(','),
      });
      let res;
      try {
        res = await fetch(`${cfg.url}?${params}`, { signal, cache: 'no-store' });
      } catch {
        if (signal && signal.aborted) throw new HazardError('aborted', 'Request cancelled.');
        throw new HazardError('network', 'Road feature service could not be reached.');
      }
      if (!res.ok) throw new HazardError('provider', `Road feature service answered HTTP ${res.status}.`);
      return parseRoadFeatures(await res.json().catch(() => null));
    },
  };
}

/**
 * Loads hazards for the visible map area: debounced, cached by area,
 * one request at a time, and backing off after a provider error.
 *
 * onState({ status, hazards, message })
 *   status: 'idle' | 'zoom-in' | 'loading' | 'ready' | 'error' | 'offline'
 * After a failed load, hazards loaded earlier stay available (they are real
 * mapped features); `hazards` then only covers previously loaded areas.
 * With cfg.maxAgeMs, a loaded area is fetched again once older than that
 * (data that changes, such as newly approved reports).
 */
export function createHazardLoader({ provider, onState, cfg = NAV_CONFIG.hazards, now = () => Date.now(), isOnline = () => true }) {
  let timer = null;
  let controller = null;
  let covered = null; // bbox of the last successful load
  let loadedAt = 0;
  let loading = null; // { area } of the load in flight
  let hazards = [];
  let failedAt = null; // time of the last failed load, null after a success
  let pending = null;

  const emit = (status, message = '') => onState({ status, hazards, message });

  async function run({ bbox, zoom }) {
    if (zoom < cfg.minZoom) { emit('zoom-in'); return; }
    const fresh = !cfg.maxAgeMs || now() - loadedAt < cfg.maxAgeMs;
    if (covered && fresh && bboxContains(covered, bbox)) { emit('ready'); return; }
    if (loading && bboxContains(loading.area, bbox)) return; // the load in flight covers this view
    if (!isOnline()) { emit('offline', 'You are offline.'); return; }
    if (failedAt !== null && now() - failedAt < cfg.retryAfterMs) { emit('error', 'Hazard data unavailable - the data service could not be reached.'); return; }

    if (controller) controller.abort();
    controller = new AbortController();
    const area = padBBox(bbox, 0.25);
    const mine = { area };
    loading = mine;
    emit('loading');
    try {
      hazards = await provider.fetchHazards(area, { signal: controller.signal });
      covered = area;
      loadedAt = now();
      failedAt = null;
      emit('ready');
    } catch (err) {
      if (err.code === 'aborted') return;
      failedAt = now();
      emit('error', 'Hazard data unavailable - the data service could not be reached.');
    } finally {
      if (loading === mine) loading = null;
    }
  }

  return {
    /** Request hazards for a view; debounced. */
    request(view) {
      pending = view;
      clearTimeout(timer);
      timer = setTimeout(() => run(pending), cfg.debounceMs);
    },
    /** Run immediately (used in tests and on layer enable). */
    requestNow(view) {
      clearTimeout(timer);
      return run(view);
    },
    retry(view) {
      failedAt = null;
      return this.requestNow(view);
    },
    cancel() {
      clearTimeout(timer);
      if (controller) controller.abort();
    },
  };
}
