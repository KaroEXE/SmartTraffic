# API reference

Every HTTP endpoint and Socket.IO event of the backend. Request and response
schemas, with examples, are in the OpenAPI document served at
`/api/openapi.json` and rendered by Swagger UI at `/api/docs/`. Both are
built from `docs/openapi.js` and `docs/openapiNavigation.js`. The tests
fail when a live, simulation (`routes/docsRoutes.test.js`) or `/api/v1`
(`test/navigationApi.test.js`) route is missing from them.

The mobile navigation API (`/api/v1`) is described for app developers in
[MOBILE_INTEGRATION_GUIDE.md](MOBILE_INTEGRATION_GUIDE.md).

## Authentication

| Credential | Header | Used by | Configured with |
|---|---|---|---|
| none | - | public reads, dashboard, mobile reads | - |
| Device token | `Authorization: Bearer <jwt>` | mobile app writes (reports, votes) | issued by `POST /api/v1/auth/device`, signed with `DEVICE_TOKEN_SECRET` |
| Navigation admin token | `Authorization: Bearer <token>` | road-feature management, report moderation | `NAV_ADMIN_TOKEN` (unset = those endpoints answer 503) |
| Ingest token | `Authorization: Bearer <token>` | Python AI service: `POST /api/traffic`, stream reads and health | `TRAFFIC_INGEST_TOKEN` (unset = open, development only) |
| Stream admin token | `Authorization: Bearer <token>` | camera stream management | `STREAM_ADMIN_TOKEN` (unset = management answers 503) |

Static tokens are compared in constant time (`utils/auth.js`) and never
logged. Device tokens are HS256 JWTs checked in `utils/deviceToken.js`.

## Response format

Success: `{ "ok": true, ... }`. Error: `{ "ok": false, "error": "<text>", "code"?: "<CODE>", "details"?: [...] }`.

Every `/api/v1` error has `code`. Elsewhere `code` is set by the shared
handlers (`NOT_FOUND`, `MALFORMED_JSON`, `PAYLOAD_TOO_LARGE`,
`INTERNAL_ERROR`); the older endpoints' own errors have `error` only. The
full list of `/api/v1` codes and what a client should do is in the
[mobile guide, §8](MOBILE_INTEGRATION_GUIDE.md#8-errors).

Request bodies: JSON, at most 100 KB.

## Mobile navigation API: `/api/v1`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/v1/config` | - | Available features, limits, rate limits, attribution |
| POST | `/api/v1/auth/device` | - / device | Issue a device token (or renew one near expiry) |
| GET | `/api/v1/places/search` | - | Place / address search (Nominatim-compatible provider) |
| GET | `/api/v1/places/reverse` | - | Address at a point |
| GET | `/api/v1/places/nearby` | - | POIs of one category around a point (Overpass) |
| POST | `/api/v1/routes` | - | Routes (OSRM) ranked by live-AI-adjusted time, with traffic and road alerts |
| GET | `/api/v1/traffic` | - | Live AI traffic per monitored intersection |
| GET | `/api/v1/road-features` | - | Operator + OpenStreetMap road features in a box |
| GET | `/api/v1/road-features/{id}` | - | One operator road feature |
| POST | `/api/v1/road-features` | nav admin | Create an operator road feature |
| PATCH | `/api/v1/road-features/{id}` | nav admin | Update it (partial) |
| DELETE | `/api/v1/road-features/{id}` | nav admin | Delete it |
| GET | `/api/v1/reports` | - / device | Active community reports in a box |
| GET | `/api/v1/reports/{id}` | - / device | One report, any status |
| POST | `/api/v1/reports` | device | Create (or merge into a nearby report) |
| POST | `/api/v1/reports/{id}/votes` | device | Confirm / dismiss |
| DELETE | `/api/v1/reports/{id}` | device | Withdraw own report |
| PATCH | `/api/v1/reports/{id}` | nav admin | Moderate: `status` (`active`, `removed`, `resolved`), `verification` |

Rate limits, per IP unless noted: 120/min overall; search and reverse
30/min; nearby 20/min; routes 20/min; device registration 10/hour; report
creation 10/hour per device; votes 60/hour per device. See
[CONFIGURATION.md](CONFIGURATION.md#rate-limits).

### Operator examples (admin token)

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

## System

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | - | Uptime, AI feed status, database status and history counters, navigation providers (`navigation`: requests, cache hits, failures, circuit state, benched Overpass instances) |
| GET | `/api/client-config` | - | Public settings for the dashboard (`aiStreamUrl`) |
| GET | `/api/docs/` | - | Swagger UI |
| GET | `/api/openapi.json` | - | OpenAPI 3.0.3 document |

## Live traffic (AI service and dashboard)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/traffic` | ingest | One perception observation (about 1/s per intersection). Contract: `python/docs/RENDER_DEPLOYMENT.md` |
| GET | `/api/traffic/observations` | - | Latest stored observation of every intersection |
| GET | `/api/traffic/observations/{intersectionId}` | - | Latest observation (memory, else newest database record) |
| GET | `/api/traffic/state` | - | Decision-engine snapshots (signals, phases, scores) |
| GET | `/api/traffic/state/{intersectionId}` | - | One snapshot with recent events |
| GET | `/api/intersections` | - | Configured intersections and summary state |
| GET | `/api/network` | - | Network topology and the latest coordination cycle |
| GET | `/api/history/traffic` | - | Stored observations (`mode`, `intersectionId`, `from`, `to`, `limit` ≤ 1000) |
| GET | `/api/history/signals` | - | Stored signal phase changes (same filters) |

## Simulation (dashboard Simulation tab)

Isolated simulated channel: its own engine, store and Socket.IO room. Never
mixed with live data, and never visible through `/api/v1`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/simulation/intersections`, `/traffic/state`, `/traffic/state/{id}`, `/network` | Read simulated state (same shapes as live) |
| GET | `/api/simulation/status` | Simulator state and scenarios |
| POST | `/api/simulation/start`, `/pause`, `/reset` | Control the simulator |
| POST | `/api/simulation/scenario`, `/tour`, `/network` | Scenario, automatic tour, network optimisation on/off |
| POST / PATCH / DELETE | `/api/simulation/ambulance`, `/ambulance/{id}` | Simulated emergency vehicle |
| GET / POST | `/api/simulation/benchmark` | Fixed vs adaptive vs network control on identical simulated demand |

## Camera streams

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/streams/status` | - | Public stream health (no URLs) |
| GET | `/api/streams` | ingest or stream admin | Registered streams with URLs |
| GET | `/api/streams/{id}` | ingest or stream admin | One stream |
| POST | `/api/streams/health` | ingest or stream admin | AI service health report |
| POST | `/api/streams` | stream admin | Register a stream |
| PATCH | `/api/streams/{id}` | stream admin | Change / enable / disable |
| DELETE | `/api/streams/{id}` | stream admin | Remove |

## Socket.IO events

Server at the backend origin (default path `/socket.io`). Implemented in
`socket/trafficSocket.js`. Used by the dashboard and the web navigation
page; **not part of the mobile v1 contract** (the app polls `/api/v1/traffic`).

Every client starts in room `live`. Client → server:

| Event | Payload | Effect |
|---|---|---|
| `subscribe` | `{ mode: 'live' \| 'simulation' }` | Switch rooms; answered with a fresh `init` |

Server → client (same names in both rooms; `dataMode` says which):

| Event | Payload |
|---|---|
| `init` | `{ dataMode, intersections: Snapshot[], serverTime, network?: { topology, decision }, simulation? }` |
| `trafficUpdate` | `Snapshot`: a new observation was processed |
| `signalUpdate` | `Snapshot`: phase, plan or mode changed |
| `systemEvent` | `{ id, dataMode, intersectionId, time, category, message, level }` |
| `networkDecision` | `{ dataMode, cycle, at, evaluated, intersections, links, corridors }` |
| `streamStatus` | live room only: same as `GET /api/streams/status` |
| `simulationStatus`, `simulationReset` | simulation room only |
| `subscribeError` | `{ error }` |

`Snapshot` is the schema of the same name in the OpenAPI document.

## Static files

`/` serves the operations dashboard (`../frontend`), `/navigation.html` the
web driver page, `/vendor/three` and `/vendor/leaflet` the libraries they use.
