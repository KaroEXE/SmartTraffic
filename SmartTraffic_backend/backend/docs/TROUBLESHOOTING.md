# Troubleshooting

Start with `GET /api/health` (database, Geoapify `enabled` / `circuit`) and the admin
console overview (`/admin.html`: the same plus the daily credit budget
and the last error). Then read the start-up log: every configuration problem is logged
once, with the variable to change.

## Start-up

| Symptom | Cause | Fix |
|---|---|---|
| `Port ... is already in use` | Another process on `PORT` | Stop it or change `PORT` in `.env` |
| `Not starting: MongoDB is not reachable (...)` and the process exits | `MONGODB_URI` is set but the database cannot be reached (three attempts) | Check the URI (user, password, database), that MongoDB is running, and the Atlas Network Access list. The reason printed is the driver's, without the password. |
| `[database] MONGODB_URI is not set` | No database configured (development only) | Set `MONGODB_URI`. Without it accounts, reports and road features answer `503 DATABASE_UNAVAILABLE`. |
| `Not starting in production:` followed by a list | `NODE_ENV=production` and a required secret is missing | Set what the list names: [DEPLOYMENT.md](DEPLOYMENT.md#production-start-checks) |
| `[config] NAV_ADMIN_TOKEN is shorter than 16 characters - administration is DISABLED` | The operator token is too short to be safe | Generate one: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` |
| `[navigation] Neither GEOAPIFY_API_KEY nor ROUTING_OSRM_URL is set: routing is disabled.` | No routing provider configured | Set `GEOAPIFY_API_KEY` ([SETUP_GUIDE.md](SETUP_GUIDE.md#3-map-search-and-routing)) or `ROUTING_OSRM_URL`. Search does not need either. |
| `[geo] DATABASE_URL is not set: place search, reverse geocoding and nearby places are disabled` | No PostgreSQL/PostGIS database configured | Set `DATABASE_URL`, run `npm run db:migrate` and `npm run db:import-osm` ([GEO_DATABASE.md](GEO_DATABASE.md)). |
| `[navigation] Routing uses Geoapify: free-flow times, up to three routes` | Information, not an error | Set `ROUTING_OSRM_URL` to use your own OSRM server instead |
| `[navigation] DEVICE_TOKEN_SECRET is not set` | Development default | Set it; otherwise every restart signs all apps out |

## Map, search and routing

| Answer / symptom | Likely cause | What to check |
|---|---|---|
| Web map shows "The map could not be set up: the Hawr server did not answer" | `GET /api/client-config` failed | Is the backend running and reachable from this page? Open `/api/client-config`: it must show `map.styleUrl` |
| Web map shows "The map could not be loaded from OpenFreeMap" | The browser cannot reach `tiles.openfreemap.org` (offline, firewall, or the service is down) | Open `https://tiles.openfreemap.org/styles/liberty` in the browser. A corporate network may block it. If OpenFreeMap itself is down, set `OPENFREEMAP_STYLE_URL` to another style or to your own tile server |
| Map is blank or black but there is no message | The browser has no WebGL (old GPU driver, hardware acceleration off, some remote desktops) | Open `chrome://gpu` (or `edge://gpu`): WebGL must be enabled. MapLibre needs WebGL |
| Streets are drawn but there are few names | OpenStreetMap has no name there (small villages and side streets) or the zoom is low: labels appear by zoom level | Zoom in. Missing names are a data gap: add them in OpenStreetMap, or add the place as a *Place* in the admin console |
| Arabic or Kurdish labels look disconnected or reversed | Old browser without complex-text support | Use a current Chrome, Edge, Firefox or Safari |
| Map will not move outside Kurdistan | By design | Area and zoom range: `config.navigation.map` in `config/index.js` |
| `503 FEATURE_DISABLED` on **search** (`/api/search`, `/api/geocode/reverse`, `/api/v1/places/*`) | No `DATABASE_URL` in the environment **of the server that answered** (a git-ignored `.env` is not deployed) | Set `DATABASE_URL` (locally `backend/.env`, on Northflank the service's environment variables) and restart |
| `503 FEATURE_DISABLED` on **routes** | No `GEOAPIFY_API_KEY` or `ROUTING_OSRM_URL` in the environment of the server that answered | Set one of them and restart |
| `503 GEO_DATA_NOT_READY` | The migrations or the OSM import have not run on this database | `npm run db:migrate`, then `npm run db:import-osm` |
| `503 GEO_DATABASE_UNAVAILABLE` / `GEO_QUERY_TIMEOUT` | PostgreSQL is not reachable (wrong host, firewall, TLS: try `DATABASE_SSL`), or a query ran longer than `DATABASE_STATEMENT_TIMEOUT_MS` | Check `DATABASE_URL`, the database and the pool (`DATABASE_POOL_MAX`) |
| Search returns nothing for Arabic or Kurdish names but works for English | The database was created with a "C" ctype: `pg_trgm` ignores non-ASCII letters (the first migration refuses such a database) | Re-create it `ENCODING 'UTF8'` with a UTF-8 `LC_CTYPE` ([GEO_DATABASE.md](GEO_DATABASE.md#setting-up-local)) |
| `502 PROVIDER_AUTH_FAILED` | The Geoapify key is invalid, disabled, or limited to another IP address | Check `GEOAPIFY_API_KEY` and its allowed IP addresses at <https://myprojects.geoapify.com>. Clients only see a generic message |
| `503 PROVIDER_QUOTA_EXCEEDED` with `Retry-After` | This server's daily budget (`GEOAPIFY_DAILY_REQUEST_LIMIT`) is used up | Admin overview shows it. Raise the limit (up to your plan) or set `ROUTING_OSRM_URL`; the budget resets at 00:00 UTC. A route search costs 3 credits. A burst from one client can use it up for everyone: lower the per-IP rate limits |
| `503 PROVIDER_BUSY` with `Retry-After` | Geoapify rate limit (5 requests per second on the free plan), a full local queue, or the circuit is open after repeated faults | Wait; check `circuit` in `/api/health` |
| `504 PROVIDER_TIMEOUT` / `502 PROVIDER_ERROR` | Geoapify slow or down | <https://apidocs.geoapify.com>; try the call with curl and your key |
| `422 POINT_NOT_ROUTABLE` / `NO_ROUTE` | A point is far from any road, or the roads are not connected | Normal for water, desert or other countries; choose a point on a road |
| One or two routes instead of three | Geoapify has no alternatives option: Hawr asks for three route types and drops a route that copies another. Between close points all three are often the same road | Nothing is invented to fill the list. Set `ROUTING_OSRM_URL` for real alternatives |
| Route summary has no street names | Geoapify's route answer carries no road names | Expected. The steps carry the instructions |
| `/places/nearby` misses places | Geoapify returns the places OpenStreetMap has in a category | Narrow the radius. The categories are in `models/navigationConstants.js` (`PLACE_CATEGORIES`) |
| A place I know is missing in search | OpenStreetMap does not have it (or under another name) | Add it as a *Place* in the admin console: it is found first by search |
| `400 INVALID_REQUEST` from routes for a normal query | Geoapify rejected a parameter (its API changed) | Compare with <https://apidocs.geoapify.com>; `npm run smoke` shows the failing call. Search does not use Geoapify: a search `400` is a bad query, see the `details` |

## Accounts, tokens and admin

| Answer | Likely cause | What to check |
|---|---|---|
| Login fails with `401 INVALID_CREDENTIALS` | Wrong email or password (the same answer for both on purpose) | Sign up first; passwords are 8-128 characters |
| `409 EMAIL_TAKEN` | The account exists | Log in instead |
| `401 USER_TOKEN_INVALID` / `DEVICE_TOKEN_INVALID` for everybody after a deploy | The signing secret changed or is unset (a per-process key) | Set stable `USER_TOKEN_SECRET` and `DEVICE_TOKEN_SECRET` |
| `401 ADMIN_TOKEN_INVALID` or the admin console refuses the token | Wrong token, or `NAV_ADMIN_TOKEN` was changed and the backend not restarted | `.env`, restart |
| Admin console says "Administration is turned off" | `NAV_ADMIN_TOKEN` unset or shorter than 16 characters | See above |
| `503 DATABASE_UNAVAILABLE` | The database connection was lost after start | `/api/health` -> `database.status`; the backend retries every 15 s |
| `429 RATE_LIMITED` for many users at once | Behind a proxy without `TRUST_PROXY`: all clients share the proxy's IP | `TRUST_PROXY=1` |

## Browser and apps

| Symptom | Cause | Fix |
|---|---|---|
| Browser console: CORS error on `/api/...` | The page's origin is not in `CORS_ORIGIN` (pages served by the backend itself are same-origin and never need it) | Add the exact origin: `CORS_ORIGIN=https://app.example.com`. Localhost origins are allowed in development only. |
| Mobile app cannot connect | Wrong base URL; a phone cannot use `localhost` | Use the computer's LAN address (`http://192.168.x.y:3000/api/v1`) on the same Wi-Fi; production needs HTTPS. Native apps are not affected by CORS; a webview app needs its origin in `CORS_ORIGIN`. |
| Mobile map shows nothing | The app has no map style URL, cannot reach `tiles.openfreemap.org`, or its MapLibre build has no WebGL/OpenGL | Load `styleUrl` from `GET /api/client-config` (no key needed) and check that the device can open it ([MOBILE_INTEGRATION_GUIDE.md](MOBILE_INTEGRATION_GUIDE.md)) |
| Dashboard shows no intersection on the map | Intersections without a surveyed position are not drawn | Set `INTERSECTION_LAT` / `INTERSECTION_LNG` for `main`, or add coordinates in `config/intersections.js` |
| Driver routes never show live traffic | No intersection with a surveyed position lies within 60 m of the route, or the AI service is not posting | `GET /api/v1/traffic`: `status` must be `live` and the intersection must have `lat`/`lng` |

## Tests

| Symptom | Fix |
|---|---|
| `npm test` skips the database tests | Set `MONGODB_TEST_URI=mongodb://127.0.0.1:27017`; the tests use a throwaway database and drop it |
| A test fails with "old map service URLs found" or "files that still mention the removed provider" | Something refers to a removed map service (old public OSRM / Nominatim / Overpass / tile servers, a removed provider or map library) again | The message names the file |
