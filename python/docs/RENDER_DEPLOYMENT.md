# Deploying the AI service on Render and connecting it to the backend

This guide covers the Python AI service (this `python/` folder) as a Render web
service, and its connection to the existing Node.js backend in
`SmartTraffic backend/backend`.

## How the pieces connect

```text
4 video sources (NORTH, SOUTH, WEST, EAST)
        |
app/pipeline.py         one loop, four YOLO/ByteTrack trackers, stopped-vehicle measurement
        |  publish_snapshot / offer_frames
app/services/shared_state.py
        |-- Flask (flaskk/)          GET /video/<direction>, /api/traffic, /api/cameras,
        |                            /api/health, /api/health/live
        |-- backend_publisher.py     POST {BACKEND_URL}/api/traffic, about once a second
                                              |
                       Node.js backend: validation -> trafficStateService
                                              -> trafficDecisionService (signal decisions)
                                              -> Socket.IO room "live": trafficUpdate / signalUpdate
                                              -> dashboard and 3D view
```

Video stays on the Python service. The backend receives only structured JSON
and never touches frames. `app/services/runtime.py` owns one pipeline thread,
the JPEG encoder and the publisher. If the pipeline fails or a source ends, it
restarts after `PIPELINE_RESTART_SECONDS`, doubling the wait up to 5 minutes
while failures repeat. The web service stays up throughout.

## Why exactly one gunicorn worker

Frames, the latest measurements and the publisher live in one process's memory.
gunicorn's usual multi-process model would start a full pipeline per worker:
four more camera connections, four more YOLO models, and a second publisher
posting competing observations for the same intersection. So
`gunicorn.conf.py` fixes `workers = 1` (ignoring `WEB_CONCURRENCY`) and gets
HTTP concurrency from threads (`gthread`). Other settings follow from that:

- `preload_app = False`. The service is built in the worker, because threads
  do not survive `fork()`.
- `max_requests = 0`. Recycling the worker would reload every model.
- MJPEG viewers are capped by `MAX_STREAM_CLIENTS` (default 8). The thread
  pool is 4 larger, so health checks and JSON requests always find a free
  thread.
- Importing `wsgi.py` builds the Flask app only. The `post_worker_init` hook
  starts the service and `worker_exit` stops it. On SIGTERM, MJPEG streams are
  closed right away so shutdown is not held open by never-ending responses.

For the same reason, keep the Render service at **one instance**. Don't enable
autoscaling. For another intersection, deploy a second service with its own
`INTERSECTION_ID` and cameras.

## Render settings

| Setting | Value |
| --- | --- |
| Service type | Web Service, runtime **Python 3** |
| Root Directory | `python` |
| Build Command | `pip install -r requirements-render.txt && python scripts/fetch_model.py` |
| Start Command | `gunicorn --config gunicorn.conf.py --bind 0.0.0.0:$PORT wsgi:app` |
| Health Check Path | `/api/health/live` |
| Instances | 1 (no autoscaling) |
| Instance type | Standard (2 GB RAM) or larger; see [Resources](#resources-and-plan) |

Why these values:

- **Build Command.** `requirements-render.txt` pins the same library versions
  as `requirements.txt`, with CPU-only PyTorch (Render has no GPU, and CUDA
  wheels are several GB) and headless OpenCV. The GUI build of OpenCV needs
  `libGL`, which Render's native runtime lacks.
- **Model download.** `scripts/fetch_model.py` downloads the exact
  `yolo26n.pt` that `AI-models/README.md` documents (5,544,453 bytes,
  SHA-256 `9b09cc8b…4fef`) and refuses any file with a different checksum. The
  file is part of the build output, so no persistent disk is needed.
- **Health check path.** Use `/api/health/live`, not `/api/health`. The
  readiness endpoint answers 503 while models load or a camera is down, and
  Render would restart a healthy web service in a loop.

## Environment variables (Python service)

Use placeholders like these; set real values only in the Render dashboard.

| Variable | Example | Notes |
| --- | --- | --- |
| `PYTHON_VERSION` | `3.12.10` | The version the tests ran on. Every pinned package has Linux wheels for it. |
| `VIDEO_NORTH`, `VIDEO_SOUTH`, `VIDEO_WEST`, `VIDEO_EAST` | `rtsp://camera.example/north` | **Required.** See [Video sources](#video-sources-on-render). |
| `BACKEND_URL` | `https://your-backend.onrender.com` | Base URL. Observations go to `/api/traffic`. |
| `INTERSECTION_ID` | `main` | Must exist in the backend's `config/intersections.js`. |
| `TRAFFIC_INGEST_TOKEN` | *(random secret)* | Same value on both services, for example from `openssl rand -hex 32`. |
| `YOLO_DEVICE` | `cpu` | `auto` also selects the CPU when there is no CUDA. |
| `PIPELINE_RESTART_SECONDS` | `10` | `0` disables automatic restarts. |
| `ALLOWED_ORIGINS` | `https://your-backend.onrender.com` | Only for browser `fetch()` of this service's JSON. `<img>` video needs no CORS. |
| `DISPLAY_FPS` | `4` | MJPEG frame rate only. Lower values save CPU. |
| `MAX_STREAM_CLIENTS` | `8` | Simultaneous `/video/*` viewers. |
| `LOG_LEVEL` | `INFO` | `DEBUG` adds pipeline failure tracebacks. |
| `ROBOFLOW_API_KEY`, `ROBOFLOW_WORKSPACE`, `ROBOFLOW_WORKFLOW_ID` | *(optional secret)* | Emergency-vehicle sampling. Without these, no emergency data is sent. |
| `OMP_NUM_THREADS` | `1` | Ultralytics' default. Raise it only on multi-CPU instance types. |

`FLASK_HOST` and `FLASK_PORT` are used only by the local launcher (`main.py`).
On Render, gunicorn binds to `0.0.0.0:$PORT`. `wsgi.py` also defaults
`YOLO_AUTOINSTALL=false` (no pip installs at runtime) and `YOLO_OFFLINE=true`
(no Ultralytics telemetry or online checks).

## Backend (Node.js) changes and settings

Two compatible backend changes were needed:

1. **Ingest token.** When `TRAFFIC_INGEST_TOKEN` is set on the backend,
   `POST /api/traffic` requires `Authorization: Bearer <token>`; otherwise it
   returns 401. Without the variable, behavior is unchanged and a startup
   warning is printed. Set it on the backend's Render service too. Without it,
   anyone who can reach the backend can post live traffic data.
2. **Generic emergency type.** The Roboflow workflow has a single class,
   `emergency-car`, so the AI cannot honestly report ambulance, police or fire
   truck. The backend now also accepts `"emergency"` (aliases `emergency_car`,
   `emergency_vehicle`). Before this change, the backend rejected the whole
   observation with HTTP 400 whenever an emergency was reported.

The backend also needs `CORS_ORIGIN` as before. Server-to-server POSTs from
Python do not use CORS.

## Integration contract

- **URL:** `POST {BACKEND_URL}/api/traffic`, from `routes/trafficRoutes.js`.
- **Headers:** `Content-Type: application/json`, and
  `Authorization: Bearer <TRAFFIC_INGEST_TOKEN>` when configured.
- **Rate:** at most once per `BACKEND_PUBLISH_INTERVAL` (1 s), and only when a
  new measurement exists for all four approaches. The backend's
  `DATA_TIMEOUT` is 10 s.

```json
{
  "intersectionId": "main",
  "timestamp": "2026-10-09T12:42:16.841Z",
  "source": "python-ai",
  "traffic": {
    "north": {"vehicles": 3, "queueLength": 2, "waitingTime": 4.5},
    "south": {"vehicles": 0, "queueLength": 0, "waitingTime": 0},
    "east":  {"vehicles": 1, "queueLength": 1, "waitingTime": 0.8},
    "west":  {"vehicles": 2, "queueLength": 0, "waitingTime": 0}
  },
  "emergency": {"detected": false, "type": null, "direction": null, "confidence": 0}
}
```

What each field means:

| Field | Meaning |
| --- | --- |
| `vehicles` | Trusted vehicle detections (confidence ≥ 0.35) in the latest measurement. |
| `queueLength` | Vehicles confirmed STOPPED. |
| `waitingTime` | Mean seconds those vehicles have been stopped, in video time, capped at the backend's 3600. |
| `timestamp` | The oldest of the four measurement times. |
| `emergency` | Present only when Roboflow sampling is enabled. `detected: true` only after the pipeline's 3-sample confirmation, with the latest positive sample's confidence. The backend acts on confidence ≥ 0.8 (`EMERGENCY_CONFIDENCE_THRESHOLD`). |

`pedestrians` is never sent: the active pipeline measures no pedestrians, and
the backend treats the missing field as no one waiting.

Backend responses:

| Response | Python publisher's reaction |
| --- | --- |
| 200 `{ok, intersectionId, stored, decision, scores}` | Success. |
| 202 | Ignored. |
| 400 / 404 / 413 / 415 / 422 | Logged with the backend's own error details; not retried for the same observation. |
| 401 | Logged with a hint to check the token. Retried every 30 s. |
| 409 | Stale: a newer observation is stored. Dropped. |
| 5xx, network errors | Exponential backoff from 1 s to 30 s, always with the newest observation. Nothing is queued. |

Redirects are never followed, so a misconfigured URL can't replay the POST or
the token elsewhere.

On success, the backend stores the observation (`GET
/api/traffic/observations/main`), runs the decision engine, and emits
`trafficUpdate`, plus `signalUpdate` when the plan changes, to the Socket.IO
room `live`.

## Video sources on Render

A Render instance has no attached camera, and `videos/` is not in Git
(`.gitignore`). Without `VIDEO_*` overrides, the service starts, `/api/health`
shows the NORTH camera as `open_failed`, and the supervisor retries with
backoff. Nothing is sent to the backend. Workable sources:

- RTSP, HTTP or HLS camera streams reachable from the public internet.
- MP4 files served over HTTPS, for example release assets or object storage.
  When a file ends, the pipeline restarts, which replays the video.
- YouTube URLs (resolved with yt-dlp). YouTube often blocks data-center IP
  addresses, so expect failures on Render.

`camera:0` (a local webcam) cannot work on Render. Keep credentials embedded
in stream URLs out of Git; status and logs strip user-info and query strings.

## Resources and plan

Measured locally on CPU (Windows, Python 3.12, `torch 2.11.0+cpu`, one
inference thread), with four 768×432 sources:

| Measurement | Result |
| --- | --- |
| Time to first full measurement | about 13 s (four model loads, four sources, first inference) |
| Throughput | about 6.8 frames/s per camera; inference on every second frame (3.4 measurements/s per camera) |
| Process memory | about 560–570 MB resident |

Render's CPUs will differ; expect slower inference on shared vCPUs. On that
basis:

- **Free and Starter** (512 MB) are too small; the service would be killed for
  memory. Free instances also sleep when idle.
- **Standard** (2 GB, 1 CPU) is the realistic minimum.
- Render offers no GPU instances. Inference here is CPU-only and nothing
  claims otherwise; `/api/health` reports `components.inference.device`.

Slower inference does not invent data. Video-time waiting is measured from
the frames actually processed, and the dashboard simply updates less often.

## Deployment checklist

1. Commit and push the changes in `python/` and `SmartTraffic backend/backend/`.
2. Backend service: add `TRAFFIC_INGEST_TOKEN` and redeploy. Check its
   `/api/health`: `ingestion.tokenRequired` must be `true`.
3. AI service: apply the settings and variables above, with the same token.
4. Deploy, and read the build log for
   `yolo26n.pt: downloaded 5544453 bytes, SHA-256 verified`.
5. Verify the live services:
   - `curl https://<ai>.onrender.com/api/health/live` returns 200 with `"alive": true`.
   - `curl https://<ai>.onrender.com/api/health` returns 200 once all four
     cameras produce fresh data. Otherwise it returns 503; check `reason`,
     `components.supervisor` and `components.backend_publisher`.
   - `curl https://<ai>.onrender.com/api/cameras` shows four `processing` cameras.
   - `curl https://<backend>.onrender.com/api/traffic/observations/main`
     shows `source: "python-ai"` with a recent `receivedAt`.
   - `curl https://<backend>.onrender.com/api/health` shows
     `aiFeeds.connected` ≥ 1.
   - The dashboard shows the intersection as connected in `NORMAL` mode,
     not `FALLBACK`.
6. Open `https://<ai>.onrender.com/video/north`. MJPEG through Render's proxy
   was not tested before deployment; if it buffers, the JSON integration is
   unaffected.

## Previous deployment errors

| Error | Cause |
| --- | --- |
| `gunicorn: command not found` | gunicorn was not in the installed requirements. It is now pinned in `requirements-render.txt`. |
| `module 'app' has no attribute 'app'` / `'server'` | `app` is this project's package (`app/__init__.py`), not a module with a Flask object. The Flask app comes from the factory `flaskk.app.create_app(shared, settings)`, which needs a `SharedState`, so no importable WSGI object existed. |
| `No module named 'render_app'` | No such file was ever committed. |

The WSGI object is now `app` in `wsgi.py`, so the target is `wsgi:app`.

## Local end-to-end run

Backend, in PowerShell:

```powershell
cd "SmartTraffic backend\backend"
npm install
$env:TRAFFIC_INGEST_TOKEN = "local-test-token"
npm start
```

This serves http://localhost:3000.

AI service, in another PowerShell window from `python/`:

```powershell
.\.venv\Scripts\python.exe scripts\fetch_model.py
$env:BACKEND_URL = "http://127.0.0.1:3000"
$env:TRAFFIC_INGEST_TOKEN = "local-test-token"
.\run.ps1
```

The startup output includes `Backend publishing: POST http://127.0.0.1:3000/api/traffic ...`.

Check the result:

```powershell
(Invoke-RestMethod http://127.0.0.1:5000/api/health).components.backend_publisher
Invoke-RestMethod http://127.0.0.1:3000/api/traffic/observations/main | ConvertTo-Json -Depth 6
```

`main.py` keeps its local behavior: Werkzeug server, optional `--show-window`,
and no automatic restart when a video ends. To run the production entry point
on Linux or WSL:
`gunicorn --config gunicorn.conf.py --bind 0.0.0.0:8000 wsgi:app`.
