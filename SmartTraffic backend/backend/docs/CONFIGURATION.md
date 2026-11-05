# Configuration

All settings are environment variables, read once at start-up by
`config/index.js` (and `config/intersections.js` for the intersection
position). Locally they come from `backend/.env` (copy `.env.example`); on
a host, set them in its environment settings. A malformed number is logged
and replaced by its default.

**Secrets** (never commit, never log, never send to a client):
`MONGODB_URI`, `TRAFFIC_INGEST_TOKEN`, `STREAM_ADMIN_TOKEN`,
`NAV_ADMIN_TOKEN`, `DEVICE_TOKEN_SECRET`, `GEOCODING_API_KEY`. Generate
tokens and secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` (`.env.example`: 5500) | HTTP port |
| `CORS_ORIGIN` | `*` | Allowed browser origin(s) for REST and Socket.IO. Native apps are not affected by CORS. |
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
| `INTERSECTION_LAT`, `INTERSECTION_LNG` | placeholder | Surveyed position of intersection `main`. **Needed for live traffic on routes**: placeholder positions are not matched to routes (see `NAV_ROUTE_INCLUDE_PLACEHOLDERS`). |
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
| `NAV_ADMIN_TOKEN` | unset | Bearer token for `POST/PATCH/DELETE /api/v1/road-features` and `PATCH /api/v1/reports/{id}`. Unset: those answer `503 FEATURE_DISABLED`. Operator tools only, never in the app. |

### Providers

Blank = the public OpenStreetMap service (fine for development; about one
request per second **for the whole server**, no SLA: use self-hosted or
commercial instances in production, see [DEPLOYMENT.md](DEPLOYMENT.md#external-providers)).
`off` = provider disabled (its endpoints answer `503 FEATURE_DISABLED`).

| Variable | Default | Description |
|---|---|---|
| `ROUTING_URL` | `https://router.project-osrm.org` | OSRM HTTP API base URL |
| `ROUTING_PROFILE` | `driving` | OSRM profile in the URL path |
| `ROUTING_TIMEOUT_MS` | `15000` | Per request |
| `ROUTING_VIA_ATTEMPTS` | `4` | When OSRM returns fewer routes than asked, try this many via points for extra alternatives (2 requests each). `0` = OSRM's own alternatives only (faster on the public server). |
| `ROUTING_ALTERNATIVES_BUDGET_MS` | `6000` | Time limit for that search |
| `ROUTING_CACHE_TTL_SECONDS` | `300` | Routes per start/destination are reused for this long (traffic is always recomputed) |
| `GEOCODING_URL` | `https://nominatim.openstreetmap.org` | Nominatim-compatible API base URL (`/search`, `/reverse`) |
| `GEOCODING_API_KEY` | unset | Sent as `?key=` (e.g. LocationIQ). Secret. |
| `GEOCODING_COUNTRY_CODES` | unset | Limit results to these ISO countries, e.g. `iq` |
| `GEOCODING_TIMEOUT_MS` | `10000` | Per request |
| `GEOCODING_CACHE_TTL_SECONDS` | `86400` | Search / reverse answers are cached this long |
| `OVERPASS_URLS` | `https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter` | Comma-separated Overpass instances, tried in order |
| `OVERPASS_TIMEOUT_MS` | `12000` | **Total** time for one lookup, shared between the instances tried |
| `OVERPASS_CACHE_TTL_SECONDS` | `3600` | OSM road-feature tiles (nearby places: at most 10 min) |
| `ROUTING_MIN_INTERVAL_MS`, `GEOCODING_MIN_INTERVAL_MS`, `OVERPASS_MIN_INTERVAL_MS` | `1100` for the public hosts, else `0` | Minimum spacing between request starts to that provider |
| `PROVIDER_MAX_WAIT_MS` | `8000` | A request that would queue longer for its turn is refused (`503 PROVIDER_BUSY`) |
| `PROVIDER_COOLDOWN_SECONDS` | `30` | Circuit breaker: after 3 consecutive faults (timeouts, 5xx, 429) OSRM / the geocoder are not called for this long; a failing Overpass instance is skipped after 1 fault. Requests then fail at once with `503 PROVIDER_BUSY` + `Retry-After`. |
| `PROVIDER_CONTACT_EMAIL` | unset | Added to the `User-Agent` (`SmartTraffic-Navigation/<version> (<email>)`) and Nominatim's `email=`, as the OSM usage policies ask. Set an operations address when using the public services. |

### Live traffic

| Variable | Default | Description |
|---|---|---|
| `NAV_TRAFFIC_STALE_SECONDS` | `15` | Older observations are `stale` |
| `NAV_ROUTE_MATCH_METERS` | `60` | An intersection within this distance of a route line is on the route |
| `NAV_SECONDS_PER_VEHICLE` | `2` | Delay estimate per approach = mean wait + vehicles × this |
| `NAV_LONG_QUEUE_VEHICLES` | `10` | `long_queue` route alert at this many queued vehicles |
| `NAV_MODERATE_DELAY_SECONDS`, `NAV_HEAVY_DELAY_SECONDS` | `30`, `90` | `level` thresholds (`light` / `moderate` / `heavy`) |
| `NAV_ROUTE_INCLUDE_PLACEHOLDERS` | `false` | `true` = also match intersections whose position is a placeholder (demos only: the delay may be attached to the wrong road) |

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
| `RATE_LIMIT_SEARCH_PER_MINUTE` | `30` (search + reverse) |
| `RATE_LIMIT_PLACES_PER_MINUTE` | `20` (nearby) |
| `RATE_LIMIT_ROUTES_PER_MINUTE` | `20` |
| `RATE_LIMIT_DEVICE_REGISTRATIONS_PER_HOUR` | `10` |
| `RATE_LIMIT_REPORTS_PER_HOUR` | `10` per device |
| `RATE_LIMIT_VOTES_PER_HOUR` | `60` per device |

Mobile users behind one carrier NAT share an IP address; raise the per-IP
limits if legitimate users hit them (watch for `429` in the logs).

### Fixed limits

In `models/navigationConstants.js`: search 3-200 characters and ≤ 10
results; nearby radius ≤ 5000 m and ≤ 50 results; map boxes ≤ 0.5 degrees
per side (5 for `/traffic`); ≤ 500 items per list; report description ≤ 280
characters; at most 4 routes.
