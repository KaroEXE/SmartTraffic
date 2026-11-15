# SmartTraffic navigation backend: mobile integration guide

This guide is for the developer of the public navigation mobile app. It
describes the contract the app consumes: base URL, authentication, every
endpoint the app needs, request and response formats, errors, limits and
the configuration the app must handle.

The backend calculates routes, searches places and serves live traffic,
road features and community reports. **The app owns everything on the
device**: map rendering and tiles, GPS and permissions, route drawing,
turn-by-turn presentation, offline behaviour, and the HTTP client.

- Interactive reference (try requests): `https://<backend-host>/api/docs/`
- Machine-readable contract (OpenAPI 3.0.3): `https://<backend-host>/api/openapi.json`.
  Operations tagged **Mobile: …** are the ones described here. Clients can
  be generated from this file if you want.

Examples below are real responses from the development backend (trimmed
where marked).

---

## 1. Base URL and versioning

| Environment | Base URL |
|---|---|
| Local development | `http://<computer-LAN-IP>:<PORT>/api/v1`; PORT is in `backend/.env` (e.g. 5500) |
| Staging / production | `https://<backend-host>/api/v1`; ask the backend developer for the host |

- Make the base URL a build configuration value, never hard-coded in code.
- Production uses HTTPS only. Android needs `usesCleartextTraffic` (or a
  network security config) and iOS needs an ATS exception **only** for a
  local `http://` development backend.
- `/api/v1` is a stable contract. Within v1 the backend only **adds**
  things: new endpoints, new optional request fields, new response fields,
  new enum values listed as possible below. **Ignore unknown fields** and
  handle unknown enum values with a sensible default. Breaking changes would
  go to `/api/v2`, with `/api/v1` kept running during the migration.
- `GET /api/health` (outside `/api/v1`) is the server liveness check. The
  app normally does not need it.

## 2. Conventions

| Topic | Rule |
|---|---|
| Format | JSON, UTF-8. Send `Content-Type: application/json` on every request with a body. |
| Success | HTTP 2xx and `{ "ok": true, ... }` |
| Error | HTTP 4xx/5xx and `{ "ok": false, "code": "…", "error": "…", "details": [ … ]? }`; see §8 |
| Points you send | Objects `{ "lat": 35.5617, "lng": 45.4329 }` or query parameters `lat=`/`lng=` |
| **Geometry you receive** | **GeoJSON**: `[lng, lat]`, longitude first (route lines, maneuver locations). Many map SDKs take GeoJSON directly; if yours wants `LatLng(lat, lng)`, swap the two values. |
| Map areas | Query `south`, `west`, `north`, `east` (degrees). At most 0.5 degrees per side; boxes across the ±180° meridian are not supported. |
| Units | Distances in metres, durations in seconds, speeds in km/h, bearings in degrees (0 = north, clockwise) |
| Time | ISO-8601 UTC strings, e.g. `2026-10-22T21:40:52.203Z`. Compare ages against `serverTime` where provided; the phone's clock may be wrong. |
| IDs | Opaque strings. Never parse them. |
| Caching | API answers are `Cache-Control: no-store` / `no-cache`; the backend caches provider results itself. |
| Language | `GET /places/*` accept `lang=` (e.g. `en`, `ar`, `ckb`) or use the `Accept-Language` header. Route instructions are English only (see §5.4). |

### Attribution (required)

Two services, two attributions (both also in `GET /api/v1/config` → `attribution[]`, each with `requiredFor`):

| Where | Text | Why |
|---|---|---|
| On the **map** | `OpenFreeMap © OpenMapTiles Data from OpenStreetMap` (link `https://openfreemap.org`) | OpenFreeMap's terms. MapLibre shows it by itself from the style. |
| Wherever **search results, places or routes** are shown | `© OpenStreetMap contributors. Powered by Geoapify` (link `https://www.geoapify.com/`) | Geoapify's free-plan terms and the OpenStreetMap licence (ODbL) |

Responses that need the second one carry it:

```json
"attribution": { "text": "© OpenStreetMap contributors. Powered by Geoapify", "url": "https://www.openstreetmap.org/copyright", "provider": "Geoapify", "providerUrl": "https://www.geoapify.com/" }
```

Show it, for example, in the corner of the map, in search results and in the about screen.

### What changed with the move to OpenFreeMap and Geoapify

An earlier version of this backend used another map provider (map tiles with a public key, search and routing
from the same provider). If your app was written against it, check these (the `/api/v1` contract is otherwise unchanged):

| Area | Before | Now |
|---|---|---|
| Map | raster tiles with a public key (`map.tiles`) | **OpenFreeMap vector style, no key**: `GET /api/client-config` → `map.styleUrl`, drawn with **MapLibre** (§9). `map.tiles` is gone. |
| Map area | not part of the API | `map.bounds` (the Kurdistan Region), `map.minZoom`, `map.maxZoom` in `/api/client-config` and `/api/v1/config` (`features.map`) |
| `attribution` | one text for everything | the map and the search/routing have separate texts (see Attribution above); `/api/client-config` also has `searchAttribution` |
| Place `id` | `<old provider>:poi:<uuid>` | `geoapify:<id>`, or `hawr:<id>` for a place the operator entered (still opaque: never parse it) |
| Place `category` / `type` | the old provider's category name and type | `category`: Geoapify category (for example `healthcare.clinic_or_praxis`), `null` possible; `type`: Geoapify result type (`amenity`, `street`, `city`, ...); new `source`: `geoapify` or `hawr` |
| `addressDetails` | `suburb` and `state` only | `road`, `houseNumber`, `suburb`, `city`, `state`, `postcode`, `country`, `countryCode` when the provider has them (each may be `null`) |
| Place names | one language | `name` is in the asked `lang` (`ar`, `ku`, `en`) when OpenStreetMap has that name, else the local name |
| `/places/nearby` | `rating`, `reviewCount`, `openingHours` from the provider | still present for compatibility but **always `null` / `0`**: Geoapify gives none; `address`, `details.*`, `url` stay `null` |
| `/road-features` | operator features | unchanged: operator features only; `sources` is `{ "operator": "ok" }`; `config.features.roadFeatures.osm` stays as `{ "available": false, "kinds": [] }` |
| Route alternatives | one request, as many as the provider found | Geoapify has no alternatives option: **up to three** different routes from its route types (balanced, short, fewer turns); a copy of another route is dropped, so 1-3 come back. With the operator's own OSRM server, real alternatives. |
| Route `summary` | street names | empty: Geoapify gives no street names. Use `steps`. |
| Route times | provider free-flow | provider free-flow (no traffic); live AI delay is still added by SmartTraffic |
| New endpoints | | `GET /places/local` (the operator's own places as a map layer), `/saved-places` (a user's favourites, needs a user token) |
| Rate limits | search 30, routes 20, nearby 20 per minute per IP | search 15, routes 10, nearby 10 per minute per IP (see `config.limits.rateLimits`) |
| New error codes | | `PROVIDER_QUOTA_EXCEEDED` (503: the server's daily credit budget is used up; has `Retry-After`), `PROVIDER_AUTH_FAILED` (502: server-side search key problem, nothing to fix in the app) |
| Intersections | five with invented coordinates | only intersections with a surveyed position have `lat`/`lng`; the others have `null` and `positionSource: "unknown"` |
| Admin | `/api/hazards`, `ADMIN_TOKEN` | removed; use the admin console (`/admin.html`, `NAV_ADMIN_TOKEN`) |

## 3. App start-up sequence

1. `GET /config`: read which features are available and the limits (§5.1).
   Hide or disable UI for any feature with `available: false`.
2. Device token: if none is stored, `POST /auth/device` (§4). Store the
   token in the Keychain (iOS) or the Keystore / EncryptedSharedPreferences
   (Android).
3. Map visible: load `GET /traffic`, `GET /road-features` and
   `GET /reports` for the visible area (§5.5-5.7).

## 4. Authentication

There are no user accounts. Reading is public. Writing (reports and votes)
needs an **anonymous device token**:

```
POST /api/v1/auth/device
Content-Type: application/json

{ "platform": "android", "appVersion": "1.0.0" }      (body optional; platform: android | ios | other)
```

`201 Created`:

```json
{
  "ok": true,
  "renewed": false,
  "tokenType": "Bearer",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ...",
  "deviceId": "629c35d2-fac8-4805-a98f-395919bdcfef",
  "issuedAt": "2026-10-22T21:40:52.000Z",
  "expiresAt": "2026-11-21T21:40:52.000Z"
}
```

Send it on write requests (sending it on `GET /reports` is optional and adds
`mine`/`myVote`):

```
Authorization: Bearer <token>
```

**Token lifecycle**

- Lifetime: 30 days by default (`expiresAt`).
- **Renewal**: call `POST /auth/device` *with* the current token in the
  `Authorization` header, e.g. at app start when `expiresAt` is less than 7
  days away. You get `200` with a fresh `token` for the same `deviceId`. If
  the current token is still valid for longer, the answer is
  `200 { "renewed": false }` **without** a `token`: keep the one you have.
- **On `401`** with `code` `DEVICE_TOKEN_EXPIRED` or `DEVICE_TOKEN_INVALID`:
  delete the stored token, call `POST /auth/device` *without* a token, and
  retry the request once. Tokens also become invalid when the server's
  signing secret changes, so always handle this case.
- A new token after expiry is a new device: the app can no longer withdraw
  reports made under the old one. Renew before expiry to avoid that.
- The token identifies an app install, not a person. It contains no
  personal data. Registration is rate-limited per IP (10 per hour by
  default), so register once per install, not per request.

**Never put the admin token (`NAV_ADMIN_TOKEN`) in the app.** Admin
endpoints (managing road features, moderating reports) are for operator
tools only.

## 5. Endpoints

All paths are relative to the base URL (`…/api/v1`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/config` | none | Features, limits, attribution |
| POST | `/auth/device` | none (or device to renew) | Device token |
| GET | `/places/search` | none | Search places and addresses |
| GET | `/places/reverse` | none | Address at a point |
| GET | `/places/nearby` | none | Fuel, parking, hospitals… around a point |
| POST | `/routes` | none | Routes ranked with live traffic, plus alerts |
| GET | `/traffic` | none | Live AI traffic at monitored intersections |
| GET | `/road-features` | none | Speed cameras, speed bumps, closures, roadworks |
| GET | `/road-features/{id}` | none | One operator feature |
| GET | `/reports` | none (device optional) | Active community reports in an area |
| GET | `/reports/{id}` | none (device optional) | One report |
| POST | `/reports` | **device** | Report a road condition |
| POST | `/reports/{id}/votes` | **device** | Confirm / dismiss someone else's report |
| DELETE | `/reports/{id}` | **device** | Withdraw your own report |

### 5.1 `GET /config`

Call at start-up (and when returning to the foreground after a long time).

```json
{
  "ok": true,
  "apiVersion": "1",
  "serverTime": "2026-10-22T21:19:59.143Z",
  "features": {
    "map": { "provider": "openfreemap", "styleUrl": "https://tiles.openfreemap.org/styles/liberty",
             "bounds": { "south": 34.4, "west": 42.3, "north": 37.4, "east": 46.4 }, "minZoom": 7, "maxZoom": 19 },
    "placeSearch": { "available": true, "provider": "geoapify" },
    "placesNearby": { "available": true, "categories": ["fuel", "charging_station", "parking", "hospital", "pharmacy", "police", "restaurant", "cafe", "atm", "car_repair", "hotel"] },
    "routing": { "available": true, "provider": "geoapify", "profile": "driving", "maxRoutes": 4 },
    "liveTraffic": {
      "available": true, "monitoredIntersections": 5, "staleAfterSeconds": 15, "recommendedRefreshSeconds": 15,
      "area": null
    },
    "roadFeatures": { "kinds": ["speed_camera", "speed_bump", "road_closure", "roadworks"], "osm": { "available": false, "kinds": [] }, "operator": { "available": true } },
    "reports": { "available": true, "types": ["accident", "traffic_jam", "road_closure", "construction", "hazard"], "requiresDeviceToken": true,
                 "ttlMinutes": { "accident": 60, "traffic_jam": 30, "road_closure": 240, "construction": 1440, "hazard": 120 } }
  },
  "limits": {
    "searchMinLength": 3, "searchMaxLength": 200, "searchMaxResults": 10, "nearbyMaxRadiusMeters": 5000,
    "maxBBoxSpanDeg": 0.5, "reportDescriptionMaxLength": 280,
    "rateLimits": { "perMinute": 120, "searchPerMinute": 15, "routesPerMinute": 10, "placesPerMinute": 10,
                    "deviceRegistrationsPerHour": 10, "reportsPerHour": 10, "votesPerHour": 60 }
  },
  "attribution": [
    { "text": "OpenFreeMap © OpenMapTiles Data from OpenStreetMap", "url": "https://openfreemap.org", "provider": "OpenFreeMap", "requiredFor": ["map"] },
    { "text": "© OpenStreetMap contributors. Powered by Geoapify", "url": "https://www.openstreetmap.org/copyright", "provider": "Geoapify", "providerUrl": "https://www.geoapify.com/", "requiredFor": ["placeSearch", "placesNearby", "routing"] }
  ]
}
```

- `liveTraffic.area` is the box around the intersections that have a surveyed position, or `null` while none has one.
- `reports.available` and `roadFeatures.operator.available` are `false`
  while the backend's database is down. Hide the "report" button then.
- `liveTraffic.area` is where SmartTraffic cameras are. Live traffic
  exists only there. Routing and search work everywhere.
- Use the `limits` for client-side validation (e.g. disable "search" under
  `searchMinLength` characters).

### 5.2 `GET /places/search`

| Query | Required | Notes |
|---|---|---|
| `q` | yes | 3-200 characters |
| `lat`, `lng` | no (both or neither) | Bias to this point (user position or map centre). Results near it come first. |
| `limit` | no | 1-10, default 5 |
| `lang` | no | Result language; default `Accept-Language` |

```
GET /api/v1/places/search?q=hospital&lat=35.5617&lng=45.4329&limit=1
```

```json
{
  "ok": true,
  "query": "hospital",
  "scope": "local",
  "count": 1,
  "places": [{
    "id": "geoapify:514ae93ea5efb846405943e7902ffcc74140f00103f901db4bee4102000000c00201920315d985d8b3d8aad8b4d981d98920d8b3d981d98ad986",
    "name": "مستشفى سفين",
    "address": "مستشفى سفين, کانی ئاسکان, Qanat Street, Sulaymaniyah, 46001, Iraq",
    "lat": 35.5623836,
    "lng": 45.4448134,
    "category": "healthcare.clinic_or_praxis",
    "type": "amenity",
    "source": "geoapify",
    "addressDetails": { "road": "Qanat Street", "houseNumber": null, "suburb": "کانی ئاسکان", "city": "Sulaymaniyah",
                        "state": "Sulaymaniyah Governorate", "postcode": "46001", "country": "Iraq", "countryCode": "iq" }
  }],
  "cached": false,
  "attribution": { "text": "© OpenStreetMap contributors. Powered by Geoapify", "url": "https://www.openstreetmap.org/copyright", "provider": "Geoapify", "providerUrl": "https://www.geoapify.com/" }
}
```

(A real answer, shortened. `name` is in the asked `lang` when OpenStreetMap has that name, else the local name.)

- `scope`: `local` = ranked near `lat`/`lng`; `global` = no point was sent.
- Places the operator entered (`source: "hawr"`, id `hawr:<id>`) come **first**, then Geoapify results (Iraq only).
- **Search on submit, not on every keystroke.** No autocomplete: every
  search uses a provider credit (3,000 a day on the free plan), the
  server caps its own daily budget and each IP may send 15 searches a
  minute. Debouncing is not enough.
- Every field of `addressDetails` may be `null`; `address` may be `null`.

### 5.3 `GET /places/reverse` and `GET /places/nearby`

```
GET /api/v1/places/reverse?lat=35.5617&lng=45.4329
→ { "ok": true, "place": Place | null, "cached": false, "attribution": {…} }
```

`place` is `null` where no address exists (open land, sea). Use it for "drop
a pin" and for labelling the start point; do not call it continuously while
driving.

```
GET /api/v1/places/nearby?lat=35.5617&lng=45.4329&category=fuel&radius=3000&limit=5
```

```json
{
  "ok": true, "category": "fuel", "center": { "lat": 35.5617, "lng": 45.4329 }, "radius": 3000, "count": 1,
  "places": [{
    "id": "geoapify:51afeb17ec86b7464059252aaff089c54140f00103f901ed06c4a001000000", "name": "New Sulemani Gas Station", "category": "fuel", "providerCategory": "service.vehicle.fuel",
    "lat": 35.5432721, "lng": 45.433805, "distanceMeters": 2046, "rating": null, "reviewCount": 0, "openingHours": null,
    "address": "New Sulemani Gas Station, ئیبراهیم ئەحمەد, Baban Street, Sulaymaniyah, 46001, Iraq",
    "details": { "brand": null, "operator": null, "openingHours": null, "phone": null, "website": null }, "url": null
  }],
  "cached": false, "attribution": {…}
}
```

(A real answer, shortened. Nearest first, straight-line distance; `name` may be `null`.)
`category`: one of `config.features.placesNearby.categories`. `radius`:
100-5000 m (default 2000). `limit`: 1-50 (default 20). `rating` is always `null`, `reviewCount` `0` and
`openingHours` `null`: the search provider has no ratings or opening hours (the keys stay so existing apps do not
break). `address` is the formatted address; `details` and `url` are always `null`.

### 5.3a Hawr places and saved places

**Hawr places** are important places the operator enters in the admin console (hospitals, mosques, landmarks,
...). They are a map layer from Hawr's own database and are also returned first by `/places/search`.

```
GET /api/v1/places/local?south=35.5&west=45.3&north=35.65&east=45.55&categories=hospital,police
→ { "ok": true, "bbox": {…}, "count": 1, "truncated": false,
    "places": [{ "id": "6540…", "name": "City Hospital", "nameAr": "مستشفى المدينة", "nameKu": null, "category": "hospital",
                 "lat": 35.5617, "lng": 45.4329, "description": null, "active": true, "updatedAt": "2026-11-12T10:00:00.000Z" }] }
```

An area wider than `limits.maxBBoxSpanDeg` is a `400`. An empty list is a real answer: draw nothing. (Creating, changing and
deleting places is the admin console's job: `POST/PATCH/DELETE /places/local` need the admin token.)

**Saved places** (home, work, favourites) belong to a signed-in user. They need a **user token**
(`/auth/signup`, `/auth/login`), not a device token; the owner is always the token's user.

| Call | Notes |
|---|---|
| `GET /saved-places` | the user's places, newest first: `{ "count", "savedPlaces": [{ "id", "label", "kind", "address", "lat", "lng", "createdAt", "updatedAt" }] }` |
| `POST /saved-places` | body `{ "label", "lat", "lng", "kind"?, "address"? }`; `kind`: `favorite` (default), `home`, `work`, `other`. At most 100 per user: `409 SAVED_PLACE_LIMIT` |
| `PATCH /saved-places/{id}` | change any of those fields |
| `DELETE /saved-places/{id}` | another user's place answers `404` |

Saved places are deleted with the account (`DELETE /auth/me`).

### 5.4 `POST /routes`

```
POST /api/v1/routes
Content-Type: application/json

{
  "start": { "lat": 35.5617, "lng": 45.4329 },
  "destination": { "lat": 35.5702, "lng": 45.4418 },
  "maxRoutes": 3,
  "steps": true
}
```

| Field | Required | Notes |
|---|---|---|
| `start`, `destination` | yes | `{ lat, lng }` |
| `maxRoutes` | no | 1-4, default 3. You may get fewer when the road network has fewer distinct routes. |
| `steps` | no | `true` = turn-by-turn steps on each route. Default `false`. |

Response (one route shown, coordinates and steps trimmed):

```json
{
  "ok": true,
  "generatedAt": "2026-10-22T21:40:51.786Z",
  "cached": false,
  "trafficStatus": "not-on-route",
  "roadAlertsStatus": "ok",
  "snapWarnings": [],
  "routes": [{
    "id": "rt_1f409e082f5f",
    "rank": 1,
    "geometry": { "type": "LineString", "coordinates": [[45.432944, 35.561758], [45.432083, 35.562195], "…", [45.441718, 35.570113]] },
    "distance": 2777.8,
    "duration": 249,
    "summary": "25 Pasha Kura, Madam Mitterrand",
    "traffic": { "basis": "none", "adjustedDuration": 249, "delay": 0, "updatedAt": null, "intersections": [], "alerts": [] },
    "roadAlerts": [],
    "steps": [
      { "distance": 91.9, "duration": 16, "name": null, "ref": null, "mode": "driving", "instruction": "Head northwest",
        "maneuver": { "type": "depart", "modifier": "left", "location": [45.432944, 35.561758], "bearingBefore": 0, "bearingAfter": 302, "exit": null } },
      { "distance": 182.3, "duration": 28, "name": null, "ref": null, "mode": "driving", "instruction": "Turn left",
        "maneuver": { "type": "turn", "modifier": "left", "location": [45.432083, 35.562195], "bearingBefore": 300, "bearingAfter": 229, "exit": null } }
    ]
  }],
  "attribution": { "text": "© OpenStreetMap contributors", "url": "https://www.openstreetmap.org/copyright" }
}
```

**Routes and ranking**

- `routes` is ordered best first (`rank` 1, 2, …), by
  `traffic.adjustedDuration` (provider time + live delay), distance breaking
  ties. Show the ETA from `traffic.adjustedDuration`.
- `duration` is the routing provider's estimate without live traffic.
- `id` is derived from the road path: the same path keeps the same `id`
  when you request again. Use it to keep the user's selected route selected
  when the ranking changes.
- `geometry` is GeoJSON, `[lng, lat]`, at full resolution. Draw it as is.
- `snapWarnings`: e.g. "Destination is 450 m from the nearest road; the
  route starts from that road." Show them.

**Live traffic on a route** (`traffic`)

- `basis: "live-ai"`: live camera observations at SmartTraffic
  intersections on this route are included in `delay`. `basis: "none"`: no
  live data on this route; `adjustedDuration == duration`. Label ETAs that
  include live data (e.g. "live traffic included").
- `traffic.intersections[]`: monitored intersections on the route, in
  order: `{ id, name, status, alongMeters, approach, delaySeconds, included, reason }`.
  `reason` when not included: `stale`, `no-data`, `video-unavailable`.
- `traffic.alerts[]`: `long_queue` and `emergency_vehicle` at intersections
  on the route, with `alongMeters` and an English `message`.
- `trafficStatus` (whole response): `included` (some route has live data),
  `unavailable` (a route passes a monitored intersection that has no live
  data right now), `not-on-route`.

**Road alerts** (`roadAlerts[]`)

Community reports and operator closures / roadworks within 40 m of the
route line, in route order:

```json
{ "type": "report", "id": "6ada82e40c4dc171ecc5383f", "kind": "accident", "lat": 35.564, "lng": 45.4351,
  "verification": "unverified", "confirmations": 2, "expiresAt": "2026-10-22T22:40:52.196Z",
  "alongMeters": 1240, "distanceFromRouteMeters": 6, "message": "Accident reported by drivers" }
{ "type": "road_feature", "id": "671f3a2b9c4e5d6f7a8b9c0d", "kind": "road_closure", "lat": 35.5655, "lng": 45.4232,
  "verification": "verified", "validUntil": "2026-12-01T00:00:00.000Z",
  "alongMeters": 2100, "distanceFromRouteMeters": 3, "message": "Road closed: Hospital Road" }
```

The routing provider does **not** avoid reported closures; a route may pass
through one. Show the alert and let the user pick another route.
`roadAlertsStatus: "unavailable"` means the database is down and
`roadAlerts` is empty, not that the road is clear.

**Steps** (`steps: true`)

- `maneuver` is the authoritative data: `type` (`depart`, `turn`,
  `new name`, `continue`, `merge`, `on ramp`, `off ramp`, `fork`,
  `end of road`, `roundabout`, `rotary`, `exit roundabout`, `notification`,
  `arrive`), `modifier` (`uturn`, `sharp right`, `right`, `slight right`,
  `straight`, `slight left`, `left`, `sharp left`), `location` (`[lng, lat]`),
  bearings, `exit` (roundabouts). These are the
  OSRM-style maneuver values (Hawr maps the provider's turn types to this vocabulary).
- `instruction` is short **English** text for convenience. For other
  languages, build your own text from `maneuver` + `name`.
- `distance` / `duration` of a step = from this maneuver to the next. The
  distance from the start to a maneuver is the sum of the previous steps.
- Detecting arrival at a maneuver, off-route detection and voice prompts
  are app-side.

**Refreshing and rerouting**

- While the user compares routes or drives, re-send the **same** request
  every 30-60 s to refresh ETAs and ranking. Provider results are cached on
  the server for 5 minutes (`cached: true`); live traffic and alerts are
  recomputed every time.
- **Rerouting** (off route, or user asks): send a new request with the
  current position as `start`. Do not reroute more than once every ~10 s:
  route requests are limited to 20 per minute per IP, and the provider
  allows about one request per second for the whole server.
- A route request can take a few seconds against the development
  provider. Show progress, allow cancelling, and use a client timeout of at
  least 20 s.

Errors specific to routes: `422 NO_ROUTE` (no drivable route),
`422 POINT_NOT_ROUTABLE` (a point is too far from any road; ask for another
point).

### 5.5 `GET /traffic`

Live camera-based traffic at SmartTraffic-monitored intersections. Real
observations only, never simulated data.

```
GET /api/v1/traffic                                   (all monitored intersections)
GET /api/v1/traffic?south=35.55&west=45.42&north=35.58&east=45.45
```

```json
{
  "ok": true,
  "serverTime": "2026-10-22T21:19:59.318Z",
  "staleAfterSeconds": 15,
  "count": 1,
  "intersections": [{
    "id": "main", "name": "Main Street", "lat": 35.5617, "lng": 45.4329,
    "positionSource": "surveyed",
    "status": "live",
    "lastUpdate": "2026-10-22T21:19:57.100Z", "ageSeconds": 2.2,
    "level": "moderate",
    "longestQueue": { "direction": "north", "vehicles": 15 },
    "approaches": {
      "north": { "available": true, "vehicles": 20, "queueLength": 15, "waitingTime": 40, "estimatedDelaySeconds": 80, "level": "moderate" },
      "south": { "available": true, "vehicles": 2, "queueLength": 1, "waitingTime": 5, "estimatedDelaySeconds": 9, "level": "light" },
      "east":  { "available": true, "vehicles": 4, "queueLength": 2, "waitingTime": 8, "estimatedDelaySeconds": 16, "level": "light" },
      "west":  { "available": false, "vehicles": null, "queueLength": null, "waitingTime": null, "estimatedDelaySeconds": null, "level": null }
    },
    "emergency": null
  }]
}
```

(Illustrative values. Without a live feed an intersection has `"status": "no-data"`,
`"approaches": null`.)

- `status`: `live` (fresh), `stale` (last data older than
  `staleAfterSeconds`, or the camera feed dropped), `no-data` (nothing
  received). Use colours only for `live`. `level` is `null` unless live.
- Approaches are named by where vehicles **come from** (`north` = traffic
  arriving from the north).
- `available: false` = that camera has no video. Counts are `null`, never 0:
  show "no data", not "no traffic".
- `level`: `light` / `moderate` / `heavy` from `estimatedDelaySeconds`
  (= `waitingTime` + 2 s × `vehicles`; thresholds 30 s and 90 s by default).
- `positionSource: "unknown"` = nobody has surveyed this intersection:
  `lat` and `lng` are `null`. Do not draw it; it is never matched to routes.
- `emergency`: `{ type, direction, since }` while an emergency vehicle is
  detected (signals give it priority). `type` may be `ambulance`, `police`,
  `fire_truck` or `emergency` (service unknown).
- Poll about every 15 s (`config.features.liveTraffic.recommendedRefreshSeconds`)
  while the map is visible; stop in the background.

### 5.6 `GET /road-features`

```
GET /api/v1/road-features?south=35.54&west=45.41&north=35.58&east=45.45[&kinds=speed_camera,road_closure]
```

```json
{
  "ok": true,
  "bbox": { "south": 35.54, "west": 45.41, "north": 35.58, "east": 45.45 },
  "count": 2,
  "truncated": false,
  "sources": { "operator": "ok" },
  "features": [
    { "id": "671f3a2b9c4e5d6f7a8b9c0d", "kind": "speed_camera", "lat": 35.5617, "lng": 45.4329, "name": null, "description": null,
      "direction": 90, "speedLimitKmh": 60, "source": "City traffic department", "provider": "smarttraffic", "verification": "verified",
      "active": true, "validFrom": null, "validUntil": null, "url": null, "updatedAt": "2026-10-22T20:00:00.000Z" }
  ]
}
```

An empty `features` list is a real answer: nothing has been entered for that area.

(Illustrative values.)

- `kind`: `speed_camera`, `speed_bump`, `road_closure`, `roadworks`.
- `verification`: always `verified` (entered by the operator in the admin console).
- `sources` is always `{ "operator": "ok" }`: kept for apps written for the
  earlier multi-source answer. `503 DATABASE_UNAVAILABLE` while the backend's
  database is down.
- Features rarely change: cache per area for 10+ minutes on the device and
  re-query only when the map moves outside the cached area. Request a
  slightly larger area than the screen.
- Speed-camera warnings are not legal in every country. Whether and how the
  app shows them is a product decision for the app.

### 5.7 Community reports

Report types: `accident`, `traffic_jam`, `road_closure`, `construction`,
`hazard`.

**List** (refresh about every 60 s while the map is visible):

```
GET /api/v1/reports?south=35.55&west=45.42&north=35.58&east=45.45[&types=accident,road_closure][&limit=200]
Authorization: Bearer <device token>        (optional: adds mine/myVote)
→ { "ok": true, "bbox": {…}, "count": 1, "truncated": false, "reports": [Report] }
```

**Report**:

```json
{
  "id": "6ada82e40c4dc171ecc5383f",
  "type": "accident",
  "label": "Accident",
  "lat": 35.564, "lng": 45.4351,
  "heading": 45,
  "description": "Two cars, right lane blocked",
  "status": "active",
  "verification": "unverified",
  "confirmations": 0, "dismissals": 0,
  "createdAt": "2026-10-22T21:40:52.203Z", "updatedAt": "2026-10-22T21:40:52.203Z",
  "expiresAt": "2026-10-22T22:40:52.196Z",
  "mine": true, "myVote": null
}
```

- `status`: `active`, `expired`, `withdrawn`, `removed` (moderator),
  `resolved` (moderator), `dismissed` (too many "not there" votes). Lists
  return only `active` ones; `GET /reports/{id}` returns any status.
- `verification`: `unverified` (user report) or `verified` (moderator).
- `label` is English display text; localize from `type` instead if needed.
- `mine` / `myVote` (`confirm` / `dismiss` / `null`) are present only when
  the request carried a device token.

**Create** (device token required):

```
POST /api/v1/reports
Authorization: Bearer <device token>
Content-Type: application/json

{ "type": "accident", "lat": 35.5640, "lng": 45.4351, "heading": 45, "description": "Two cars, right lane blocked" }
```

| Field | Required | Notes |
|---|---|---|
| `type` | yes | one of the types above |
| `lat`, `lng` | yes | Where the problem is (normally the user position) |
| `heading` | no | Direction of travel, 0-359.9 degrees (separates the two sides of a road). Send the GPS course. |
| `description` | no | ≤ 280 characters, plain text |

- `201 { "merged": false, "report": {…} }`: new report.
- `200 { "merged": true, "report": {…} }`: an active report of the same type
  already existed within 75 m. It was **confirmed** instead of creating a
  duplicate. Tell the user "Thanks, others reported this too".
- `409 DUPLICATE_REPORT` (+ `reportId`): this device already reported it there.
- `429 REPORT_LIMIT_REACHED`: this device has 5 active reports already.
- A report stays visible for its type's lifetime (`config.features.reports.ttlMinutes`);
  each confirmation extends it.

**Vote** on someone else's report ("still there?" prompts when the user
passes a report):

```
POST /api/v1/reports/{id}/votes
Authorization: Bearer <device token>
Content-Type: application/json

{ "vote": "confirm" }          or  { "vote": "dismiss" }
→ 200 { "ok": true, "report": {…} }
```

Errors: `403 CANNOT_VOTE_OWN_REPORT`, `409 ALREADY_VOTED`,
`409 REPORT_NOT_ACTIVE`, `404 NOT_FOUND`. One vote per device per report;
votes cannot be changed.

**Withdraw** your own report: `DELETE /api/v1/reports/{id}` with the device
token → `200`, `status: "withdrawn"`. Errors: `403 NOT_REPORT_OWNER`,
`409 REPORT_NOT_ACTIVE`.

**Safety**: the app should not ask a driver to type while moving. One-tap
report buttons and "still there?" prompts are the usual pattern. That is
app-side UX, not enforced by the backend.

## 6. Recommended request cadence

| Data | When | Interval |
|---|---|---|
| `/config` | start-up, back to foreground after > 1 h | - |
| `/traffic` | map visible | 15 s |
| `/reports` | map visible | 60 s, and after the map moves to a new area |
| `/road-features` | map moves outside the cached area | cache 10+ min per area |
| `/routes` | route preview and navigation | 30-60 s (same request); reroute ≥ 10 s apart |
| `/places/*` | user action only | never on a timer or per keystroke |

Stop polling when the app is in the background unless it is actively
navigating.

## 7. Rate limits

Per client IP address unless noted (values from `config.limits.rateLimits`):

| Scope | Default |
|---|---|
| All `/api/v1` requests | 120 / minute |
| `/places/search`, `/places/reverse` | 30 / minute |
| `/places/nearby` | 20 / minute |
| `/routes` | 20 / minute |
| `/auth/device` | 10 / hour |
| `POST /reports` | 10 / hour per device |
| votes | 60 / hour per device |

Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset` (seconds). When refused: `429` with `code: "RATE_LIMITED"`
and a `Retry-After` header (seconds). Wait that long; do not retry in a loop.
Users behind the same carrier NAT share an IP address, so keep requests to
what the user actually needs.

## 8. Errors

```json
{ "ok": false, "code": "INVALID_REQUEST", "error": "lat must be a number between -90 and 90", "details": ["lat must be a number between -90 and 90"] }
```

**Switch on `code`**, never on `error` (English text that may change).
`details` (validation errors) and `retryAfterSeconds` are optional.

| HTTP | `code` | Meaning | What the app should do |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | Input failed validation (`details` lists why) | Fix the request. A bug on the app side, or a missing input check. |
| 400 | `MALFORMED_JSON` | Body is not valid JSON | App bug |
| 401 | `DEVICE_TOKEN_REQUIRED` | Write without a token | Register (§4), retry |
| 401 | `DEVICE_TOKEN_INVALID` / `DEVICE_TOKEN_EXPIRED` | Token unusable | Drop it, register again, retry once |
| 403 | `CANNOT_VOTE_OWN_REPORT`, `NOT_REPORT_OWNER` | Not allowed for this device | Hide the action |
| 404 | `NOT_FOUND` | Unknown id or path | Remove the item from the UI |
| 409 | `ALREADY_VOTED`, `REPORT_NOT_ACTIVE`, `DUPLICATE_REPORT` | State conflict | Refresh the item; show a short message |
| 413 | `PAYLOAD_TOO_LARGE` | Body > 100 KB | App bug |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Missing `Content-Type: application/json` | App bug |
| 422 | `NO_ROUTE`, `POINT_NOT_ROUTABLE` | No route / point off the road network | Tell the user; ask for another point |
| 429 | `RATE_LIMITED`, `REPORT_LIMIT_REACHED` | Too many requests / active reports | Wait `Retry-After`; explain the report limit |
| 502 | `PROVIDER_ERROR`, `PROVIDER_UNREACHABLE` | Routing / search provider failed | "Service unavailable, try again" + retry button |
| 503 | `PROVIDER_BUSY` | Provider overloaded or temporarily benched (`Retry-After`) | Retry after `Retry-After` |
| 503 | `DATABASE_UNAVAILABLE` | Reports / operator features temporarily unavailable | Hide reporting for now; retry later |
| 503 | `FEATURE_DISABLED` | Not configured on this server | Hide the feature (also visible in `/config`) |
| 503 | `SERVICE_UNAVAILABLE` | All road-feature sources down | Keep showing cached features |
| 504 | `PROVIDER_TIMEOUT` | Provider did not answer in time | Retry button |
| 500 | `INTERNAL_ERROR` | Server bug | Generic error; report it to the backend developer |

Also handle the network layer: no connection, DNS failure, TLS errors and
client timeouts never reach the backend's error format.

## 9. What the backend does not provide

These are app-side decisions or not available yet:

- **The map itself and the map SDK.** The backend serves no tiles: the app draws the map with **MapLibre**
  (MapLibre GL Native for Android and iOS, or a MapLibre binding for your framework) from the style URL in
  `GET /api/client-config` → `map.styleUrl` (OpenFreeMap's Liberty style, vector tiles). **It needs no key and no
  account.** Keep the map inside `map.bounds` and between `map.minZoom` and `map.maxZoom`, and show the map attribution.
  Labels are OpenStreetMap names: a village or street OpenStreetMap does not name has no label (Hawr never invents
  one). Arabic and Kurdish labels need text shaping, which MapLibre Native does; a web view needs a current browser.
  **Never put `GEOAPIFY_API_KEY` in the app**: search and routing go through this backend, and the web and mobile
  apps share one search budget. OpenFreeMap has no search, routing or traffic: do not look for them there.
- GPS, permissions, background location, route drawing, maneuver
  detection, off-route detection, voice guidance, offline maps.
  OpenFreeMap's terms (<https://openfreemap.org/tos/>) allow an app to download areas for offline use only if each
  download is at most 3,000 tiles or 50 MB, uses at most 4 parallel requests and sends a unique User-Agent that
  identifies the app; anything larger needs OpenFreeMap's permission (info@openfreemap.org). Do not bulk-download tiles.
- History. Saved places sync through `/saved-places` (§5.3a); trips are not stored.
- Speed limits per road segment, lane guidance, toll information, traffic
  on road segments without SmartTraffic cameras.
- Routing that avoids reported closures (closures are reported as alerts).
- Real-time push. Polling (§6) is the supported way to get updates.
  (The backend's Socket.IO `live` room carries raw dashboard snapshots; it
  is not part of the v1 mobile contract.)

## 10. Testing against the backend

- **Swagger UI** (`/api/docs/`): every v1 endpoint with examples. Use
  **Authorize** → `deviceToken` with a token from `POST /auth/device`.
- **Local backend**: see `backend/README.md`. Phones on the same Wi-Fi reach
  it at `http://<computer-LAN-IP>:<PORT>/api/v1`.
- **Live traffic** needs the AI service sending data. Without it, every
  intersection is `no-data`, which is a real state the app must handle.
  Ask the backend developer for an environment with the AI feed running
  when you need to see `live` data.
- **Reports** need the database. `GET /config` shows whether it is up.
- **Test data**: there is none. Road features and reports are real records:
  the operator adds road features in the admin console (`/admin.html`), and
  your app registers its own device with `POST /auth/device` and sends real
  reports. A report within 75 m of an active one of the same type confirms
  that one instead of adding a pin (`merged: true`).

## 11. Mobile integration checklist

- [ ] Base URL is configuration; production uses HTTPS.
- [ ] `/config` at start-up; unavailable features hidden.
- [ ] Device token stored in secure storage; renewed before expiry; `401`
      token codes handled by re-registering once.
- [ ] All received geometry treated as GeoJSON `[lng, lat]`.
- [ ] The attribution text (© OpenMapTiles © OpenStreetMap contributors) shown with the map, places and routes.
- [ ] Search runs on submit only.
- [ ] Route ETA from `traffic.adjustedDuration`; live-traffic label only when
      `traffic.basis == "live-ai"`; selected route kept by `id`.
- [ ] `roadAlerts` and `traffic.alerts` shown along the route.
- [ ] `no-data`, `stale`, `available: false` and `positionSource: "unknown"`
      rendered as such, never as "no traffic".
- [ ] Polling intervals per §6, paused in the background.
- [ ] `429` and `Retry-After` respected.
- [ ] Errors handled by `code` (§8); unknown fields and enum values tolerated.
- [ ] No admin token or other backend secret in the app.
