/**
 * Driver navigation configuration. Limits and endpoints live here only; UI
 * modules never hard-code them. No provider URL and no secret is stored in
 * this file: the map style (OpenFreeMap) and the map area come from
 * /api/client-config, place search (GET /api/search: our own PostgreSQL/PostGIS
 * database with OpenStreetMap data) and routing (Geoapify, or an own OSRM) from
 * the SmartTraffic backend, which holds the credentials and the quota budget.
 * See navigation/README.md.
 */
export const NAV_CONFIG = Object.freeze({
  routing: {
    // POST /api/v1/routes: routes from the routing provider, in ranking order.
    url: '/api/v1/routes',
    // Routes shown, ranked best to worst. The backend returns the different
    // routes it found (up to 3), at most this many are drawn.
    maxRoutes: 4,
    timeoutMs: 25000,
  },

  geocoding: {
    // GET /api/search
    url: '/api/search',
    resultLimit: 5,
    minQueryLength: 2,
    timeoutMs: 15000,
  },

  roadFeatures: {
    // Speed cameras, bumps and closures entered by the operator (backend
    // GET /api/v1/road-features, database only).
    url: '/api/v1/road-features',
    minZoom: 12,
    maxSpanDeg: 0.45, // the endpoint refuses areas wider than 0.5 degrees
    maxResults: 500,
    maxAgeMs: 60000,
    timeoutMs: 15000,
    retryAfterMs: 30000,
    debounceMs: 700,
  },

  map: {
    // The map is OpenFreeMap (vector tiles, no key). The style URL, the area the map is
    // fixed to and the zoom range are served by GET /api/client-config.
    clientConfigUrl: '/api/client-config',
  },

  reports: {
    // Driver reports (accidents, jams, closures, roadworks, hazards) from the backend
    // database: GET /api/v1/reports, POST /api/v1/reports.
    url: '/api/v1/reports',
    minZoom: 11,
    maxSpanDeg: 0.45,
    maxAgeMs: 30000, // new and expiring reports: look again after this long
    descriptionMaxLength: 280, // the same as reportDescriptionMaxLength in GET /api/v1/config
    timeoutMs: 15000,
    retryAfterMs: 30000,
    debounceMs: 700,
  },

  places: {
    // Important places entered by the operator (hospitals, mosques, ...): GET /api/v1/places/local.
    url: '/api/v1/places/local',
    minZoom: 12,
    maxSpanDeg: 0.45,
    maxAgeMs: 120000,
    timeoutMs: 15000,
    retryAfterMs: 30000,
    debounceMs: 700,
  },

  // Place of the device session used to post a report (localStorage key).
  deviceStorageKey: 'hawr.deviceSession',

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
