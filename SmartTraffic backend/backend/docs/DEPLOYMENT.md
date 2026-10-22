# Deployment

How to run the backend in production and what to check. Steps that create
an account, a paid plan or a server are decisions for the project owner.

## Requirements

- Node.js ≥ 18 (developed and tested on 22.19).
- MongoDB ≥ 5.0 (time-series collections; tested on 7.0). MongoDB Atlas or
  self-hosted.
- HTTPS in front of the backend: the mobile app must use HTTPS in production.
- **One instance** (see [Scaling](#scaling)).

## Render (same platform as the AI service)

The AI service's guide (`python/docs/RENDER_DEPLOYMENT.md`) already
describes connecting it to this backend.

| Setting | Value |
|---|---|
| Service type | Web Service |
| Root directory | `SmartTraffic backend/backend` |
| Runtime | Node |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Instances | 1 |

Environment, at minimum:

| Variable | Value |
|---|---|
| `MONGODB_URI` | Atlas connection string (secret) |
| `TRUST_PROXY` | `1`: Render's proxy. Without it every client shares one IP for rate limiting. |
| `DEVICE_TOKEN_SECRET` | 64 hex characters (secret). Keep it stable: changing it signs every app out (they re-register automatically). |
| `NAV_ADMIN_TOKEN` | random (secret), only for operator tools |
| `TRAFFIC_INGEST_TOKEN` | same value as on the AI service (secret) |
| `STREAM_ADMIN_TOKEN` | random (secret) |
| `INTERSECTION_LAT`, `INTERSECTION_LNG` | surveyed position of the camera intersection (needed for live traffic on routes) |
| `PROVIDER_CONTACT_EMAIL` | an operations address (while public OSM services are used) |
| `ROUTING_URL`, `GEOCODING_URL`, `OVERPASS_URLS` | production providers (next section) |
| `CORS_ORIGIN` | the dashboard's origin (native apps do not use CORS) |

Render sets `PORT`. On the free plan the service sleeps when idle; the
first request after that takes tens of seconds, which the mobile app sees
as a timeout. Use an always-on plan for the app.

## External providers

The defaults are public OpenStreetMap services. They are free, but their
policies allow only light use: about **one request per second for this
whole backend** (not per user), no heavy or bulk use, no autocomplete, and no
SLA. The backend spaces, caches and benches requests, but a public app with
real traffic needs its own capacity. Options, roughly by effort:

| Purpose | Self-hosted (free software, you pay for the server) | Hosted (paid plans; check terms and pricing) |
|---|---|---|
| Routing (`ROUTING_URL`) | [OSRM](https://github.com/Project-OSRM/osrm-backend) with a regional extract (e.g. Iraq from Geofabrik) | Any OSRM-compatible hosted API |
| Geocoding (`GEOCODING_URL`) | [Nominatim](https://nominatim.org/release-docs/latest/admin/Installation/) | Nominatim-compatible APIs, e.g. LocationIQ (`GEOCODING_API_KEY` is sent as `key=`) |
| OSM features, nearby (`OVERPASS_URLS`) | [Overpass API](https://overpass-api.de/no_frills.html) or a private instance | Commercial Overpass instances |

A regional OSRM (one country) runs on a small server; Nominatim and
Overpass need more disk and RAM. For self-hosted providers set
`*_MIN_INTERVAL_MS=0` (the default for non-public hosts) and consider
`ROUTING_VIA_ATTEMPTS=6`.

Other providers (Google, Mapbox, HERE…) use different APIs and would need
a new client in `services/navigation/`. The controllers and the app
contract would not change.

## MongoDB

- Atlas: create a database user with read/write on one database, allow
  the backend's outbound IPs, and put the SRV string in `MONGODB_URI`.
- Indexes are created by the backend at every start (idempotent),
  including the 2dsphere and TTL indexes of the navigation collections.
- The TTL index deletes community reports `REPORT_RETENTION_DAYS` after they
  stop being active; traffic history is kept forever.
- Backups: enable them on Atlas, or `mongodump` on a schedule.

## Security checklist

- [ ] HTTPS only; HTTP redirected by the platform.
- [ ] All secrets set as platform secrets, not in git; `.env` is git-ignored.
- [ ] `DEVICE_TOKEN_SECRET` and `NAV_ADMIN_TOKEN` set (the startup log warns otherwise).
- [ ] `TRUST_PROXY` matches the real proxy hop count (too high lets clients fake their IP via `X-Forwarded-For`).
- [ ] `TRAFFIC_INGEST_TOKEN` set: otherwise anyone can post live traffic.
- [ ] Admin tokens only in operator tools; rotate them by changing the variable and restarting.
- [ ] `/api/docs` is public and lists endpoints, never secrets. Restrict it at the proxy if that is a concern.

## After a deploy

```bash
curl -s https://<host>/api/health        # navigation: providers, database, device tokens, admin
cd backend && node scripts/smokeNavigation.js https://<host>
# with writes (creates and withdraws a report, creates and deletes a feature):
SMOKE_ADMIN_TOKEN=<NAV_ADMIN_TOKEN> node scripts/smokeNavigation.js https://<host> --write
```

The startup log lists warnings for development settings still in use
(public providers, no contact email, no admin token, no device-token secret).

## Scaling

The backend is a single stateful process: decision engines, the latest
observations, provider caches, rate-limit counters and circuit breakers are
in memory, and the AI service posts to one URL. Running two instances would
split that state. Before scaling out: move the shared state to a store such
as Redis, and make one instance own signal control. Until then, scale up
(more CPU / RAM) instead of out.
