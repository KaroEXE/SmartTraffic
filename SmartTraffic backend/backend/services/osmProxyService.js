const path = require('path');
const { pathToFileURL } = require('url');

/**
 * OpenStreetMap map data (speed cameras/bumps, important places) fetched
 * from the Overpass API on behalf of the navigation page.
 *
 * Why the backend and not the browser: public Overpass instances refuse or
 * rate-limit clients that do not identify themselves (HTTP 406/429), and
 * many drivers asking for the same area would hit their limits. Here every
 * request carries a SmartTraffic User-Agent, identical areas share one
 * cached answer, and the next instance is tried when one fails.
 *
 * Only queries built by the navigation modules themselves are sent (the
 * client chooses a layer and an area, never the query), so this is not an
 * open proxy.
 */

const NAV_DIR = path.join(__dirname, '..', '..', 'frontend', 'navigation');
const LAYERS = {
  hazards: { file: 'hazardService.js', build: 'buildOverpassQuery', cfg: 'hazards' },
  places: { file: 'placesService.js', build: 'buildPlacesQuery', cfg: 'places' },
};

class OsmError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // invalid | too-large | upstream
  }
}

function createOsmProxyService({
  // The query itself may run up to 20 s on the server ([timeout:20]).
  urls, userAgent, timeoutMs = 25000, cacheTtlMs = 10 * 60 * 1000, failureTtlMs = 60 * 1000, maxCacheEntries = 300, maxSpanDeg = 2,
  fetchImpl = fetch, now = () => Date.now(),
}) {
  const cache = new Map(); // key -> { at, json }
  let failedAt = null; // all instances failed at this time; answer at once until failureTtlMs passes
  const inFlight = new Map(); // key -> Promise<json>
  let builders = null;

  // The query builders are ES modules shared with the browser; load them once.
  async function builder(layer) {
    if (!builders) {
      builders = {};
      const { NAV_CONFIG } = await import(pathToFileURL(path.join(NAV_DIR, 'config.js')).href);
      for (const [name, def] of Object.entries(LAYERS)) {
        const mod = await import(pathToFileURL(path.join(NAV_DIR, def.file)).href);
        builders[name] = (bbox) => mod[def.build](bbox, NAV_CONFIG[def.cfg].maxResults);
      }
    }
    return builders[layer];
  }

  async function fromUpstream(query) {
    const body = new URLSearchParams({ data: query }).toString();
    const failures = [];
    for (const url of urls) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent, Accept: 'application/json' },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) { failures.push(`${new URL(url).host}: HTTP ${res.status}`); continue; }
        const json = await res.json().catch(() => null);
        if (!json || !Array.isArray(json.elements)) { failures.push(`${new URL(url).host}: unreadable answer`); continue; }
        return { elements: json.elements };
      } catch (err) {
        failures.push(`${new URL(url).host}: ${err.name === 'TimeoutError' ? 'timed out' : 'not reachable'}`);
      }
    }
    console.warn(`[osm] all Overpass instances failed - ${failures.join('; ')}`);
    throw new OsmError('upstream', 'OpenStreetMap data service not reachable');
  }

  function remember(key, json) {
    cache.delete(key);
    cache.set(key, { at: now(), json });
    while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value); // oldest first
  }

  return {
    layers: Object.keys(LAYERS),

    /** Resolves Overpass JSON ({ elements }) for a layer and area. Throws OsmError. */
    async fetchLayer(layer, bbox) {
      if (!LAYERS[layer]) throw new OsmError('invalid', `layer must be one of: ${Object.keys(LAYERS).join(', ')}`);
      if (bbox.north - bbox.south > maxSpanDeg || bbox.east - bbox.west > maxSpanDeg) {
        throw new OsmError('too-large', 'Area too large - zoom in');
      }
      // Rounded outward to ~100 m so nearby views share a cache entry.
      const r = (v, f) => Number((f(v * 1000) / 1000).toFixed(3));
      const box = { south: r(bbox.south, Math.floor), west: r(bbox.west, Math.floor), north: r(bbox.north, Math.ceil), east: r(bbox.east, Math.ceil) };
      const key = `${layer}:${box.south},${box.west},${box.north},${box.east}`;

      const hit = cache.get(key);
      if (hit && now() - hit.at < cacheTtlMs) return hit.json;
      if (inFlight.has(key)) return inFlight.get(key);
      // While every Overpass instance is down, the last good answer for this
      // area (however old; map data changes slowly) beats an error.
      if (failedAt !== null && now() - failedAt < failureTtlMs) {
        if (hit) return hit.json;
        throw new OsmError('upstream', 'OpenStreetMap data service not reachable');
      }

      const pending = (async () => fromUpstream((await builder(layer))(box)))();
      inFlight.set(key, pending);
      try {
        const json = await pending;
        failedAt = null;
        remember(key, json);
        return json;
      } catch (err) {
        if (err instanceof OsmError) {
          failedAt = now();
          if (hit) return hit.json;
        }
        throw err;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}

module.exports = { createOsmProxyService, OsmError };
