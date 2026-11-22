# API reference

Every HTTP endpoint and Socket.IO event of the backend, grouped by who uses it. Request and response
schemas with examples are in the OpenAPI document (`/api/openapi.json`, source: `docs/openapi.js` and
`docs/openapiNavigation.js`) and in Swagger UI (`/api/docs/`). Tests fail when a `/api/v1`, `/api/search`,
`/api/geocode/reverse` or live/simulation route is missing from the document (`test/navigationApi.test.js`,
`test/geoApi.test.js`, `routes/docsRoutes.test.js`).

Guides:

| For | Read |
|---|---|
| The mobile app | [MOBILE_INTEGRATION_GUIDE.md](MOBILE_INTEGRATION_GUIDE.md) (`/api/v1`, the contract the app consumes) |
| Search and reverse geocoding (web, mobile, any client) | [§ Geographic search](#geographic-search) below and [GEO_DATABASE.md](GEO_DATABASE.md) |
| Settings and environment variables | [CONFIGURATION.md](CONFIGURATION.md) |
| Deploying | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Errors you see | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |

## Base URLs

| Group | Base path | Example |
|---|---|---|
| Mobile navigation API | `/api/v1` | `https://<host>/api/v1/config` |
| Geographic search | `/api` (no version) | `https://<host>/api/search?q=...` |
| Everything else | `/api` | `https://<host>/api/health` |
| Web pages | `/` | `/navigation.html` (driver page), `/` (operations dashboard), `/admin.html` (admin console) |

Local development: `http://localhost:<PORT>` (PORT in `backend/.env`; the examples below use `5500`).

## Authentication

| Credential | Header | Used by | Configured with |
|---|---|---|---|
| none | - | public reads, dashboard, navigation page, most mobile reads | - |
| Device token | `Authorization: Bearer <token>` | mobile writes: reports, votes, withdraw | issued by `POST /api/v1/auth/device`, signed with `DEVICE_TOKEN_SECRET` (32+ characters) |
| User token | `Authorization: Bearer <token>` | saved places, account | `POST /api/v1/auth/signup` or `/login`, signed with `USER_TOKEN_SECRET` (32+ characters) |
| Navigation admin token | `Authorization: Bearer <token>` | admin console, road features, report moderation, local places | `NAV_ADMIN_TOKEN` (16+ characters; unset or shorter = those endpoints answer `503`) |
| Ingest token | `Authorization: Bearer <token>` | the Python AI service: `POST /api/traffic`, stream reads and health | `TRAFFIC_INGEST_TOKEN` (unset = open; development only) |
| Stream admin token | `Authorization: Bearer <token>` | camera stream management | `STREAM_ADMIN_TOKEN` (unset = management answers `503`) |

Static tokens are compared in constant time (`utils/auth.js`) and never logged. Device and user tokens are HS256
JWTs (`utils/deviceToken.js`, `utils/userToken.js`). The geographic endpoints need no token.

## Response format

Success: `{ "ok": true, ... }`. Error: `{ "ok": false, "code": "<CODE>", "error": "<English text>", "details"?: [...], "retryAfterSeconds"?: n }`.

* `code` is stable: switch on it, never on `error`.
* Every `/api/v1` error and every `/api/search` / `/api/geocode/reverse` error has `code`.
* Older endpoints (live traffic, simulation, streams) return `code` only for the shared handler errors
  (`NOT_FOUND`, `MALFORMED_JSON`, `PAYLOAD_TOO_LARGE`, `INTERNAL_ERROR`); their own errors carry `error` only.
* Request bodies are JSON, at most 100 KB.
* Caching: `/api/v1` answers are `Cache-Control: no-store`; `/api/search` and `/api/geocode/reverse` answers are
  `private, max-age=30`; `/api/client-config` and `/api/v1/config` are `no-cache`.
* Rate-limited answers: `429` with `code: "RATE_LIMITED"` and `Retry-After`. Limits are in
  [Rate limits](#rate-limits).

## Endpoint index

### Geographic search (PostgreSQL + PostGIS, OpenStreetMap data)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/search` | - | Search places, streets and areas by name. Optional position for nearby ranking. |
| GET | `/api/geocode/reverse` | - | What is at a point: street, house number, district, city, governorate, country, nearest road and place. |

Details: [Geographic search](#geographic-search).

### Mobile navigation API: `/api/v1`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/v1/config` | - | Features, limits, rate limits, attribution. Call at start-up. |
| POST | `/api/v1/auth/device` | - / device | Issue a device token (or renew one near expiry). |
| POST | `/api/v1/auth/signup` | - | Create a user account and sign in. |
| POST | `/api/v1/auth/login` | - | Sign in with email and password. |
| POST | `/api/v1/auth/refresh` | user | Exchange a still-valid user token for a fresh one. |
| POST | `/api/v1/auth/logout` | user | Sign out on every device. |
| POST | `/api/v1/auth/change-password` | user | Change the password (needs the current one). |
| GET | `/api/v1/auth/me` | user | The signed-in user. |
| PATCH | `/api/v1/auth/me` | user | Change the profile name. |
| DELETE | `/api/v1/auth/me` | user | Delete the account (needs the password). |
| GET | `/api/v1/places/search` | - | Place and address search for the apps: operator places first, then the PostGIS search. |
| GET | `/api/v1/places/reverse` | - | Address at a point. |
| GET | `/api/v1/places/nearby` | - | Places of one category (fuel, hospital, ...) around a point, nearest first. |
| GET | `/api/v1/places/local` | - | Operator-entered places (MongoDB) in a map area. |
| GET | `/api/v1/places/local/{id}` | - | One operator place. |
| POST | `/api/v1/places/local` | admin | Add an operator place. |
| PATCH | `/api/v1/places/local/{id}` | admin | Change it (partial). |
| DELETE | `/api/v1/places/local/{id}` | admin | Delete it. |
| GET | `/api/v1/saved-places` | user | The user's saved places (home, work, favourites). |
| POST | `/api/v1/saved-places` | user | Save a place (at most 100 per user). |
| PATCH | `/api/v1/saved-places/{id}` | user | Change one of them. |
| DELETE | `/api/v1/saved-places/{id}` | user | Delete one of them. |
| POST | `/api/v1/routes` | - | Up to three routes ranked by live-AI-adjusted travel time, with alerts and steps. |
| GET | `/api/v1/traffic` | - | Live AI traffic at monitored intersections, optionally in a box. |
| GET | `/api/v1/road-features` | - | Operator road features (speed cameras, bumps, closures, roadworks) in a box. |
| GET | `/api/v1/road-features/{id}` | - | One road feature. |
| POST | `/api/v1/road-features` | admin | Create one. |
| PATCH | `/api/v1/road-features/{id}` | admin | Change one (partial). |
| DELETE | `/api/v1/road-features/{id}` | admin | Delete one. |
| GET | `/api/v1/reports` | - / device | Active community reports in a box. |
| GET | `/api/v1/reports/{id}` | - / device | One report, any status. |
| POST | `/api/v1/reports` | device | Report a road condition (a nearby report of the same type is confirmed instead: `merged: true`). |
| DELETE | `/api/v1/reports/{id}` | device | Withdraw this device's own report. |
| POST | `/api/v1/reports/{id}/votes` | device | Confirm or dismiss someone else's report. |
| PATCH | `/api/v1/reports/{id}` | admin | Moderate: `status` (`active`, `removed`, `resolved`), `verification`. |
| GET | `/api/v1/admin/overview` | admin | System health, live feed state, counts. |
| GET | `/api/v1/admin/users` | admin | Accounts, newest first (`q` = start of an email). |
| GET | `/api/v1/admin/reports` | admin | Driver reports in any status (`status`, `type`). |
| GET | `/api/v1/admin/places` | admin | Operator places (`category`, `active`). |
| GET | `/api/v1/admin/road-features` | admin | Road features (`kind`, `active`). |

Full contract, examples and the error table: [MOBILE_INTEGRATION_GUIDE.md](MOBILE_INTEGRATION_GUIDE.md).

### System and public configuration

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | - | Liveness: uptime, AI feed status, database (MongoDB) status and history counters, `navigation` block (below). |
| GET | `/api/client-config` | - | Public settings for the web pages and apps: AI stream URL, map (`styleUrl`, `bounds`, zoom range, attribution), search attribution. No secret. |
| GET | `/api/docs/` | - | Swagger UI. |
| GET | `/api/openapi.json` | - | OpenAPI 3.0.3 document. |

`GET /api/health` → `navigation`:

| Field | Meaning |
|---|---|
| `geoapify.enabled` | A routing key is configured (`GEOAPIFY_API_KEY`). |
| `geoapify.circuit` | `closed` (working) or `open` (paused after repeated faults). |
| `routing.enabled` | Routing is available (Geoapify key or `ROUTING_OSRM_URL`). |
| `places.enabled` | `DATABASE_URL` is configured, so search, reverse geocoding and nearby places are enabled. **This says the setting is present, not that the database answers**: a request to a database that is down returns `503 GEO_DATABASE_UNAVAILABLE`. |
| `database` | `connected` or `unavailable`: the MongoDB connection (accounts, reports, road features, operator places). |

### Live traffic (AI service and dashboard)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/traffic` | ingest | One perception observation (about one per second per intersection). Contract: `python/docs/RENDER_DEPLOYMENT.md`. |
| GET | `/api/traffic/observations` | - | Latest stored observation of every intersection. |
| GET | `/api/traffic/observations/{intersectionId}` | - | Latest observation (memory, else newest database record). |
| GET | `/api/traffic/state` | - | Decision-engine snapshots (signals, phases, scores). |
| GET | `/api/traffic/state/{intersectionId}` | - | One snapshot with recent events. |
| GET | `/api/intersections` | - | Configured intersections and summary state. |
| GET | `/api/network` | - | Network topology and the latest coordination cycle. |
| GET | `/api/history/traffic` | - | Stored observations: `mode`, `intersectionId`, `from`, `to`, `limit` (at most 1000). |
| GET | `/api/history/signals` | - | Stored signal phase changes (same filters). |

### Simulation (dashboard Simulation tab)

An isolated channel: its own engine, store and Socket.IO room. Never mixed with live data, never visible through
`/api/v1`. In production (`NODE_ENV=production`) the write endpoints answer `403`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/simulation/intersections` | Simulated intersections and summary state. |
| GET | `/api/simulation/traffic/state` | Simulated decision snapshots. |
| GET | `/api/simulation/traffic/state/{intersectionId}` | One simulated snapshot with events. |
| GET | `/api/simulation/network` | Simulated topology and latest decision. |
| POST | `/api/simulation/network` | Turn network-wide optimisation on or off. |
| GET | `/api/simulation/status` | Simulator state and scenarios. |
| POST | `/api/simulation/start` | Start or resume. |
| POST | `/api/simulation/pause` | Pause the simulator and its clock. |
| POST | `/api/simulation/reset` | Discard simulated state and stop. |
| POST | `/api/simulation/scenario` | Apply a scenario to an intersection. |
| POST | `/api/simulation/tour` | Enable or disable the automatic scenario tour. |
| POST | `/api/simulation/ambulance` | Send a simulated emergency vehicle through the network. |
| PATCH | `/api/simulation/ambulance/{id}` | Change its route. |
| DELETE | `/api/simulation/ambulance/{id}` | Remove it. |
| POST | `/api/simulation/benchmark` | Compare fixed-time, adaptive and network-aware control on identical simulated demand. |
| GET | `/api/simulation/benchmark` | Latest benchmark result (`null` before the first run). |

### Camera streams

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/streams/status` | - | Public stream health (no URLs). |
| GET | `/api/streams` | ingest or stream admin | Registered streams, with URLs. |
| GET | `/api/streams/{id}` | ingest or stream admin | One stream. |
| POST | `/api/streams/health` | ingest or stream admin | AI service health report. |
| POST | `/api/streams` | stream admin | Register a stream. |
| PATCH | `/api/streams/{id}` | stream admin | Change settings, enable or disable. |
| DELETE | `/api/streams/{id}` | stream admin | Remove. |

## Geographic search

Search, reverse geocoding and nearby places are answered by **Redoz's own PostgreSQL/PostGIS database**, built from an
OpenStreetMap extract. No external search or geocoding provider is called. Setup and the data: [GEO_DATABASE.md](GEO_DATABASE.md).

Requirements on the server: `DATABASE_URL` set, `npm run db:migrate` run, and `npm run db:import-osm` run. Until then
these endpoints answer `503` (see the error table below). Results carry the OpenStreetMap attribution.

### `GET /api/search`

| Parameter | Required | Rules | Meaning |
|---|---|---|---|
| `q` | yes | 2-200 characters after trimming; spaces collapse | The text to find. Any script: Latin, Arabic, Sorani Kurdish. |
| `lat`, `lng` | no; both or neither | -90..90, -180..180 | The user's position. Nearer results rank higher and get `distanceMeters`. |
| `limit` | no | 1-20, default 10 | Results per page. |
| `offset` | no | 0-200, default 0 | Results to skip (paging). |
| `lang` | no | a language tag, `ar`, `en`, `ku` (or `ckb`, which means `ku`) | Which name to show. Default: the `Accept-Language` header, else the local name. Other languages fall back to the local name. |

What it matches: the full name, its start, a word inside it, and misspellings; every known name of a place (local,
`name:ar`, `name:ckb`, `name:en`, alternative and old names). A query that is a kind of place ("restaurant", "مستشفى",
"نەخۆشخانە") also returns the nearest places of that kind. Arabic letter variants (ك/ک, ي/ی/ى, ه/ە/ة, أ/إ/آ), vowel marks,
Arabic-Indic digits and Latin accents are treated as the same text.

Request:

```bash
curl "http://localhost:5500/api/search?q=Family%20Mall&lat=35.5617&lng=45.4329&limit=10&lang=en"
```

Answer (values illustrative):

```json
{
  "ok": true,
  "query": "Family Mall",
  "count": 1,
  "results": [{
    "id": "osm:w123456789",
    "name": "Family Mall",
    "type": "shopping_mall",
    "category": "shopping_mall",
    "latitude": 35.56,
    "longitude": 45.43,
    "address": "Example Street, Example City",
    "source": "osm",
    "entity": "poi",
    "verified": false,
    "distanceMeters": 480,
    "names": { "default": "Family Mall", "ar": null, "ckb": null, "en": "Family Mall" },
    "addressDetails": null,
    "boundingBox": null
  }],
  "pagination": { "limit": 10, "offset": 0, "count": 1, "hasMore": false },
  "attribution": { "text": "© OpenStreetMap contributors", "url": "https://www.openstreetmap.org/copyright", "provider": "OpenStreetMap" }
}
```

Fields of a result:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | `osm:<n\|w\|r\|s\|a><id>` for OpenStreetMap (node, way, relation, street, area); `redoz:<uuid>` for a Redoz-owned place. Opaque: never parse it. |
| `name` | string or null | In the requested language when OpenStreetMap has it, else the local name. `null` for an unnamed place. |
| `type`, `category` | string | Redoz category: `hospital`, `school`, `restaurant`, `fuel`, `shopping_mall`, `street`, `city`, `area`, ... |
| `latitude`, `longitude` | number | WGS 84. |
| `address` | string or null | Address text when known. |
| `source` | `osm` or `redoz` | Where it comes from. |
| `entity` | `poi`, `settlement`, `street`, `area` | What kind of thing it is. |
| `verified` | boolean | Confirmed by Redoz (true only for Redoz data). |
| `distanceMeters` | integer or null | Straight-line distance from `lat`/`lng`; `null` when no position was sent. |
| `names` | object | `default`, `ar`, `ckb`, `en`: each string or `null`. |
| `addressDetails` | object or null | `road`, `houseNumber`, `suburb`, `city`, `state`, `postcode`, `country`; each may be `null`. |
| `boundingBox` | object or null | `south`, `west`, `north`, `east` for streets and areas (fit the map to it). |

Paging: `pagination.hasMore` is `true` when another page exists; request it with `offset = previous offset + limit`.

Ranking, best first: exact name, then prefix, then a word starting the name, then fuzzy similarity; alternative names count
slightly less; a category word brings nearby places of that category; with a position, distance raises a result and
importance (cities and main roads above small shops) breaks ties. A verified Redoz place gets a small boost.

### `GET /api/geocode/reverse`

| Parameter | Required | Rules |
|---|---|---|
| `lat`, `lng` | yes | -90..90, -180..180 |
| `lang` | no | as for `/api/search` |

Looks up, in the database, the nearest address point (within 40 m), the nearest named road (within 120 m), the
administrative areas that contain the point, the nearest settlement and neighbourhood, and the nearest named place
(within 30 m). Nothing is invented: a point with no data answers `displayName: null` with status `200`.

```bash
curl "http://localhost:5500/api/geocode/reverse?lat=35.5617&lng=45.4329&lang=en"
```

```json
{
  "ok": true,
  "latitude": 35.5617,
  "longitude": 45.4329,
  "displayName": "Example Street 12, Example City, Example Governorate, Example Country",
  "street": "Example Street",
  "houseNumber": "12",
  "neighbourhood": null,
  "district": "Example District",
  "city": "Example City",
  "state": "Example Governorate",
  "country": "Example Country",
  "nearestRoad": {
    "id": "osm:w98765",
    "osmWayId": 98765,
    "name": "Example Street",
    "type": "residential",
    "ref": null,
    "oneway": null,
    "maxspeed": null,
    "lanes": null,
    "surface": null,
    "access": null,
    "junction": null,
    "bridge": null,
    "tunnel": null,
    "distanceMeters": 8
  },
  "place": { "id": "osm:n1234567", "name": "Example Shop", "type": "shop", "distanceMeters": 20 },
  "attribution": { "text": "© OpenStreetMap contributors", "url": "https://www.openstreetmap.org/copyright", "provider": "OpenStreetMap" }
}
```

(Values illustrative.) `place` is the named place right at the point, or `null`. `nearestRoad` is `null` when no named
road is within 120 m.

### Errors of the geographic endpoints

| HTTP | `code` | Meaning | What to do |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | Bad parameter; `details` says which | Fix the request. |
| 404 | `NOT_FOUND` | Unknown path under `/api` | Check the path. |
| 405 | `METHOD_NOT_ALLOWED` | Only `GET` is accepted | Use `GET`. |
| 429 | `RATE_LIMITED` | Too many searches from this IP | Wait `Retry-After`. |
| 503 | `FEATURE_DISABLED` | `DATABASE_URL` is not set on this server | Hide search, or show "search is not available". |
| 503 | `GEO_DATA_NOT_READY` | The schema or the OpenStreetMap import is missing | Operator: run `db:migrate` and `db:import-osm`. |
| 503 | `GEO_DATABASE_UNAVAILABLE` | The database cannot be reached (`Retry-After: 10`) | Retry later. |
| 503 | `GEO_QUERY_TIMEOUT` | The query took longer than `DATABASE_STATEMENT_TIMEOUT_MS` (`Retry-After: 5`) | Retry; try a longer word. |
| 500 | `INTERNAL_ERROR` | Server bug | Report it. |

## Mobile navigation API: operator examples (admin token)

```bash
API=http://localhost:5500/api/v1
ADMIN="Authorization: Bearer $NAV_ADMIN_TOKEN"

# Add a verified speed camera
curl -X POST $API/road-features -H "$ADMIN" -H 'Content-Type: application/json' \
  -d '{"kind":"speed_camera","lat":35.5617,"lng":45.4329,"speedLimitKmh":60,"direction":90,"source":"City traffic department"}'

# A temporary closure that disappears by itself
curl -X POST $API/road-features -H "$ADMIN" -H 'Content-Type: application/json' \
  -d '{"kind":"road_closure","lat":35.5655,"lng":45.4232,"name":"Hospital Road","validUntil":"2026-12-01T00:00:00Z"}'

# Deactivate / delete
curl -X PATCH $API/road-features/<id> -H "$ADMIN" -H 'Content-Type: application/json' -d '{"active":false}'
curl -X DELETE $API/road-features/<id> -H "$ADMIN"

# Moderate a community report
curl -X PATCH $API/reports/<id> -H "$ADMIN" -H 'Content-Type: application/json' -d '{"verification":"verified"}'
curl -X PATCH $API/reports/<id> -H "$ADMIN" -H 'Content-Type: application/json' -d '{"status":"removed"}'
```

## Rate limits

Per client IP address unless noted. Values come from `config.navigation.rateLimits` (see [CONFIGURATION.md](CONFIGURATION.md#rate-limits)).

| Scope | Default |
|---|---|
| All `/api/v1` requests | 120 per minute |
| `GET /api/search`, `GET /api/geocode/reverse`, `GET /api/v1/places/search`, `GET /api/v1/places/reverse` | 60 per minute |
| `GET /api/v1/places/nearby` | 30 per minute |
| `POST /api/v1/routes` | 10 per minute |
| `POST /api/v1/auth/device` | 10 per hour |
| `POST /api/v1/auth/signup` | 10 per hour |
| `POST /api/v1/auth/login` | 30 per hour per IP and 10 per hour per account |
| `POST /api/v1/reports` | 10 per hour per device |
| `POST /api/v1/reports/{id}/votes` | 60 per hour per device |
| Password checks of a signed-in user | 10 per hour per account |

Refused requests get `429`, `code: "RATE_LIMITED"` and `Retry-After`. Every `/api/v1` answer carries
`RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`.

## Live traffic and perception ingest

The AI service posts observations; the dashboard and the navigation page read them. Shapes: the `Snapshot` schema in
the OpenAPI document. The observation contract: `python/docs/RENDER_DEPLOYMENT.md`.

## Socket.IO events

Server at the backend origin, default path `/socket.io`. Implemented in `socket/trafficSocket.js`. Used by the dashboard
and the web navigation page. **Not part of the mobile `/api/v1` contract**: the app polls `/api/v1/traffic`.

Every client starts in room `live`. Client to server:

| Event | Payload | Effect |
|---|---|---|
| `subscribe` | `{ mode: 'live' \| 'simulation' }` | Switch rooms; answered with a fresh `init`. |

Server to client (same names in both rooms; `dataMode` says which):

| Event | Payload |
|---|---|
| `init` | `{ dataMode, intersections: Snapshot[], serverTime, network?: { topology, decision }, simulation? }` |
| `trafficUpdate` | `Snapshot`: a new observation was processed. |
| `signalUpdate` | `Snapshot`: phase, plan or mode changed. |
| `systemEvent` | `{ id, dataMode, intersectionId, time, category, message, level }` |
| `networkDecision` | `{ dataMode, cycle, at, evaluated, intersections, links, corridors }` |
| `streamStatus` | live room only: same as `GET /api/streams/status`. |
| `simulationStatus`, `simulationReset` | simulation room only. |
| `subscribeError` | `{ error }` |

## Static files

`/` serves the operations dashboard (`frontend/`), `/navigation.html` the web driver page, `/admin.html` the admin
console, and `/vendor/three` and `/vendor/maplibre-gl` the libraries they use.
