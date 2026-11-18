# Deployment

How to run the backend in production and what to check. Steps that create an account, a paid
plan or a server are decisions for the project owner. For a first run on a machine, see
[SETUP_GUIDE.md](SETUP_GUIDE.md).

## Requirements

- Node.js 18 or newer (tested on 22).
- MongoDB 5.0 or newer (time-series collections): MongoDB Atlas or self-hosted.
- HTTPS in front of the backend. The mobile app must use HTTPS in production, and the browser
  location feature of the navigation page needs it too.
- **One instance** (see [Scaling](#scaling)).

## Production start checks

With `NODE_ENV=production` the backend **refuses to start** (exit code 1, the reasons are
printed) unless:

- `TRAFFIC_INGEST_TOKEN` is set (otherwise anyone can post traffic data to the signal engine),
- `DEVICE_TOKEN_SECRET` and `USER_TOKEN_SECRET` are set, 32+ characters and different from each other,
- `MONGODB_URI` is set (and then the database must be reachable, in every environment).

Also in production the simulation write endpoints (`POST /api/simulation/*`) answer `403`; the
simulation can still be watched. `CORS_ORIGIN=*` prints a warning.

## Environment

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `MONGODB_URI` | Atlas connection string (secret) |
| `GEOAPIFY_API_KEY` | Geoapify key limited to the server's IP address (secret) |
| `GEOAPIFY_DAILY_REQUEST_LIMIT` | sized to the plan (default 2500; the free plan is 3,000 credits a day) |
| `ROUTING_OSRM_URL` | optional: your own OSRM server (no credits, real alternatives) |
| `DEVICE_TOKEN_SECRET`, `USER_TOKEN_SECRET` | two different random values, 32+ characters (secrets). Keep them stable: changing one signs the apps out. |
| `NAV_ADMIN_TOKEN` | random, 16+ characters (secret), for the admin console |
| `TRAFFIC_INGEST_TOKEN` | the same value as on the AI service (secret) |
| `STREAM_ADMIN_TOKEN` | random (secret), only if camera streams are managed through the API |
| `TRUST_PROXY` | `1` behind Render / Nginx, so rate limits see the client address |
| `CORS_ORIGIN` | the exact origin(s) of any separately hosted front end, comma separated. Not needed when the backend serves the pages itself, nor for native apps. |
| `INTERSECTION_LAT`, `INTERSECTION_LNG` | surveyed position of the camera intersection `main` |
| `PORT` | set by the host (Render does) |

Full list: [CONFIGURATION.md](CONFIGURATION.md). Never commit `.env`.

## Render (same platform as the AI service)

| Setting | Value |
|---|---|
| Service type | Web Service |
| Root directory | `SmartTraffic backend/backend` |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Instances | 1 |

**Set the variables in Render.** `backend/.env` is git-ignored and is never deployed: on Render the
variables come only from the service's **Environment** tab (Dashboard, your service, Environment, Add
Environment Variable). For search to work add at least `GEOAPIFY_API_KEY` (and `MONGODB_URI`, the token
secrets and `NODE_ENV=production` from the table above), then **Save** and let the service redeploy. A
server without `GEOAPIFY_API_KEY` answers `GET /api/v1/places/search` and `/places/reverse` with
`503 FEATURE_DISABLED`, and the apps show their "search is not available" message. Check it with:

```bash
curl https://<your-service>.onrender.com/api/v1/config        # features.placeSearch.available must be true
curl "https://<your-service>.onrender.com/api/v1/places/search?q=Sulaymaniyah&limit=2"
```

On the free plan the service sleeps when idle and the first request takes tens of seconds,
which the mobile app sees as a timeout: use an always-on plan for the app. Render's outgoing IP
addresses change on some plans, so a Geoapify key limited to one IP may need Render's
static outbound addresses.

## Map, search and routing in production

- **Map: OpenFreeMap.** No key and no request limit, but also no service-level guarantee: it is a free public
  service run by volunteers. If the map is part of something people depend on, consider hosting your own tiles
  (<https://github.com/hyperknot/openfreemap>) and set `OPENFREEMAP_STYLE_URL` to your style. Browsers load the tiles
  directly: they cost your server nothing.
- **Search and routing: Geoapify.** Use the free plan only to try: it is 3,000 credits a day and stops at the limit.
  Restrict the key to the server's IP address in <https://myprojects.geoapify.com>. `GEOAPIFY_DAILY_REQUEST_LIMIT` is
  this server's own budget; the admin overview shows how much of it is used today. A route search costs 3 credits.
- Run your own OSRM (`ROUTING_OSRM_URL`) when route traffic grows: routing then costs no credits.
- Route times are free-flow, without provider traffic. Do not rely on any of these services where a mistake could
  put someone in danger.
- Commercial use, caching and storage of provider results: read Geoapify's terms
  (<https://www.geoapify.com/terms-and-conditions/>) before launching. This backend caches in memory only.
- Keep the attribution on every map and every search or route result ("Powered by Geoapify", the OpenStreetMap
  attribution): the pages show it, and `attribution` / `searchAttribution` in `GET /api/client-config` carry it.

## Mobile app

It needs the HTTPS base URL of this backend (`https://.../api/v1`) and the map style URL from
`GET /api/client-config`. It needs no map key. Never ship `GEOAPIFY_API_KEY` or `NAV_ADMIN_TOKEN`: search and routing
go through this backend.

## Scaling

The decision engines, the latest observations, the caches, the rate-limit counters, the circuit
breaker and the daily request budget live in memory of one process. Several instances would each
have their own, and the AI service posts to one. Run one instance; scaling out needs shared state
(for example Redis) first.

## Backups and data

MongoDB holds accounts (salted scrypt password hashes), road features, reports and traffic history.
Back it up with your provider's tools. Reports are deleted `REPORT_RETENTION_DAYS` (30) days after
they stop being active. There is no other state to back up.

## Checklist

- [ ] `NODE_ENV=production`, the server starts without the list of problems.
- [ ] `GET /api/health`: `database.status` is `connected`, `navigation.geoapify.enabled` is `true`.
- [ ] `GET /api/client-config` shows `map.styleUrl`; the navigation page draws the map with street names and shows the attribution.
- [ ] The Geoapify key is restricted to the server IP.
- [ ] `/admin.html` accepts `NAV_ADMIN_TOKEN`; the overview shows no red status.
- [ ] HTTPS everywhere; `CORS_ORIGIN` lists only your origins.
- [ ] `npm run smoke` against the production URL passes.
