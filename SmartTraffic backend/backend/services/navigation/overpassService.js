const { TtlCache } = require('../../utils/ttlCache');
const {
  requestJson, createThrottle, createCircuitBreaker, UpstreamError,
} = require('../../utils/upstream');
const { isValidLatLng, distanceMeters, bboxContainsPoint } = require('../../utils/geo');
const { ApiError } = require('../../utils/apiError');
const { PLACE_CATEGORIES } = require('../../models/navigationConstants');

/**
 * OpenStreetMap data through the Overpass API (OVERPASS_URLS, tried in
 * order; the public instances are often busy).
 *
 *   roadFeatures(bbox)   speed cameras (highway=speed_camera) and speed bumps
 *                        (traffic_calming=bump|hump|table|cushion)
 *   nearbyPlaces(...)    fuel stations, parking, hospitals ... around a point
 *
 * OSM data is community-mapped and often incomplete; it is returned with
 * verification "community" and attribution. Road features are cached per
 * tile (tileDeg, default 0.05 degrees): a request fetches only the tiles
 * not cached yet, with one Overpass query over their combined area.
 */

const PROVIDER = 'Overpass API';
const CALMING = { bump: 'Speed bump', hump: 'Speed hump', table: 'Speed table', cushion: 'Speed cushion' };
const OSM_SOURCE = 'OpenStreetMap contributors';

function elementPosition(el) {
  const lat = Number.isFinite(el.lat) ? el.lat : el.center && el.center.lat;
  const lng = Number.isFinite(el.lon) ? el.lon : el.center && el.center.lon;
  return isValidLatLng({ lat, lng }) ? { lat, lng } : null;
}

function bearingFromTag(raw) {
  const n = Number(raw);
  if (raw !== undefined && Number.isFinite(n) && n >= 0 && n < 360) return n;
  const compass = {
    N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315,
  };
  return typeof raw === 'string' && compass[raw.toUpperCase()] !== undefined ? compass[raw.toUpperCase()] : null;
}

function speedFromTag(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 5 || n > 200) return null;
  return /mph/i.test(String(raw)) ? Math.round(n * 1.609) : n;
}

/** Overpass JSON -> road features (public RoadFeature shape). Unknown elements are skipped. */
function parseRoadFeatures(json) {
  const out = [];
  for (const el of (json && json.elements) || []) {
    const tags = el.tags || {};
    const pos = elementPosition(el);
    if (!pos) continue;
    let kind = null;
    let name = null;
    if (tags.highway === 'speed_camera') {
      kind = 'speed_camera';
      name = 'Speed camera';
    } else if (CALMING[tags.traffic_calming]) {
      kind = 'speed_bump';
      name = CALMING[tags.traffic_calming];
    }
    if (!kind) continue;
    out.push({
      id: `osm:${el.type}:${el.id}`,
      kind,
      lat: pos.lat,
      lng: pos.lng,
      name: tags.name || name,
      description: null,
      direction: kind === 'speed_camera' ? bearingFromTag(tags.direction) : null,
      speedLimitKmh: kind === 'speed_camera' ? speedFromTag(tags.maxspeed) : null,
      source: OSM_SOURCE,
      provider: 'openstreetmap',
      verification: 'community',
      validFrom: null,
      validUntil: null,
      url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      updatedAt: null,
    });
  }
  return out;
}

function roadFeatureQuery(bbox, maxElements) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const calming = '"traffic_calming"~"^(bump|hump|table|cushion)$"';
  return `[out:json][timeout:20];(node["highway"="speed_camera"](${b});node[${calming}](${b});way[${calming}](${b}););out center tags ${maxElements};`;
}

function nearbyQuery({
  lat, lng, radius, category, limit,
}) {
  const [k, v] = PLACE_CATEGORIES[category];
  const around = `(around:${radius},${lat},${lng})`;
  // Ask for more than `limit`: results are sorted by distance afterwards.
  return `[out:json][timeout:15];(node["${k}"="${v}"]${around};way["${k}"="${v}"]${around};);out center tags ${Math.min(200, limit * 4)};`;
}

function address(tags) {
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  return [street, tags['addr:city']].filter(Boolean).join(', ') || null;
}

function parseNearby(json, center, category) {
  const out = [];
  for (const el of (json && json.elements) || []) {
    const pos = elementPosition(el);
    if (!pos) continue;
    const tags = el.tags || {};
    out.push({
      id: `osm:${el.type}:${el.id}`,
      name: tags.name || tags.brand || null,
      category,
      lat: pos.lat,
      lng: pos.lng,
      distanceMeters: Math.round(distanceMeters(center, pos)),
      address: address(tags),
      details: {
        brand: tags.brand || null,
        operator: tags.operator || null,
        openingHours: tags.opening_hours || null,
        phone: tags.phone || tags['contact:phone'] || null,
        website: tags.website || tags['contact:website'] || null,
      },
      url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    });
  }
  return out.sort((a, b) => a.distanceMeters - b.distanceMeters);
}

// --------------------------------------------------------------------- tiles

/** Tile keys "x:y" covering a bbox. */
function tilesFor(bbox, tileDeg) {
  const keys = [];
  const x0 = Math.floor(bbox.west / tileDeg);
  const x1 = Math.floor(bbox.east / tileDeg);
  const y0 = Math.floor(bbox.south / tileDeg);
  const y1 = Math.floor(bbox.north / tileDeg);
  for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) keys.push(`${x}:${y}`);
  return keys;
}

function tileBBox(key, tileDeg) {
  const [x, y] = key.split(':').map(Number);
  return {
    west: x * tileDeg, east: (x + 1) * tileDeg, south: y * tileDeg, north: (y + 1) * tileDeg,
  };
}

function unionBBox(boxes) {
  return {
    south: Math.min(...boxes.map((b) => b.south)),
    west: Math.min(...boxes.map((b) => b.west)),
    north: Math.max(...boxes.map((b) => b.north)),
    east: Math.max(...boxes.map((b) => b.east)),
  };
}

function createOverpassService({
  config, userAgent, maxWaitMs = 8000, cooldownMs = 30_000, fetchImpl = globalThis.fetch, now = Date.now,
}) {
  const cfg = config;
  const enabled = cfg.urls.length > 0;
  const ttlMs = cfg.cacheTtlSeconds * 1000;
  const tiles = new TtlCache({ maxEntries: 5000, ttlMs, now });
  const nearby = new TtlCache({ maxEntries: 1000, ttlMs: Math.min(ttlMs, 600_000), now });
  const throttle = createThrottle({ minIntervalMs: cfg.minIntervalMs, maxWaitMs, provider: PROVIDER, now });
  // Public instances are often overloaded: one failure benches an instance for the cooldown.
  const breakers = new Map(cfg.urls.map((url) => [url, createCircuitBreaker({
    provider: PROVIDER, failureThreshold: 1, cooldownMs, now,
  })]));
  const stats = { requests: 0, cacheHits: 0, failures: 0, lastError: null, lastErrorAt: null };

  function requireEnabled() {
    if (!enabled) throw new ApiError(503, 'FEATURE_DISABLED', 'OpenStreetMap data is disabled on this server (OVERPASS_URLS=off)');
  }

  /**
   * Runs one query against the instances that are not benched, in order,
   * within OVERPASS_TIMEOUT_MS in total (each gets a fair share of what is left).
   */
  async function run(query) {
    const body = new URLSearchParams({ data: query }).toString();
    const deadline = now() + cfg.timeoutMs;
    const usable = cfg.urls.filter((url) => !breakers.get(url).open);
    let lastError = null;
    if (!usable.length) {
      // Every instance is benched: fail at once, retry when the first one is due.
      const waits = cfg.urls.map((url) => { try { breakers.get(url).check(); return 0; } catch (err) { return err.retryAfterSeconds; } });
      lastError = new UpstreamError('PROVIDER_BUSY', `${PROVIDER} is not responding; retrying in ${Math.min(...waits)} s`, {
        provider: PROVIDER, retryAfterSeconds: Math.min(...waits),
      });
    }
    for (let i = 0; i < usable.length; i += 1) {
      const url = usable[i];
      const remaining = deadline - now();
      if (remaining < 200) break;
      const breaker = breakers.get(url);
      stats.requests += 1;
      try {
        const { status, json } = await throttle.schedule(() => requestJson(url, {
          provider: PROVIDER,
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          timeoutMs: Math.floor(remaining / (usable.length - i)),
          userAgent,
          fetchImpl,
        }));
        if (status >= 400 || !json || !Array.isArray(json.elements)) {
          lastError = new UpstreamError('PROVIDER_ERROR', `${PROVIDER} answered HTTP ${status}`, { provider: PROVIDER, status });
          breaker.failure(lastError);
          continue;
        }
        breaker.success();
        return json;
      } catch (err) {
        breaker.failure(err);
        lastError = err;
        // A full local queue will not empty by trying the next instance.
        if (err.code === 'PROVIDER_BUSY' && !err.status) break;
      }
    }
    stats.failures += 1;
    stats.lastError = (lastError && lastError.code) || 'PROVIDER_ERROR';
    stats.lastErrorAt = new Date(now()).toISOString();
    throw lastError || new UpstreamError('PROVIDER_ERROR', `${PROVIDER} is not configured`, { provider: PROVIDER });
  }

  return {
    enabled,

    /** OSM road features inside bbox. Resolves { features, truncated }. */
    async roadFeatures(bbox) {
      requireEnabled();
      const keys = tilesFor(bbox, cfg.tileDeg);
      const missing = keys.filter((k) => tiles.get(k) === undefined);
      stats.cacheHits += keys.length - missing.length;
      let truncated = false;
      if (missing.length) {
        const area = unionBBox(missing.map((k) => tileBBox(k, cfg.tileDeg)));
        const json = await run(roadFeatureQuery(area, cfg.maxElements));
        const features = parseRoadFeatures(json);
        // A capped answer is incomplete: use it, but do not cache it as the truth for those tiles.
        truncated = (json.elements || []).length >= cfg.maxElements;
        const byTile = new Map(missing.map((k) => [k, []]));
        for (const f of features) {
          const k = `${Math.floor(f.lng / cfg.tileDeg)}:${Math.floor(f.lat / cfg.tileDeg)}`;
          if (byTile.has(k)) byTile.get(k).push(f);
        }
        for (const [k, list] of byTile) {
          if (!truncated) tiles.set(k, list);
          else tiles.delete(k);
        }
        if (truncated) {
          const seen = new Set();
          const merged = [...keys.flatMap((k) => tiles.get(k) || []), ...features]
            .filter((f) => bboxContainsPoint(bbox, f) && !seen.has(f.id) && seen.add(f.id));
          return { features: merged, truncated };
        }
      }
      const features = keys.flatMap((k) => tiles.get(k) || []).filter((f) => bboxContainsPoint(bbox, f));
      return { features, truncated };
    },

    /** Places of one category around a point, nearest first. Resolves { places, cached }. */
    async nearbyPlaces({
      lat, lng, category, radius, limit,
    }) {
      requireEnabled();
      // ~110 m grid for the centre.
      const key = `${lat.toFixed(3)},${lng.toFixed(3)}|${category}|${radius}`;
      let places = nearby.get(key);
      const cached = places !== undefined;
      if (cached) {
        stats.cacheHits += 1;
      } else {
        const json = await run(nearbyQuery({
          lat, lng, radius, category, limit: 50,
        }));
        places = parseNearby(json, { lat, lng }, category).filter((p) => p.distanceMeters <= radius);
        nearby.set(key, places);
      }
      // Distances from the exact point asked for (the cache key is rounded).
      const exact = places
        .map((p) => ({ ...p, distanceMeters: Math.round(distanceMeters({ lat, lng }, p)) }))
        .filter((p) => p.distanceMeters <= radius)
        .sort((a, b) => a.distanceMeters - b.distanceMeters)
        .slice(0, limit);
      return { places: exact, cached };
    },

    status() {
      return {
        enabled,
        instances: cfg.urls.length,
        benchedInstances: cfg.urls.filter((url) => breakers.get(url).open).length,
        cachedTiles: tiles.size,
        ...stats,
      };
    },
  };
}

module.exports = {
  createOverpassService, parseRoadFeatures, parseNearby, roadFeatureQuery, nearbyQuery, tilesFor, tileBBox,
};
