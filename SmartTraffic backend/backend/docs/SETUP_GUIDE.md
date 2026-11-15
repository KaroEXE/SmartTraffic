# Setup guide: run SmartTraffic from a clean machine

This repository contains the **backend** (Node.js + Express + Socket.IO + MongoDB),
the **web front end** (`frontend/`: operations dashboard, driver navigation page, admin
console) and the API documentation. The **mobile app** is a separate project that talks
to the same backend through `/api/v1` (see [MOBILE_INTEGRATION_GUIDE.md](MOBILE_INTEGRATION_GUIDE.md)).
The Python AI service (camera detection) is a third project that posts to `POST /api/traffic`.

```
 Web (navigation.html)   Mobile app   Admin console (admin.html)   Python AI service
          \                  |                  |                         |
           +------------- SmartTraffic backend (this repo) --------------+
                              |                         |
                           MongoDB             Geoapify (search, routing) / own OSRM
```

The apps never call Geoapify: the backend does, with a secret key, and returns normalised answers.
Only the map is loaded by the browser or the app, from **OpenFreeMap**, which needs no key.

## 1. Prerequisites

| Need | Version | Check |
|---|---|---|
| Node.js | 18 or newer (tested on 22) | `node -v` |
| npm | comes with Node | `npm -v` |
| MongoDB | 5.0 or newer (local, or MongoDB Atlas) | `mongod --version`, or an Atlas cluster |
| A Geoapify account | free plan is enough to start | <https://myprojects.geoapify.com> |

## 2. Install

```bash
cd "SmartTraffic backend/backend"
npm ci            # installs exactly what package-lock.json lists
cp .env.example .env     # Windows PowerShell: Copy-Item .env.example .env
```

## 3. Map, search and routing

### OpenFreeMap (the map): nothing to set up

The map is **OpenFreeMap** vector tiles drawn by **MapLibre GL JS** in the browser (and by MapLibre in the
mobile app). It needs no account, no key and has no request limit (<https://openfreemap.org/tos/>); commercial
use is allowed, there is no service-level guarantee. The style URL is
`https://tiles.openfreemap.org/styles/liberty` (<https://openfreemap.org/quick_start/>), served to the apps by
`GET /api/client-config`; change it with `OPENFREEMAP_STYLE_URL`. The attribution text is shown by MapLibre.

OpenFreeMap is a basemap only: it has **no search, no routing and no traffic**. Hawr never asks it for any.

**The maps are fixed to the Kurdistan Region** (south 34.4, west 42.3, north 37.4, east 46.4), zoom 7 to 19: the map
cannot be dragged outside it. The area and zoom range are in `config.navigation.map` (`config/index.js`) and reach the
pages and the app through `GET /api/client-config`.

**Labels.** Street, place and shop names are the OpenStreetMap names. In a Latin-script style (Liberty) the label
shows the Latin name and the local one (Arabic or Kurdish script) under it. A place has a name on the map only if
OpenStreetMap has one: big cities are well covered, villages and small streets less so. Hawr never invents a name.
Add what is missing in OpenStreetMap (<https://www.openstreetmap.org>) or enter it yourself as a *Place* in the admin
console (it is drawn as a Hawr marker and found by search).

*Measured on 15 November 2026* (headless Edge, a 1000 x 700 map, the real OpenFreeMap Liberty tiles; named labels
actually drawn in the view, roads and places and points of interest together; Baghdad was measured with the lock
removed, since the apps are fixed to the Kurdistan Region):

| Place | zoom 11 | zoom 14 | zoom 16 |
|---|---|---|---|
| Sulaymaniyah | 69 | 51 | 63 |
| Erbil | 62 | 40 | 58 |
| Duhok | 64 | 27 | 62 |
| Kirkuk | 55 | 39 | 32 |
| Baghdad (outside the lock) | 41 | 33 | 27 |
| Halabja | 79 | 18 | 31 |
| Soran | 53 | 34 | 26 |
| Koya | 73 | 16 | 32 |
| Penjwin | 74 | 8 | 5 |
| Dukan (a village) | 75 | 6 | 2 |

What this shows: city centres have dozens of street, district and shop names at street zoom, in Latin and in Arabic
or Kurdish script. Towns have fewer, and small villages and rural roads have a handful of names or none, because
OpenStreetMap has none there. That is a data limit, not a map bug: the counts follow the OpenStreetMap coverage.
Hawr does not fill the gaps with invented names.

### Geoapify (search, nearby places, routing)

Documentation: <https://apidocs.geoapify.com>.

1. Sign in at <https://myprojects.geoapify.com> and create a project.
2. Copy the project's **API key**. In the project settings restrict it to your server's IP address, so a copy of
   the key is useless elsewhere.
3. Put it in `backend/.env`:

   ```
   GEOAPIFY_API_KEY=your-key
   ```

   `GEOAPIFY_DAILY_REQUEST_LIMIT` (default 2500) is optional. `ROUTING_OSRM_URL` is optional (see below).

The key is sent only from the server, in the `x-api-key` header. It never reaches a browser, an app, a log or an
answer; `GET /api/client-config` carries no key.

What is used:

| Feature | Geoapify call | Used by |
|---|---|---|
| Place search (Iraq only) | `GET /v1/geocode/search?text=&filter=countrycode:iq&bias=proximity:lng,lat` | `GET /api/v1/places/search` |
| Address at a point | `GET /v1/geocode/reverse?lat=&lon=` | `GET /api/v1/places/reverse` |
| Nearby places | `GET /v2/places?categories=&filter=circle:lng,lat,r` | `GET /api/v1/places/nearby` |
| Routing | `GET /v1/routing?waypoints=lat,lng\|lat,lng&mode=drive&type=balanced\|short\|less_maneuvers` | `POST /api/v1/routes` |

Limits and terms (checked November 2026; read them again before going live):

- Free plan: 3,000 credits a day, 5 requests per second. This backend spaces its requests (220 ms), keeps a daily
  budget (`GEOAPIFY_DAILY_REQUEST_LIMIT`, default 2500, then `503 PROVIDER_QUOTA_EXCEEDED`) and stops calling for
  30 s after repeated provider faults.
- A search costs 1 credit. Geoapify has no "alternative routes" option, so Hawr asks for three route types
  (balanced, short, fewer turns): **a route search costs 3 credits**, repeated searches within
  `ROUTING_CACHE_TTL_SECONDS` cost none, and a route that copies another is dropped.
- **Attribution is required** on the free plan: "Powered by Geoapify" and the OpenStreetMap attribution wherever
  search results or routes are shown. The web pages show it in the map's corner; the API returns it in
  `searchAttribution` of `GET /api/client-config`.
- Route times are free-flow (no provider traffic). SmartTraffic adds its own live AI delay at monitored
  intersections and its drivers' reports. Geoapify gives no street names for a route, so the route summary is empty.
- This backend caches answers in memory only (routes 5 minutes, search and places 1 day) and stores none. Check
  Geoapify's terms (<https://www.geoapify.com/terms-and-conditions/>) before a commercial launch.

**Your own routing server (optional).** Set `ROUTING_OSRM_URL` to an OSRM server (for example `http://127.0.0.1:5000`,
built from Iraq data from <https://download.geofabrik.de>) and routes come from it: real alternatives, no credits. Geoapify
is then used for search only. Only a server you run yourself may be used; there is no default.

How to check the integration: start the backend, then

```bash
curl "http://localhost:3000/api/v1/places/search?q=hospital&lat=35.5617&lng=45.4329&limit=2"
curl -X POST http://localhost:3000/api/v1/routes -H "Content-Type: application/json" \
  -d '{"start":{"lat":35.5617,"lng":45.4329},"destination":{"lat":35.5702,"lng":45.4418}}'
```

Both must answer `"ok": true`. `GET /api/health` shows `navigation.geoapify` (`enabled`, `circuit`).

## 4. Database

1. Local MongoDB: install it and start the service; the connection string is
   `mongodb://127.0.0.1:27017/smarttraffic` (any database name; it is created on first use).
   Atlas: create a free cluster, a database user with read/write rights, allow your IP address
   (Network Access) and copy the `mongodb+srv://...` string.
2. Put it in `.env`: `MONGODB_URI=...`
3. Nothing else to create. At start the backend creates every collection and index
   (time-series traffic history, 2dsphere indexes for road features and reports, the unique
   email index of accounts, the report retention TTL index). There are no migrations and no seed
   data: a fresh database is empty and the apps show empty states.

Collections: `users`, `roadFeatures`, `roadReports`, `trafficRecords`, `signalEvents`,
`trafficStreams`.

**Start-up rule.** With `MONGODB_URI` set, the backend connects first and **refuses to start**
(exit code 1, with the reason) if it cannot after three attempts. With it blank it starts for
local development and says that accounts, reports and road features do not work.

## 5. Secrets

Put these in `.env` (generate each with
`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`):

```
DEVICE_TOKEN_SECRET=...     # 32+ characters
USER_TOKEN_SECRET=...       # 32+ characters, different from the one above
NAV_ADMIN_TOKEN=...         # 16+ characters (shorter: administration is disabled)
TRAFFIC_INGEST_TOKEN=...    # the same value goes into the Python AI service
```

The complete variable list, with defaults, is in [CONFIGURATION.md](CONFIGURATION.md).

## 6. Run

```bash
npm start                   # http://localhost:3000 (PORT in .env)
```

| What | Where |
|---|---|
| Operations dashboard | <http://localhost:3000/> |
| Driver navigation page | <http://localhost:3000/navigation.html> |
| Admin console | <http://localhost:3000/admin.html> (sign in with `NAV_ADMIN_TOKEN`) |
| Swagger (API docs, try it out) | <http://localhost:3000/api/docs/> (JSON: `/api/openapi.json`) |
| Health | <http://localhost:3000/api/health> |

The web front end is plain files served by the backend: there is nothing to build. The admin
console is part of it (`frontend/admin.html`). The mobile app is built in its own project.

## 7. Test

```bash
npm test                                            # all automated tests (no network, no database)
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test # also the database tests (use a scratch database)
npm run smoke                                       # live check of the running backend and Geoapify (a few credits)
```

`npm test` includes guards that fail if the front end, the backend, the docs or `.env.example` refer to a removed map
provider or to the old public map services again.

By hand:

| Check | How |
|---|---|
| Register | `curl -X POST localhost:3000/api/v1/auth/signup -H "Content-Type: application/json" -d '{"email":"me@example.com","password":"Correct-Horse-9"}'` returns 201 and a `token` |
| Log in | the same with `/auth/login` returns 200; a wrong password returns 401 |
| Protected route | `GET /api/v1/auth/me` with `Authorization: Bearer <token>` returns your account; without it, 401 |
| Map | open `navigation.html`: the OpenFreeMap map loads, with street names, and the attribution is in the corner |
| Search | type a place name in the destination box and press Enter |
| Routing | pick a destination and set "map centre" as the start: routes appear with time and distance |
| Reports | `POST /api/v1/auth/device` for a device token, then `POST /api/v1/reports` (see Swagger) |
| Admin | sign in at `/admin.html`; add a road feature; it appears at `GET /api/v1/road-features?south=..&west=..&north=..&east=..` |
| Database | the admin overview shows "Database: Connected"; users and reports counts match |

## 8. Graphify

`graphify-out/` (at the repository root) is the generated knowledge graph of this project
(`graph.json`, `GRAPH_REPORT.md`, `graph.html`). It is built by the Graphify tool from the
source files and must be regenerated after architecture changes: run `/graphify` in Claude Code
from `SmartTraffic backend/`, or `graphify update .` if the CLI is installed. Check it:
`graph.json` must list `providerClient`, `placeService`, `localPlaceService` and `adminController` and must not list
`overpassService`, `osmProxyService` or `hazardReportService`. Generated files are never edited by hand.

## 9. Production

See [DEPLOYMENT.md](DEPLOYMENT.md): HTTPS, `NODE_ENV=production` start checks, CORS, one instance,
what to set on the Geoapify key.

## 10. When something does not work

[TROUBLESHOOTING.md](TROUBLESHOOTING.md).
