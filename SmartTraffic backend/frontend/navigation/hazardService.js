import { NAV_CONFIG } from './config.js';
import {
  bboxContains, clampBBox, isValidLatLng, padBBox,
} from './geo.js';

/**
 * Road hazard data (no DOM). The map only sees normalised hazards, so the
 * data source can be replaced without touching the UI.
 *
 * Hazard:
 *   { id, kind: 'speed_camera' | 'speed_bump' | 'road_closure', lat, lng,
 *     source, verification: 'verified' | 'unverified',
 *     label, details: { maxspeed?, direction?, reportedAt? }, url? }
 *
 * Provider: { name, kinds: string[], fetchHazards(bbox, { signal }) -> Promise<Hazard[]> }
 *
 * One provider, served by the SmartTraffic backend:
 *   createRoadFeatureProvider  speed cameras, bumps and closures entered by the
 *                              operator (GET /api/v1/road-features, database)
 */

export const HAZARD_KINDS = ['speed_camera', 'speed_bump', 'road_closure'];

export const VERIFICATION_TEXT = {
  verified: 'Verified',
  unverified: 'Unverified user report',
};

export class HazardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // network | provider | timeout | aborted | offline
  }
}

// ------------------------------------------------------------ operator data

const FEATURE_LABEL = { speed_camera: 'Speed camera', speed_bump: 'Speed bump', road_closure: 'Road closure' };

/**
 * Operator-managed road features (GET /api/v1/road-features, stored in the
 * backend's database, no map provider needed) -> Hazard[]. Kinds the map
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
        south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east, kinds: HAZARD_KINDS.join(','),
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

// ------------------------------------------------- driver reports and places

const REPORT_ICON = {
  accident: 'accident', traffic_jam: 'traffic_jam', road_closure: 'road_closure', construction: 'construction', hazard: 'hazard',
};

/** GET /api/v1/reports -> Hazard[] of kind "report" (only active reports are listed by the backend). */
export function parseReports(json) {
  const out = [];
  for (const r of (json && json.reports) || []) {
    if (!r || typeof r.id !== 'string' || !isValidLatLng(r) || r.status !== 'active') continue;
    const details = {};
    if (typeof r.description === 'string' && r.description) details.description = r.description;
    if (Number.isFinite(Date.parse(r.createdAt))) details.reportedAt = r.createdAt;
    if (Number.isFinite(Date.parse(r.expiresAt))) details.expiresAt = r.expiresAt;
    if (Number.isFinite(r.confirmations) && Number.isFinite(r.dismissals)) details.votes = `${r.confirmations} confirmed, ${r.dismissals} disputed`;
    out.push({
      id: `report-${r.id}`,
      kind: 'report',
      icon: REPORT_ICON[r.type] || 'hazard',
      lat: r.lat,
      lng: r.lng,
      source: 'Driver report',
      verification: r.verification === 'verified' ? 'verified' : 'unverified',
      label: typeof r.label === 'string' && r.label ? r.label : 'Driver report',
      details,
      url: null,
    });
  }
  return out;
}

/** GET /api/v1/places/local -> Hazard[] of kind "place". */
export function parsePlaces(json) {
  const out = [];
  for (const p of (json && json.places) || []) {
    if (!p || typeof p.id !== 'string' || !isValidLatLng(p) || typeof p.name !== 'string') continue;
    out.push({
      id: `place-${p.id}`,
      kind: 'place',
      icon: 'place',
      lat: p.lat,
      lng: p.lng,
      source: 'Hawr',
      verification: 'verified',
      label: p.name,
      details: p.description ? { description: p.description } : {},
      url: null,
    });
  }
  return out;
}

/** A provider for one of the backend's area listings (reports, local places). */
function createAreaProvider({ name, kind, cfg, parse, failure }) {
  return {
    name,
    kinds: [kind],
    async fetchHazards(bbox, { signal } = {}) {
      const params = new URLSearchParams({
        south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east,
      });
      let res;
      try {
        res = await fetch(`${cfg.url}?${params}`, { signal, cache: 'no-store' });
      } catch {
        if (signal && signal.aborted) throw new HazardError('aborted', 'Request cancelled.');
        throw new HazardError('network', `${failure} could not be reached.`);
      }
      if (!res.ok) throw new HazardError('provider', `${failure} answered HTTP ${res.status}.`);
      return parse(await res.json().catch(() => null));
    },
  };
}

export const createReportProvider = (cfg = NAV_CONFIG.reports) => createAreaProvider({
  name: 'Driver reports', kind: 'report', cfg, parse: parseReports, failure: 'Report service',
});

export const createPlaceProvider = (cfg = NAV_CONFIG.places) => createAreaProvider({
  name: 'Hawr places', kind: 'place', cfg, parse: parsePlaces, failure: 'Places service',
});

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
export function createHazardLoader({ provider, onState, cfg = NAV_CONFIG.roadFeatures, now = () => Date.now(), isOnline = () => true }) {
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
    // The backend refuses areas wider than its limit: a big screen at the minimum zoom is cut down to it.
    const area = cfg.maxSpanDeg ? clampBBox(padBBox(bbox, 0.25), cfg.maxSpanDeg) : padBBox(bbox, 0.25);
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
    /** Fetch again now: after an error, or when the data is known to have changed. */
    retry(view) {
      failedAt = null;
      covered = null;
      return this.requestNow(view);
    },
    cancel() {
      clearTimeout(timer);
      if (controller) controller.abort();
    },
  };
}
