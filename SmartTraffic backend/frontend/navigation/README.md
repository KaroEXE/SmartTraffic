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
| `routeRanking.js` | Four routes ranked best to worst: live delay estimate, ordering, distinct-route checks |
| `trafficFeed.js`, `trafficStore.js` | Socket.IO subscription (live room only) and freshness |
| `hazardService.js` | Speed cameras / bumps / closures, replaceable provider |
| `status.js`, `format.js`, `geo.js` | Offline/notices, formatting, geometry |
| `manifest.webmanifest`, `icon.svg` | PWA metadata (no service worker yet, so no offline mode) |

Unit tests: `backend/test/navigation.test.js` and `backend/test/routeRanking.test.js` (`npm test` in `backend/`).

## Four ranked routes

The page shows up to four routes between the same start and destination,
ranked by estimated travel time (distance breaks ties) and drawn green
(Route 1, best, on top) -> yellow-green -> orange -> red (Route 4, slowest).
The route list is the legend: tapping an entry or a line highlights it.

- **Where they come from.** One OSRM request with alternatives. When OSRM
  returns fewer than four, `findMoreRoutes` asks the same OSRM server for
  routes through via points beside the direct line, each first moved onto a
  nearby named road (`/nearest`). A candidate is kept only if it runs on
  different roads (less than 80% shared with every other route), does not
  double back, and is not more than 2.5x the fastest time. Requests are
  spaced 1.1 s apart and stop once four routes exist. If the road network
  offers fewer distinct routes, fewer are shown and the page says so.
- **Estimate.** OSRM travel time plus, for each AI-monitored intersection
  the route passes (within 60 m), a live delay for the approach the route
  enters by: the mean wait of the stopped vehicles on that approach plus 2 s
  per vehicle on it (`traffic.secondsPerVehicle`). This is the same live
  data the backend broadcasts to the dashboard.
- **Updates.** Every live update re-ranks from data already on the page; no
  route is re-requested. Lines and list entries are recoloured and moved in
  place. Two routes swap only when their estimates differ by more than 5 s
  (`traffic.rankHysteresisSeconds`), so near-ties do not flicker.
- **No live data** (feed stale, video unavailable, or no route passes the
  intersection): ranking uses OSRM times only, and the note above the list
  says live traffic is not included.

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

- Road geometry for each approach. The approach a route uses is inferred
  from the route's heading as it reaches the intersection (heading south =
  entering from the north approach), which assumes the cameras' north/south/
  east/west match the compass.
- Surveyed coordinates. Set `INTERSECTION_LAT` / `INTERSECTION_LNG` on the
  backend; the default position is a placeholder that no through-route
  passes. Route matching (within 60 m of the line) uses it as-is.

## Backend endpoints the page is ready for (not implemented)

**Traffic-adjusted routes**: set `routing.trafficRoutesUrl` in `config.js`.

```
POST <trafficRoutesUrl>
{ "start": {"lat","lng"}, "destination": {"lat","lng"}, "maxRoutes": 4 }

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
