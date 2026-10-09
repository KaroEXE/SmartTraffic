# Smart Traffic AI

A Python traffic-intersection research/demo using four video inputs, Ultralytics
YOLO/ByteTrack, stopped-vehicle scoring, adaptive signal selection, fixed-cycle
fallback, and optional Roboflow emergency-vehicle priority. Flask exposes the
existing annotated output and measurements for an existing website or Express backend.

The project explores adapting green time to confirmed waiting traffic while
falling back to a fixed sequence when vision is uncertain or no stopped queue exists.
It does not include physical traffic-light hardware control.

Start with [installation](#installation-windows-powershell), then
[run commands](#run). Website developers can use the
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
        Flask /video/* and /api/* -> browser or existing Express
```

The AI loop and Flask run in **one process**, with HTTP in a background thread.
There is one latest pending display batch and one latest JPEG per direction.
Each accepted frame is encoded once for all viewers. Slow clients skip old frames.
Changing display FPS/quality does not change inference frequency or resolution.

The active loop remains together in `app/pipeline.py` to preserve its coupled
tracking/controller behavior. It retains `yolo26n.pt`, CUDA device 0, `imgsz=640`,
`conf=0.25`, persistent `bytetrack.yaml`, and inference every second frame.
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
main.py                        # Combined Flask + AI launcher
run.ps1                        # Launcher that explicitly selects the project .venv
yooFinalMaybe.py                # Backwards-compatible desktop-only launcher
.env.example, .gitignore
requirements*.txt, pyproject.toml
```

No dataset directory or frontend source was supplied. Historical source copies
are explained in [legacy/README.md](legacy/README.md); the `controller/` and
`detection/` experiments remain because their regression tests still use them.

## Installation (Windows PowerShell)

The supplied dependency pins match the existing **Python 3.14, Windows x64,
PyTorch 2.11.0+cu128** environment. An NVIDIA GPU compatible with that environment
is required by the unchanged `device=0` inference configuration. Other Python/OS
combinations and CPU execution have not been validated. No environment packages
were upgraded or reinstalled by this refactor; Flask 3.1.3 was already installed.

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

Keep the **same** model weight at `AI-models/yolo26n.pt`, or explicitly set
`MODEL_PATH` to your copy of that file. The existing checkout has this 5.54 MB
weight locally; it is excluded from the next commit. Distribute that exact weight
separately if appropriate (for example, a release asset with its license and checksum).
Never substitute another model automatically; startup fails if the path is missing.
Other weights and training outputs are not used by the active loop.
The exact required checksum and acquisition instructions are in
[AI-models/README.md](AI-models/README.md).

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

Choose one launcher. Do **not** run both simultaneously, start `flask run`, use
the Flask debug reloader, or launch multiple WSGI workers: they would not share
these ordinary in-process buffers. Imports and `create_app(shared)` do not start
cameras/models. No separate Flask process is needed.

`q` closes the desktop loop. In combined mode, EOF, a failed camera read, `q`, or
an inference error stops the AI loop and leaves HTTP running for diagnostics.
Press Ctrl+C to shut down the combined process. As in the original program,
one failed/ended input stops all four inputs; there is no automatic reconnect.
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
| GET | `/api/health` | 200 when all streams/data are ready; otherwise 503 |

No control-changing API exists. Streams return 503 with `Retry-After: 2` before
the first annotated frame, on expiry, or after shutdown; unknown directions give
404. Existing streams close when no longer available. The browser should retry
when `/api/cameras` reports availability. All responses disable caching.

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
  `signal`, `measured_at`, `frames_read`, `emergency_status`, and
  `emergency_detections` with normalized sampled `xyxy` coordinates.
- Counts are **current measurement counts**, not cumulative throughput. The
  priority score does not imply eligibility: AI road selection still considers
  only directions with stopped traffic.
- `controller` exposes `started`, `mode` (AI/AUTO), `effective_mode` (also
  EMERGENCY when a target exists), `phase`, `selected_direction`,
  `active_green_direction` (null during yellow/all-red), `remaining_seconds`,
  `timer_is_estimate`, `fallback_active`, `good_ai_updates`, `bad_ai_updates`.
  AUTO includes startup/no-queue operation, not only degraded vision. The timer
  is a snapshot; emergency expiry or preemption can end green before its estimate.
- `emergency` exposes `enabled`, `active`, `direction`. `warnings` contains
  actual camera reliability warnings. Roboflow uncertainty appears in each
  direction's emergency status. `schema_version` is 1.

Check locally:

```powershell
Invoke-RestMethod http://127.0.0.1:5000/api/health
Invoke-RestMethod http://127.0.0.1:5000/api/cameras
Invoke-RestMethod http://127.0.0.1:5000/api/traffic | ConvertTo-Json -Depth 8
```

Open any `/video/...` URL in a browser to view that feed.

## Connect your existing website / Express

No existing frontend or Express source was available to edit. Integration is
manual in your dashboard's existing video elements and data-loading code.
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
your remote AI host. For deployment, put access controls/TLS at your existing
backend/proxy and keep Flask private. CORS is not authentication.
The included Werkzeug server is for local integration; follow
[Flask deployment guidance](https://flask.palletsprojects.com/en/stable/deploying/)
before hosting it. A production process/IPC design is a separate change.

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

The smoke command runs actual CUDA inference on four local files, checks all
HTTP streams with six simultaneous viewers and live JSON updates, and releases
resources. It explicitly disables Roboflow for that test. It writes local
evidence under ignored `.local/smoke/`. Optional network probes:

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

- One failed input/EOF stops the complete loop, preserving current behavior.
  Reconnect/independent camera failure operation needs explicit policy design.
- Video-time motion estimation uses frame counts and reported FPS, even for live
  sources. Existing low-FPS/reused-ID issues in the active loop are documented,
  not silently fixed using the different historical detector.
- No ROI, manual API, cumulative traffic totals, accuracy benchmark, or hardware
  signal actuation is implemented. Adding these changes requires separate testing.
- No automatic CPU/device fallback or inference-performance tuning was introduced.
- Native capture/HTTP operations have their existing blocking characteristics;
  display buffering alone does not solve input latency or inference bottlenecks.
- Validate real-world scene accuracy, long-running stability, synchronized live
  sources, deployment security, and model/asset licensing before broader use.
