import { NAV_CONFIG } from './config.js';
import { isValidLatLng } from './geo.js';

/**
 * Route planning. Road-following routes come from OSRM; a straight line is
 * never used as a route. When `trafficRoutesUrl` is configured, the backend
 * is asked first for traffic-adjusted routes and OSRM is the fallback.
 *
 * Normalised route:
 *   { id, index, source: 'osrm' | 'backend', coordinates: [[lat, lng]...],
 *     distance (m), duration (s, base estimate), summary,
 *     traffic: null | { adjustedDuration, delay, basis: 'live-ai', updatedAt, alerts: [{ message }] } }
 *
 * `traffic` is non-null only when the backend supplied a valid adjustment.
 */

export class RouteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RouteError';
    this.code = code; // invalid-input | no-route | provider | network | timeout | offline | aborted
  }
}

const OSRM_MESSAGES = {
  NoRoute: 'No drivable route was found between these points.',
  NoSegment: 'One of the points is too far from any road. Choose a point on or near a road.',
  InvalidValue: 'The routing service rejected the coordinates.',
  InvalidQuery: 'The routing service rejected the request.',
  InvalidUrl: 'The routing service rejected the request.',
  TooBig: 'The route request is too large for the routing service.',
};

export function buildOsrmUrl(start, destination, cfg = NAV_CONFIG.routing) {
  const coords = `${start.lng},${start.lat};${destination.lng},${destination.lat}`;
  const params = new URLSearchParams({
    alternatives: String(Math.max(0, cfg.maxRoutes - 1)),
    overview: 'full',
    geometries: 'geojson',
    steps: 'true', // needed for the road-name summary; steps themselves are not kept
  });
  return `${cfg.osrmUrl.replace(/\/$/, '')}/route/v1/${cfg.profile}/${coords}?${params}`;
}

function lineToLatLngs(geometry) {
  if (!geometry || geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates)) return null;
  const out = [];
  for (const c of geometry.coordinates) {
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
    out.push([c[1], c[0]]);
  }
  return out.length >= 2 ? out : null;
}

/**
 * A backend traffic adjustment is accepted only when it is complete and
 * explicitly based on live AI observations; anything else is ignored.
 */
export function validTrafficAdjustment(traffic, baseDuration) {
  if (!traffic || typeof traffic !== 'object') return null;
  const { adjustedDuration, basis, updatedAt } = traffic;
  if (basis !== 'live-ai') return null;
  if (!Number.isFinite(adjustedDuration) || adjustedDuration < 0) return null;
  if (!Number.isFinite(Date.parse(updatedAt))) return null;
  const delay = Number.isFinite(traffic.delay) ? traffic.delay : adjustedDuration - baseDuration;
  const alerts = Array.isArray(traffic.alerts)
    ? traffic.alerts.filter((a) => a && typeof a.message === 'string' && a.message.trim()).map((a) => ({ message: a.message.trim() }))
    : [];
  return { adjustedDuration, delay, basis, updatedAt, alerts };
}

function normalizeRoute(raw, index, source) {
  const coordinates = lineToLatLngs(raw.geometry);
  if (!coordinates || !Number.isFinite(raw.distance) || !Number.isFinite(raw.duration)) return null;
  const summary = typeof raw.summary === 'string'
    ? raw.summary
    : Array.isArray(raw.legs) ? raw.legs.map((l) => l && l.summary).filter(Boolean).join(', ') : '';
  return {
    id: `${source}-${index}`,
    index,
    source,
    coordinates,
    distance: raw.distance,
    duration: raw.duration,
    summary,
    traffic: source === 'backend' ? validTrafficAdjustment(raw.traffic, raw.duration) : null,
  };
}

/** OSRM JSON -> { routes, snapWarnings } or throws RouteError. */
export function normalizeOsrmResponse(json, cfg = NAV_CONFIG.routing) {
  if (!json || typeof json !== 'object') throw new RouteError('provider', 'The routing service returned an unreadable answer.');
  if (json.code !== 'Ok') {
    const code = json.code === 'NoRoute' || json.code === 'NoSegment' ? 'no-route' : 'provider';
    throw new RouteError(code, OSRM_MESSAGES[json.code] || 'The routing service could not plan this route.');
  }
  const routes = (json.routes || [])
    .slice(0, cfg.maxRoutes)
    .map((r, i) => normalizeRoute(r, i, 'osrm'))
    .filter(Boolean);
  if (!routes.length) throw new RouteError('no-route', OSRM_MESSAGES.NoRoute);

  const snapWarnings = [];
  (json.waypoints || []).forEach((w, i) => {
    if (w && Number.isFinite(w.distance) && w.distance > cfg.snapWarningMeters) {
      snapWarnings.push(`${i === 0 ? 'Start' : 'Destination'} is ${Math.round(w.distance)} m from the nearest road; the route starts from that road.`);
    }
  });
  return { routes, snapWarnings };
}

/** Backend JSON { routes: [...] } -> routes, or null when unusable. */
export function normalizeBackendResponse(json, cfg = NAV_CONFIG.routing) {
  if (!json || !Array.isArray(json.routes)) return null;
  const routes = json.routes.slice(0, cfg.maxRoutes).map((r, i) => normalizeRoute(r, i, 'backend')).filter(Boolean);
  return routes.length ? routes : null;
}

async function fetchJson(url, init, { signal, timeoutMs }) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new RouteError('offline', 'You are offline. Routing needs an internet connection.');
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) throw new RouteError('aborted', 'Request cancelled.');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let json = null;
    try { json = await res.json(); } catch { /* handled below */ }
    return { res, json };
  } catch (err) {
    if (timedOut) throw new RouteError('timeout', 'The routing service did not answer in time.');
    if (signal && signal.aborted) throw new RouteError('aborted', 'Request cancelled.');
    throw new RouteError('network', 'The routing service could not be reached.');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function fetchOsrm(start, destination, signal, cfg) {
  const { res, json } = await fetchJson(buildOsrmUrl(start, destination, cfg), {}, { signal, timeoutMs: cfg.timeoutMs });
  if (!json) throw new RouteError('provider', `The routing service returned an error (HTTP ${res.status}).`);
  return normalizeOsrmResponse(json, cfg);
}

async function fetchBackend(start, destination, signal, cfg) {
  const { res, json } = await fetchJson(cfg.trafficRoutesUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start, destination, maxRoutes: cfg.maxRoutes }),
  }, { signal, timeoutMs: cfg.timeoutMs });
  return res.ok ? normalizeBackendResponse(json, cfg) : null;
}

/**
 * Plans routes between two points.
 * Resolves { routes, snapWarnings, trafficRouting: 'backend' | 'unavailable' | 'not-configured' }.
 */
export async function planRoutes(start, destination, { signal, cfg = NAV_CONFIG.routing } = {}) {
  if (!isValidLatLng(start) || !isValidLatLng(destination)) {
    throw new RouteError('invalid-input', 'Start or destination coordinates are invalid.');
  }
  if (start.lat === destination.lat && start.lng === destination.lng) {
    throw new RouteError('invalid-input', 'Start and destination are the same point.');
  }

  if (cfg.trafficRoutesUrl) {
    try {
      const routes = await fetchBackend(start, destination, signal, cfg);
      if (routes) return { routes, snapWarnings: [], trafficRouting: 'backend' };
    } catch (err) {
      if (err.code === 'aborted' || err.code === 'offline') throw err;
    }
    const osrm = await fetchOsrm(start, destination, signal, cfg);
    return { ...osrm, trafficRouting: 'unavailable' };
  }
  const osrm = await fetchOsrm(start, destination, signal, cfg);
  return { ...osrm, trafficRouting: 'not-configured' };
}

/** Effective duration for ranking: adjusted only when every route has a valid adjustment. */
export function rankRoutes(routes) {
  const allAdjusted = routes.length > 0 && routes.every((r) => r.traffic);
  const time = (r) => (allAdjusted ? r.traffic.adjustedDuration : r.duration);
  let fastest = null;
  for (const r of routes) if (!fastest || time(r) < time(fastest)) fastest = r;
  return { fastestId: fastest ? fastest.id : null, basis: allAdjusted ? 'live-ai' : 'base' };
}
