# Driver navigation page

`navigation.html` is a phone-first page for drivers: search a destination, see ranked
routes with time and distance, see where the AI cameras report live traffic, and report an incident. It is plain
ES modules served by the backend (no build step) and talks **only to the SmartTraffic
backend**, never to the map provider.

```
 navigation.html -> navApp.js
   NavMap (MapLibre + OpenFreeMap)      /api/client-config   map style URL, area, attribution
   SearchBox / geocoder.js              GET  /api/v1/places/search
   routeService.js                      POST /api/v1/routes
   hazardService.js                     GET  /api/v1/road-features, /api/v1/reports, /api/v1/places/local
   deviceSession.js, reportDialog.js    POST /api/v1/auth/device, POST /api/v1/reports
   trafficStore / trafficFeed           Socket.IO "live" room + GET /api/intersections
```

## Modules

| File | Role |
|---|---|
| `navApp.js` | Wires the page: map, search, routes, live feed, layers |
| `navMap.js` | MapLibre map, created once: routes, hazards, reports and places as GeoJSON layers (updated with `setData`), intersection markers, point picker. Intersections without a position are not drawn. |
| `../mapCore.js`, `../mapConfig.js` | Shared by every web map: load the style URL, area and attribution from the backend, create the map, add the icons, show a message when the map cannot load |
| `config.js` | Endpoints and limits. No provider URL, no key. |
| `searchBox.js`, `geocoder.js` | Destination search through the backend |
| `routeService.js`, `routePanel.js` | Route request, normalisation to `[lat, lng]` lines, the route sheet |
| `routeRanking.js`, `routeTraffic.js` | Ranking by provider time plus live AI delay; matching routes to monitored intersections |
| `hazardService.js`, `layersPanel.js` | Speed cameras, bumps and closures entered by the operator, driver reports, Hawr places; layer switches |
| `deviceSession.js`, `reportDialog.js` | The anonymous device session (kept in localStorage) and the "Report an incident" dialog |
| `trafficStore.js`, `trafficFeed.js` | Live intersection state from the backend |
| `format.js`, `geo.js`, `status.js` | Helpers |

## Routing

- One `POST /api/v1/routes` asks the backend for up to four routes. The backend asks Geoapify once per route
  type (or your own OSRM once) and returns the different routes it found, at most three from Geoapify;
  fewer is normal and the list says so. A straight line is never drawn as a route.
- Times are the provider's free-flow estimate. The page adds **live AI delay** at monitored
  intersections from the live feed (`routeRanking.estimateRoute`): the mean wait of the stopped
  vehicles on the approach the route enters by plus 2 s per vehicle. Intersections without fresh
  data, without a camera video or without a surveyed position add nothing and are listed as such.
  Routes are re-ranked as live data changes (no new route request), with a 5 s tolerance so near
  ties do not flip.
- Backend errors are shown as readable messages (no route, point too far from a road, busy, quota,
  offline, timeout) with a retry button where retrying can help.

## Map

The map is **OpenFreeMap** vector tiles drawn by **MapLibre GL JS**; the style URL, the area the map is fixed to
(the Kurdistan Region) and the zoom range come from `GET /api/client-config`. No key is involved. Attribution is
shown in the corner (OpenFreeMap's and "Powered by Geoapify"). If the style cannot be loaded, a message says so
instead of a blank map. Labels are OpenStreetMap names: a place or street OpenStreetMap does not name has no label.
Tap the map for "Start here", "Destination here" or "Report an incident here"; a report is posted with the
browser's device session and appears on the map once the backend has stored it.

## Data shown

| Layer | Source | When empty |
|---|---|---|
| Monitored intersections | the live decision engine (AI cameras); only those with a surveyed position | "No monitored intersections with known positions" |
| Speed cameras, bumps, closures | `GET /api/v1/road-features` (entered in the admin console) | "None in this area" |
| Driver reports | `GET /api/v1/reports` (posted by drivers, shown until they expire) | "None in this area" |
| Hawr places | `GET /api/v1/places/local` (entered in the admin console) | "None in this area" |

Nothing is invented: counts without a camera are `-`, never 0; a stale observation says so.

## Tests

`backend/test/navigation.test.js` and `routeRanking.test.js` test these modules without a browser
(`npm test` in `backend/`). A real-browser check of the page is described in
`backend/docs/API_TEST_REPORT.md`.
