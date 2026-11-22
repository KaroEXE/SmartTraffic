# API test report

> **Historical record, not the current state.** This report describes the build of 12-15 November 2026, before place
> search, reverse geocoding and nearby places moved to the PostgreSQL/PostGIS database ([GEO_DATABASE.md](GEO_DATABASE.md)).
> Its numbers and its search rows (Geoapify) are as they were on those days. It was not run again for the PostGIS change,
> so no current result is claimed in this file.

Generated from the Swagger document (`/api/openapi.json`, 74 operations) after the move from the previous map provider to
OpenFreeMap + Geoapify. Date of the runs: 12 to 15 November 2026. Everything below was run on a development machine
(Windows 11, Node 22, local MongoDB). Nothing here is carried over from an earlier report: every number comes from a run of
this build.

## How it was tested

| Level | What | Result |
|---|---|---|
| Automated suite | `MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test`: 232 tests, real MongoDB for the database tests; Geoapify and OSRM replaced by local fake servers that answer with **real captured Geoapify bodies** (`test/fixtures/geoapify/`) | **232 pass, 0 fail, 0 skipped** (full suite, run after the last code, frontend and docs change) |
| Frontend logic + guards | `test/navigation.test.js`: map config, report and place parsing, device session, route ranking, hazard loader, "no removed provider anywhere" guard | **20 of 20 PASS**, including the guard that fails if the removed provider, the removed map library or an old public map service appears in any source, doc or the env example file |
| Live smoke run | `node scripts/smokeNavigation.js <url> --write` against a real `server.js` on a throw-away MongoDB database with the **real Geoapify key** | **19 of 19 PASS** |
| Real browser (earlier pass) | Headless Edge (software WebGL) against that server: navigation page (map load, one canvas, one style request, search, 3 routes, distance/ETA, report an incident, the report in the database and in the admin API), dashboard map, admin console (wrong token refused, sign in, overview cards, places add / validate / hide / delete, map tab) | navigation flow **11 of 11 PASS**; dashboard **2 of 2 PASS**; admin **10 of 11**: the one "failure" is the browser logging the deliberate 401 of the wrong-token attempt |
| Start-up behaviour | final server.js booted on a clean scratch database after the last change (database connected, all routes up, /api/health answered 200) | PASS; the unreachable-database and production-without-secrets cases were not re-run (see Not verified) |
| Final pass (15 Nov) | after the last frontend changes: navigation flow 11 of 11, phone-width checks 7 of 7 (persistent "Powered by Geoapify", results attribution, 280-character report limit, outside-region notice), admin and dashboard 11 of 12 (the one is the deliberate 401), smoke 19 of 19, auth probes (no / wrong token 401, NoSQL operator in login 400, foreign CORS origin refused, no key in the client config) | PASS |

**Evidence labels.** *Live* = called against a running backend with a real database (and real Geoapify where it applies) in this round.
*Automated only* = the path is exercised by the automated suite (real router, services and validation; MongoDB for the database
tests; providers and the AI service replaced by fakes) but was **not called live** in this round. *NOT TESTED* = no test mentions
the path. The status column is PASS only where one of the first two applies and the run passed; nothing is marked PASS on the
strength of the Swagger document alone. The "automated" label matches the path only (any method): it shows that tests use the path, not that every method on it has a test.

## Endpoint table

| Method | Endpoint | Status | Auth | Tested |
|---|---|---|---|---|
| GET | `/api/health` | PASS | - | Live (this round) + automated |
| GET | `/api/client-config` | PASS | - | Live (this round) |
| POST | `/api/traffic` | PASS | ingestToken | Automated only |
| GET | `/api/intersections` | PASS | - | Live (this round) |
| GET | `/api/traffic/state` | PASS | - | Automated only |
| GET | `/api/traffic/state/{intersectionId}` | PASS | - | Automated only |
| GET | `/api/network` | NOT TESTED | - | No test calls this path (the logic behind it is unit-tested) |
| GET | `/api/simulation/intersections` | PASS | - | Automated only |
| GET | `/api/simulation/traffic/state` | PASS | - | Automated only |
| GET | `/api/simulation/traffic/state/{intersectionId}` | PASS | - | Automated only |
| GET | `/api/simulation/network` | NOT TESTED | - | No test calls this path (the logic behind it is unit-tested) |
| POST | `/api/simulation/network` | NOT TESTED | - | No test calls this path (the logic behind it is unit-tested) |
| GET | `/api/traffic/observations` | PASS | - | Automated only |
| GET | `/api/traffic/observations/{intersectionId}` | PASS | - | Automated only |
| GET | `/api/history/traffic` | PASS | - | Automated only |
| GET | `/api/history/signals` | PASS | - | Automated only |
| GET | `/api/simulation/status` | PASS | - | Automated only |
| POST | `/api/simulation/start` | PASS | - | Automated only |
| POST | `/api/simulation/pause` | PASS | - | Automated only |
| POST | `/api/simulation/reset` | PASS | - | Automated only |
| POST | `/api/simulation/scenario` | PASS | - | Automated only |
| POST | `/api/simulation/tour` | PASS | - | Automated only |
| POST | `/api/simulation/ambulance` | NOT TESTED | - | No test calls this path (the logic behind it is unit-tested) |
| PATCH | `/api/simulation/ambulance/{id}` | NOT TESTED | - | No test calls this path (the logic behind it is unit-tested) |
| DELETE | `/api/simulation/ambulance/{id}` | NOT TESTED | - | No test calls this path (the logic behind it is unit-tested) |
| POST | `/api/simulation/benchmark` | NOT TESTED | - | No test calls this path (the logic behind it is unit-tested) |
| GET | `/api/simulation/benchmark` | NOT TESTED | - | No test calls this path (the logic behind it is unit-tested) |
| GET | `/api/streams` | PASS | ingestToken / streamAdminToken | Automated only |
| POST | `/api/streams` | PASS | streamAdminToken | Automated only |
| GET | `/api/streams/status` | PASS | - | Automated only |
| POST | `/api/streams/health` | PASS | ingestToken / streamAdminToken | Automated only |
| GET | `/api/streams/{id}` | PASS | ingestToken / streamAdminToken | Automated only |
| PATCH | `/api/streams/{id}` | PASS | streamAdminToken | Automated only |
| DELETE | `/api/streams/{id}` | PASS | streamAdminToken | Automated only |
| GET | `/api/v1/config` | PASS | - | Live (this round) + automated |
| POST | `/api/v1/auth/device` | PASS | deviceToken | Live (this round) + automated |
| POST | `/api/v1/auth/signup` | PASS | - | Live (this round) + automated |
| POST | `/api/v1/auth/login` | PASS | - | Live (this round) + automated |
| POST | `/api/v1/auth/refresh` | PASS | userToken | Automated only |
| POST | `/api/v1/auth/logout` | PASS | userToken | Automated only |
| POST | `/api/v1/auth/change-password` | PASS | userToken | Automated only |
| GET | `/api/v1/auth/me` | PASS | userToken | Live (this round) + automated |
| PATCH | `/api/v1/auth/me` | PASS | userToken | Automated only |
| DELETE | `/api/v1/auth/me` | PASS | userToken | Live (this round) + automated |
| GET | `/api/v1/places/search` | PASS | - | Live (this round) + automated |
| GET | `/api/v1/places/reverse` | PASS | - | Live (this round) + automated |
| GET | `/api/v1/places/nearby` | PASS | - | Live (this round) + automated |
| POST | `/api/v1/routes` | PASS | - | Live (this round) + automated |
| GET | `/api/v1/traffic` | PASS | - | Live (this round) + automated |
| GET | `/api/v1/road-features` | PASS | - | Live (this round) + automated |
| POST | `/api/v1/road-features` | PASS | navAdminToken | Live (this round) + automated |
| GET | `/api/v1/road-features/{id}` | PASS | - | Automated only |
| PATCH | `/api/v1/road-features/{id}` | PASS | navAdminToken | Automated only |
| DELETE | `/api/v1/road-features/{id}` | PASS | navAdminToken | Live (this round) + automated |
| GET | `/api/v1/reports` | PASS | deviceToken | Live (this round) + automated |
| POST | `/api/v1/reports` | PASS | deviceToken | Live (this round) + automated |
| GET | `/api/v1/reports/{id}` | PASS | deviceToken | Automated only |
| DELETE | `/api/v1/reports/{id}` | PASS | deviceToken | Live (this round) + automated |
| PATCH | `/api/v1/reports/{id}` | PASS | navAdminToken | Automated only |
| POST | `/api/v1/reports/{id}/votes` | PASS | deviceToken | Live (this round) + automated |
| GET | `/api/v1/places/local` | PASS | - | Live (this round) + automated |
| POST | `/api/v1/places/local` | PASS | navAdminToken | Live (this round) + automated |
| GET | `/api/v1/places/local/{id}` | PASS | - | Automated only |
| PATCH | `/api/v1/places/local/{id}` | PASS | navAdminToken | Live (this round) + automated |
| DELETE | `/api/v1/places/local/{id}` | PASS | navAdminToken | Live (this round) + automated |
| GET | `/api/v1/saved-places` | PASS | userToken | Live (this round) + automated |
| POST | `/api/v1/saved-places` | PASS | userToken | Live (this round) + automated |
| PATCH | `/api/v1/saved-places/{id}` | PASS | userToken | Automated only |
| DELETE | `/api/v1/saved-places/{id}` | PASS | userToken | Live (this round) + automated |
| GET | `/api/v1/admin/overview` | PASS | navAdminToken | Live (this round) + automated |
| GET | `/api/v1/admin/users` | PASS | navAdminToken | Automated only |
| GET | `/api/v1/admin/reports` | PASS | navAdminToken | Live (this round) + automated |
| GET | `/api/v1/admin/places` | PASS | navAdminToken | Live (this round) + automated |
| GET | `/api/v1/admin/road-features` | PASS | navAdminToken | Automated only |

74 operations: 31 called live in this round, 35 covered by the automated suite only, 8 not tested.

## Authentication and authorisation (what is covered)

All of these are in `test/userAuth.test.js` and `test/navigationApi.test.js` (automated, real router) and, for sign-up, login,
`/auth/me`, wrong password and account deletion, also in the live smoke run:

| Check | Result |
|---|---|
| Register, then `/auth/me` returns the account without any password data | PASS |
| Duplicate email is refused (`409 EMAIL_TAKEN`) | PASS |
| Login with the right password; a wrong password and an unknown email give the same 401 | PASS |
| Invalid sign-up and login input is refused | PASS |
| Protected routes: no token, forged token, a device token used as a user token, an expired token | all 401 |
| Refresh issues a working token; logout revokes every token of the user | PASS |
| Change password needs the current one and signs other devices out; delete account needs the password | PASS |
| Login and password checks are rate limited per account | PASS |
| Passwords are stored as salted scrypt hashes, never returned | PASS |
| Roles: admin endpoints need `NAV_ADMIN_TOKEN` (device and user tokens are refused; 503 when it is unset) | PASS |
| Saved places are private to their user, another user gets 404, and they are deleted with the account | PASS (automated, database) |
| A secret never reaches a client: `/api/client-config` carries no key (the smoke script checks its answer against the live key; `/api/v1/config` is covered by the automated suite) | PASS |

## Not verified

- **The old 74-check live API sweep script was not re-run.** The final build was exercised by the 19-check smoke run (live Geoapify), the auth probes and the browser flows listed above; the other endpoints are covered by the automated suite (35 endpoints automated only). To run the sweep: start the backend on a scratch database and run the script again.
- **`POST /api/traffic` with a valid observation, `/api/streams` writes and `/api/simulation/*` writes** were not called live:
  no Python AI service is connected and `STREAM_ADMIN_TOKEN` is not set here. Covered by `test/streams.test.js`,
  `utils/trafficIngestion.test.js`, `test/liveScene.test.js`, `services/simulationService.test.js`. To test: start the AI service
  with `TRAFFIC_INGEST_TOKEN`; `GET /api/traffic/state` must then show `live` intersections.
- **Eight operations are not called by any test over HTTP** (the rows marked NOT TESTED: /api/network, /api/simulation/network, /api/simulation/ambulance, /api/simulation/benchmark). The engines behind them are unit-tested (networkCoordination, benchmark and simulationService tests); the production lock on the simulation writes is tested over HTTP. To close the gap: add route tests for them.
- **Own OSRM server**: the adapter is tested against a fake server in the OSRM format only. BLOCKED on a real OSRM server. To
  test: set `ROUTING_OSRM_URL`, run `npm run smoke`.
- **`NO_ROUTE` from Geoapify** (two reachable points with no connecting road) could not be provoked live; the unroutable-point
  error (a point with no road: 400 "no suitable edges" -> `422 POINT_NOT_ROUTABLE`) was captured live and is tested.
- **Mobile app**: not in this repository, not tested. The contract it uses (`/api/v1`) is the one above.
- **Real locations through the Hawr API**: only Sulaymaniyah (search, nearby, reverse, routes) was run through the Hawr API on this build. Erbil, Duhok, Kirkuk, Baghdad and smaller places were checked for **map labels** only (see SETUP_GUIDE.md); the five-city search and routing checks done in an earlier round used the same Geoapify calls but not this build.
- **Current location**: the browser flow was not run with a real GPS fix (headless Edge has none); the code path is unchanged from before the migration. There is no register or login screen in the web pages, so saved places can only be used through the API.
- **Production mode** (`NODE_ENV=production`): the start checks and the 403 on simulation writes are unit-tested; a full
  production deployment was not run.
- **Geoapify key restriction**: restricting the key to the server's IP is an account setting; it cannot be checked from here.
- **Screen reader testing** (NVDA / VoiceOver) was not done.
