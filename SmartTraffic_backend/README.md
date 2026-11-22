# Smart Traffic AI

Adaptive traffic-signal management prototype: a Node.js decision engine, a live
operations dashboard, a 3D digital twin of each intersection (Three.js), and a
network map (MapLibre + OpenFreeMap), a driver navigation page and an admin console.

> **Prototype.** This system is not certified or safe for controlling real
> traffic signals. Production readiness has not been established; the database
> integration and deployment configuration still need to be verified.

The dashboard has two strictly separated data modes:

```
LIVE TRAFFIC                                        SIMULATION
Perception (Python / YOLO - teammate)               in-process simulator (started from the dashboard)
   │  POST /api/traffic  (JSON contract below)         │  no HTTP ingestion
   ▼                                                   ▼
live state + live decision engine                   simulation state + simulation decision engine
   │  Socket.IO room "live"                            │  Socket.IO room "simulation"
   │  MongoDB records dataMode "live"                  │  MongoDB records dataMode "simulation"
   └──────────────►  Dashboard: [Live traffic | Simulation]  ◄──────────────┘
```

The two channels share no state. Simulated observations cannot reach live
state, live signal decisions or emergency preemption, and the live view never
depends on the simulator.

---

## Quick start

Requirements: Node.js 18+ (uses built-in `fetch`). Internet access is only needed
for the OpenFreeMap map tiles (no key) and for routing (set `GEOAPIFY_API_KEY`, see [backend/docs/SETUP_GUIDE.md](backend/docs/SETUP_GUIDE.md)). Place search and reverse geocoding need `DATABASE_URL` (your own PostgreSQL/PostGIS database, see [backend/docs/GEO_DATABASE.md](backend/docs/GEO_DATABASE.md)); Three.js and MapLibre GL JS are served locally.
see [backend/docs/SETUP_GUIDE.md](backend/docs/SETUP_GUIDE.md)); Three.js and MapLibre GL JS are served locally.

```bash
cd backend
npm install
npm start                      # http://localhost:3000
```

Open **http://localhost:3000**. The dashboard opens in **Live traffic** mode.
Until the perception system posts data, every intersection shows
`AI DATA WAITING` and runs a fixed-time plan. To see generated traffic, switch
to **Simulation** in the top bar and press **Start**. No second process is needed.

| Command (in `backend/`) | Purpose |
|---|---|
| `npm start` | API + Socket.IO + dashboard (live and simulation) |
| `npm run dev` | same, restarts on file changes |
| `npm test` | all backend tests (plus the dashboard mode logic) |

Copy `backend/.env.example` to `backend/.env` and set `MONGODB_URI` to record
traffic history (see *Historical data*). Weights and timings are optional
variables listed under *Configuration*.

---

## Demo flow (judges)

Switch the top bar to **Simulation**. Everything shown in this mode is marked
in amber as *simulated*. The **Simulation** panel (bottom right) has Start /
Pause / Reset, and its scenario buttons apply to the selected intersection.

| Step | Action | What to point at |
|---|---|---|
| 1 | Open the dashboard, choose **Simulation**, press **Start** | Map, 3D intersection, status, all updating; "SIMULATED DATA" badge |
| 2 | Click a traffic-light marker on the map | Header, 3D scene, stats, events all switch to that intersection |
| 3 | **Normal traffic** | Vehicles queue on red, flow on green; reason text explains each choice |
| 4 | **Heavy East** | East score climbs → `EAST has the highest traffic demand` → EAST → GREEN |
| 5 | **Pedestrians South** | People wait at the kerb, then `PEDESTRIAN` mode: all approaches red, WALK, clearance |
| 6 | **Ambulance North** | 72% detection logged and ignored (below 80%), then confirmed → `EMERGENCY`, NORTH preempted to green and held (`HOLD`), ambulance drives through |
| 7 | **Emergency cleared** (or wait until it has passed) | Back to `NORMAL` adaptive mode |

Also try **Long wait West** (waiting-time weight and the fairness guard) and
**Police East**. Ticking **Auto tour** loops a scripted sequence on its own.
**Pause** freezes the simulation, including its countdown and 3D traffic.
**Reset** discards all simulated state. Switching back to **Live traffic** at
any point shows live data untouched by the simulation.

---

## Swagger API documentation

Open **http://localhost:3000/api/docs/** after starting the backend. Swagger UI
documents every REST endpoint with request schemas, response schemas, errors,
and examples. Use **Try it out** to send requests directly to the running backend.
For the Python/YOLO integration, expand **POST /api/traffic** and use the normal
traffic or ambulance example. Replace intersectionId with a configured ID.
The examples omit timestamp so repeated requests use the server receive time.

The OpenAPI 3.0 document is available at **/api/openapi.json**, suitable for import
into Postman or an API client generator. Swagger assets are served locally.
No authentication is currently required. Simulation controls affect only the
isolated simulator; traffic ingestion affects live state. History endpoints
require MongoDB. Socket.IO events remain documented below.

Maintain the REST contract in backend/docs/openapi.js when changing routes or
validation. waitingTime is the canonical input field; waiting is a legacy alias.
Vehicle and queue counts currently accept numbers, including fractional values,
as implemented by the validator.

---

## API contract (for the perception system)

The perception system only needs to send one HTTP request per intersection
per frame window (about 1 Hz is plenty). It does not need to know anything
about Socket.IO, Three.js, MapLibre or the UI.

### `POST /api/traffic`

```json
{
  "intersectionId": "main",
  "timestamp": "2026-10-07T12:00:00Z",
  "traffic": {
    "north": { "vehicles": 12, "waiting": 8,  "queueLength": 10 },
    "south": { "vehicles": 4,  "waiting": 15, "queueLength": 4 },
    "east":  { "vehicles": 20, "waiting": 5,  "queueLength": 16 },
    "west":  { "vehicles": 2,  "waiting": 20, "queueLength": 3 }
  },
  "pedestrians": { "north": false, "south": true, "east": false, "west": false },
  "emergency": { "detected": false, "type": null, "direction": null, "confidence": 0 }
}
```

| Field | Rules |
|---|---|
| `intersectionId` | Required. Must match an id in `backend/config/intersections.js`. |
| `timestamp` | Optional ISO-8601 string (capture time). |
| `traffic.<dir>` | Required for all four directions. `vehicles` and `queueLength` are integers 0–1000 (vehicles visible on the approach / vehicles stopped in the queue). `waiting` is the average wait in seconds, 0–3600. |
| `pedestrians.<dir>` | Optional booleans. `true` = people waiting to cross the crosswalk on that leg. Missing directions default to `false`. |
| `emergency` | Optional. When `detected` is `true`, `type` must be `ambulance`, `police` or `fire_truck` (`fire`/`firetruck` are accepted), `direction` one of the four directions, `confidence` 0–1. |
| `source` | Optional producer tag, e.g. a camera name. The values `"mock"` and `"simulation"` are **reserved for simulated data and rejected with HTTP 422**, so simulated data can never enter live state. The partner's schema is otherwise unchanged. |

Detections may flicker from frame to frame. A pedestrian request or an
emergency is only withdrawn after it has been absent from the data for
`PERCEPTION_HOLD_TIME` seconds (default 3). A single missed frame therefore
does not restart a request or an emergency.

Run **one** producer per intersection. Two producers posting different
observations for the same intersection make every update contradict the
previous one.

Directions refer to the **approach**: `north` = vehicles coming from the north.

Example:

```bash
curl -X POST http://localhost:3000/api/traffic \
  -H "Content-Type: application/json" \
  -d @payload.json
```

Responses:

| Status | Body |
|---|---|
| `200` | `{ ok: true, intersectionId, decision: { mode, phase, greenDirection, signals, remaining, reason }, scores }` |
| `400` | `{ ok: false, error, details: [ "traffic.north.vehicles must be an integer", ... ] }` |
| `404` | `{ ok: false, error, knownIntersections: [...] }` |
| `422` | `{ ok: false, error, hint }`: `source` is `"mock"` / `"simulation"` (simulated data is not accepted here) |

Keep sending data while an emergency vehicle is visible; send
`"detected": false` once it has passed. If no data arrives for `DATA_TIMEOUT`
seconds the backend treats the feed as lost (see *Fallback*).

### Read endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/health` | Status, uptime, number of connected perception feeds |
| `GET /api/intersections` | Id, name, coordinates and summary state for every intersection |
| `GET /api/traffic/state` | Full snapshot for every intersection |
| `GET /api/traffic/state/:intersectionId` | Full snapshot plus recent event history |
| `GET /api/history/traffic` | Stored observations, newest first (see *Historical data*) |
| `GET /api/history/signals` | Stored signal phase changes, newest first |

Simulation endpoints (`/api/simulation/...`) are listed under *Simulation mode*.

### Socket.IO events (server → browser)

Live and simulated data travel in separate rooms. Every client starts in the
`live` room, so clients that don't know about simulation keep working. A
client switches rooms by sending `subscribe` with `{ mode: "live" | "simulation" }`,
and the server answers with a fresh `init`. Every payload carries
`intersectionId` and `dataMode` (`"live"` or `"simulation"`).

| Event | Payload | When |
|---|---|---|
| `init` | `{ dataMode, intersections: Snapshot[], serverTime, simulation? }` | On connect and after `subscribe` |
| `trafficUpdate` | `Snapshot` | After each accepted observation of that room's channel |
| `signalUpdate` | `Snapshot` | Whenever phase, plan, mode or reason changes |
| `systemEvent` | `{ id, dataMode, intersectionId, time, category, message, level }` | Activity log entry |
| `simulationStatus` | `{ state, scenarios, intersections, error }` | Simulation room only: Start / Pause / Reset / scenario changed |
| `simulationReset` | `{ dataMode, intersections: Snapshot[] }` | Simulation room only: all simulated state discarded |
| `subscribeError` | `{ error }` | Unknown mode requested |

A `Snapshot` includes `dataMode`, `mode`, `phase`, `greenDirection`, `nextDirection`,
`signals` (`RED`/`YELLOW`/`GREEN` per direction), `pedestrianSignals`
(`DONT_WALK`/`WALK`/`CLEARANCE`), `remaining`, `phaseDuration`, `reason`,
`traffic`, `scores`, `redSeconds`, `emergency`, `aiStatus`
(`WAITING`/`CONNECTED`/`STALE`) and `lastUpdate`.

---

## Decision engine

`backend/services/trafficDecisionService.js` runs one state machine per
intersection, ticking every 250 ms. The browser never decides signal state.

```
GREEN(dir) → YELLOW(dir) → ALL_RED → GREEN(next) | PED_WALK → PED_CLEAR → GREEN(next)
```

Only one approach is green at a time, so straight-through movements never
conflict.

**Priority score** (weights configurable):

```
priorityScore = vehicles × 2 + waiting × 3 + queueLength × 2
```

Rules, in order of precedence while a direction is green:

1. **Emergency** (confidence ≥ `EMERGENCY_CONFIDENCE_THRESHOLD`, 0.80): the
   emergency approach is served immediately via yellow and all-red, even if the
   current green has not reached its minimum. That green is then held until the
   emergency is cleared. A safety cap (`EMERGENCY_MAX_HOLD_TIME`) stops a stuck
   detection from holding the junction forever. Detections below the threshold
   are logged and ignored; an emergency that is already confirmed is not
   dropped because of one weak frame.
2. **Fallback**: with no perception data, a fixed-time rotation N → E → S → W
   (`FALLBACK_GREEN_TIME`).
3. **Minimum green** (`MIN_GREEN_TIME`, 10 s) is always honoured otherwise.
4. **Pedestrians**: a request is served when the current green's plan ends, or
   after `PEDESTRIAN_MAX_WAIT` at the latest. The pedestrian phase is exclusive:
   every vehicle approach is red, WALK for `MIN_PEDESTRIAN_CROSSING_TIME`
   (10 s), then `PEDESTRIAN_CLEARANCE_TIME` (3 s). An emergency shortens WALK
   but never skips clearance. Requests are ignored for `PEDESTRIAN_COOLDOWN`
   seconds after a crossing so the same people do not re-trigger it.
5. **Fairness**: an approach with demand that has been red for `MAX_RED_TIME`
   (90 s) is served next, regardless of score.
6. **Adaptive**: when the planned green ends, the highest-scoring other
   approach wins. Planned green = `MIN_GREEN_TIME + queueLength ×
   SECONDS_PER_QUEUED_VEHICLE`, capped at `MAX_GREEN_TIME` (45 s). If the
   current approach still clearly leads (by more than 25%) the green is
   extended in 5 s steps up to the maximum. An approach that empties hands
   over early. With no competing demand the green rests where it is.

Every transition includes `YELLOW_TIME` (3 s) and `ALL_RED_TIME` (1 s).
Each decision records a human-readable `reason`, shown in the dashboard and
event stream.

---

## Frontend

Served by the backend from `frontend/`. Plain HTML/CSS/ES modules, no build step.

| File | Responsibility |
|---|---|
| `app.js` | Socket.IO, state store, intersection selection |
| `dashboard.js` | Decision, approach statistics, signal heads, emergency, system status, event stream |
| `map.js`, `mapCore.js`, `mapConfig.js` | MapLibre + OpenFreeMap (one map per page, created once), traffic-light markers (only intersections with a surveyed position), click to select |
| `simControls.js` | Scenario panel of the Simulation tab |
| `admin.html`, `admin.js`, `admin.css` | Admin console: system status, driver reports, road features, places, users, map (sign in with `NAV_ADMIN_TOKEN`) |
| `navigation.html`, `navigation/` | Driver navigation page (see [frontend/navigation/README.md](frontend/navigation/README.md)) |
| `three/scene.js` | Renderer, camera/orbit controls, lighting, frame loop, projected approach labels |
| `three/intersection.js` | Roads, markings, sidewalks, street lights, seeded buildings/trees, shared layout helpers |
| `three/trafficLights.js` | Signal heads, pedestrian heads and stop-line state bars, driven by backend state |
| `three/vehicles.js` | Vehicle queues and flow, emergency vehicles |
| `three/pedestrians.js` | People waiting at and crossing the crosswalks |

**Selecting an intersection** (map marker, list, or `#id` in the URL) sets
`selectedId`. The cached snapshot renders immediately, then
`GET /api/traffic/state/:id` loads the full state and event history. The
dashboard, 3D scene and event stream all follow the same id. Map markers keep
updating for every intersection.

**3D traffic** is a visualization, not a physics simulation. Visible vehicles
per approach follow `traffic.<dir>.vehicles` (scaled and capped at 14). Vehicles:

- stop for red, and for yellow when they can stop comfortably
- never enter the junction while cross traffic is inside it
- never drive into a crosswalk with people on it
- keep a minimum gap to the vehicle ahead

Camera: drag to orbit, scroll to zoom, right-drag to pan, **Reset view** to
return. There is no automatic camera motion.

### Intersection coordinates

Edit `backend/config/intersections.js`. Each entry needs `id`, `name`, `lat`
and `lng`. The map, list and API pick the changes up on restart. The `id` is
what the perception system sends as `intersectionId`.

---

## Simulation mode

`backend/services/simulationService.js` generates traffic inside the backend.
It uses a queue model: queues discharge on green
and build on red. The simulator owns its **own** decision engine and
observation store, created with `dataMode: "simulation"`, and shares no
object with the live channel.

- It creates no timers until **Start**. A failure inside it only sets its
  state to `error`; live traffic keeps running.
- It has no HTTP ingestion route. Each generated observation goes through the
  same validation → store → engine path as a real one, but only into the
  simulation channel, tagged `source: "simulation"`.
- **Pause** freezes the simulation clock: phases, countdowns and generated
  traffic resume where they stopped. **Reset** discards all simulated state.
- Scenarios: Normal traffic, Heavy East, Heavy North, Long wait West,
  Pedestrians South, Ambulance North, Police East, Emergency cleared, plus Auto
  tour.

| Endpoint | Purpose |
|---|---|
| `GET /api/simulation/status` | `{ state: stopped/running/paused/error, scenarios, intersections }` |
| `POST /api/simulation/start` · `/pause` · `/reset` | Control; returns the new status |
| `POST /api/simulation/scenario` | `{ intersectionId, scenario }` |
| `POST /api/simulation/tour` | `{ intersectionId, enabled }` |
| `GET /api/simulation/traffic/state[/:intersectionId]`, `GET /api/simulation/intersections` | Simulated state (read-only) |

Simulated data is never accepted by the live endpoint (`source` `"mock"` / `"simulation"` is
refused with HTTP 422). In production (`NODE_ENV=production`) the simulation write endpoints
answer 403; the simulation can still be watched.

---

## Configuration

Set in `backend/.env` (never committed). `.env.example` lists the variables a
deployment needs; everything else is optional with the defaults below.

| Variable | Default | Meaning |
|---|---|---|
| `MONGODB_URI` | - | MongoDB connection string incl. database name, e.g. `mongodb://127.0.0.1:27017/smart-traffic`. Unset = history not recorded |
| `PORT` | 3000 | HTTP / Socket.IO port (hosting platforms set this) |
| `AI_STREAM_URL` | - | Python/Flask camera stream for the Live AI page, e.g. `http://<flask-host>:5000/video_feed`. Sent to browsers (no credentials). Unset = "not connected" |
| `CORS_ORIGIN` | `*` | Allowed origin(s) |
| `WEIGHT_VEHICLES` / `WEIGHT_WAITING` / `WEIGHT_QUEUE` | 2 / 3 / 2 | Priority score weights |
| `MIN_GREEN_TIME` / `MAX_GREEN_TIME` | 10 / 45 | Green bounds (s) |
| `YELLOW_TIME` / `ALL_RED_TIME` | 3 / 1 | Transition intervals (s) |
| `SECONDS_PER_QUEUED_VEHICLE` | 2 | Planned green per queued vehicle |
| `MAX_RED_TIME` | 90 | Fairness guard (s) |
| `MIN_PEDESTRIAN_CROSSING_TIME` / `PEDESTRIAN_CLEARANCE_TIME` | 10 / 3 | Pedestrian phase (s) |
| `PEDESTRIAN_MAX_WAIT` / `PEDESTRIAN_COOLDOWN` | 15 / 20 | Pedestrian request handling (s) |
| `EMERGENCY_CONFIDENCE_THRESHOLD` | 0.80 | Minimum confidence to act on |
| `EMERGENCY_MAX_HOLD_TIME` | 90 | Emergency hold cap (s) |
| `PERCEPTION_HOLD_TIME` | 3 | Detection flicker tolerance before a pedestrian request / emergency is dropped (s) |
| `DATA_TIMEOUT` / `FALLBACK_GREEN_TIME` | 10 / 20 | Lost-feed detection and fixed-time plan (s) |

---

## Historical data (MongoDB)

Every accepted observation and every signal phase change is appended to
MongoDB, so a dataset builds up over time for later analysis and model
training. Nothing is overwritten or expired.

| Collection | One document per | Contents |
|---|---|---|
| `trafficRecords` (time-series) | accepted observation (live or simulated) | `dataMode`, `intersectionId`, `timestamp` (capture time, else receive time), `receivedAt`, `source`, `traffic.<dir>` {vehicles, queueLength, waitingTime}, `pedestrians.<dir>` (bool), `emergency` {detected, type, direction, confidence}, `signal` {mode, phase, signals, pedestrianSignals} in effect when it arrived |
| `signalEvents` | phase change while data is flowing | `dataMode`, `intersectionId`, `timestamp`, `mode`, `phase`, `previousPhase`, `signals`, `pedestrianSignals`, `changes` [{direction, kind, from, to}], `reason`, `plannedDuration`, `previousPhaseDuration` |

**Live vs simulated records.** `dataMode` is `"live"` or `"simulation"`. It is
set by the server (one history recorder per channel) and never taken from a
request. Every query must go through `modeFilter()` in
`backend/models/constants.js`:

- **Live:** `dataMode != "simulation"` and `source` not `"mock"` / `"simulation"`.
  Rows written before `dataMode` existed count as live unless their `source`
  says they were simulated.
- **Simulation:** the exact complement. Old `source: "mock"` rows count as simulated.

`GET /api/history/traffic` and `GET /api/history/signals` apply this filter
for you:

| Parameter | Default | |
|---|---|---|
| `mode` | `live` | `live` or `simulation`, never both |
| `intersectionId` | all | |
| `from`, `to` | open | ISO-8601 dates (inclusive) |
| `limit` | 100 | 1-1000, newest first |

Responses: `200 { ok, mode, count, records }`, `400` for invalid parameters,
`503` when no database is configured or it is not connected.

Indexes: `{intersectionId, timestamp}` on both (one intersection over a time
range) and `{timestamp}` on `trafficRecords` (all intersections over a time
range).

The database is not required for signal control. If `MONGODB_URI` is unset or
MongoDB is unreachable the backend still runs, logs it, retries every 15 s and
reports `database.status` in `GET /api/health`. Records that arrive while
it is unavailable are not saved, and the health endpoint counts them in
`notSaved`.

Export for analysis, e.g. live data for one intersection (same filter as `modeFilter("live")`):

```bash
mongoexport --uri "$MONGODB_URI" --collection trafficRecords \
  --query '{"intersectionId":"main","dataMode":{"$ne":"simulation"},"source":{"$nin":["mock","simulation"]}}' \
  --out main-live.json
```

---

## Project structure

```
├── README.md
├── backend/
│   ├── server.js                      Express + static frontend + Socket.IO
│   ├── .env.example
│   ├── config/
│   │   ├── index.js                   env-driven settings
│   │   ├── database.js                the MongoDB connection
│   │   └── intersections.js           ids, names, coordinates
│   ├── models/                        TrafficRecord, SignalEvent, constants (modeFilter)
│   ├── controllers/                   trafficController (live + history), simulationController
│   ├── routes/trafficRoutes.js        /api (live) and /api/simulation
│   ├── services/                      decision engine, traffic state, history recorder, simulator
│   ├── socket/trafficSocket.js        rooms "live" / "simulation"
│   ├── utils/validation.js
│   └── test/                          (tests also live next to the files they cover)
├── frontend/
│   ├── index.html · style.css · app.js · dashboard.js · map.js · simControls.js
│   ├── modeStore.js                   per-mode client state (Live traffic / Simulation)
│   └── three/ scene.js · intersection.js · trafficLights.js · vehicles.js · pedestrians.js
```

Dependencies: `express`, `socket.io`, `cors`, `dotenv`, `mongoose`, plus `three` and
`maplibre-gl`. The last two are installed with the backend only so the server can
serve them locally to the browser.

## Tests

```bash
cd backend && npm test
```

The tests cover:

- validation errors
- the fixed-time start
- score-based selection
- no two approaches ever non-red at the same time
- minimum and maximum green
- emergency preemption and hold
- rejection of low-confidence detections
- the exclusive pedestrian phase
- the fairness guard
- stale-data fallback
- ingestion over real HTTP, including rejection of simulated sources on `POST /api/traffic`
- history recording, `dataMode` stamping and mode-filtered history queries (with a fake model)
- simulation start / pause / reset, and isolation from a live "twin" engine
- Socket.IO room isolation over a real server: live clients never receive
  simulated events and vice versa, and switching modes moves the client
- dashboard mode switching (`frontend/modeStore.js`, imported from a test;
  needs Node 22.7 or newer)

None of the tests needs MongoDB. Writing to and reading from a real database
has not been tested.
