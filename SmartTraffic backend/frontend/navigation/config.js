/**
 * Driver navigation configuration. Provider URLs and limits live here only;
 * UI modules never hard-code them. Every provider below is a public, keyless
 * service, so no secret is (or may ever be) stored in this file.
 *
 * The public OSM services have usage policies (rate limits, no bulk use, no
 * autocomplete on Nominatim). For production, point these at self-hosted or
 * commercial instances - see navigation/README.md.
 */
export const NAV_CONFIG = Object.freeze({
  routing: {
    // OSRM HTTP API (https://project-osrm.org/docs/v5.24.0/api/). The public
    // demo server has no SLA and allows about one request per second.
    osrmUrl: 'https://router.project-osrm.org',
    profile: 'driving',
    maxRoutes: 3,
    timeoutMs: 15000,
    // A start/destination snapped more than this far onto a road is reported.
    snapWarningMeters: 300,
    // Backend endpoint for traffic-adjusted routes. Not implemented yet; while
    // null, routes come from OSRM and carry no live-traffic adjustment.
    trafficRoutesUrl: null,
    // Minimum time between backend re-evaluations triggered by traffic updates.
    trafficRefreshMs: 30000,
  },

  geocoding: {
    nominatimUrl: 'https://nominatim.openstreetmap.org',
    resultLimit: 5,
    minQueryLength: 3,
    // Nominatim policy: max 1 request/s and no search-as-you-type.
    minIntervalMs: 1100,
    timeoutMs: 10000,
    // Searches first inside an area at least this wide (degrees, ~33 km)
    // around the map view, then worldwide if nothing is found there.
    localSpanDeg: 0.3,
  },

  hazards: {
    // 'overpass' = OpenStreetMap data via the Overpass API.
    // 'backend'  = project endpoint returning { hazards: [...] } (see README).
    provider: 'overpass',
    // Tried in order. Instances must send CORS headers to work from a browser.
    overpassUrls: [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
    ],
    backendUrl: null,
    minZoom: 13, // below this the visible area is too large to query
    maxResults: 500,
    timeoutMs: 25000,
    retryAfterMs: 30000,
    debounceMs: 700,
  },

  map: {
    // Same tile source as the operations dashboard (frontend/map.js).
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    // Only used when the intersection list cannot be loaded.
    fallbackView: { lat: 35.5617, lng: 45.4329, zoom: 14 },
  },

  traffic: {
    // An observation older than this is shown as stale even before the
    // backend marks the feed STALE (backend DATA_TIMEOUT defaults to 10 s).
    staleAfterSeconds: 15,
    // A monitored intersection counts as "on the route" within this distance
    // of the route line. Intersection positions come from
    // backend/config/intersections.js.
    routeMatchMeters: 60,
    // Shown as "long queue" when an approach reports at least this many
    // queued vehicles. The label states the number; it is not a traffic score.
    longQueueVehicles: 10,
  },
});
