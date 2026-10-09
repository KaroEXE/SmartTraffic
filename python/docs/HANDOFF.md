# Refactor and Flask handoff — 2026-10-09

For the latest publication status and the subsequently approved Git-index cleanup,
see [GitHub readiness](GITHUB_READINESS.md). The audit below records the initial
refactor state; its original tracked-file and test counts are historical.

**Follow-up source fix:** the user selected MP4s in a separate restored desktop
script, while Flask still read YouTube defaults from shared configuration. The
selection has now been consolidated in `config/config.py`, and both launchers use
the same pipeline. See [source-selection fix](SOURCE_FIX.md). Historical YouTube
probe results below describe the earlier configuration, not the current MP4 inputs.

## 1. Baseline and audit

The workspace started clean at Git commit `6c121b5`. No commit, staging, reset,
remote operation, or publication was performed. That existing commit is the
recoverable source checkpoint; no secret-bearing backup or duplicate dataset
was created. Original private `config/.env`, media, weights and training outputs
remain in place. The active model is byte-identical to its committed baseline.

The active application was the 1,547-line `yooFinalMaybe.py`, with eager camera
and model initialization at import. It overrides configuration with four YouTube
sources in NORTH/SOUTH/WEST/EAST order. Each has its own persistent tracker. The
single loop performs detection every other frame, evaluates motion history,
counts only stopped vehicles for signal decisions, and draws the four-camera grid.

| Original Python source | Purpose / status |
| --- | --- |
| `yooFinalMaybe.py` | Active monolithic application; moved as described below |
| `config/config.py` | Asset paths, environment loading, constants; some video defaults differed from active main |
| `emergency/emergency_priority.py` | Active background sampler, response parser, bounded emergency policy |
| `controller/traffic_controller.py` | Earlier separate state/controller implementation; not used by active main |
| `detection/vehicle_detection.py` | Earlier detector with different low-FPS/expired-ID behavior; not used by active main |
| `video_work/video_io.py` | Earlier capture/grid helpers; capture opening is now reused |
| `vehicle detection/vehicle_detection.py` | Historical detector variant; preserved |
| `VideoWork/video_io.py` | Historical video helper variant; preserved |
| Package `__init__.py` files | Package markers, no runtime initialization |
| `tests/refactor_support.py` | Deterministic full-loop mock-camera/model harness and image/state hashes |
| `tests/test_refactor.py` | Full-loop, import, path, configuration and ignore-rule tests |
| `tests/test_main_lifecycle.py` | Camera/model/sampler failure cleanup tests; stale entry-point assumptions repaired |
| `tests/test_vehicle_detection.py` | Earlier experimental detector's motion tests; explicitly supplies its required timestamp state |
| `tests/test_emergency_priority.py` | Parser, emergency policy, controller and background-worker tests |

Dependencies: OpenCV, NumPy, Ultralytics, Torch/torchvision, ByteTrack's `lap`,
yt-dlp, python-dotenv, and now explicitly recorded Flask. Roboflow uses stdlib
HTTP, not its SDK. No frontend/Express code, Flask app, ROI filter, active manual
mode, cumulative throughput counter, or independent density percentage was found.

Assets: 18 local MP4 files (two over 1 GB), alternative YOLO weights under
`AIModels/`, active `AI-models/yolo26n.pt`, and experiment outputs under `runs/`.
No standalone dataset folder was found. Virtual environments and `.audit-tools/`
contain third-party source and were excluded from application-source refactoring.

## 2. Final structure and changes

The complete tree and responsibilities are in [README](../README.md#source-layout).

| Change | Files |
| --- | --- |
| Moved active logic, kept backward launcher | `yooFinalMaybe.py` -> `app/pipeline.py`; new launcher at original path |
| Added read-only publication | `app/services/shared_state.py`, `app/services/snapshot.py`, package markers |
| Added Flask layer | `flaskk/app.py`, `routes.py`, `video_stream.py`, `config.py`, package marker |
| Added combined launcher | `main.py` |
| Fixed configuration/path integration | `config/config.py`, `video_work/video_io.py` |
| Added/updated repository/setup documentation | `.gitignore`, `.env.example`, `README.md`, `ROBOFLOW_INTEGRATION.md`, this report |
| Extended existing dependency system | `requirements.txt`, `requirements-lock.txt`; Torch/CUDA pins unchanged |
| Updated source list | `pyproject.toml` |
| Repaired stale test imports/mock targets and lifecycle harness | Existing test files and `refactor_support.py` |
| Added verification | `tests/test_flask.py`, `tests/fixtures/active_baseline.json`, publication-equivalence test |
| Added runnable probes | `scripts/smoke_runtime.py`, `check_inputs.py`, `review_repository.py` |
| Added standalone integration examples | `examples/dashboard.html`, `examples/express-proxy.cjs` |

No other existing source or asset was moved. Keeping the distinct historical
implementations visible avoids accidentally replacing the active algorithm.
`audit/REPORT.md` describes an earlier state and is not evidence for this refactor.

## 3. Behavior preservation and explicit integration fixes

Detection options, classes/weights, motion windows, stopped scoring, track expiry,
confidence thresholds, inference cadence, camera order, AI/AUTO transition logic,
green/yellow/all-red timing, and emergency policy are preserved. The emergency
module is byte-identical to the baseline. Four pre-edit scenario results matched
the existing fixtures before any code move. After the move, both desktop and
publisher-enabled runs match the same state/history/image/stdout/model-call hashes.
Each scenario observes 96 display iterations and 48 inference calls per camera.

Explicit changes beyond organization:

1. Initialization is now explicit; imports cannot open cameras or load models.
2. `try/finally` releases opened cameras/sampler on partial startup, exceptions,
   stop, and EOF. The original successful-path behavior remains unchanged.
3. Environment lookup now reads root `.env` and the existing `config/.env`.
   The previous `config/config/.env` path and lookup of `../config/.env` as an
   environment-variable name prevented normal Roboflow key loading. Correcting
   this can **enable Roboflow when a real existing key is configured**. No key was
   changed or printed. A placeholder disables it intentionally.
4. Config defaults now reflect the actual active main's four YouTube sources.
   Explicit environment overrides support local files/URLs/`camera:N`.
5. Model and local video paths are repository-root-relative. Missing model paths
   fail explicitly rather than letting an alternate model/download be selected.
6. Web snapshots and an optional headless mode were added. Counts are observed
   from existing detection variables and do not feed new values into decisions.
7. Camera-open errors no longer include the raw source URL in their message.

The tested equivalent outputs apply to identical configured inputs and mocked
timing. They are not an accuracy guarantee or a claim that live wall-clock timing
is unaffected by any added CPU work. No performance benchmark was claimed.

## 4. Flask and website integration

Run `python main.py`: the original loop owns four models and all traffic state;
Flask runs in the same process. One bounded JPEG worker consumes final display
frames and publishes immutable bytes. HTTP routes only read published data/bytes.
Multiple viewers never create models/captures or repeat encoding.

- `http://127.0.0.1:5000/video/north`
- `http://127.0.0.1:5000/video/south`
- `http://127.0.0.1:5000/video/west`
- `http://127.0.0.1:5000/video/east`
- `http://127.0.0.1:5000/api/traffic`
- `http://127.0.0.1:5000/api/cameras`
- `http://127.0.0.1:5000/api/health`

For exact JSON field definitions, complete HTML/JavaScript, Express mounting,
virtual-environment setup and PowerShell commands, see
[README](../README.md), [dashboard example](../examples/dashboard.html), and
[Express proxy](../examples/express-proxy.cjs). No frontend layout was edited.
Only exact configured CORS origins are granted; all API routes are read-only.
Debugging/reloading are not enabled. This local server is not a public deployment.

## 5. Tests performed

### Passed

- **49 unittest tests** after adding publication-enabled baseline comparisons.
  They cover current baseline state/pixel/model-call equivalence, tracking and
  direction isolation, fallback, emergency preemption/clearance/recovery, sampler
  errors, resource cleanup, configuration precedence, imports from another CWD,
  and Git ignore rules. Experimental detector tests remain clearly separate from
  the active-loop baseline checks.
- Flask factory/startup, all four MJPEG endpoints, decodable JPEG content,
  NumPy JSON serialization, live snapshot access, health/readiness, unknown
  directions, read-only methods, exact-origin CORS, unavailable/stale frames,
  disconnects, six viewers sharing encodings, bounded slow-encoder storage,
  wakeup/shutdown. Slow viewers never hold the producer lock while writing sockets.
- **Actual CUDA smoke:** four real model instances, four distinct trackers with
  at least two processed measurements each; four 640x480 annotated streams and six
  concurrent real HTTP viewers; live traffic JSON updates and clean resource release.
  Roboflow explicitly disabled only for this offline smoke.
- All **18 local MP4 files** decoded a first frame. This is not a full-video integrity test.
- One delivered JPEG inspected visually, showing original scene and annotations.
- Runtime dependency consistency: `pip check` reported no broken requirements.
- Syntax scan across candidate Python sources; focused Ruff correctness/import
  checks (`E4,E7,E9,F,I`); `node --check examples/express-proxy.cjs`; `git diff --check`.
- Active model bytes match Git baseline; SHA256:
  `9b09cc8bf347f0fc8a5f7657480587f25db09b34bf33b0652110fb03a8ad4fef`.
- Read-only candidate/history scan: no configured-secret matches or common
  credential-pattern matches. Private `.env` is ignored. This is a heuristic
  check, not proof that arbitrary secrets cannot exist.

Local GPU/HTTP evidence and sample JPEGs are under ignored `.local/smoke/`.
Initial temporary-directory tests hit Windows sandbox permission errors; the
approved rerun passed. No test assertion was removed to hide that environment error.

### Failed / unresolved checks

- All four bounded live YouTube probes returned `DownloadError`, including the
  approved retry outside the network sandbox. Their live availability is not
  established. Defaults were preserved; no substitute stream was selected.
- The real Roboflow request failed with `URLError` in the sandbox and timed out
  on the approved retry. Its normal 4-second timeout and workflow were preserved.
  Mocked parsing/policy/error handling passes; remote authorization/detection was
  not established by this run.
- Full strict Ruff and mypy checks are not clean. Broad exception guards are
  intentional at worker/probe boundaries; existing test-style findings and
  missing/narrowing annotations in the original loop/emergency/video code remain.
  Focused correctness lint passes. Type-check success is not claimed.

### Not executed / not applicable

- Visible GUI interaction (offscreen rendering hashes were tested), physical
  webcams, production hosting/TLS, actual team Express/frontend integration,
  long-duration stability, scene accuracy and comparative performance benchmarks.
- Fresh environment install: this run validated the existing environment and
  recorded existing Flask dependency versions without changing Torch/CUDA.
- ROI/manual-control/cumulative counting tests: these are not active features.

## 6. GitHub contents and security

The proposed repository contains Python source, tests/fixtures, safe example
configuration, requirements, documentation and standalone integration examples.
Private configuration, environments, caches, video files, weights, local runtime
evidence, datasets and training outputs are covered by ignore rules.

`AI-models/yolo26n.pt` and 19 old `audit/` files are **already tracked**, so they
remain Git candidates until you make the documented index-only removal decision.
No tracked private `.env` was found. No rotation need was established by the
configured-secret/history scan; if another credential is discovered, rotate it.
History was neither rewritten nor erased. The original commit still contains
the model and old audit material even if a later commit stops tracking them.

The model is 5,544,453 bytes. LFS is optional for this small file; consider release
assets or LFS for larger model distribution and check applicable licensing. The
README includes the manual review, index-only removal, commit and push commands.
Do not publish before reviewing that asset decision and the staged diff.

## 7. Remaining issues retained deliberately

- The active loop's low-FPS motion history can remain NEW when observations are
  farther apart than its 0.60-second window. A different historical detector
  contains a fix; activating it would change the user's current behavior.
- Reused IDs refresh `last_seen` before expired-track cleanup in the active loop;
  a historical variant handles expiry differently. Left unchanged.
- Infinite camera FPS is not rejected by the active `math.isnan` check. The
  integration preserves that existing behavior; NaN/low FPS still falls back to 30.
- Emergency parser accepts Python booleans as numeric values in some fields.
  Not changed as part of this integration.
- Current input failure policy exits all four feeds. MJPEG and health report
  unavailability rather than serving a frozen image indefinitely. No reconnect.
- Capture resolution/decoding and four sequential GPU model calls remain primary
  potential bottlenecks. JPEG work is separated but no inference settings changed.
- The older modular detector expects timestamp state absent from the older
  `TrafficState` initializer. Its test harness supplies that input explicitly;
  those components are not the active application and were not silently repaired.

## 8. Beginner-friendly next steps

1. Activate `.venv`. Keep your existing `config/.env`; set four `VIDEO_*` paths
   to the tested local files if the live services are unavailable. Leave model
   settings unchanged. Configure your exact dashboard origin for direct fetches.
2. Run `python main.py`; wait until `/api/health` returns 200. Open the four video
   URLs. No separate Flask process is necessary.
3. In the existing website, bind `<img>` elements to stream URLs and use
   `state.data.directions.<direction>` / `state.data.controller` from the traffic
   endpoint. Always respect `state.available`. Use the supplied retrying example.
4. Have the Express teammate mount the supplied `/ai` proxy if same-origin
   integration is preferred. Test it in their actual application before deployment.
5. Run the regression suite and repository-review script. Review tracked model
   and audit files, inspect staged changes yourself, then manually commit/push.

No application process from testing is intended to remain running after handoff.
