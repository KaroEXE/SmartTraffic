import { NAV_CONFIG } from './config.js';
import { isValidLatLng } from './geo.js';

/**
 * Route planning through the SmartTraffic backend (POST /api/v1/routes), which
 * asks the routing provider. A straight line is never used as a route. The page never talks
 * to the map provider itself.
 *
 * Normalised route:
 *   { id, index, source: 'backend', coordinates: [[lat, lng]...],
 *     distance (m), duration (s, the provider's free-flow estimate), summary,
 *     traffic: null }
 *
 * `traffic` stays null: live AI delays are added in the browser from the live
 * feed (routeRanking.estimateRoute), which is fresher than the answer of a
 * request, and the two must not be counted twice.
 */

export class RouteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RouteError';
    this.code = code; // invalid-input | no-route | provider | busy | network | timeout | offline | aborted
  }
}

/** Backend error code -> [RouteError code, message for the driver]. */
const BACKEND_ERRORS = {
  NO_ROUTE: ['no-route', 'No drivable route was found between these points.'],
  POINT_NOT_ROUTABLE: ['no-route', 'One of the points is too far from any road. Choose a point on or near a road.'],
  INVALID_REQUEST: ['invalid-input', 'The route request was not accepted. Check the start and destination.'],
  RATE_LIMITED: ['busy', 'Too many route requests. Wait a moment and try again.'],
  PROVIDER_BUSY: ['busy', 'The routing service is busy. Try again shortly.'],
  PROVIDER_QUOTA_EXCEEDED: ['busy', 'The routing quota for today is used up. Try again later.'],
  FEATURE_DISABLED: ['provider', 'Routing is not set up on this server.'],
  PROVIDER_AUTH_FAILED: ['provider', 'Routing is not set up correctly on this server.'],
  PROVIDER_TIMEOUT: ['timeout', 'The routing service did not answer in time.'],
};

function lineToLatLngs(geometry) {
  if (!geometry || geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates)) return null;
  const out = [];
  for (const c of geometry.coordinates) {
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
    out.push([c[1], c[0]]);
  }
  return out.length >= 2 ? out : null;
}

function normalizeRoute(raw, index) {
  const coordinates = lineToLatLngs(raw && raw.geometry);
  if (!coordinates || !Number.isFinite(raw.distance) || !Number.isFinite(raw.duration)) return null;
  return {
    id: `backend-${index}`,
    index,
    source: 'backend',
    coordinates,
    distance: raw.distance,
    duration: raw.duration,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    traffic: null,
  };
}

/** Backend JSON { routes, snapWarnings } -> { routes, snapWarnings }, or null when no route is usable. */
export function normalizeBackendResponse(json, cfg = NAV_CONFIG.routing) {
  if (!json || !Array.isArray(json.routes)) return null;
  const routes = json.routes.slice(0, cfg.maxRoutes).map((r, i) => normalizeRoute(r, i)).filter(Boolean);
  if (!routes.length) return null;
  const snapWarnings = Array.isArray(json.snapWarnings) ? json.snapWarnings.filter((w) => typeof w === 'string') : [];
  return { routes, snapWarnings };
}

async function postJson(url, body, { signal, timeoutMs }) {
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
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* handled by the caller */ }
    return { res, json };
  } catch {
    if (timedOut) throw new RouteError('timeout', 'The routing service did not answer in time.');
    if (signal && signal.aborted) throw new RouteError('aborted', 'Request cancelled.');
    throw new RouteError('network', 'SmartTraffic could not be reached.');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Plans routes between two points.
 * Resolves { routes, snapWarnings } or throws RouteError.
 */
export async function planRoutes(start, destination, { signal, cfg = NAV_CONFIG.routing } = {}) {
  if (!isValidLatLng(start) || !isValidLatLng(destination)) {
    throw new RouteError('invalid-input', 'Start or destination coordinates are invalid.');
  }
  if (start.lat === destination.lat && start.lng === destination.lng) {
    throw new RouteError('invalid-input', 'Start and destination are the same point.');
  }
  const { res, json } = await postJson(cfg.url, {
    start: { lat: start.lat, lng: start.lng },
    destination: { lat: destination.lat, lng: destination.lng },
    maxRoutes: cfg.maxRoutes,
  }, { signal, timeoutMs: cfg.timeoutMs });

  if (!res.ok) {
    const known = json && BACKEND_ERRORS[json.code];
    if (known) throw new RouteError(known[0], known[1]);
    throw new RouteError('provider', `The routing service returned an error (HTTP ${res.status}).`);
  }
  const result = normalizeBackendResponse(json, cfg);
  if (!result) throw new RouteError('no-route', 'No drivable route was found between these points.');
  return result;
}

/** Effective duration for ranking: the provider's estimate; live delays are added by routeRanking. */
export function rankRoutes(routes) {
  let fastest = null;
  for (const r of routes) if (!fastest || r.duration < fastest.duration) fastest = r;
  return { fastestId: fastest ? fastest.id : null, basis: 'base' };
}
