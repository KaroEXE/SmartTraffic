# Architecture

One Node.js process (Express 4, Socket.IO 4, Mongoose 8) serves three
groups of clients:

- the **Python AI service**, which posts camera-based traffic observations;
- the **operations dashboard**, the web driver page and the **admin console** (static files in
  `../frontend`, Socket.IO);
- the **public navigation mobile app**, through the versioned REST API
  `/api/v1`.

```
 Python AI service ──POST /api/traffic──▶ validation ─▶ trafficStateService ─▶ decision engine (live)
                                                                 │                 │  signals, phases,
                                                                 ▼                 ▼  network coordinator
                                                         trafficHistoryService   Socket.IO room "live" ─▶ dashboard
                                                                 │
                                                                 ▼
                                                              MongoDB ◀──────────────────────────────┐
                                                                                                     │
 Web / mobile ──/api/v1──▶ routes/navigationRoutes.js (auth, rate limits)                              │
 Admin console ─/api/v1/admin─┘  │                                                                      │
                          ├─ navigationController ─┬─ placeService ────┐                              │
                          │                        ├─ routePlanner ─┬──┴─ routingService ──▶ providerClient ──▶ Geoapify / own OSRM
                          │                        │                ├─ liveTrafficService ◀── live decision engine (read only)
                          │                        │                └─ road alerts ───────────────────┤
                          │                        └─ liveTrafficService                              │
                          ├─ placeDataController ──┬─ localPlaceService ─ LocalPlace (also searched by placeService)
                          │                        └─ savedPlaceService ─ SavedPlace (per user) ───┤
                          ├─ roadDataController ───┬─ roadFeatureService ── RoadFeature ─────────────┤
                          ├─ adminController ──────┤                                                  │
                          └─ authController ───────┴─ roadReportService  ── RoadReport / User ───────┘

 Dashboard Simulation tab ─▶ /api/simulation ─▶ simulation engine (separate, never reaches the live path or /api/v1)
```

## Principles the code follows

- **Only real data on live paths.** Live views, including `/api/v1`, read
  the live decision engine, which is fed only by `POST /api/traffic`. The
  simulator has its own engine, store, routes and Socket.IO room.
  `test/noFakeData.test.js` enforces this (no random numbers outside the
  simulator, no simulation imports in live modules).
- **Nothing invented where nothing was measured.** An intersection
  without a feed is `no-data`; a missing camera is `available: false` with
  `null` counts; an intersection without a surveyed position has `null` coordinates,
  is drawn on no map and is never matched to routes; an unavailable source is reported as `unavailable`.
- **Signal control never depends on the database or external providers.**
  MongoDB and the search / routing providers can be down after start-up and the signals keep running.
  (At start-up, with `MONGODB_URI` set, the backend verifies the database and
  refuses to start without it: see Database.)
- **Provider credentials stay on the server.** The app calls only this
  backend; provider URLs and keys are environment variables and never
  appear in answers or error messages.

## Mobile navigation API

### Layers

| Layer | Files | Responsibility |
|---|---|---|
| Wiring | `services/navigation/index.js` | Builds services, controllers and router from `config`; used by `server.js` and by the tests (with fakes) |
| Routes | `routes/navigationRoutes.js` | Paths, authentication (device / admin), rate limits, security headers, v1 404 |
| Controllers | `controllers/navigationController.js`, `controllers/roadDataController.js`, `controllers/adminController.js`, `controllers/authController.js` | Validate input (`utils/navValidation.js`), call services, shape answers |
| Services | `services/navigation/*.js` | Provider client (Geoapify, OSRM), places, routing, live traffic view, route planning, local and saved places, database access |
| Models | `models/RoadFeature.js`, `models/RoadReport.js`, `models/LocalPlace.js`, `models/SavedPlace.js`, `models/navigationConstants.js` | Schemas, indexes, enumerations |
| Utilities | `utils/geo.js`, `utils/upstream.js`, `utils/ttlCache.js`, `utils/rateLimit.js`, `utils/deviceToken.js`, `utils/apiError.js` | Geometry, provider HTTP (timeouts, throttle, circuit breaker), cache, rate limiter, device tokens, error format |
| Docs | `docs/openapiNavigation.js` | OpenAPI paths and schemas, built from the same constants as the code |

### `POST /api/v1/routes`: what happens

1. Validation (`validateRouteRequest`): points, `maxRoutes` 1-4, `steps`.
2. `routingService.route()`: cache lookup by rounded coordinates (5 min).
   On a miss the provider is asked:
   - **Own OSRM** (`ROUTING_OSRM_URL`): one request with `alternatives=<maxRoutes-1>`, GeoJSON geometry and steps.
   - **Geoapify** (default): `GET /v1/routing?waypoints=lat,lng|lat,lng&mode=drive&type=…` once per route
     type (`balanced`, `short`, `less_maneuvers`), because Geoapify has no alternatives option. A route
     that shares most of its line with a better one is dropped, so 1 to 3 different routes remain.
   Times are free-flow. Each answer is normalised once into the SmartTraffic `Route` shape (GeoJSON
   LineString, distance m, duration s, steps with an OSRM-style maneuver vocabulary), so no client depends
   on the provider's format. Provider errors (unroutable point, quota, rate limit, key problems) become
   the API's own codes.
3. `liveTrafficService.estimate()`: for each route, each monitored
   intersection with a surveyed position within 60 m of the line. The
   approach the route enters by comes from its heading. Delay = mean wait
   of the stopped vehicles + 2 s per vehicle on that approach, from the
   latest live observation only.
4. `routePlanner.roadAlerts()`: one geospatial query each for active
   reports and in-force closures / roadworks in the routes' bounding box,
   then the exact distance to each line (<= 40 m) and position along it.
5. Rank by `duration + delay`, distance breaking ties.

Steps 3-5 run on every request, so a client re-sending the same request
gets fresh ETAs without new provider requests.

### Geographic database: PostgreSQL + PostGIS (own search)

Search, reverse geocoding, nearby places and roads come from **our own PostgreSQL/PostGIS database** filled from an
OpenStreetMap extract; no external search provider exists in that path. It sits next to MongoDB (unchanged: users,
reports, traffic, devices). Layers: `db/postgres.js` (lazy pool) -> `repositories/geoRepository.js` (all SQL) ->
`services/geo/geoService.js` -> `controllers/geoController.js` / `routes/geoRoutes.js` (`GET /api/search`,
`GET /api/geocode/reverse`) and `services/navigation/placeService.js` (the `/api/v1/places/*` endpoints of the apps).
Schema, import, ranking and Northflank notes: [GEO_DATABASE.md](GEO_DATABASE.md).

### External providers: Geoapify and OpenFreeMap

The map and the routing are separate services (see [CONFIGURATION.md](CONFIGURATION.md)):

- **OpenFreeMap** only draws the map: the browser or app loads its vector style and tiles directly (no key,
  no server involvement). The backend only serves the style URL, the area the map is fixed to and the
  attribution (`GET /api/client-config`). It has no search, routing or traffic, and none is asked of it.
- **Geoapify** and an optional own **OSRM** serve routing only.
  `services/navigation/providerClient.js` is the only code that talks to them (one generic client, two
  instances). Routing (`routingService`) uses the Geoapify instance:

  - **Authentication**: `x-api-key: <GEOAPIFY_API_KEY>` header only, never in a URL, a log or an answer.
    Nothing secret is sent to a browser or an app.
  - **Throttle**: request starts at least 220 ms apart (the free plan allows 5 per second).
    A request that would wait longer than `PROVIDER_MAX_WAIT_MS` is refused with `503 PROVIDER_BUSY`.
  - **Daily credit budget** (`GEOAPIFY_DAILY_REQUEST_LIMIT`, UTC days): when used up, requests fail at once
    with `503 PROVIDER_QUOTA_EXCEEDED` and `Retry-After`, before Geoapify is called. A route search costs
    one credit per route type.
  - **Circuit breaker**: after 3 consecutive faults (timeouts, 5xx, rate limiting) the provider is benched
    for `PROVIDER_COOLDOWN_SECONDS`. A used-up quota or a key problem does not trip it.
  - **Caching** (in memory): routes 5 min. Search, reverse and nearby are not cached (PostGIS answers in milliseconds).
  - Errors become `UpstreamError` / `ApiError` codes without URLs, keys or provider text.
- **Hawr's own data** is searched first: `localPlaceService` (operator-entered places in MongoDB) is merged
  in front of the PostGIS results of `/api/v1/places/search`, so a place only the operator knows is found even when OpenStreetMap lacks it.

The provider is chosen by configuration and hidden behind `placeService` / `routingService`: a different
search or routing provider is a new client and a new normaliser; the API answers, the web pages and the
mobile app do not change.

### Admin console API

`controllers/adminController.js` serves the read-only views of `admin.html` behind
`NAV_ADMIN_TOKEN`: overview, users, reports, road features. Changes use the
existing endpoints (`PATCH /reports/:id`, `/road-features`).

### Device tokens

`utils/deviceToken.js`: HS256 JWTs (`sub` = random UUID device id, `plt`,
`iat`, `exp`, `iss: "smarttraffic"`, `typ: "device"`), signed with
`DEVICE_TOKEN_SECRET`. Verification checks the header algorithm exactly
(no `none`, no algorithm switching), compares the signature in constant
time, and checks issuer, type, id format, issue time and expiry. Nothing is
stored server-side: a device "exists" when it holds a valid token. Tokens
let the backend rate-limit writes per device, refuse double votes and let a
device withdraw its own reports. They are not proof of identity, which is
why registration is rate-limited per IP.

### Map-area queries

Boxes become a GeoJSON polygon for `$geoWithin` on the 2dsphere index.
MongoDB draws polygon edges as great circles, which bow towards the pole
away from a box's lines of latitude (about 28 m for a 0.5° box, kilometres
for a long route's box). `utils/geo.bboxQueryPolygon` pads the polygon by
that amount, and the services then keep only results inside the exact box.
`test/navigationDatabase.test.js` shows the plain polygon missing a point
5 m inside a box.

## Database

MongoDB through Mongoose's default connection (`config/database.js`).
`bufferCommands` is off (a query while disconnected fails at once). With `MONGODB_URI` set the
connection is verified **before** the API starts: three attempts, then the process exits with
the reason. Afterwards a lost connection is retried in the background and shown in `/api/health`.
Collections and indexes are created explicitly after connecting
(`prepareCollections`, idempotent) for every registered model, including
the two navigation models. Without `MONGODB_URI` the backend runs without
history and the navigation database features answer
`503 DATABASE_UNAVAILABLE`.

| Collection | Model | Written by | Purpose |
|---|---|---|---|
| `users` | `User` | `userAccountService` | Accounts: email (unique), salted scrypt password hash, name |
| `trafficRecords` | `TrafficRecord` (time-series, `timestamp` / `intersectionId`) | `trafficHistoryService` | Accepted AI observations (sampled) with the signal state |
| `signalEvents` | `SignalEvent` | `trafficHistoryService` | Every signal phase change |
| `trafficStreams` | `TrafficStream` | `/api/streams` | Camera stream registry and health |
| `roadFeatures` | `RoadFeature` | `/api/v1/road-features` (admin) | Speed cameras, bumps, closures, roadworks entered by the operator |
| `roadReports` | `RoadReport` | `/api/v1/reports` | Community reports, votes, moderation |

### `roadFeatures`

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | exposed as `id` |
| `kind` | `speed_camera` \| `speed_bump` \| `road_closure` \| `roadworks` | required |
| `location` | GeoJSON Point `[lng, lat]` | required |
| `name`, `description`, `source` | string \| null | ≤ 120 / 500 / 80 characters |
| `direction` | number \| null | bearing 0-359.9 the feature applies to |
| `speedLimitKmh` | number \| null | 5-200 |
| `active` | boolean | default true |
| `validFrom`, `validUntil` | Date \| null | in force only inside this window |
| `createdAt`, `updatedAt` | Date | Mongoose timestamps |

Index: `{ location: '2dsphere', kind: 1, active: 1 }`.

### `roadReports`

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | exposed as `id` |
| `type` | `accident` \| `traffic_jam` \| `road_closure` \| `construction` \| `hazard` | required |
| `location` | GeoJSON Point | required |
| `heading` | number \| null | reporter's direction of travel |
| `description` | string \| null | ≤ 280, control characters refused |
| `reporterId` | string | device id. **Never returned by the API.** |
| `platform` | string \| null | from the device token |
| `status` | `active` \| `withdrawn` \| `removed` \| `resolved` \| `dismissed` | `expired` is computed (active and `expiresAt` passed), never stored |
| `verification` | `unverified` \| `verified` | moderator decision |
| `confirmations`, `dismissals` | number | counters |
| `votes` | `[{ deviceId, vote, at }]` | ≤ 200 newest kept; one per device; **never returned** |
| `expiresAt` | Date | creation + type TTL; extended by confirmations, at most 4 TTLs after creation |
| `purgeAt` | Date \| null | TTL index: MongoDB deletes the report then (`REPORT_RETENTION_DAYS` after it stops being active) |
| `createdAt`, `updatedAt` | Date | |

Indexes: `{ location: '2dsphere', status: 1, expiresAt: 1 }` (area and
near-route queries, merge check with `$nearSphere`),
`{ reporterId: 1, status: 1, expiresAt: 1 }` (active report cap),
`{ purgeAt: 1 }` with `expireAfterSeconds: 0` (retention).

Consistency: a vote is one conditional `findOneAndUpdate` (active, not
expired, not the reporter, this device not among the voters) with `$push`
and `$inc`, so concurrent votes from one device count once. Expiry
extension and the switch to `dismissed` are follow-up conditional updates
and are idempotent.

## Code organization

```
backend/
  server.js                    process wiring: engines, services, routes, Socket.IO, shutdown
  config/
    index.js                   all environment settings (see docs/CONFIGURATION.md)
    database.js                MongoDB connection, retry, collection / index creation
    intersections.js           live intersections (positions, grid)
    simulationIntersections.js simulated intersections
  routes/
    trafficRoutes.js           /api (live), /api/simulation, /api/streams
    navigationRoutes.js        /api/v1 (mobile): auth, rate limits
    docsRoutes.js              /api/docs (Swagger UI), /api/openapi.json
  controllers/
    trafficController.js       ingestion, state, history, health
    simulationController.js    simulator controls
    streamController.js        camera stream registry
    navigationController.js    /api/v1 config, device, places, routes, traffic
    roadDataController.js      /api/v1 road features, reports
  services/
    trafficDecisionService.js  signal decision engine (one instance per channel)
    trafficStateService.js     latest observation per intersection
    trafficHistoryService.js   history writer / reader
    streamRegistryService.js   camera stream registry cache
    networkTopology.js, networkCoordinator.js, networkTrafficModel.js, emergencyCorridor.js
    simulationService.js, simulationBenchmark.js   simulation channel only
    navigation/                mobile navigation API services
      index.js                 builds the whole /api/v1 stack
      providerClient.js        the one provider HTTP client: Geoapify and OSRM instances (key, throttle, budget, breaker)
      placeService.js          /api/v1/places/*: adapter over services/geo (PostGIS) + local places first
      routingService.js        routes, alternatives, steps (Geoapify route types or own OSRM)
      localPlaceService.js     operator-entered places (LocalPlace)
      savedPlaceService.js     a user's saved places (SavedPlace)
      liveTrafficService.js    live traffic view, per-route delay
      routePlanner.js          routes + traffic + alerts -> ranked answer
      roadFeatureService.js    RoadFeature access
      roadReportService.js     RoadReport access (merge, votes, moderation)
  models/                      Mongoose schemas + shared enumerations
  socket/trafficSocket.js      Socket.IO rooms and events
  utils/                       validation, auth, geometry, provider HTTP, cache, limits, errors
  docs/                        OpenAPI sources and these documents
  scripts/smokeNavigation.js   end-to-end check against a running backend
  test/                        node:test suites (+ colocated *.test.js)
```

## Known limits of the current design

- **Single instance.** The decision engines, latest observations, caches,
  rate-limit counters and circuit breakers live in process memory. Several
  instances would each have their own (and the AI service posts to one).
  Scaling out needs shared state (e.g. Redis) first.
- Route alerts do not change routes: the providers cannot be told to avoid reported closures.
- Route times are free-flow (no provider traffic is used); live delay exists only at
  camera-monitored intersections.
- One shared daily credit budget: a burst from one client can use it up for everyone until
  00:00 UTC (per-IP rate limits make this harder).
- Live traffic exists only at camera-monitored intersections with
  surveyed positions.
- Route instructions are English.
