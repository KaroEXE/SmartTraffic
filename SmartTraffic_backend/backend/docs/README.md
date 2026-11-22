# Documentation index

Start with the document for your job. All paths are relative to `backend/docs/`.

## By role

| You are | Read first | Then |
|---|---|---|
| **Mobile app developer** | [MOBILE_INTEGRATION_GUIDE.md](MOBILE_INTEGRATION_GUIDE.md): base URL, auth, every `/api/v1` endpoint the app uses, errors, limits | [API_REFERENCE.md](API_REFERENCE.md) (endpoint index), `/api/docs/` (try requests), [GEO_DATABASE.md](GEO_DATABASE.md) (what search returns and why) |
| **Web / frontend developer** | [API_REFERENCE.md](API_REFERENCE.md) | [MOBILE_INTEGRATION_GUIDE.md](MOBILE_INTEGRATION_GUIDE.md) §2 (conventions, attribution), `/api/client-config` |
| **Anyone calling search or reverse geocoding** | [API_REFERENCE.md § Geographic search](API_REFERENCE.md#geographic-search) | [GEO_DATABASE.md](GEO_DATABASE.md) (ranking, data, limits) |
| **AI service (Python) integrator** | [API_REFERENCE.md § Live traffic](API_REFERENCE.md#live-traffic-and-perception-ingest) | `python/docs/RENDER_DEPLOYMENT.md` (observation contract), [CONFIGURATION.md](CONFIGURATION.md) (`TRAFFIC_INGEST_TOKEN`) |
| **Backend developer** | [ARCHITECTURE.md](ARCHITECTURE.md) | [CONFIGURATION.md](CONFIGURATION.md), [GEO_DATABASE.md](GEO_DATABASE.md), [SETUP_GUIDE.md](SETUP_GUIDE.md) |
| **Operator (deploying, running the import)** | [DEPLOYMENT.md](DEPLOYMENT.md), [GEO_DATABASE.md](GEO_DATABASE.md) § Production | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |

## Every document

| File | What it covers | Status |
|---|---|---|
| [API_REFERENCE.md](API_REFERENCE.md) | Every HTTP endpoint and Socket.IO event, grouped; geographic search in full; rate limits; authentication; response format | current |
| [MOBILE_INTEGRATION_GUIDE.md](MOBILE_INTEGRATION_GUIDE.md) | The `/api/v1` contract for the navigation app: conventions, auth, endpoints, routes, traffic, reports, errors, rate limits, checklist | current; §"What changed with the move to OpenFreeMap and Geoapify" is history |
| [GEO_DATABASE.md](GEO_DATABASE.md) | PostgreSQL + PostGIS: schema, OpenStreetMap import, search ranking, reverse geocoding, performance, Northflank | current; the import has not yet been run against a real database (see the status note in the file) |
| [CONFIGURATION.md](CONFIGURATION.md) | Every environment variable and fixed limit | current |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Production checklist, secrets, hosting notes | current |
| [SETUP_GUIDE.md](SETUP_GUIDE.md) | Running the project from a clean machine | current |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layers, decisions, known limits | current |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Start-up warnings, error codes, symptoms and causes | current |
| [API_TEST_REPORT.md](API_TEST_REPORT.md) | The test run of 12-15 November 2026 | **historical**: before the PostGIS change; not re-run |
| `openapi.js`, `openapiNavigation.js` | The source of `/api/openapi.json` and `/api/docs/` | source |

## Where the live documentation is

| Path | What |
|---|---|
| `/api/docs/` | Swagger UI: every operation, schemas, examples, "Try it out" |
| `/api/openapi.json` | The OpenAPI 3.0.3 document (generate clients from it) |
| `/api/client-config` | Map style URL, map area, attribution: what the browser and app need before any other call |
| `/api/v1/config` | Features that are available on this server, limits, rate limits, attribution (the app calls it at start-up) |
| `/api/health` | Liveness and the state of the navigation providers and databases (see [API_REFERENCE.md](API_REFERENCE.md#system-and-public-configuration)) |

## Conventions used in these documents

* "Redoz" names the geographic layer (`redoz_*` tables, source `redoz`). "Hawr" names the operator's places in MongoDB
  (`hawr:` ids) and the older parts of the system; both are in use until a rename is decided.
* Coordinates are `lat`/`lng` in query strings and objects; GeoJSON geometry is `[lng, lat]`.
* Examples use `http://localhost:5500`. Replace it with your host.
* Values in examples are illustrative unless a section says they are real output.
