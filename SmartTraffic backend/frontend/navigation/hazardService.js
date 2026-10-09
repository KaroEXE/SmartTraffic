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
 */

export const HAZARD_KINDS = ['speed_camera', 'speed_bump', 'road_closure'];

export const VERIFICATION_TEXT = {
  community: 'Mapped by OpenStreetMap contributors - not verified by SmartTraffic',
  verified: 'Verified',
  unverified: 'Unverified user report',
};

const CALMING_TYPES = { bump: 'Speed bump', hump: 'Speed hump', table: 'Speed table', cushion: 'Speed cushion' };

export class HazardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // network | provider | timeout | aborted | offline
  }
}

// ------------------------------------------------------------------ overpass

export function buildOverpassQuery(bbox, maxResults = NAV_CONFIG.hazards.maxResults) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const calming = '"traffic_calming"~"^(bump|hump|table|cushion)$"';
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

async function postWithTimeout(url, body, { signal, timeoutMs }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (signal && signal.aborted) throw new HazardError('aborted', 'Request cancelled.');
    throw new HazardError(timedOut ? 'timeout' : 'network', timedOut ? 'Hazard service timed out.' : 'Hazard service could not be reached.');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export function createOverpassProvider(cfg = NAV_CONFIG.hazards) {
  return {
    name: 'OpenStreetMap (Overpass API)',
    kinds: ['speed_camera', 'speed_bump'],
    async fetchHazards(bbox, { signal } = {}) {
      const body = new URLSearchParams({ data: buildOverpassQuery(bbox, cfg.maxResults) }).toString();
      let lastError = null;
      // Public instances are often busy; try each configured one in turn.
      for (const url of cfg.overpassUrls) {
        try {
          const res = await postWithTimeout(url, body, { signal, timeoutMs: cfg.timeoutMs });
          if (!res.ok) { lastError = new HazardError('provider', `Hazard service answered HTTP ${res.status}.`); continue; }
          const json = await res.json().catch(() => null);
          if (!json || !Array.isArray(json.elements)) { lastError = new HazardError('provider', 'Hazard service returned unreadable data.'); continue; }
          return parseOverpass(json);
        } catch (err) {
          if (err.code === 'aborted') throw err;
          lastError = err;
        }
      }
      throw lastError || new HazardError('provider', 'No hazard service configured.');
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

export function createBackendProvider(cfg = NAV_CONFIG.hazards) {
  return {
    name: 'SmartTraffic hazard service',
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

export function createHazardProvider(cfg = NAV_CONFIG.hazards) {
  if (cfg.provider === 'backend' && cfg.backendUrl) return createBackendProvider(cfg);
  return createOverpassProvider(cfg);
}

// -------------------------------------------------------------------- loader

/**
 * Loads hazards for the visible map area: debounced, cached by area,
 * one request at a time, and backing off after a provider error.
 *
 * onState({ status, hazards, message })
 *   status: 'idle' | 'zoom-in' | 'loading' | 'ready' | 'error' | 'offline'
 * After a failed load, hazards loaded earlier stay available (they are real
 * mapped features); `hazards` then only covers previously loaded areas.
 */
export function createHazardLoader({ provider, onState, cfg = NAV_CONFIG.hazards, now = () => Date.now(), isOnline = () => true }) {
  let timer = null;
  let controller = null;
  let covered = null; // bbox of the last successful load
  let hazards = [];
  let failedAt = null; // time of the last failed load, null after a success
  let pending = null;

  const emit = (status, message = '') => onState({ status, hazards, message });

  async function run({ bbox, zoom }) {
    if (zoom < cfg.minZoom) { emit('zoom-in'); return; }
    if (covered && bboxContains(covered, bbox)) { emit('ready'); return; }
    if (!isOnline()) { emit('offline', 'You are offline.'); return; }
    if (failedAt !== null && now() - failedAt < cfg.retryAfterMs) { emit('error', 'Hazard data unavailable - the data service could not be reached.'); return; }

    if (controller) controller.abort();
    controller = new AbortController();
    const area = padBBox(bbox, 0.25);
    emit('loading');
    try {
      hazards = await provider.fetchHazards(area, { signal: controller.signal });
      covered = area;
      failedAt = null;
      emit('ready');
    } catch (err) {
      if (err.code === 'aborted') return;
      failedAt = now();
      emit('error', 'Hazard data unavailable - the data service could not be reached.');
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
