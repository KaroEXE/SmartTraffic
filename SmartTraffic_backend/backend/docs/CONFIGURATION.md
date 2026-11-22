# Configuration

All settings are environment variables, read once at start-up by
`config/index.js` (and `config/intersections.js` for the intersection
position). Locally they come from `backend/.env` (copy `.env.example`); on
a host, set them in its environment settings. A malformed number is logged
and replaced by its default.

**Secrets** (never commit, never log, never send to a client):
`MONGODB_URI`, `TRAFFIC_INGEST_TOKEN`, `STREAM_ADMIN_TOKEN`,
`NAV_ADMIN_TOKEN`, `DEVICE_TOKEN_SECRET`, `USER_TOKEN_SECRET`, `GEOAPIFY_API_KEY`. The map needs no key (OpenFreeMap), so nothing secret is ever sent to a browser or an app. Generate
tokens and secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` (`.env.example`: 5500) | HTTP port |
| `NODE_ENV` | unset | `production` enables the production start checks (see [DEPLOYMENT.md](DEPLOYMENT.md#production-start-checks)) and locks the simulation write endpoints (403). |
| `CORS_ORIGIN` | none (localhost origins in development) | Comma-separated exact origins allowed to call the API and Socket.IO from a browser, e.g. `https://app.example.com,https://admin.example.com`. `*` allows every website (not recommended). Requests without an `Origin` header (same-origin pages, native apps, curl) are not affected. A webview app needs its own origin here (e.g. `capacitor://localhost`). |
| `TRUST_PROXY` | off | Express [trust proxy](https://expressjs.com/en/guide/behind-proxies.html): `1` (one proxy hop, e.g. Render), `true`, a hop count or an address list. **Set it behind a proxy**, otherwise every client has the proxy's IP and they all share one rate limit. |

## Database

| Variable | Default | Description |
|---|---|---|
| `MONGODB_URI` | unset | MongoDB connection string (MongoDB ≥ 5.0: traffic history uses a time-series collection). Unset: no history, no camera registry, and the mobile reports / operator road features answer `503 DATABASE_UNAVAILABLE`. Signal control and routing work without it. |
| `HISTORY_SAMPLE_SECONDS` | `5` | At most one stored traffic record per intersection per this many seconds (0 = all) |

## AI service integration

| Variable | Default | Description |
|---|---|---|
| `TRAFFIC_INGEST_TOKEN` | unset | Bearer token the Python AI service sends on `POST /api/traffic` and stream reads. Unset = open (development only; a warning is logged). |
| `STREAM_ADMIN_TOKEN` | unset | Bearer token for camera stream management. Unset = management disabled (503). |
| `AI_STREAM_URL` | unset | Public base URL of the AI service (dashboard Live AI tab). Sent to browsers: no credentials. |
| `INTERSECTION_LAT`, `INTERSECTION_LNG` | unset | Surveyed position of intersection `main`. Unset = the position is unknown (`lat`/`lng` null): the intersection is not drawn on maps and never matched to driver routes. |
| `INTERSECTION_NAME` | `Main Street` | Display name of `main` |

The other intersections and their positions are in `config/intersections.js`.

## Signal control

Decision-engine timing (seconds unless noted): `MIN_GREEN_TIME` (10),
`MAX_GREEN_TIME` (45), `YELLOW_TIME` (3), `ALL_RED_TIME` (1),
`SECONDS_PER_QUEUED_VEHICLE` (2), `MAX_RED_TIME` (90),
`MIN_PEDESTRIAN_CROSSING_TIME` (10), `PEDESTRIAN_CLEARANCE_TIME` (3),
`PEDESTRIAN_MAX_WAIT` (15), `PEDESTRIAN_COOLDOWN` (20),
`EMERGENCY_MAX_HOLD_TIME` (90), `PERCEPTION_HOLD_TIME` (3), `DATA_TIMEOUT`
(10: AI feed counts as stale after this), `FALLBACK_GREEN_TIME` (20).
Priority weights: `WEIGHT_VEHICLES` (2), `WEIGHT_WAITING` (3),
`WEIGHT_QUEUE` (2). `EMERGENCY_CONFIDENCE_THRESHOLD` (0.8).

Network coordination: `NETWORK_OPTIMIZATION` (`true`),
`NETWORK_DECISION_INTERVAL` (2), `NETWORK_LINK_LENGTH_M` (200),
`NETWORK_LINK_CAPACITY` (40), `NETWORK_SPILLBACK_START` (0.7),
`NETWORK_SPILLBACK_BLOCK` (0.9), `NETWORK_DOWNSTREAM_WEIGHT` (0.5),
`NETWORK_LOOKAHEAD_RELEASE_SHARE` (0.3), `NETWORK_UPSTREAM_WEIGHT` (2),
`NETWORK_SATURATION_FLOW` (1.35), `NETWORK_BLOCKED_CYCLES` (2).
Emergency corridor: `EMERGENCY_CORRIDOR_LENGTH` (3),
`EMERGENCY_CORRIDOR_PREPARE_SECONDS` (30), `EMERGENCY_CORRIDOR_HOLD_SECONDS`
(8), `EMERGENCY_CORRIDOR_NOMINAL_SPEED` (12 m/s),
`EMERGENCY_CORRIDOR_TRACK_TIMEOUT` (10), `EMERGENCY_CORRIDOR_FROM_CAMERA`
(`true`).

## Mobile navigation API (`/api/v1`)

### Security

| Variable | Default | Description |
|---|---|---|
| `DEVICE_TOKEN_SECRET` | unset | HMAC-SHA256 key for device tokens; 32+ random characters. Unset: a per-process key (logged warning): every token stops working at each restart and apps must re-register. **Required in production.** Changing it invalidates all tokens (apps re-register automatically). |
| `DEVICE_TOKEN_TTL_DAYS` | `30` | Device token lifetime (minimum 1 hour) |
| `USER_TOKEN_SECRET` | unset | HMAC-SHA256 key for user tokens (`/auth/signup`, `/auth/login`); 32+ random characters, different from `DEVICE_TOKEN_SECRET`. Unset: a per-process key (logged warning): users are signed out at each restart. **Required in production.** Changing it signs every user out. |
| `USER_TOKEN_TTL_DAYS` | `7` | User token lifetime (minimum 1 hour); the user signs in again afterwards |
| `NAV_ADMIN_TOKEN` | unset | Bearer token of the admin console (`/admin.html`) and all operator endpoints: `/api/v1/admin/*`, `POST/PATCH/DELETE /api/v1/road-features`, `PATCH /api/v1/reports/{id}`. **16+ characters: a shorter value disables administration.** Unset: those answer `503 FEATURE_DISABLED`. Never in an app. |

### Geographic database (PostgreSQL + PostGIS)

Place search, reverse geocoding and nearby places run on our own PostgreSQL/PostGIS database filled from OpenStreetMap
(guide: [GEO_DATABASE.md](GEO_DATABASE.md)). It sits next to MongoDB, which is unchanged.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | unset | `postgresql://user:password@host:5432/database`. Unset: the server starts and `GET /api/search`, `GET /api/geocode/reverse` and `/api/v1/places/*` answer `503 FEATURE_DISABLED`. The database must be UTF8 with a UTF-8 ctype and allow `postgis` and `pg_trgm`. Secret: on Northflank set it as a secret environment variable; never commit it, never log it. |
| `DATABASE_SSL` | `false` | `false` (local, private network), `true` (TLS, verify the certificate) or `no-verify`. |
| `DATABASE_POOL_MAX` | `10` | Connections this backend may keep open. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `5000` | A geographic query running longer is cancelled: `503 GEO_QUERY_TIMEOUT`. |
| `OSM_PBF_PATH`, `OSM2PGSQL_BIN` | unset | Import job only (`npm run db:import-osm`): the extract (default: the only `*.osm.pbf` in the repository root) and the osm2pgsql binary. |
| `GEO_TEST_DATABASE_URL` | unset | Tests only: a database `test/geoDatabase.test.js` may query; without it those tests are skipped. |

### Map, search and routing (OpenFreeMap, own PostGIS, Geoapify, optional OSRM)

Separate jobs, separate services, all behind the Hawr API:

| Job | Service | Key | Where it is called from |
|---|---|---|---|
| Map (vector tiles, labels) | **OpenFreeMap**, drawn with MapLibre GL | none | the browser or the app, directly. The style URL and the map area come from `GET /api/client-config`. |
| Place search, reverse geocoding, nearby places | **our own PostGIS database** (OpenStreetMap data) | `DATABASE_URL` | the Hawr backend only |
| Routing | **Geoapify** (default) or **your own OSRM** (`ROUTING_OSRM_URL`) | same key, or none | the Hawr backend only |

OpenFreeMap serves tiles only: it has no search, no routing and no traffic, and Hawr never asks it for any.
For routing, create the Geoapify key at <https://myprojects.geoapify.com>; the API is documented at
<https://apidocs.geoapify.com>. See [SETUP_GUIDE.md](SETUP_GUIDE.md#geoapify-routing-only) for the key restrictions to set.

| Variable | Default | Description |
|---|---|---|
| `GEOAPIFY_API_KEY` | unset | Server only, sent in the `x-api-key` header and never in a URL, a log or an answer. Without it routing answers `503 FEATURE_DISABLED` unless `ROUTING_OSRM_URL` is set. Everything else keeps working (search does not use it). |
| `GEOAPIFY_DAILY_REQUEST_LIMIT` | `2500` | Credits this server may spend per UTC day (0 = no limit). Cached answers cost nothing. Over the limit: `503 PROVIDER_QUOTA_EXCEEDED` with `Retry-After` (seconds to 00:00 UTC). The free plan is 3,000 credits a day. A route search costs 1 credit per route type, 3 in all. |
| `ROUTING_OSRM_URL` | unset | Your own OSRM server (for example `http://127.0.0.1:5000`). Set: routes come from it (real alternatives, no credits) and Geoapify is not used at all. Unset: routes come from Geoapify. There is no default: no public OSRM server may be used. |
| `OPENFREEMAP_STYLE_URL` | `https://tiles.openfreemap.org/styles/liberty` | The MapLibre style apps load. Other OpenFreeMap styles: `bright`, `positron`. Served by `GET /api/client-config`. |
| `ROUTING_CACHE_TTL_SECONDS` | `300` | Routes per start/destination are reused for this long (traffic is always recomputed). |
| `PROVIDER_MAX_WAIT_MS` | `8000` | A request that would queue longer for its turn (Geoapify allows 5 requests per second on the free plan; starts are spaced 220 ms) is refused (`503 PROVIDER_BUSY`). |
| `PROVIDER_COOLDOWN_SECONDS` | `30` | Circuit breaker: after 3 consecutive faults (timeouts, 5xx, rate limiting) the provider is not called for this long; requests fail at once with `503 PROVIDER_BUSY` and `Retry-After`. A used-up quota or a key problem does not trip it. |

Fixed in code: request timeout 15 s, one shared client for routing and places. The map area (Kurdistan Region) and zoom range 7-19 are in `config.navigation.map`.

### Live traffic

| Variable | Default | Description |
|---|---|---|
| `NAV_TRAFFIC_STALE_SECONDS` | `15` | Older observations are `stale` |
| `NAV_ROUTE_MATCH_METERS` | `60` | An intersection within this distance of a route line is on the route |
| `NAV_SECONDS_PER_VEHICLE` | `2` | Delay estimate per approach = mean wait + vehicles × this |
| `NAV_LONG_QUEUE_VEHICLES` | `10` | `long_queue` route alert at this many queued vehicles |
| `NAV_MODERATE_DELAY_SECONDS`, `NAV_HEAVY_DELAY_SECONDS` | `30`, `90` | `level` thresholds (`light` / `moderate` / `heavy`) |

### Community reports

| Variable | Default | Description |
|---|---|---|
| `REPORT_TTL_ACCIDENT_MINUTES` | `60` | Lifetime without confirmations, per type |
| `REPORT_TTL_TRAFFIC_JAM_MINUTES` | `30` | |
| `REPORT_TTL_ROAD_CLOSURE_MINUTES` | `240` | |
| `REPORT_TTL_CONSTRUCTION_MINUTES` | `1440` | |
| `REPORT_TTL_HAZARD_MINUTES` | `120` | |
| `REPORT_MERGE_RADIUS_METERS` | `75` | A new report this close to an active one of the same type confirms it instead (0 = never merge) |
| `REPORT_DISMISS_THRESHOLD` | `3` | Dismissals that hide a report (when they outnumber confirmations) |
| `REPORT_MAX_ACTIVE_PER_DEVICE` | `5` | Active reports per device at once |
| `REPORT_RETENTION_DAYS` | `30` | MongoDB deletes a report this many days after it stops being active (0 = keep) |
| `REPORT_ROUTE_ALERT_METERS` | `40` | Reports and closures this close to a route line are listed on it |

A confirmation extends a report by its TTL, up to 4 TTLs after creation
(fixed in `config/index.js`).

### Rate limits

In-memory, per backend instance. Per client IP unless noted.

| Variable | Default |
|---|---|
| `RATE_LIMIT_PER_MINUTE` | `120` (all `/api/v1`) |
| `RATE_LIMIT_SEARCH_PER_MINUTE` | `60` (`/api/search`, `/api/geocode/reverse`, `/api/v1/places/search` and `/reverse`; our own database, an app searches while typing) |
| `RATE_LIMIT_PLACES_PER_MINUTE` | `30` (nearby) |
| `RATE_LIMIT_ROUTES_PER_MINUTE` | `10` |
| `RATE_LIMIT_DEVICE_REGISTRATIONS_PER_HOUR` | `10` |
| `RATE_LIMIT_REPORTS_PER_HOUR` | `10` per device |
| `RATE_LIMIT_VOTES_PER_HOUR` | `60` per device |
| `RATE_LIMIT_SIGNUPS_PER_HOUR` | `10` per IP |
| `RATE_LIMIT_LOGINS_PER_HOUR` | `30` per IP |
| `RATE_LIMIT_LOGINS_PER_ACCOUNT_PER_HOUR` | `10` per email |

Mobile users behind one carrier NAT share an IP address; raise the per-IP
limits if legitimate users hit them (watch for `429` in the logs).

### Fixed limits

In `models/navigationConstants.js`: `/api/v1/places/search` 3-200 characters and ≤ 10
results; `/api/search` 2-200 characters, ≤ 20 results, offset ≤ 200; nearby radius ≤ 5000 m and ≤ 50 results; map boxes ≤ 0.5 degrees
per side (5 for `/traffic`); ≤ 500 items per list; report description ≤ 280
characters; at most 4 routes.
