# Graph Report - SmartTraffic backend  (2026-11-05)

## Corpus Check
- 61 files · ~52,953 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 5 file(s) not represented in the graph (top: .css 2, (none) 1, .example 1)

## Summary
- 795 nodes · 1666 edges · 36 communities (34 shown, 2 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 83 edges (avg confidence: 0.85)
- Token cost: 140,478 input · 0 output

## Community Hubs (Navigation)
- Nav Map & Formatting
- Dashboard App Boot
- Signal Decision Engine
- Decision & Socket Tests
- Dashboard Rendering
- Navigation App Controller
- HTTP Routes & Server
- Deprecated Mock Client
- Architecture Concepts (README)
- Backend Package Deps
- OpenAPI Spec
- 3D Intersection Geometry
- Traffic History Service
- Config & Simulation World
- Models & Constants
- Live AI Camera Panel
- Service Factory Tests
- 3D Vehicle Models
- 3D Traffic Lights
- 3D Scene & Pedestrians
- Simulation Service
- Hazard Providers
- Vehicle System
- Payload Validation
- Route Planning (OSRM)
- Controllers & Ingestion Tests
- Traffic State Store
- Socket Integration Tests
- Geocoding & Nav Config
- Nav Traffic Store
- Simulation Tests
- Search Box UI
- MongoDB Connection
- Geo Utilities
- Historical Data Model
- Navigation Icon

## God Nodes (most connected - your core abstractions)
1. `TrafficDecisionService` - 40 edges
2. `boot()` - 29 edges
3. `NavMap` - 19 edges
4. `validateObservation()` - 18 edges
5. `SimulationService` - 17 edges
6. `createTrafficDecisionService()` - 17 edges
7. `TrafficHistoryService` - 17 edges
8. `VehicleSystem` - 17 edges
9. `initializeLiveAI()` - 14 edges
10. `setText()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `dataMode Stamping and modeFilter Rule` --references--> `modeFilter()`  [EXTRACTED]
  README.md → backend/models/constants.js
- `OpenStreetMap Tile Provider` --semantically_similar_to--> `Network Map (Leaflet + OpenStreetMap)`  [INFERRED] [semantically similar]
  frontend/navigation/README.md → README.md
- `Simulation Control Panel (Start/Pause/Reset, Auto tour)` --implements--> `Simulation Mode`  [INFERRED]
  frontend/index.html → README.md
- `Navigation Reads Live Room Only` --implements--> `Live/Simulation Data Isolation`  [INFERRED]
  frontend/navigation/README.md → README.md
- `Live AI Camera Panel` --references--> `connectLiveVideo()`  [EXTRACTED]
  frontend/index.html → frontend/liveAI.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Decision Engine Precedence Rules** — readme_emergency_preemption, readme_fixed_time_fallback, readme_minimum_green, readme_exclusive_pedestrian_phase, readme_fairness_guard, readme_adaptive_green, readme_priority_score [EXTRACTED 1.00]
- **Live/Simulation Isolation Mechanisms** — readme_live_simulation_isolation, readme_reserved_source_tags, readme_socket_io_rooms, readme_datamode_mode_filter, frontend_navigation_readme_live_room_only [INFERRED 0.85]
- **Navigation External OSM-Based Providers** — frontend_navigation_readme_osm_tiles, frontend_navigation_readme_osrm_routing, frontend_navigation_readme_nominatim_search, frontend_navigation_readme_overpass_hazards [EXTRACTED 1.00]

## Communities (36 total, 2 thin omitted)

### Community 0 - "Nav Map & Formatting"
Cohesion: 0.06
Nodes (28): DIRECTION_LABEL, directionLabel(), escapeHtml(), formatAge(), formatClock(), formatCoords(), formatDelay(), formatDistance() (+20 more)

### Community 1 - "Dashboard App Boot"
Cohesion: 0.07
Nodes (36): applyModeChrome(), applySimStatus(), boot(), connectSocket(), createScene(), fetchJson(), isFrozen(), onInit() (+28 more)

### Community 2 - "Signal Decision Engine"
Cohesion: 0.13
Nodes (7): normalizeObservation(), pct(), perDirection(), round1(), TrafficDecisionService, typeLabel(), up()

### Community 3 - "Decision & Socket Tests"
Cohesion: 0.05
Nodes (22): assert, config, DIRECTIONS, NO_EMERGENCY, setup(), SIGNAL_VALUES, SPEC_TRAFFIC, test (+14 more)

### Community 4 - "Dashboard Rendering"
Cohesion: 0.11
Nodes (36): appendEvent(), DIRS, escapeHtml(), eventRow(), formatTime(), initLayout(), MODE_INFO, pct() (+28 more)

### Community 5 - "Navigation App Controller"
Cohesion: 0.12
Nodes (32): boot(), clearDestination(), clearRoutes(), computeMatches(), GEO_ERRORS, HAZARD_IDS, hazardKinds, hazardLayersOn() (+24 more)

### Community 6 - "HTTP Routes & Server"
Cohesion: 0.09
Nodes (26): disconnectDatabase(), getDatabaseStatus(), createDocsRoutes(), express, swaggerUiPath, assert, checkRefs(), express (+18 more)

### Community 7 - "Deprecated Mock Client"
Cohesion: 0.12
Nodes (28): advanceTour(), API_URL, argv, CONTROL_PORT, createWorld(), DIRECTIONS, fetchStates(), http (+20 more)

### Community 8 - "Architecture Concepts (README)"
Cohesion: 0.10
Nodes (13): Live AI Camera Panel, AI_STREAM_URL (Flask camera stream), Environment Configuration (backend/.env), Traffic Decision Engine, Judges Demo Flow, Deprecated Mock Client, Live Traffic Mode, Perception System (Python / YOLO) (+5 more)

### Community 9 - "Backend Package Deps"
Cohesion: 0.09
Nodes (25): dependencies, cors@^2.8.5, dotenv@^16.4.7, express@^4.22.3, leaflet@^1.9.4, socket.io@^4.8.1, swagger-ui-dist@^5.33.1, description (+17 more)

### Community 10 - "OpenAPI Spec"
Cohesion: 0.10
Nodes (21): approachProperties, bool, date, direction, error(), historyParameters, id, nullableDate (+13 more)

### Community 11 - "3D Intersection Geometry"
Cohesion: 0.13
Nodes (21): three@^0.169.0, buildCityBlocks(), buildStaticIntersection(), DIRS, flatPlane(), laneOffset(), LAYOUT, LEG (+13 more)

### Community 12 - "Traffic History Service"
Cohesion: 0.13
Nodes (6): isDatabaseConnected(), modeFilter(), round1(), signalChanges(), TrafficHistoryService, snap()

### Community 13 - "Config & Simulation World"
Cohesion: 0.13
Nodes (17): config, path, advanceTour(), createPausableClock(), createWorld(), NORMAL_RATES, poisson(), rand() (+9 more)

### Community 14 - "Models & Constants"
Cohesion: 0.15
Nodes (17): DATA_MODES, MODES, PEDESTRIAN_SIGNALS, perDirection(), PHASES, SIMULATED_SOURCES, VEHICLE_SIGNALS, change (+9 more)

### Community 15 - "Live AI Camera Panel"
Cohesion: 0.23
Nodes (21): connectConfiguredStream(), connectLiveVideo(), DIRS, disconnectLiveVideo(), el, emptyNote(), initializeLiveAI(), isNum() (+13 more)

### Community 16 - "Service Factory Tests"
Cohesion: 0.13
Nodes (12): createTrafficDecisionService(), createTrafficHistoryService(), assert, config, fakeModel(), setup(), test, assert (+4 more)

### Community 17 - "3D Vehicle Models"
Cohesion: 0.12
Nodes (19): Three.js Import Map (local vendor), 3D Viewport (alerts, compass, reset view), AMB_RED, BODY, box(), cachedBox(), emergencyModel(), FIRE_RED (+11 more)

### Community 18 - "3D Traffic Lights"
Cohesion: 0.14
Nodes (14): backplateGeo, backplateMat, BAR_COLORS, buildHead(), COLORS, housingGeo, housingMat, lampGeo (+6 more)

### Community 20 - "Simulation Service"
Cohesion: 0.27
Nodes (3): applyScenario(), EventEmitter, SimulationService

### Community 21 - "Hazard Providers"
Cohesion: 0.18
Nodes (14): bboxContains(), padBBox(), CALMING_TYPES, createBackendProvider(), createHazardLoader(), run(), createHazardProvider(), createOverpassProvider() (+6 more)

### Community 22 - "Vehicle System"
Cohesion: 0.24
Nodes (4): approach(), pathPoint(), pickKind(), VehicleSystem

### Community 23 - "Payload Validation"
Cohesion: 0.34
Nodes (12): liveObservation(), checkNonNegative(), EMERGENCY_TYPE_ALIASES, isMissing(), isPlainObject(), toDecisionInput(), unknownKeys(), validateEmergency() (+4 more)

### Community 24 - "Route Planning (OSRM)"
Cohesion: 0.31
Nodes (12): buildOsrmUrl(), fetchBackend(), fetchJson(), fetchOsrm(), lineToLatLngs(), normalizeBackendResponse(), normalizeOsrmResponse(), normalizeRoute() (+4 more)

### Community 25 - "Controllers & Ingestion Tests"
Cohesion: 0.21
Nodes (8): createSimulationController(), createTrafficController(), historyHandler(), parseHistoryQuery(), assert, express, startApp(), test

### Community 26 - "Traffic State Store"
Cohesion: 0.22
Nodes (4): clone(), EventEmitter, TrafficStateService, trafficStateService

### Community 27 - "Socket Integration Tests"
Cohesion: 0.18
Nodes (7): createSimulationService(), assert, config, http, INTERSECTIONS, startServer(), test

### Community 28 - "Geocoding & Nav Config"
Cohesion: 0.21
Nodes (8): NAV_CONFIG, createGeocoder(), request(), GeocodeError, parseNominatim(), Nominatim Destination Search, OSRM Routing Provider, Traffic-Adjusted Routes Endpoint (planned)

### Community 29 - "Nav Traffic Store"
Cohesion: 0.26
Nodes (11): isValidLatLng(), parseBackendHazards(), parseOverpass(), createTrafficStore(), apply(), applyMeta(), entry(), view() (+3 more)

### Community 30 - "Simulation Tests"
Cohesion: 0.24
Nodes (7): assert, config, INTERSECTIONS, seeded(), setup(), test, createTrafficStateService()

### Community 32 - "MongoDB Connection"
Cohesion: 0.44
Nodes (8): attachListeners(), attempt(), connectDatabase(), mongoose, prepareCollections(), safeMessage(), state, where()

### Community 33 - "Geo Utilities"
Cohesion: 0.43
Nodes (4): distanceMeters(), distanceToPolylineMeters(), rad(), matchRouteToTraffic()

### Community 34 - "Historical Data Model"
Cohesion: 0.50
Nodes (3): Historical Data (MongoDB), signalEvents Collection, trafficRecords Time-Series Collection

### Community 35 - "Navigation Icon"
Cohesion: 1.00
Nodes (3): Navigation App Icon (icon.svg), Navigation Arrow Pointer, Traffic Light Glyph (green signal active)

## Knowledge Gaps
- **6 isolated node(s):** `Perception System (Python / YOLO)`, `View Tabs (Operations / Live AI)`, `Event Stream Log`, `Three.js Import Map (local vendor)`, `Nominatim Destination Search` (+1 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 242 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Signal Operations Dashboard Page` connect `Dashboard App Boot` to `Architecture Concepts (README)`, `3D Vehicle Models`, `Dashboard Rendering`?**
  _High betweenness centrality (0.182) - this node is a cross-community bridge._
- **Are the 8 inferred relationships involving `boot()` (e.g. with `clearDestination()` and `onHazardState()`) actually correct?**
  _`boot()` has 8 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Perception System (Python / YOLO)`, `View Tabs (Operations / Live AI)`, `Event Stream Log` to the rest of the system?**
  _6 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Nav Map & Formatting` be split into smaller, more focused modules?**
  _Cohesion score 0.059395801331285206 - nodes in this community are weakly interconnected._
- **Why does `Driver Navigation Module (README)` connect `Dashboard App Boot` to `Decision & Socket Tests`, `Geocoding & Nav Config`, `Navigation App Controller`?**
  _High betweenness centrality (0.150) - this node is a cross-community bridge._
- **Should `Dashboard App Boot` be split into smaller, more focused modules?**
  _Cohesion score 0.06753246753246753 - nodes in this community are weakly interconnected._
- **Why does `three` connect `3D Intersection Geometry` to `Backend Package Deps`, `3D Traffic Lights`, `3D Vehicle Models`?**
  _High betweenness centrality (0.139) - this node is a cross-community bridge._