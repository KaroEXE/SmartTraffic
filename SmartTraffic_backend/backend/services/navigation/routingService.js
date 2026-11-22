const crypto = require('crypto');
const { TtlCache } = require('../../utils/ttlCache');
const { ApiError } = require('../../utils/apiError');
const { UpstreamError } = require('../../utils/upstream');
const { distanceMeters } = require('../../utils/geo');

/**
 * Road routes, normalised into one Route shape whatever the provider:
 *   { id, geometry: GeoJSON LineString [lng, lat], distance (m), duration (s), summary, steps?: [Step] }
 *
 * Providers (chosen by configuration, the apps never know):
 *   - your own OSRM (ROUTING_OSRM_URL): best route plus alternatives in one request;
 *   - Geoapify (GEOAPIFY_API_KEY): `GET /v1/routing` once per route type (balanced, short,
 *     less_maneuvers). Geoapify has no alternatives parameter; those types give real, different
 *     routes, and a route that copies another is dropped. Times are free-flow: no provider traffic.
 *     Geoapify gives no street names, so `summary` is empty and `name` is null.
 *
 * Results are cached (ROUTING_CACHE_TTL_SECONDS) by rounded coordinates, so an app refreshing its
 * ETAs re-ranks cached routes with fresh live traffic (routePlanner.js) without new provider
 * requests. Route ids are derived from the geometry: the same road path keeps the same id.
 */

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
 * Short English instruction for one routing step. A convenience for display
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

// ------------------------------------------------------------------ Geoapify

/** Geoapify instruction type ("StartAtLeft", "SlightRight", "RoundaboutEnter", ...) -> OSRM-style maneuver. */
function geoapifyManeuver(type) {
  const t = String(type || '');
  const side = /Left/.test(t) ? 'left' : (/Right/.test(t) ? 'right' : null);
  if (/^Start/.test(t)) return { type: 'depart', modifier: side };
  if (/^Destination/.test(t)) return { type: 'arrive', modifier: side };
  if (/Roundabout/i.test(t)) return { type: /Exit/i.test(t) ? 'exit roundabout' : 'roundabout', modifier: null };
  if (/U-?turn/i.test(t)) return { type: 'turn', modifier: 'uturn' };
  const strength = /Slight/.test(t) ? 'slight ' : (/Sharp/.test(t) ? 'sharp ' : '');
  if (/Merge/i.test(t)) return { type: 'merge', modifier: side };
  if (/Ramp/i.test(t)) return { type: 'on ramp', modifier: side };
  if (/Exit/i.test(t)) return { type: 'off ramp', modifier: side };
  if (/Keep|Fork/i.test(t)) return { type: 'fork', modifier: side };
  if (/Continue|Straight|Becomes/i.test(t)) return { type: 'continue', modifier: 'straight' };
  if (side) return { type: 'turn', modifier: `${strength}${side}` };
  return { type: null, modifier: null };
}

/**
 * One Geoapify route feature (geometry: MultiLineString [lng, lat], one line per leg) -> Route.
 * Step indexes (from_index) point into the leg's own line, so they are shifted by where
 * that line starts in the joined line. Geoapify gives no street names: summary is ''.
 */
function normalizeGeoapifyRoute(feature) {
  const props = feature && feature.properties;
  const geometry = feature && feature.geometry;
  if (!props || !geometry || geometry.type !== 'MultiLineString' || !Array.isArray(geometry.coordinates)) return null;
  const coordinates = [];
  const lineStart = [];
  for (const line of geometry.coordinates) {
    if (!Array.isArray(line)) return null;
    lineStart.push(Math.max(0, coordinates.length - (coordinates.length && line.length ? 1 : 0)));
    line.forEach((c, i) => {
      const last = coordinates[coordinates.length - 1];
      if (i === 0 && last && last[0] === c[0] && last[1] === c[1]) return; // the join point is shared by two legs
      coordinates.push(c);
    });
  }
  if (!validLine({ type: 'LineString', coordinates }) || !Number.isFinite(props.distance) || !Number.isFinite(props.time)) return null;
  const steps = [];
  (Array.isArray(props.legs) ? props.legs : []).forEach((leg, li) => {
    for (const s of (leg && Array.isArray(leg.steps) ? leg.steps : [])) {
      const instruction = s.instruction || {};
      const m = geoapifyManeuver(instruction.type);
      const at = coordinates[(lineStart[li] || 0) + (Number.isInteger(s.from_index) ? s.from_index : 0)];
      steps.push({
        distance: Math.round((Number(s.distance) || 0) * 10) / 10,
        duration: Math.round((Number(s.time) || 0) * 10) / 10,
        name: null,
        ref: null,
        mode: 'driving',
        instruction: typeof instruction.text === 'string' && instruction.text ? instruction.text : 'Continue',
        maneuver: {
          type: m.type, modifier: m.modifier, location: at || null, bearingBefore: null, bearingAfter: null, exit: Number.isInteger(instruction.roundabout_exit) ? instruction.roundabout_exit : null,
        },
      });
    }
  });
  return {
    id: routeId(coordinates),
    geometry: { type: 'LineString', coordinates },
    distance: Math.round(props.distance * 10) / 10,
    duration: Math.round(props.time * 10) / 10,
    summary: '',
    steps,
  };
}

/** Share of a's vertices (about 11 m grid) that b also passes through. */
function sharedShare(a, b) {
  const key = (c) => `${c[0].toFixed(4)},${c[1].toFixed(4)}`;
  const set = new Set(b.map(key));
  return a.filter((c) => set.has(key(c))).length / a.length;
}

/** True when two routes follow (almost) the same road: a route that copies another is not an alternative. */
function isSameRoad(a, b) {
  return sharedShare(a.geometry.coordinates, b.geometry.coordinates) >= 0.9 && sharedShare(b.geometry.coordinates, a.geometry.coordinates) >= 0.9;
}

// ------------------------------------------------------------------ service

// Geoapify has no alternatives parameter: the three route types are three real, different routes.
const GEOAPIFY_ROUTE_TYPES = ['balanced', 'short', 'less_maneuvers'];

function createRoutingService({
  geoapify, osrm, config, now = Date.now, log = console,
}) {
  const provider = osrm.enabled ? 'osrm' : (geoapify.enabled ? 'geoapify' : null);
  const enabled = provider !== null;
  const cache = new TtlCache({ maxEntries: 500, ttlMs: config.cacheTtlSeconds * 1000, now });
  const stats = { cacheHits: 0 };

  const snapWarnings = (points, snapped) => points.flatMap((p, i) => {
    const s = snapped[i];
    if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return [];
    const d = distanceMeters(p, s);
    return d > config.snapWarningMeters ? [`${i === 0 ? 'Start' : 'Destination'} is ${Math.round(d)} m from the nearest road; the route starts from that road.`] : [];
  });

  /** Own OSRM: best route plus alternatives in one request. */
  async function viaOsrm(start, destination, maxRoutes) {
    const json = await osrm.get(`/route/v1/driving/${start.lng},${start.lat};${destination.lng},${destination.lat}`, {
      alternatives: maxRoutes > 1 ? String(maxRoutes - 1) : 'false', overview: 'full', geometries: 'geojson', steps: 'true',
    });
    if (!json || json.code !== 'Ok' || !Array.isArray(json.routes)) {
      throw new UpstreamError('PROVIDER_ERROR', 'Routing server returned an unexpected answer', { provider: 'Routing server' });
    }
    const snapped = (json.waypoints || []).map((w) => (w && Array.isArray(w.location) ? { lat: w.location[1], lng: w.location[0] } : null));
    return { routes: json.routes.map(normalizeRoute).filter(Boolean), warnings: snapWarnings([start, destination], snapped) };
  }

  /** Geoapify: one request per route type; the first must succeed, the others add real alternatives. */
  async function viaGeoapify(start, destination, maxRoutes) {
    const ask = async (type) => {
      const json = await geoapify.get('/v1/routing', {
        waypoints: `${start.lat},${start.lng}|${destination.lat},${destination.lng}`, mode: 'drive', type, details: 'instruction_details', lang: 'en',
      });
      if (!json || !Array.isArray(json.features)) throw new UpstreamError('PROVIDER_ERROR', 'Map provider returned an unexpected routing answer', { provider: 'Map provider' });
      const feature = json.features[0];
      const snapped = ((feature && feature.properties && feature.properties.waypoints) || []).map((w) => (w && Array.isArray(w.location) ? { lat: w.location[1], lng: w.location[0] } : null));
      return { route: normalizeGeoapifyRoute(feature), warnings: snapWarnings([start, destination], snapped) };
    };
    const types = GEOAPIFY_ROUTE_TYPES.slice(0, Math.max(1, maxRoutes));
    const first = await ask(types[0]);
    const routes = first.route ? [first.route] : [];
    const others = await Promise.allSettled(types.slice(1).map(ask));
    for (const result of others) {
      if (result.status === 'rejected') {
        log.warn(`[navigation] an alternative route type failed: ${result.reason && result.reason.code}`);
        continue;
      }
      const r = result.value.route;
      if (r && !routes.some((x) => isSameRoad(x, r))) routes.push(r);
    }
    return { routes, warnings: first.warnings };
  }

  return {
    enabled,

    async route({
      start, destination, maxRoutes, steps = false,
    }) {
      if (!enabled) throw new ApiError(503, 'FEATURE_DISABLED', 'Routing is disabled: no routing provider is configured (GEOAPIFY_API_KEY or ROUTING_OSRM_URL)');
      const key = [start.lat, start.lng, destination.lat, destination.lng].map((n) => n.toFixed(5)).join(',') + `|${maxRoutes}|${provider}`;
      let entry = cache.get(key);
      const cached = entry !== undefined;
      if (cached) {
        stats.cacheHits += 1;
      } else {
        const found = provider === 'osrm' ? await viaOsrm(start, destination, maxRoutes) : await viaGeoapify(start, destination, maxRoutes);
        const routes = [];
        for (const r of found.routes) {
          if (!routes.some((x) => x.id === r.id)) routes.push(r);
          if (routes.length >= maxRoutes) break;
        }
        if (!routes.length) throw new ApiError(422, 'NO_ROUTE', 'No drivable route was found between these points');
        entry = { routes, snapWarnings: found.warnings };
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
        enabled, provider, cacheEntries: cache.size, ...stats,
      };
    },
  };
}

module.exports = {
  createRoutingService, normalizeRoute, normalizeGeoapifyRoute, geoapifyManeuver, isSameRoad, instructionFor, routeSteps, routeId,
};
