# Driver navigation (`/navigation.html`)

Mobile-first driver page, separate from the operator dashboard. Opened from
the dashboard topbar (navigation arrow next to "Live AI") or directly at
`http://<host>:<port>/navigation.html`. No build step, no extra dependencies:
it uses the Leaflet and Socket.IO client files the backend already serves.

| File | Role |
|---|---|
| `../navigation.html` | Page layout |
| `navigation.css` | Mobile-first styles (`nv-` prefix; colour tokens from `../style.css`) |
| `navApp.js` | Entry point: wires everything, one instance per page |
| `config.js` | **All provider URLs and limits** |
| `navMap.js`, `layersPanel.js` | Leaflet map, layers, legend |
| `searchBox.js`, `geocoder.js` | Destination search (Nominatim) |
| `routeService.js`, `routePanel.js`, `routeTraffic.js` | Routing (OSRM), route sheet, route vs. live observations |
| `trafficFeed.js`, `trafficStore.js` | Socket.IO subscription (live room only) and freshness |
| `hazardService.js` | Speed cameras / bumps / closures, replaceable provider |
| `status.js`, `format.js`, `geo.js` | Offline/notices, formatting, geometry |
| `manifest.webmanifest`, `icon.svg` | PWA metadata (no service worker yet, so no offline mode) |

Unit tests: `backend/test/navigation.test.js` (`npm test` in `backend/`).

## External providers (no keys, nothing secret in the frontend)

| Purpose | Default | Policy to respect |
|---|---|---|
| Map tiles | tile.openstreetmap.org (same as dashboard) | OSM tile usage policy, attribution shown |
| Routing | router.project-osrm.org (OSRM demo) | Demo server, no SLA, ~1 request/s |
| Search | nominatim.openstreetmap.org | Max 1 request/s, no search-as-you-type (search runs on submit) |
| Hazards | Overpass API (OSM `highway=speed_camera`, `traffic_calming=bump/hump/table/cushion`) | Public instances are often busy; the page says "unavailable" when they fail |

For production, point `config.js` at self-hosted or commercial instances.
OpenStreetMap hazard data is community-mapped, often incomplete, and shown
as "not verified by SmartTraffic". Road closures have no data source yet.

## Live traffic: fields the page reads

From the existing live Socket.IO room (`init`, `trafficUpdate`,
`signalUpdate`). The page never subscribes to simulation, and ignores any
payload with `dataMode: "simulation"`.

```
intersectionId, name, lat, lng          -> marker position (point only)
traffic.<north|south|east|west>.{vehicles, queueLength, waitingTime}
aiStatus ('CONNECTED' | 'STALE' | 'WAITING'), lastUpdate, serverTime
emergency.{active, type, direction, confidence, since}
dataMode
```

**Not available yet** (so traffic is drawn as points at intersections, never
as coloured road segments):

- Road geometry or bearing for each approach, e.g. `approaches.<dir>.bearing`
  (degrees) or a GeoJSON line per approach. Without it the page cannot tell
  which approach a route uses or colour the road.
- Surveyed coordinates. `backend/config/intersections.js` says its positions
  are placeholders. Route matching (within 60 m of the line) uses them as-is.

## Backend endpoints the page is ready for (not implemented)

**Traffic-adjusted routes**: set `routing.trafficRoutesUrl` in `config.js`.

```
POST <trafficRoutesUrl>
{ "start": {"lat","lng"}, "destination": {"lat","lng"}, "maxRoutes": 3 }

200 { "routes": [ {
  "geometry": { "type": "LineString", "coordinates": [[lng, lat], ...] },
  "distance": 5100, "duration": 420, "summary": "via ...",
  "traffic": {                                  // optional
    "adjustedDuration": 540, "delay": 120,      // seconds
    "basis": "live-ai",                         // required for the live label
    "updatedAt": "2026-10-09T10:00:00Z",
    "alerts": [ { "message": "Long queue at Main Street" } ]
  } } ] }
```

A route is labelled "live AI-adjusted" only when `traffic` has a numeric
`adjustedDuration`, `basis: "live-ai"` and a valid `updatedAt`. If the call
fails, OSRM routes are shown with "Live traffic data unavailable". While
routes come from the backend, they are re-requested when traffic changes
(at most every `trafficRefreshMs`).

**Hazards**: set `hazards.provider: 'backend'` and `hazards.backendUrl`.

```
GET <backendUrl>?south=&west=&north=&east=
200 { "hazards": [ { "id": "c-12", "kind": "speed_camera" | "speed_bump" | "road_closure",
                     "lat": 35.56, "lng": 45.43, "source": "City traffic department",
                     "verification": "verified" | "unverified", "label": "...", "reportedAt": "ISO" } ] }
```

Entries with an unknown `kind` or invalid coordinates are dropped; a missing
or unknown `verification` is shown as "Unverified user report".

## Notes

- Geolocation needs HTTPS (or `localhost`). Phones opening
  `http://<LAN-IP>:3000` cannot share their location; they can still tap the
  map or use the map centre as the start.
- `window.smartTrafficNav.diagnostics()` reports map/listener counts for
  checking that live updates never duplicate the map or socket listeners.
