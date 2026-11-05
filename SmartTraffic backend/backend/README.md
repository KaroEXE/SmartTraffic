# SmartTraffic backend

Node.js backend of SmartTraffic. It runs:

- the **adaptive signal decision engine**, fed by the Python AI service
  (`POST /api/traffic`), with network coordination and emergency corridors;
- the **operations dashboard** API, Socket.IO hub and static files (`../frontend`);
- the **mobile navigation API** (`/api/v1`) for the public navigation app:
  place search, routes ranked with live AI traffic, live traffic, road
  features (speed cameras, bumps, closures, roadworks) and community road
  reports;
- an isolated **simulation** channel for the dashboard.

| Document | Contents |
|---|---|
| [docs/MOBILE_INTEGRATION_GUIDE.md](docs/MOBILE_INTEGRATION_GUIDE.md) | For the mobile app developer: base URL, auth, every `/api/v1` endpoint, errors, limits |
| [docs/API_REFERENCE.md](docs/API_REFERENCE.md) | Every HTTP endpoint and Socket.IO event |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, code organization, database models and indexes |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every environment variable |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production setup, providers, security checklist, scaling |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptoms, causes, fixes |
| `/api/docs/` (running server) | Swagger UI; OpenAPI at `/api/openapi.json` |
| `../../python/docs/RENDER_DEPLOYMENT.md` | The AI service and its contract with this backend |

## Quick start

Requires Node.js ≥ 18. MongoDB is optional locally: without it there is no
history, and community reports / operator road features answer 503.

```bash
cd "SmartTraffic backend/backend"
npm install
cp .env.example .env      # then edit; see docs/CONFIGURATION.md
npm start                 # or: npm run dev (restarts on changes)
```

The console prints the URLs:

```
  Swagger     http://localhost:5500/api/docs/
  Dashboard   http://localhost:5500
  API         http://localhost:5500/api/health
  Mobile API  http://localhost:5500/api/v1/config
```

followed by `[navigation]` warnings for development defaults (public OSM
providers, no admin token…). Try the mobile API:

```bash
curl -s localhost:5500/api/v1/config
curl -s "localhost:5500/api/v1/places/search?q=hospital&lat=35.5617&lng=45.4329"
curl -s -X POST localhost:5500/api/v1/routes -H 'Content-Type: application/json' \
  -d '{"start":{"lat":35.5617,"lng":45.4329},"destination":{"lat":35.5702,"lng":45.4418},"steps":true}'
```

For a local MongoDB: `MONGODB_URI=mongodb://127.0.0.1:27017/smarttraffic`.

Recommended local settings for working on the navigation API:

```
DEVICE_TOKEN_SECRET=<64 hex characters>   # tokens survive restarts
NAV_ADMIN_TOKEN=<random>                  # enables road-feature management and moderation
INTERSECTION_LAT=… INTERSECTION_LNG=…     # surveyed position: live traffic on routes
```

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run with `node --watch` |
| `npm test` | All tests (`node --test`) |
| `npm run smoke -- <baseUrl> [--write]` | End-to-end check of `/api/v1` against a running backend and its real providers (`scripts/smokeNavigation.js`) |

## Testing

```bash
npm test                                            # no database needed
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test # + real-MongoDB tests
```

| Suite | Covers |
|---|---|
| `test/navigationUnits.test.js` | Geometry, device tokens (tampering, `alg: none`, expiry), rate limiter, cache, throttle, circuit breaker, provider error mapping, validation, OSRM / Nominatim / Overpass parsing, live traffic view and route delay |
| `test/navigationApi.test.js` | The whole `/api/v1` over HTTP with the real router, services and decision engine; providers are a local fake server reached over real HTTP; errors, auth, rate limits, disabled features, cache behaviour; Swagger covers every route |
| `test/navigationDatabase.test.js` | Against a **real** MongoDB (`MONGODB_TEST_URI`, skipped otherwise): 2dsphere / TTL indexes, area queries incl. geodesic edges, merge, votes (incl. a concurrency race), dismissals, withdraw, expiry, moderation, retention, route alerts. Creates and drops its own database. |
| the other `*.test.js` files | Decision engine, ingestion, history, streams, simulation, network, Socket.IO, Swagger, web navigation logic, "no fake data" guard |

`scripts/smokeNavigation.js` complements them: it calls a running backend,
so the real OSRM, Nominatim and Overpass are exercised.

## Project layout

```
config/       settings (config/index.js), database connection, intersections
routes/       Express routers: /api, /api/simulation, /api/streams, /api/v1, docs
controllers/  HTTP layer
services/     decision engine, state, history, streams, network, simulation
services/navigation/   mobile API: providers, live traffic, routes, road data
models/       Mongoose schemas and enumerations
socket/       Socket.IO
utils/        validation, auth, geometry, provider HTTP, cache, rate limit, errors
docs/         OpenAPI sources and documentation
scripts/      operational scripts
test/         tests (more are colocated as *.test.js)
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#code-organization).

## Repository note

`node_modules/` is committed in this repository. It is now listed in
`.gitignore`, which only stops new files from being added. To stop tracking
it (deployments run `npm ci` anyway): `git rm -r --cached node_modules`, then
commit.
