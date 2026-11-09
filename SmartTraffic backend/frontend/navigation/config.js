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
    // Routes shown, ranked best to worst. OSRM's own alternatives come first;
    // the rest are OSRM routes through via points (routeService.findMoreRoutes).
    maxRoutes: 4,
    // At most this many via points are tried per start/destination pair
    // (two OSRM requests each: nearest road + route), every request spaced
    // minIntervalMs apart (public OSRM: about one request per second).
    maxViaRequests: 10,
    // Roads tried per via point (each one route request) before moving on.
    roadsPerVia: 2,
    minIntervalMs: 1100,
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
    // OpenStreetMap speed cameras and bumps through the backend's Overpass
    // proxy (backend/routes/osmRoutes.js), which builds the query with
    // buildOverpassQuery() and maxResults below. The Overpass instances it
    // uses are OVERPASS_URLS in backend/.env.
    osmUrl: '/api/osm/hazards',
    minZoom: 13, // below this the visible area is too large to query
    maxResults: 500,
    // The backend tries each Overpass instance for up to 25 s.
    timeoutMs: 55000,
    retryAfterMs: 30000,
    debounceMs: 700,
  },

  reports: {
    // Drivers' reports approved on admin.html (backend GET /api/hazards).
    backendUrl: '/api/hazards',
    minZoom: 0, // a few hundred points at most, so any zoom
    maxAgeMs: 60000, // reloaded once older, so newly approved reports appear
    retryAfterMs: 30000,
    debounceMs: 700,
  },

  roadFeatures: {
    // Speed cameras, bumps and closures entered by the operator (backend
    // GET /api/v1/road-features, database only - works without OpenStreetMap).
    url: '/api/v1/road-features',
    minZoom: 12, // the endpoint refuses areas wider than 0.5 degrees
    maxAgeMs: 60000,
    retryAfterMs: 30000,
    debounceMs: 700,
  },

  places: {
    // Important places (placesService.js) through the same backend proxy.
    osmUrl: '/api/osm/places',
    maxResults: 300,
    timeoutMs: 55000,
  },

  map: {
    // Same tile source as the operations dashboard (frontend/map.js).
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    // Only used when the intersection list cannot be loaded.
    fallbackView: { lat: 35.5617, lng: 45.4329, zoom: 14 },
    // Areas for an area picker: the whole Kurdistan Region (bounds
    // [[south, west], [north, east]]) and its main cities (centre + zoom).
    defaultRegion: 'kurdistan',
    regions: [
      { id: 'kurdistan', name: 'Kurdistan Region', bounds: [[34.4, 42.3], [37.4, 46.4]] },
      { id: 'erbil', name: 'Erbil', lat: 36.1911, lng: 44.0092, zoom: 13 },
      { id: 'sulaymaniyah', name: 'Sulaymaniyah', lat: 35.5617, lng: 45.4329, zoom: 13 },
      { id: 'duhok', name: 'Duhok', lat: 36.8671, lng: 42.9885, zoom: 13 },
      { id: 'halabja', name: 'Halabja', lat: 35.1778, lng: 45.9861, zoom: 14 },
    ],
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
    // Live delay at a monitored intersection (routeRanking.estimateRoute):
    // mean wait of the stopped vehicles on the approach the route enters by,
    // plus this many seconds per vehicle on that approach (one saturation
    // headway, the time each vehicle ahead takes to clear the stop line).
    secondsPerVehicle: 2,
    // Two routes swap places only when their estimates differ by more than this.
    rankHysteresisSeconds: 5,
  },
});
