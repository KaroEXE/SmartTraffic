# Smart Traffic AI

A Python traffic-intersection research/demo using four video inputs, Ultralytics
YOLO/ByteTrack, stopped-vehicle scoring, adaptive signal selection, fixed-cycle
fallback, and optional Roboflow emergency-vehicle priority. Flask exposes the
existing annotated output and measurements, and a background publisher sends
each new measurement to the SmartTraffic Node.js backend (`POST /api/traffic`).

The project explores adapting green time to confirmed waiting traffic while
falling back to a fixed sequence when vision is uncertain or no stopped queue exists.
It does not include physical traffic-light hardware control.

Start with [installation](#installation-windows-powershell), then
[run commands](#run). For Render, the backend contract and the production server,
see [Render deployment and backend integration](docs/RENDER_DEPLOYMENT.md).
Website developers can use the
[dashboard example](examples/dashboard.html) and [Express proxy](examples/express-proxy.cjs).
Before publishing, follow the [repository review](docs/GITHUB_READINESS.md).

**This is a research/demo implementation, not an authorized public-road traffic
controller. Real infrastructure requires appropriate validation and safety engineering.**

## Architecture and preserved behavior

```text
Four sources (NORTH, SOUTH, WEST, EAST)
                 |
        One original processing loop
        Four independent YOLO/ByteTrack states
        Stopped counts + AI/AUTO controller + emergency policy
                 |
        Final annotated display frames + read-only snapshot
                 |
        SharedState (thread synchronization, bounded storage)
                 |
        JPEG worker (8 FPS, quality 70 by default)
                 |
        Flask /video/* and /api/* -> browser
                 |
        Backend publisher -> Node.js POST /api/traffic -> decision engine -> Socket.IO
```

The AI loop and Flask run in **one process**, with HTTP in a background thread.
There is one latest pending display batch and one latest JPEG per direction.
Each accepted frame is encoded once for all viewers. Slow clients skip old frames.
Changing display FPS/quality does not change inference frequency or resolution.

The active loop remains together in `app/pipeline.py` to preserve its coupled
tracking/controller behavior. It retains `yolo26n.pt`, `imgsz=640`, `conf=0.25`,
persistent `bytetrack.yaml`, and inference every second frame. The device comes
from `YOLO_DEVICE` (default `auto`: CUDA device 0 when PyTorch reports CUDA,
otherwise CPU). The device in use is logged and shown in `/api/health`.
Trusted vehicle threshold is 0.35; reliability uses mean confidence 0.40 and track
ratio 0.60. Green time is 4–12 seconds, fixed AUTO green 7 seconds, yellow 2 seconds,
all-red clearance 1 second. Emergency settings remain in the original policy module.

There is no active ROI filtering, manual mode, cumulative crossing counter, or
independent density percentage calculation. The API exposes the actual stopped
score rather than inventing these features. Older detector/controller modules
are preserved for reference and their tests; they are not silently substituted
for the active loop. See [audit and handoff](docs/HANDOFF.md).

## Source layout

```text
app/
  pipeline.py                  # Original active loop, explicit run/cleanup
  services/
    shared_state.py             # Bounded frames, JPEG worker, synchronized data
    snapshot.py                 # Read-only projection of actual loop values
    backend_publisher.py        # POSTs measured observations to the Node.js backend
    runtime.py                  # TrafficService: one supervised pipeline + publisher
    diagnostics.py              # Error text with URL credentials/tokens removed
flaskk/
  app.py                       # Factory; never starts inference
  routes.py                    # Read-only JSON/video routes and exact-origin CORS
  video_stream.py               # MJPEG framing of shared JPEG bytes
  config.py                    # HTTP/display settings
config/config.py               # Root-relative paths and private environment loading
emergency/emergency_priority.py # Existing Roboflow sampler and emergency policy
video_work/video_io.py          # Portable source opening; older grid helper retained
controller/, detection/        # Preserved earlier modular implementation
legacy/                       # Clearly labeled historical copies; not active imports
AI-models/                     # Required active weight; no binary modifications
AIModels/, videos/, runs/      # Existing local model/media/experiment assets
tests/                         # Original regression fixtures plus Flask tests
scripts/                       # Real runtime/input probes and read-only Git review
examples/                      # Standalone HTML and Express integration examples
docs/HANDOFF.md                 # Changes, validation evidence, remaining issues
docs/RENDER_DEPLOYMENT.md       # Render settings, backend contract, verification
main.py                        # Combined Flask + AI launcher (local, Werkzeug)
wsgi.py, gunicorn.conf.py      # Production entry point: gunicorn, one worker
run.ps1                        # Launcher that explicitly selects the project .venv
yooFinalMaybe.py                # Backwards-compatible desktop-only launcher
.env.example, .gitignore
requirements*.txt, pyproject.toml  # requirements-render.txt: Linux/CPU server set
```

No dataset directory or frontend source was supplied. Historical source copies
are explained in [legacy/README.md](legacy/README.md); the `controller/` and
`detection/` experiments remain because their regression tests still use them.

## Installation (Windows PowerShell)

The supplied dependency pins match the existing **Python 3.14, Windows x64,
PyTorch 2.11.0+cu128** environment, which uses the NVIDIA GPU through
`YOLO_DEVICE=auto`. `requirements-render.txt` holds the same versions for Linux
servers with CPU-only PyTorch, headless OpenCV and gunicorn. That set and the
test suite were also run on Python 3.12 (CPU).

If using the existing environment:

```powershell
.\.venv\Scripts\Activate.ps1
python -m pip check
```

For a **new** checkout/environment, from the repository root:

```powershell
py -3.14 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-lock.txt
```

The manifest includes the official CUDA 12.8 wheel index and preserves current
Torch/torchvision versions. Review GPU support before installing on another
computer. Do not upgrade or replace an existing working CUDA environment just
to add Flask. Direct dependencies are in `requirements.txt`; the existing
`requirements-lock.txt` includes transitive pins. Dev manifests add lint/type tools.
Roboflow HTTP uses Python's standard library, so no Roboflow SDK is required.

## Configuration and model setup

Both root `.env` and the existing `config/.env` are supported. Precedence is:
nonempty process environment, then root `.env`, then `config/.env`. Values are read
on startup; restart after changing configuration. Interpolation is disabled.
The existing private file is never overwritten by application startup.

For a new checkout only:

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
```

If already using `config/.env`, you can keep it and add the desired web/video
settings there. Copying the root example would override its Roboflow key with a
disabled placeholder until you explicitly configure the root key.

| Variable | Default / meaning |
| --- | --- |
| `FLASK_HOST`, `FLASK_PORT` | `127.0.0.1`, `5000` |
| `ALLOWED_ORIGINS` | Empty by default; exact comma-separated origins without trailing `/` |
| `DISPLAY_FPS`, `JPEG_QUALITY` | `8`, `70`; only display encoding |
| `FRAME_STALE_SECONDS` | `10`; expire stale web frames/data |
| `MODEL_PATH` | `AI-models/yolo26n.pt`, relative to repository root |
| `VIDEO_NORTH/SOUTH/WEST/EAST` | Empty values use the four selected MP4s in `config/config.py` |
| `ROBOFLOW_API_KEY` | Optional private key; blank/placeholder disables sampling |
| `ROBOFLOW_WORKSPACE`, `ROBOFLOW_WORKFLOW_ID` | Existing workflow defaults; configure your own workflow when sharing |
| `ROBOFLOW_API_URL`, `ROBOFLOW_TIMEOUT` | Existing serverless base URL and 4-second timeout |
| `YOLO_DEVICE` | `auto` (CUDA device 0 if available, else CPU); or `cpu`, `0`, `cuda:0`. An explicit CUDA request fails if CUDA is missing |
| `MAX_STREAM_CLIENTS` | `8` simultaneous `/video/*` viewers; extra viewers get 503 |
| `BACKEND_URL` | Empty disables publishing; for example `http://127.0.0.1:3000` |
| `INTERSECTION_ID` | `main`; an id from the backend's `config/intersections.js` |
| `TRAFFIC_INGEST_TOKEN` | Empty by default; same secret as the backend's `TRAFFIC_INGEST_TOKEN` |
| `BACKEND_PUBLISH_INTERVAL`, `BACKEND_TIMEOUT` | `1` and `5` seconds |
| `PIPELINE_RESTART_SECONDS`, `LOG_LEVEL` | Production server (`wsgi.py`) only: `10` (0 disables), `INFO` |

Keep the **same** model weight at `AI-models/yolo26n.pt`, or explicitly set
`MODEL_PATH` to your copy of that file. The existing checkout has this 5.54 MB
weight locally; it is excluded from the next commit. Distribute that exact weight
separately if appropriate (for example, a release asset with its license and checksum).
Never substitute another model automatically; startup fails if the path is missing.
Other weights and training outputs are not used by the active loop.
The exact required checksum and acquisition instructions are in
[AI-models/README.md](AI-models/README.md). If the file is missing,
`python scripts/fetch_model.py` downloads Ultralytics' official release asset and
keeps it only if its SHA-256 matches that checksum; an existing different file
is never replaced. The Render build runs the same command.

Video paths also resolve from the repository root. Examples:

```dotenv
VIDEO_NORTH=videos/1car8mins.mp4
VIDEO_SOUTH=videos/4cars.mp4
VIDEO_WEST=videos/5carsgood.mp4
VIDEO_EAST=videos/aFewMoreCars.mp4
```

These files already exist in this workspace; a new checkout must obtain its own
authorized input files. `camera:0` explicitly selects webcam device 0; RTSP/HTTP
URLs are accepted. Do not commit credentials embedded in camera URLs. Both launchers
read the same `videos` list in `config/config.py`; do not add another list to
`yooFinalMaybe.py`. YouTube is used only if you explicitly configure a YouTube URL.
Such URLs are resolved afresh with yt-dlp and depend on remote availability.
No replacement source is chosen automatically.

## Run

Start AI and Flask together, headless:

```powershell
python main.py
```

To always use this project's `.venv` even when `.audit-tools` is activated:

```powershell
.\run.ps1
# Or invoke the interpreter explicitly:
.\.venv\Scripts\python.exe main.py
# Show resolved source selections without starting cameras, models or HTTP:
.\.venv\Scripts\python.exe main.py --check-config
```

Startup prints all four effective inputs. Nonempty `VIDEO_*` values in your
environment still override the shared defaults. If an old server is running,
press Ctrl+C in its terminal before restarting; it retains its startup configuration.
Open `http://127.0.0.1:5000/api/health` with **HTTP**, since this local server does
not accept HTTPS. An HTTPS request produces a protocol error, not a YOLO error.

Or also display the original OpenCV grid:

```powershell
python main.py --show-window
```

The original desktop-only command still works:

```powershell
python yooFinalMaybe.py
```

Production server on Linux (Render), with exactly one worker process:

```bash
gunicorn --config gunicorn.conf.py --bind 0.0.0.0:$PORT wsgi:app
```

Choose one launcher. Do **not** run several simultaneously, start `flask run`,
use the Flask debug reloader, or run more than one WSGI worker or instance:
each would start its own cameras and models, because these buffers live in
process memory. Imports, `create_app(shared)` and `import wsgi` do not start
cameras or models. No separate Flask process is needed.

When `BACKEND_URL` is set, both launchers post each new measurement to the
backend. See the [integration contract](docs/RENDER_DEPLOYMENT.md#integration-contract).

`q` closes the desktop loop. In `main.py`, EOF, a failed camera read, `q`, or an
inference error stops the AI loop and leaves HTTP running for diagnostics.
Press Ctrl+C to shut down the combined process. One failed or ended input stops
all four inputs. The production server (`wsgi.py`) restarts the whole pipeline
after `PIPELINE_RESTART_SECONDS` instead, with growing backoff while failures
repeat, so a video file loops and a dropped stream is retried.
Native network/capture operations may delay interruption while blocked.

## HTTP API

Base URL: `http://127.0.0.1:5000`.

| Method | Endpoint | Response |
| --- | --- | --- |
| GET | `/video/north` | Annotated north MJPEG |
| GET | `/video/south` | Annotated south MJPEG |
| GET | `/video/west` | Annotated west MJPEG |
| GET | `/video/east` | Annotated east MJPEG |
| GET | `/api/traffic` | Published measurement/controller snapshot |
| GET | `/api/cameras` | Direction, status, freshness, stream URL |
| GET | `/api/health` | Readiness: 200 when all streams/data are ready; otherwise 503 |
| GET | `/api/health/live` | Liveness: always 200 while the web process answers |

No control-changing API exists. Streams return 503 with `Retry-After: 2` before
the first annotated frame, on expiry, or after shutdown, and 503 with
`Retry-After: 5` beyond `MAX_STREAM_CLIENTS` viewers. Unknown directions give
404. Existing streams close when no longer available. The browser should retry
when `/api/cameras` reports availability. All responses disable caching. Errors
are JSON `{"error": ...}`. `/api/health` also reports `stream_clients` and
`components`: inference device, pipeline supervisor restarts and last exit,
and backend publisher state and last error. It never includes tokens.

`/api/traffic` returns `{available, pipeline_status, age_seconds, data}`.
`data` is null before the first complete loop update. Historical data is retained
for diagnostics after shutdown, with `available: false`; do not display it as live.
Unix timestamps are seconds since the UTC epoch. No input URLs or API keys are returned.

Within `data`:

- `directions.north` (also `south`, `west`, `east`) exposes `detected_vehicles`
  (all vehicle-class candidates in the latest measurement), `trusted_vehicles`
  (confidence >=0.35), `tracked_vehicles` (trusted detections with IDs),
  `stopped_vehicles` (confirmed stopped only), `stopped_score` (existing weighted
  waiting score), `priority_score` (stopped score + waiting cycles * 1.5),
  `wait_cycles`, `reliable`, `vision_status`, `average_confidence`, `tracking_ratio`,
  `signal`, `measured_at`, `frames_read`, `emergency_status`,
  `emergency_detections` with normalized sampled `xyxy` coordinates, and
  `mean_wait_seconds` / `max_wait_seconds`: how long the currently STOPPED
  vehicles have waited, in video seconds (0 when none are stopped).
- Counts are **current measurement counts**, not cumulative throughput. The
  priority score does not imply eligibility: AI road selection still considers
  only directions with stopped traffic.
- `controller` exposes `started`, `mode` (AI/AUTO), `effective_mode` (also
  EMERGENCY when a target exists), `phase`, `selected_direction`,
  `active_green_direction` (null during yellow/all-red), `remaining_seconds`,
  `timer_is_estimate`, `fallback_active`, `good_ai_updates`, `bad_ai_updates`.
  AUTO includes startup/no-queue operation, not only degraded vision. The timer
  is a snapshot; emergency expiry or preemption can end green before its estimate.
- `emergency` exposes `enabled`, `active`, `direction`, and `confidence` (the
  latest positive sample's confidence on the confirmed road, else null).
  `warnings` contains actual camera reliability warnings. Roboflow uncertainty
  appears in each direction's emergency status. `schema_version` is 1.

Check locally:

```powershell
Invoke-RestMethod http://127.0.0.1:5000/api/health
Invoke-RestMethod http://127.0.0.1:5000/api/cameras
Invoke-RestMethod http://127.0.0.1:5000/api/traffic | ConvertTo-Json -Depth 8
```

Open any `/video/...` URL in a browser to view that feed.

## Connect your existing website / Express

Structured data reaches the SmartTraffic backend through the publisher (set
`BACKEND_URL`). The backend's decision engine and Socket.IO then drive the
dashboard. The contract is in
[docs/RENDER_DEPLOYMENT.md](docs/RENDER_DEPLOYMENT.md#integration-contract).
Video is not sent to the backend: browsers load `/video/<direction>` from this
service directly. The frontend's Live AI view has a `connectLiveVideo(url)`
hook for that. It is not wired up yet; the frontend was left unchanged.
The complete working bindings are in [examples/dashboard.html](examples/dashboard.html).
They discover stream URLs, retry unavailable feeds, and hide stale measurements.

Minimal direct connection:

```html
<img src="http://127.0.0.1:5000/video/north" alt="North">
<img src="http://127.0.0.1:5000/video/south" alt="South">
<img src="http://127.0.0.1:5000/video/west" alt="West">
<img src="http://127.0.0.1:5000/video/east" alt="East">
<script>
async function readTraffic() {
  const response = await fetch('http://127.0.0.1:5000/api/traffic');
  const state = await response.json();
  if (!state.available || !state.data) return; // Show an unavailable state.
  const northStopped = state.data.directions.north.stopped_vehicles;
  const green = state.data.controller.active_green_direction;
  // Bind northStopped and green to your EXISTING dashboard elements/state.
  console.log({ northStopped, green });
}
readTraffic();
</script>
```

For direct browser JSON requests, put your exact frontend origin in
`ALLOWED_ORIGINS` (e.g. `http://localhost:3000`). `localhost` and `127.0.0.1` are
different origins. Do not use wildcard origins or expose private keys. Test the
standalone example with `python -m http.server 3000 --bind 127.0.0.1 --directory examples`
in another terminal, then open `http://127.0.0.1:3000/dashboard.html`.

For Express, mount [examples/express-proxy.cjs](examples/express-proxy.cjs) at
`/ai` in your existing server, before compression/static/catch-all middleware.
Use `BASE = '/ai'` in the example page. Express forwards requests to Flask on
loopback; it streams MJPEG without buffering. Same-origin browser requests then
need no Flask CORS grants. Your server can also fetch
`http://127.0.0.1:5000/api/traffic` directly. The proxy has not been exercised
inside your unavailable Express project.

An HTTPS website needs an HTTPS/same-origin proxy; browsers can block HTTP mixed
content. `127.0.0.1` in browser JavaScript means the **viewer's** computer, not
your remote AI host. CORS is not authentication. The Werkzeug server in
`main.py` is for local use. For hosting, use `wsgi.py` with `gunicorn.conf.py`
(one worker process, threads), as described in
[docs/RENDER_DEPLOYMENT.md](docs/RENDER_DEPLOYMENT.md).

## Testing and repository review

```powershell
python -m unittest discover -s tests -v
python -m pip check
python scripts/smoke_runtime.py
python scripts/check_inputs.py
python scripts/check_inputs.py --configured
python scripts/review_repository.py
```

The repository review exits `0` when its hygiene checks pass, `1` for credential
findings, and `2` when tracked ignored files or large/binary candidates need review.
It never stages, removes, or publishes files. Passing it does not replace manual
review of your staged changes or a decision about the project's license.

The smoke command runs actual inference on four local files, using the
`YOLO_DEVICE` it reports (CUDA when available). It checks all HTTP streams with
six simultaneous viewers and live JSON updates, and releases resources. It
explicitly disables Roboflow for that test. It writes local evidence under
ignored `.local/smoke/`. The unit tests cover backend publication against a
local HTTP server, the service lifecycle, the WSGI import and the gunicorn
hooks, without cameras, GPU or network. Optional network probes:

```powershell
python scripts/check_inputs.py --live --roboflow
```

The Roboflow probe sends one local video frame to your configured workflow.
See [handoff](docs/HANDOFF.md) for executed results and limitations. Regression
tests compare exact pre-refactor controller/history/model-call/annotated-image
hashes, including with publication enabled. No performance improvement or accuracy
claim is inferred from these tests.

## GitHub preparation

Review source, tests, documentation, examples, and safe configuration. `.gitignore`
excludes private `.env` files, credentials/certificates, environments, caches,
logs, local evidence, videos, datasets, weights, and experiments. Existing private
`config/.env` is ignored. With user approval, `AI-models/yolo26n.pt` and the 19 old
`audit/` files were removed from the Git index; all remain on disk. Only those
removals are staged. Source changes and new files still need review and staging.
No commit, remote creation, push, or publication was performed.

Untracking does not erase history. The model remains in the earlier
commit unless you separately decide to change history. That small weight does not
need Git LFS for file size alone; LFS or a release asset may be useful if you later
distribute larger licensed models. Document the exact file/checksum either way.
Do not publish datasets or footage without appropriate distribution rights.

Manual review and publication commands:

```powershell
git status --short
git ls-files
git status --ignored --short
git check-ignore config/.env .local/smoke/result.json videos/3Cars3.mp4
python scripts/review_repository.py
git diff --check
git diff
# Only after reviewing the candidate files and tracked-asset decision:
git add -- .
git diff --cached --stat
git diff --cached
git commit -m "Integrate read-only Flask traffic streams and APIs"
# Create an empty repository yourself, then set its URL if no origin exists:
git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-REPOSITORY.git
git push -u origin HEAD
```

If `origin` already exists, inspect it locally and use the intended existing
remote. A secret discovered in a past commit needs rotation and a separately
reviewed history-remediation plan; adding ignore rules does not erase it.

## Known limitations / future work

- One failed input or EOF stops the complete loop. The production server then
  restarts all four inputs together. Dropping a single camera and continuing
  with three is not supported: the backend needs all four approaches, and the
  missing one would have to be invented.
- Video-time motion estimation uses frame counts and reported FPS, even for live
  sources. Two issues in the active loop are fixed, matching the tested
  historical detector, with the recorded baselines unchanged. Stationary vehicles
  are now counted when measurements are more than 0.6 s apart (sources below
  about 3.3 FPS). A track ID that returns after the 2 s forget window no longer
  inherits its old waiting time.
- No ROI, manual API, cumulative traffic totals, accuracy benchmark, or hardware
  signal actuation is implemented. Adding these changes requires separate testing.
  Without an ROI, vehicles parked in view count as stopped and add waiting time.
- `yolo26n.pt` is the stock 80-class COCO detector. It has `person` but no
  emergency classes; the `police car` vehicle weight never matches. Emergency
  vehicles come only from the optional Roboflow workflow, whose single class
  cannot tell ambulance, police and fire apart: the backend receives the generic
  type `emergency`. Pedestrians are not measured (no crosswalk regions), so none
  are reported to the backend.
- Accuracy depends on the camera view. In local tests the COCO model missed
  vehicles in strict top-down footage.
- Native capture/HTTP operations have their existing blocking characteristics;
  display buffering alone does not solve input latency or inference bottlenecks.
- Validate real-world scene accuracy, long-running stability, synchronized live
  sources, deployment security, and model/asset licensing before broader use.
