const crypto = require('crypto');
const { TtlCache } = require('../../utils/ttlCache');
const {
  requestJson, createThrottle, createCircuitBreaker, UpstreamError,
} = require('../../utils/upstream');
const { viaCandidates, isUsefulAlternative } = require('../../utils/geo');
const { ApiError } = require('../../utils/apiError');

/**
 * Road routes from an OSRM HTTP API (ROUTING_URL; default the public OSRM
 * demo server, which has no SLA and allows about one request per second -
 * self-host OSRM for production, see docs/DEPLOYMENT.md).
 *
 * route({ start, destination, maxRoutes, steps }) resolves
 *   { routes: [Route], snapWarnings: [string], cached }
 *   Route: { id, geometry: GeoJSON LineString, distance (m), duration (s),
 *            summary, steps?: [Step] }
 *
 * Routes come from one OSRM request with alternatives. When OSRM returns
 * fewer than `maxRoutes`, more are looked for through via points beside the
 * direct line (ROUTING_VIA_ATTEMPTS, within ROUTING_ALTERNATIVES_BUDGET_MS);
 * a candidate is kept only when it runs on different roads, does not double
 * back and is at most 2.5x the fastest time (utils/geo.isUsefulAlternative).
 * The same method as the web navigation page (frontend/navigation/routeService.js).
 *
 * Results are cached (ROUTING_CACHE_TTL_SECONDS) by rounded coordinates, so
 * an app refreshing its ETAs re-ranks cached routes with fresh live traffic
 * (routePlanner.js) without new OSRM requests. Route ids are derived from
 * the geometry: the same road path keeps the same id across requests.
 */

const PROVIDER = 'Routing provider';

const OSRM_ERRORS = {
  NoRoute: [422, 'NO_ROUTE', 'No drivable route was found between these points'],
  NoSegment: [422, 'POINT_NOT_ROUTABLE', 'A point is too far from any road; choose a point on or near a road'],
  InvalidValue: [400, 'INVALID_REQUEST', 'The routing provider rejected the coordinates'],
  TooBig: [400, 'INVALID_REQUEST', 'The route request is too large for the routing provider'],
};

// ---------------------------------------------------------------- maneuvers

function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
}
const side = (modifier) => (/left/.test(modifier || '') ? 'left' : (/right/.test(modifier || '') ? 'right' : null));
const DIRECTION_WORD = {
  left: 'left', right: 'right', 'slight left': 'slightly left', 'slight right': 'slightly right',
  'sharp left': 'sharp left', 'sharp right': 'sharp right', straight: 'straight', uturn: 'U-turn',
};

/**
 * Short English instruction for one OSRM step. A convenience for display
 * or text-to-speech; the structured `maneuver` is the authoritative data
 * (an app that localizes builds its own text from it).
 */
function instructionFor(step) {
  const m = step.maneuver || {};
  const road = step.name || step.ref || '';
  const onto = road ? ` onto ${road}` : '';
  const on = road ? ` on ${road}` : '';
  const dir = DIRECTION_WORD[m.modifier] || '';
  switch (m.type) {
    case 'depart': return `Head ${['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(((m.bearing_after || 0) % 360) / 45) % 8]}${on}`;
    case 'arrive': return 'You have arrived at your destination';
    case 'roundabout':
    case 'rotary':
    case 'exit roundabout':
    case 'exit rotary':
      return m.exit ? `At the roundabout, take the ${ordinal(m.exit)} exit${onto}` : `Enter the roundabout${onto}`;
    case 'merge': return `Merge${side(m.modifier) ? ` ${side(m.modifier)}` : ''}${onto}`;
    case 'on ramp': return `Take the ramp${side(m.modifier) ? ` on the ${side(m.modifier)}` : ''}${onto}`;
    case 'off ramp': return `Take the exit${side(m.modifier) ? ` on the ${side(m.modifier)}` : ''}${onto}`;
    case 'fork': return `Keep ${side(m.modifier) || 'straight'} at the fork${onto}`;
    case 'end of road': return `At the end of the road, turn ${dir || 'as directed'}${onto}`;
    case 'continue': return m.modifier === 'uturn' ? `Make a U-turn${onto}` : `Continue ${dir || 'straight'}${on}`;
    case 'new name': return `Continue${onto}`;
    default:
      if (m.modifier === 'uturn') return `Make a U-turn${onto}`;
      if (m.modifier === 'straight') return `Continue straight${onto}`;
      return dir ? `Turn ${dir}${onto}` : `Continue${onto}`;
  }
}

function normalizeStep(step) {
  const m = step.maneuver || {};
  return {
    distance: Math.round(step.distance * 10) / 10,
    duration: Math.round(step.duration * 10) / 10,
    name: step.name || null,
    ref: step.ref || null,
    mode: step.mode || null,
    instruction: instructionFor(step),
    maneuver: {
      type: m.type || null,
      modifier: m.modifier || null,
      location: Array.isArray(m.location) ? m.location : null, // [lng, lat]
      bearingBefore: Number.isFinite(m.bearing_before) ? m.bearing_before : null,
      bearingAfter: Number.isFinite(m.bearing_after) ? m.bearing_after : null,
      exit: Number.isInteger(m.exit) ? m.exit : null,
    },
  };
}

/** Steps of all legs as one list; the arrive/depart pair at an internal via point is dropped. */
function routeSteps(legs) {
  const out = [];
  legs.forEach((leg, i) => {
    const steps = Array.isArray(leg.steps) ? leg.steps : [];
    steps.forEach((s, j) => {
      const type = s.maneuver && s.maneuver.type;
      if (type === 'arrive' && i < legs.length - 1) return;
      if (type === 'depart' && i > 0 && j === 0) return;
      out.push(normalizeStep(s));
    });
  });
  return out;
}

// ------------------------------------------------------------------ routes

function validLine(geometry) {
  return geometry && geometry.type === 'LineString' && Array.isArray(geometry.coordinates)
    && geometry.coordinates.length >= 2
    && geometry.coordinates.every((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
}

/** Stable id from the road path (coordinates rounded to ~1 m). */
function routeId(coordinates) {
  const hash = crypto.createHash('sha1');
  for (const [lng, lat] of coordinates) hash.update(`${lng.toFixed(5)},${lat.toFixed(5)};`);
  return `rt_${hash.digest('hex').slice(0, 12)}`;
}

/** One OSRM route -> Route (steps kept for later), or null when unusable. */
function normalizeRoute(raw) {
  if (!raw || !validLine(raw.geometry) || !Number.isFinite(raw.distance) || !Number.isFinite(raw.duration)) return null;
  const legs = Array.isArray(raw.legs) ? raw.legs : [];
  // A route through a via point has two legs; name each road once.
  const summary = [...new Set(legs.flatMap((l) => (l && l.summary ? l.summary.split(', ') : [])))].filter(Boolean).join(', ');
  return {
    id: routeId(raw.geometry.coordinates),
    geometry: { type: 'LineString', coordinates: raw.geometry.coordinates },
    distance: Math.round(raw.distance * 10) / 10,
    duration: Math.round(raw.duration * 10) / 10,
    summary,
    steps: routeSteps(legs),
  };
}

function osrmError(json, status) {
  const known = json && OSRM_ERRORS[json.code];
  if (known) return new ApiError(known[0], known[1], known[2]);
  return new UpstreamError('PROVIDER_ERROR', `${PROVIDER} could not plan this route (${(json && json.code) || `HTTP ${status}`})`, { provider: PROVIDER, status });
}

function createRoutingService({
  config, userAgent, maxWaitMs = 8000, cooldownMs = 30_000, fetchImpl = globalThis.fetch, now = Date.now, log = console,
}) {
  const cfg = config;
  const enabled = Boolean(cfg.url);
  const cache = new TtlCache({ maxEntries: 500, ttlMs: cfg.cacheTtlSeconds * 1000, now });
  const throttle = createThrottle({ minIntervalMs: cfg.minIntervalMs, maxWaitMs, provider: PROVIDER, now });
  const breaker = createCircuitBreaker({
    provider: PROVIDER, failureThreshold: 3, cooldownMs, now,
  });
  const stats = { requests: 0, cacheHits: 0, failures: 0, lastError: null, lastErrorAt: null };

  async function get(path, params) {
    breaker.check();
    stats.requests += 1;
    try {
      const answer = await throttle.schedule(() => requestJson(`${cfg.url}${path}?${new URLSearchParams(params)}`, {
        provider: PROVIDER, timeoutMs: cfg.timeoutMs, userAgent, fetchImpl,
      }));
      // 4xx + JSON is a routing answer (NoRoute, NoSegment); 5xx is a failing provider.
      if (answer.status >= 500) {
        throw new UpstreamError('PROVIDER_ERROR', `${PROVIDER} answered HTTP ${answer.status}`, { provider: PROVIDER, status: answer.status });
      }
      breaker.success();
      return answer;
    } catch (err) {
      breaker.failure(err);
      stats.failures += 1;
      stats.lastError = err.code || 'PROVIDER_ERROR';
      stats.lastErrorAt = new Date(now()).toISOString();
      throw err;
    }
  }

  const coords = (points) => points.map((p) => `${p.lng},${p.lat}`).join(';');

  async function osrmRoute(points, alternatives) {
    const { status, json } = await get(`/route/v1/${cfg.profile}/${coords(points)}`, {
      alternatives: alternatives > 0 ? String(alternatives) : 'false',
      overview: 'full',
      geometries: 'geojson',
      steps: 'true', // also needed for the road-name summary
    });
    if (!json || json.code !== 'Ok') throw osrmError(json, status);
    return json;
  }

  /** Roads near a point, nearest first, one per road name; unnamed ways (service roads) skipped. */
  async function nearbyRoads(point) {
    const { json } = await get(`/nearest/v1/${cfg.profile}/${coords([point])}`, { number: '10' });
    const seen = new Set();
    const roads = [];
    for (const w of (json && json.code === 'Ok' && Array.isArray(json.waypoints) ? json.waypoints : [])) {
      const name = w && typeof w.name === 'string' ? w.name.trim() : '';
      if (!name || seen.has(name) || !Array.isArray(w.location)) continue;
      seen.add(name);
      roads.push({ lat: w.location[1], lng: w.location[0] });
    }
    return roads;
  }

  async function moreRoutes(start, destination, existing, wanted) {
    const deadline = now() + cfg.alternativesBudgetMs;
    const found = [];
    const candidates = viaCandidates(start, destination).slice(0, cfg.viaAttempts);
    for (const candidate of candidates) {
      if (existing.length + found.length >= wanted || now() >= deadline) break;
      try {
        // The nearest named road only: one more request per attempt at most.
        const [via] = await nearbyRoads(candidate);
        if (!via || now() >= deadline) continue;
        const json = await osrmRoute([start, via, destination], 0);
        const route = normalizeRoute(json.routes && json.routes[0]);
        if (route && isUsefulAlternative(route, [...existing, ...found])) found.push(route);
      } catch (err) {
        // A failed candidate is skipped, never replaced by something invented.
        if (err.code === 'PROVIDER_BUSY') break;
      }
    }
    return found;
  }

  return {
    enabled,

    async route({
      start, destination, maxRoutes, steps = false,
    }) {
      if (!enabled) throw new ApiError(503, 'FEATURE_DISABLED', 'Routing is disabled on this server (ROUTING_URL=off)');
      const key = [start.lat, start.lng, destination.lat, destination.lng].map((n) => n.toFixed(5)).join(',') + `|${maxRoutes}`;
      let entry = cache.get(key);
      const cached = entry !== undefined;
      if (cached) {
        stats.cacheHits += 1;
      } else {
        const json = await osrmRoute([start, destination], maxRoutes - 1);
        const routes = [];
        for (const raw of json.routes || []) {
          const r = normalizeRoute(raw);
          if (r && !routes.some((x) => x.id === r.id)) routes.push(r);
          if (routes.length >= maxRoutes) break;
        }
        if (!routes.length) throw new ApiError(422, 'NO_ROUTE', OSRM_ERRORS.NoRoute[2]);
        if (routes.length < maxRoutes && cfg.viaAttempts > 0) {
          const extra = await moreRoutes(start, destination, routes, maxRoutes).catch((err) => {
            log.warn(`[navigation] extra route alternatives failed: ${err.message}`);
            return [];
          });
          routes.push(...extra);
        }
        const snapWarnings = [];
        (json.waypoints || []).forEach((w, i) => {
          if (w && Number.isFinite(w.distance) && w.distance > cfg.snapWarningMeters) {
            snapWarnings.push(`${i === 0 ? 'Start' : 'Destination'} is ${Math.round(w.distance)} m from the nearest road; the route starts from that road.`);
          }
        });
        entry = { routes, snapWarnings };
        cache.set(key, entry);
      }
      return {
        routes: entry.routes.map(({ steps: s, ...r }) => (steps ? { ...r, steps: s } : r)),
        snapWarnings: entry.snapWarnings,
        cached,
      };
    },

    status() {
      return {
        enabled, provider: enabled ? 'osrm' : null, profile: cfg.profile, cacheEntries: cache.size, ...breaker.state(), ...stats,
      };
    },
  };
}

module.exports = {
  createRoutingService, normalizeRoute, instructionFor, routeSteps, routeId,
};
