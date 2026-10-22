# Troubleshooting

Start with `GET /api/health`: its `database` and `navigation` blocks show
the state of MongoDB and of each provider (`circuit`, `failures`,
`lastError`, `benchedInstances`). Then read the startup log: every
configuration problem is logged once, with the variable to change.

## Start-up

| Symptom | Cause | Fix |
|---|---|---|
| `Port … is already in use` | Another process on `PORT` | Stop it or change `PORT` in `.env` |
| `[database] MONGODB_URI is not set` | No database configured | Set `MONGODB_URI`. Without it reports and operator features answer 503. |
| `[database] MongoDB connection failed … retrying every 15s` | Wrong URI, network, Atlas IP allow-list | Check the URI and Atlas Network Access. The backend keeps retrying. |
| `[database] Could not prepare collection` | Missing rights, or MongoDB < 5.0 (time-series) | Use a user with readWrite; MongoDB ≥ 5.0 |
| `[navigation] DEVICE_TOKEN_SECRET is not set` | Dev default | Set it; otherwise every restart signs all apps out |
| `[navigation] Routing uses the public OSRM demo server` (and Nominatim) | Dev defaults | Fine locally; set provider URLs for production ([DEPLOYMENT.md](DEPLOYMENT.md#external-providers)) |

## Mobile API answers

| Answer | Likely cause | What to check |
|---|---|---|
| `503 DATABASE_UNAVAILABLE` | MongoDB not configured or disconnected | `/api/health` → `database.status`; logs |
| `503 FEATURE_DISABLED` | Provider set to `off`, or `NAV_ADMIN_TOKEN` unset for admin calls | `ROUTING_URL` / `GEOCODING_URL` / `OVERPASS_URLS`, `NAV_ADMIN_TOKEN` |
| `503 PROVIDER_BUSY` with `Retry-After` | Circuit open after repeated provider faults, the local request queue is full, or the provider rate-limits us (429) | `/api/health` → `navigation.<provider>.circuit`, `lastError`. The public services are often overloaded: wait, or use your own instance. |
| `504 PROVIDER_TIMEOUT` | Provider slow or down | Try the provider URL directly (below) |
| `502 PROVIDER_ERROR` | Provider answered 5xx or something unreadable | Provider status page; the URL in the env |
| `422 POINT_NOT_ROUTABLE` / `NO_ROUTE` | A point is far from any road / no road connection | Normal for points in water, fields, or another island |
| `401 DEVICE_TOKEN_INVALID` for every app after a deploy | `DEVICE_TOKEN_SECRET` changed or unset (per-process secret) | Set a stable secret. Apps re-register automatically. |
| `401 ADMIN_TOKEN_INVALID` | Wrong or missing admin token | `Authorization: Bearer <NAV_ADMIN_TOKEN>` |
| `429 RATE_LIMITED` for many users at once | `TRUST_PROXY` not set behind a proxy: all clients share the proxy IP | Set `TRUST_PROXY=1` (Render). Or raise `RATE_LIMIT_*` for carrier-NAT traffic. |
| `400 … the box may span at most 0.5 degrees` | Map zoomed out too far | The app requests smaller areas, or skips road data at low zoom |
| `GET /road-features` 200 with `sources.osm: "unavailable"` | Overpass down or benched; operator features are still returned | `/api/health` → `navigation.overpass.benchedInstances`. Retries after `PROVIDER_COOLDOWN_SECONDS`. |
| `/places/nearby` 504 / 503 | Same: nearby places come only from Overpass | As above |

## Live traffic on routes

`trafficStatus` is `not-on-route` or every route has `traffic.basis: "none"`:

1. Is the AI service posting? `GET /api/v1/traffic` → `status` should be
   `live` for its intersection. `no-data` = nothing received; `stale` = no
   update in 15 s (check the AI service and `TRAFFIC_INGEST_TOKEN`).
2. Is the intersection surveyed? `positionSource: "placeholder"` is never
   matched to routes. Set `INTERSECTION_LAT` / `INTERSECTION_LNG` for `main`
   (or the positions in `config/intersections.js`), or, for a demo only,
   `NAV_ROUTE_INCLUDE_PLACEHOLDERS=true`.
3. Does the route pass within 60 m of it (`NAV_ROUTE_MATCH_METERS`)? Check
   `traffic.intersections` on the route.
4. `reason: "video-unavailable"`: the camera for the approach the route
   enters by has no video. Nothing is estimated for it.

## Checking a provider directly

```bash
# OSRM
curl "https://router.project-osrm.org/route/v1/driving/45.4329,35.5617;45.4418,35.5702?overview=false"
# Nominatim (an identifying User-Agent is required by its policy)
curl -A "SmartTraffic-Navigation/1.0.0 (ops@example.org)" "https://nominatim.openstreetmap.org/search?format=jsonv2&q=hospital&limit=1"
# Overpass
curl -A "SmartTraffic-Navigation/1.0.0" --data-urlencode 'data=[out:json][timeout:10];node["highway"="speed_camera"](35.55,45.42,35.58,45.45);out 5;' https://overpass-api.de/api/interpreter
```

The public Overpass instances are frequently overloaded or unreachable for
minutes at a time. That is why OSM features are optional in the API and an
own instance is recommended.

## Tests

| Symptom | Fix |
|---|---|
| `navigation database tests … skipped` | Expected without `MONGODB_TEST_URI`. Set it to a MongoDB you may write to (the test creates and drops its own database). |
| Database tests time out | MongoDB not reachable at that URI (`serverSelectionTimeoutMS` is 5 s) |
| `test\helpers\navigationHarness.js` listed as a test | Node's default test glob loads every `.js` under `test/`; the helper defines no tests and passes trivially |
