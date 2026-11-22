# Graph Report - SmartTraffic backend  (2026-11-15)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1855 nodes · 4064 edges · 84 communities (76 shown, 8 thin omitted)
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 296 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `c07a2e0d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- NavMap
- app.js
- Signal Decision Engine
- trafficHistoryService.test.js
- Dashboard Rendering
- Navigation App Controller
- server.js
- admin.js
- Traffic Decision Engine
- Backend Package Deps
- OpenAPI Spec
- map.js
- Traffic History Service
- analytics.js
- Models & Constants
- liveAI.js
- decisionPanel.js
- 3D Vehicle Models
- 3D Traffic Lights
- TrafficScene
- Simulation Service
- isValidLatLng
- Vehicle System
- Payload Validation
- navMap.js
- mapConfig.js
- Traffic State Store
- Socket Integration Tests
- navigationHarness.js
- streamValidation.js
- hazardService.js
- Search Box UI
- routePanel.js
- navigation/geo.js
- 5. Endpoints
- Navigation Icon
- routeService.js
- apiError.js
- SimControls
- navValidation.js
- trafficDecisionService.js
- simulationBenchmark.js
- SmartTraffic navigation backend: mobile integration guide
- navigation/index.js
- ApiError
- utils/geo.js
- scene.js
- providerClient.js
- IntersectionSite
- navigationUnits.test.js
- NetworkCoordinator
- SmartTraffic Driver Navigation Page
- auth.js
- Mobile navigation API
- EmergencyCorridorPlanner
- RoutePanel
- liveScene.test.js
- network3d.test.js
- intersection.js
- streams.test.js
- pedestrians.js
- trafficIngestion.test.js
- smokeNavigation.js
- navigation.test.js
- routeRanking.test.js
- ref_path
- noFakeData.test.js
- API reference
- Setup guide: run SmartTraffic from a clean machine
- Signal Operations Dashboard Page
- routingService.js
- Deployment
- intersections.js
- modeStore.test.js
- streamStatus.test.js
- TtlCache
- scripts
- SmartTraffic backend
- Troubleshooting
- Historical Data (MongoDB)
- API test report
- createDeviceSession
- LayersPanel

## God Nodes (most connected - your core abstractions)
1. `TrafficScene` - 48 edges
2. `TrafficDecisionService` - 47 edges
3. `boot()` - 35 edges
4. `NavMap` - 27 edges
5. `createTrafficDecisionService()` - 25 edges
6. `createNavigationApi()` - 23 edges
7. `SimulationService` - 22 edges
8. `VehicleSystem` - 21 edges
9. `boot()` - 20 edges
10. `ApiError` - 19 edges

## Surprising Connections (you probably didn't know these)
- `Principles the code follows` --references--> `unavailable()`  [INFERRED]
  backend/docs/ARCHITECTURE.md → frontend/admin.js
- `5.3 `GET /places/reverse` and `GET /places/nearby`` --references--> `name()`  [INFERRED]
  backend/docs/MOBILE_INTEGRATION_GUIDE.md → frontend/decisionPanel.js
- `5.4 `POST /routes`` --references--> `name()`  [INFERRED]
  backend/docs/MOBILE_INTEGRATION_GUIDE.md → frontend/decisionPanel.js
- `Live traffic` --references--> `moderate()`  [INFERRED]
  backend/docs/CONFIGURATION.md → frontend/admin.js
- `5.5 `GET /traffic`` --references--> `moderate()`  [INFERRED]
  backend/docs/MOBILE_INTEGRATION_GUIDE.md → frontend/admin.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Decision Engine Precedence Rules** — readme_emergency_preemption, readme_fixed_time_fallback, readme_minimum_green, readme_exclusive_pedestrian_phase, readme_fairness_guard, readme_adaptive_green, readme_priority_score [EXTRACTED 1.00]
- **Navigation External OSM-Based Providers** — frontend_navigation_readme_osm_tiles, frontend_navigation_readme_osrm_routing, frontend_navigation_readme_nominatim_search, frontend_navigation_readme_overpass_hazards [EXTRACTED 1.00]
- **Live/Simulation Isolation Mechanisms** — readme_live_simulation_isolation, readme_reserved_source_tags, readme_socket_io_rooms, readme_datamode_mode_filter, frontend_navigation_readme_live_room_only [INFERRED 0.85]

## Communities (84 total, 8 thin omitted)

### Community 0 - "NavMap"
Cohesion: 0.13
Nodes (6): circlePolygon(), featureCollection(), latLngsToLngLats(), element(), hazardPopup(), NavMap

### Community 1 - "app.js"
Cohesion: 0.23
Nodes (26): acceptNetwork(), applyModeChrome(), applySimStatus(), boot(), connectSocket(), createScene(), dataStateOf(), fetchJson() (+18 more)

### Community 2 - "Signal Decision Engine"
Cohesion: 0.10
Nodes (11): EventEmitter, isCountMap(), nonNegative(), normalizeObservation(), pct(), perDirection(), round1(), TrafficDecisionService (+3 more)

### Community 3 - "trafficHistoryService.test.js"
Cohesion: 0.07
Nodes (20): createTrafficDecisionService(), assert, config, DIRECTIONS, NO_EMERGENCY, setup(), SIGNAL_VALUES, SPEC_TRAFFIC (+12 more)

### Community 4 - "Dashboard Rendering"
Cohesion: 0.09
Nodes (45): ageText(), appendEvent(), approachView(), dataAgeSeconds(), DIRS, escapeHtml(), eventRow(), formatTime() (+37 more)

### Community 5 - "Navigation App Controller"
Cohesion: 0.12
Nodes (35): loadMapConfig(), formatCoords(), boot(), clearDestination(), clearRoutes(), computeMatches(), drawRoutes(), GEO_ERRORS (+27 more)

### Community 6 - "server.js"
Cohesion: 0.05
Nodes (30): attachListeners(), attempt(), connectDatabase(), disconnectDatabase(), getDatabaseStatus(), mongoose, prepareCollections(), safeMessage() (+22 more)

### Community 7 - "admin.js"
Cohesion: 0.07
Nodes (60): AI service integration, Community reports, Configuration, Database, Fixed limits, Live traffic, Map, search and routing (OpenFreeMap, Geoapify, optional OSRM), Mobile navigation API (`/api/v1`) (+52 more)

### Community 8 - "Traffic Decision Engine"
Cohesion: 0.09
Nodes (15): Live AI Camera Panel, AI_STREAM_URL (Flask camera stream), Environment Configuration (backend/.env), Traffic Decision Engine, Judges Demo Flow, Deprecated Mock Client, Live Traffic Mode, Perception System (Python / YOLO) (+7 more)

### Community 9 - "Backend Package Deps"
Cohesion: 0.11
Nodes (22): dependencies, cors@^2.8.5, dotenv@^16.4.7, express@^4.22.3, maplibre-gl@^6.18.0, mongoose@^8.24.5, socket.io@^4.8.1, swagger-ui-dist@^5.33.1 (+14 more)

### Community 10 - "OpenAPI Spec"
Cohesion: 0.05
Nodes (31): Response format, 8. Errors, approachProperties, benchmarkResult, bool, date, direction, error() (+23 more)

### Community 11 - "map.js"
Cohesion: 0.16
Nodes (9): DIRS, esc(), markerHtml(), NetworkMap, tooltipHtml(), CONGESTION_LABEL, CONGESTION_THRESHOLDS, DIRS (+1 more)

### Community 12 - "Traffic History Service"
Cohesion: 0.14
Nodes (4): modeFilter(), round1(), signalChanges(), TrafficHistoryService

### Community 13 - "analytics.js"
Cohesion: 0.20
Nodes (20): CARDS, changeText(), esc(), fmt(), initAnalytics(), lineChart(), loadLatest(), loadScenarios() (+12 more)

### Community 14 - "Models & Constants"
Cohesion: 0.15
Nodes (16): DATA_MODES, HAZARD_KINDS, HAZARD_REPORT_STATUSES, MODES, PEDESTRIAN_SIGNALS, perDirection(), PHASES, SIMULATED_SOURCES (+8 more)

### Community 15 - "liveAI.js"
Cohesion: 0.13
Nodes (39): connectCameraStreams(), DIRS, disconnectCameraStreams(), el, emptyNote(), initializeLiveAI(), isNum(), loadStreamConfig() (+31 more)

### Community 16 - "decisionPanel.js"
Cohesion: 0.17
Nodes (16): clock(), esc(), initDecisionPanel(), names, onSelect(), renderDecision(), SOURCE_LABEL, STATE_LABEL (+8 more)

### Community 17 - "3D Vehicle Models"
Cohesion: 0.10
Nodes (22): Three.js Import Map (local vendor), 3D Viewport (alerts, compass, reset view), AMB_RED, BODY, box(), cachedBox(), CLASS_KIND, emergencyModel() (+14 more)

### Community 18 - "3D Traffic Lights"
Cohesion: 0.10
Nodes (19): armGeo, backplateGeo, backplateMat, BAR_COLORS, barGeo, beaconTexture, buildHead(), COLORS (+11 more)

### Community 19 - "TrafficScene"
Cohesion: 0.08
Nodes (7): ambulanceModel(), chevronGeometry(), NetworkOverlay, corridorPath(), linkStates(), vehiclePosition(), TrafficScene

### Community 20 - "Simulation Service"
Cohesion: 0.14
Nodes (13): routePath(), advanceTour(), applyScenario(), createWorld(), EventEmitter, generateArrivals(), NORMAL_RATES, observeWorld() (+5 more)

### Community 21 - "isValidLatLng"
Cohesion: 0.16
Nodes (15): isValidLatLng(), BUSY_CODES, createGeocoder(), GeocodeError, parsePlaces(), parseRoadFeatures(), Nominatim Destination Search, createTrafficStore() (+7 more)

### Community 22 - "Vehicle System"
Cohesion: 0.19
Nodes (4): approach(), pathPoint(), kindMix(), VehicleSystem

### Community 23 - "Payload Validation"
Cohesion: 0.26
Nodes (17): liveObservation(), checkNonNegative(), EMERGENCY_TYPE_ALIASES, EMERGENCY_TYPES, isMissing(), isPlainObject(), LIMITS, toDecisionInput() (+9 more)

### Community 24 - "navMap.js"
Cohesion: 0.13
Nodes (14): formatAge(), VERIFICATION_TEXT, Map Layers and Legend Panel, LAYERS, LEGEND, BUMP_SVG, CAMERA_SVG, GROUP_LABEL (+6 more)

### Community 25 - "mapConfig.js"
Cohesion: 0.17
Nodes (9): Map label coverage (OpenStreetMap names), MapLibre GL JS, OpenFreeMap (basemap), boundsCenter(), MAP_ICONS, toMapBounds(), addHawrIcons(), createBaseMap() (+1 more)

### Community 26 - "Traffic State Store"
Cohesion: 0.12
Nodes (12): createPausableClock(), assert, config, INTERSECTIONS, seeded(), setup(), test, clone() (+4 more)

### Community 27 - "Socket Integration Tests"
Cohesion: 0.14
Nodes (12): createSimulationService(), bindTrafficEvents(), ENGINE_EVENTS, initTrafficSocket(), MODES, { Server }, assert, config (+4 more)

### Community 28 - "navigationHarness.js"
Cohesion: 0.05
Nodes (53): createUserAccountService(), changePassword(), current(), deleteAccount(), list(), login(), logout(), signup() (+45 more)

### Community 29 - "streamValidation.js"
Cohesion: 0.09
Nodes (22): { Schema, model }, trafficStreamSchema, dbUnavailable(), EventEmitter, iso(), notFound(), rethrowDuplicate(), sortKey() (+14 more)

### Community 30 - "hazardService.js"
Cohesion: 0.17
Nodes (17): bboxContains(), clampBBox(), padBBox(), createAreaProvider(), createHazardLoader(), run(), createPlaceProvider(), createReportProvider() (+9 more)

### Community 32 - "routePanel.js"
Cohesion: 0.20
Nodes (14): DIRECTION_LABEL, directionLabel(), formatClock(), formatDelay(), formatDistance(), formatDuration(), LIVE_NOTE, liveText() (+6 more)

### Community 33 - "navigation/geo.js"
Cohesion: 0.20
Nodes (13): distanceMeters(), distanceToPolylineMeters(), rad(), rerank(), approachDirection(), bearingDegrees(), DIRECTIONS, estimateRoute() (+5 more)

### Community 34 - "5. Endpoints"
Cohesion: 0.14
Nodes (16): Database, `roadFeatures`, `roadReports`, 2. Conventions, 5.1 `GET /config`, 5.2 `GET /places/search`, 5.3 `GET /places/reverse` and `GET /places/nearby`, 5.3a Hawr places and saved places (+8 more)

### Community 35 - "Navigation Icon"
Cohesion: 1.00
Nodes (3): Navigation App Icon (icon.svg), Navigation Arrow Pointer, Traffic Light Glyph (green signal active)

### Community 36 - "routeService.js"
Cohesion: 0.23
Nodes (10): NAV_CONFIG, OSRM Routing Provider, Traffic-Adjusted Routes Endpoint (planned), BACKEND_ERRORS, lineToLatLngs(), normalizeBackendResponse(), normalizeRoute(), planRoutes() (+2 more)

### Community 37 - "apiError.js"
Cohesion: 0.08
Nodes (24): createNavigationRoutes(), express, handle(), sendApiError(), sendError(), UPSTREAM_STATUS, bearer(), createDeviceTokens() (+16 more)

### Community 39 - "navValidation.js"
Cohesion: 0.07
Nodes (69): paging(), unwrap(), unwrap(), unwrap(), requireId(), unwrap(), requireId(), unwrap() (+61 more)

### Community 40 - "trafficDecisionService.js"
Cohesion: 0.09
Nodes (20): aiServiceBaseUrl(), config, httpUrl(), path, createEmergencyCorridorPlanner(), createNetworkCoordinator(), DEFAULTS, buildTopology() (+12 more)

### Community 41 - "simulationBenchmark.js"
Cohesion: 0.13
Nodes (20): OPPOSITE, createNetworkTrafficModel(), DEFAULTS, straightPath(), compare(), drawDemand(), emergencyRoute(), improvementPercent() (+12 more)

### Community 42 - "SmartTraffic navigation backend: mobile integration guide"
Cohesion: 0.22
Nodes (10): Socket.IO events, 10. Testing against the backend, 1. Base URL and versioning, 3. App start-up sequence, 4. Authentication, 6. Recommended request cadence, 7. Rate limits, 9. What the backend does not provide (+2 more)

### Community 43 - "navigation/index.js"
Cohesion: 0.08
Nodes (16): createAdminController(), createAuthController(), createNavigationController(), createPlaceDataController(), createRoadDataController(), createNavigationApi(), createLocalPlaceService(), iso() (+8 more)

### Community 44 - "ApiError"
Cohesion: 0.14
Nodes (19): isDatabaseConnected(), requireJson(), requireJson(), External providers: Geoapify and OpenFreeMap, refreshStreams(), createRoadFeatureService(), load(), iso() (+11 more)

### Community 45 - "utils/geo.js"
Cohesion: 0.14
Nodes (26): 11. Mobile integration checklist, 5.4 `POST /routes`, approachDirection(), approachView(), createLiveTrafficService(), estimateRoute(), intersectionView(), LEVEL_ORDER (+18 more)

### Community 46 - "scene.js"
Cohesion: 0.12
Nodes (20): three@^0.169.0, disposeStatic(), LAYOUT, finish(), gridLayout(), hasCoords(), layoutNetwork(), HEADING_ANGLE (+12 more)

### Community 47 - "providerClient.js"
Cohesion: 0.22
Nodes (17): createGeoapifyClient(), createOsrmClient(), createProviderClient(), fail(), get(), spend(), geoapifyError(), osrmError() (+9 more)

### Community 49 - "navigationUnits.test.js"
Cohesion: 0.09
Nodes (22): productionProblems(), addressDetails(), hasPosition(), pickName(), point(), preferredLang(), text(), toNearbyPlace() (+14 more)

### Community 50 - "NetworkCoordinator"
Cohesion: 0.21
Nodes (4): EventEmitter, linkState(), NetworkCoordinator, up()

### Community 51 - "SmartTraffic Driver Navigation Page"
Cohesion: 0.22
Nodes (7): SmartTraffic Driver Navigation Page, Offline Banner, Driver Navigation Module (README), PWA Manifest (no service worker), Route Sheet, Navigation Search Card (From / To), createStatus()

### Community 52 - "auth.js"
Cohesion: 0.48
Nodes (6): bearerToken(), crypto, digest(), hasBearerToken(), requireToken(), unauthorized()

### Community 53 - "Mobile navigation API"
Cohesion: 0.20
Nodes (10): Admin console API, Architecture, Code organization, Device tokens, Known limits of the current design, Layers, Map-area queries, Mobile navigation API (+2 more)

### Community 56 - "liveScene.test.js"
Cohesion: 0.14
Nodes (11): ALL_GREEN, ALL_RED, assert, frontend(), path, { pathToFileURL }, { register }, { spawnSync } (+3 more)

### Community 57 - "network3d.test.js"
Cohesion: 0.14
Nodes (12): assert, DECISION, EW_GREEN, frontend(), NS_GREEN, NS_YELLOW, path, { pathToFileURL } (+4 more)

### Community 58 - "intersection.js"
Cohesion: 0.18
Nodes (15): buildCity(), buildRoadNetwork(), groundPlane(), instanced(), laneOffset(), LEG, _m, MAT (+7 more)

### Community 59 - "streams.test.js"
Cohesion: 0.17
Nodes (9): createStreamController(), createStreamRoutes(), createStreamRegistryService(), assert, express, fakeRecordModel(), fakeStreamModel(), startApp() (+1 more)

### Community 60 - "pedestrians.js"
Cohesion: 0.22
Nodes (8): DIRS, legVector(), bodyGeo, CLOTHES, crosswalkGeometry(), headGeo, SKIN, WALK_SPEED

### Community 61 - "trafficIngestion.test.js"
Cohesion: 0.08
Nodes (26): createSimulationController(), createTrafficController(), historyHandler(), parseHistoryQuery(), createDocsRoutes(), express, swaggerUiPath, assert (+18 more)

### Community 62 - "smokeNavigation.js"
Cohesion: 0.15
Nodes (8): adminToken, args, base, DESTINATION, path, results, START, write

### Community 63 - "navigation.test.js"
Cohesion: 0.15
Nodes (5): assert, path, { pathToFileURL }, test, TRAFFIC_CFG

### Community 64 - "routeRanking.test.js"
Cohesion: 0.17
Nodes (10): assert, at(), BYPASS, EASTBOUND, IX, path, { pathToFileURL }, route() (+2 more)

### Community 65 - "ref_path"
Cohesion: 0.25
Nodes (4): assert, path, { pathToFileURL }, test

### Community 66 - "noFakeData.test.js"
Cohesion: 0.18
Nodes (9): assert, files, fs, MAY_LOAD_SIMULATION, path, ROOT, runtimeFiles(), SKIP_DIRS (+1 more)

### Community 67 - "API reference"
Cohesion: 0.20
Nodes (10): API reference, Authentication, Camera streams, Live traffic (AI service and dashboard), Mobile navigation API: `/api/v1`, Operator examples (admin token), Simulation (dashboard Simulation tab), Static files (+2 more)

### Community 68 - "Setup guide: run SmartTraffic from a clean machine"
Cohesion: 0.15
Nodes (13): 10. When something does not work, 1. Prerequisites, 2. Install, 3. Map, search and routing, 4. Database, 5. Secrets, 6. Run, 7. Test (+5 more)

### Community 69 - "Signal Operations Dashboard Page"
Cohesion: 0.12
Nodes (14): Current Decision / Signal Heads / Emergency / System Panels, Event Stream Log, Network Map and Intersection List, Data Source Mode Switch (Live traffic / Simulation), Signal Operations Dashboard Page, Simulation Control Panel (Start/Pause/Reset, Auto tour), View Tabs (Operations / Live AI), createModeStore() (+6 more)

### Community 70 - "routingService.js"
Cohesion: 0.17
Nodes (19): createRoutingService(), viaGeoapify(), viaOsrm(), crypto, DIRECTION_WORD, GEOAPIFY_ROUTE_TYPES, geoapifyManeuver(), instructionFor() (+11 more)

### Community 71 - "Deployment"
Cohesion: 0.20
Nodes (10): Backups and data, Checklist, Deployment, Environment, Map, search and routing in production, Mobile app, Production start checks, Render (same platform as the AI service) (+2 more)

### Community 72 - "intersections.js"
Cohesion: 0.29
Nodes (4): mainLat, mainLng, path, UNKNOWN

### Community 73 - "modeStore.test.js"
Cohesion: 0.25
Nodes (4): assert, path, { pathToFileURL }, test

### Community 74 - "streamStatus.test.js"
Cohesion: 0.25
Nodes (5): assert, NOW, path, { pathToFileURL }, test

### Community 76 - "scripts"
Cohesion: 0.40
Nodes (5): scripts, dev, smoke, start, test

### Community 78 - "SmartTraffic backend"
Cohesion: 0.29
Nodes (7): More, Project layout, Quick start, Repository note, Scripts, SmartTraffic backend, Testing

### Community 79 - "Troubleshooting"
Cohesion: 0.33
Nodes (6): Accounts, tokens and admin, Browser and apps, Map, search and routing, Start-up, Tests, Troubleshooting

### Community 80 - "Historical Data (MongoDB)"
Cohesion: 0.50
Nodes (3): Historical Data (MongoDB), signalEvents Collection, trafficRecords Time-Series Collection

### Community 81 - "API test report"
Cohesion: 0.33
Nodes (5): API test report, Authentication and authorisation (what is covered), Endpoint table, How it was tested, Not verified

### Community 83 - "createDeviceSession"
Cohesion: 0.22
Nodes (8): Driver incident reports, createDeviceSession(), ensure(), register(), send(), ReportError, ReportDialog, TYPES

## Knowledge Gaps
- **10 isolated node(s):** `RFC-7519`, `RFC-7519`, `Three.js Import Map (local vendor)`, `Nominatim Destination Search`, `Map label coverage (OpenStreetMap names)` (+5 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 615 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `three` connect `scene.js` to `Backend Package Deps`, `3D Vehicle Models`, `3D Traffic Lights`, `intersection.js`, `pedestrians.js`?**
  _High betweenness centrality (0.192) - this node is a cross-community bridge._
- **Are the 8 inferred relationships involving `boot()` (e.g. with `clearDestination()` and `onLayerToggle()`) actually correct?**
  _`boot()` has 8 INFERRED edges - model-reasoned connections that need verification._
- **What connects `RFC-7519`, `RFC-7519`, `Three.js Import Map (local vendor)` to the rest of the system?**
  _10 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `NavMap` be split into smaller, more focused modules?**
  _Cohesion score 0.1282051282051282 - nodes in this community are weakly interconnected._
- **Why does `Driver Navigation Module (README)` connect `SmartTraffic Driver Navigation Page` to `routeService.js`, `Navigation App Controller`, `navigation.test.js`?**
  _High betweenness centrality (0.093) - this node is a cross-community bridge._
- **Should `Signal Decision Engine` be split into smaller, more focused modules?**
  _Cohesion score 0.10482180293501048 - nodes in this community are weakly interconnected._
- **Why does `express` connect `trafficIngestion.test.js` to `apiError.js`, `server.js`, `Backend Package Deps`, `navigationUnits.test.js`, `streams.test.js`, `navigationHarness.js`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._