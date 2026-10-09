# Roboflow emergency priority integration

The existing YOLO models, ByteTrack IDs, stopped-vehicle counts/scores, adaptive
road selection, and AI/AUTO reliability fallback are coordinated by `app/pipeline.py`.
`yooFinalMaybe.py` remains the desktop launcher; `main.py` starts AI and Flask together.
See [README](README.md) and [current handoff](docs/HANDOFF.md) for the current layout.
The workflow observations below were recorded on 2026-10-08, not reverified by the Flask refactor.
Roboflow supplies a separate temporary priority request. The ordinary controller
continues evaluating traffic during that request and resumes its current AI or
fixed AUTO policy afterward. Emergency observations never add to YOLO counts.

## Verified workflow and actual response

Workspace: `nooc-5o5-gmail-com`. Workflow: `emergency-car-1-workflow`.

On 2026-10-08, `workflows_run` initially failed because the saved model ID was
`project-jd6as/emergency-car-xxgus/1`. Roboflow's version metadata identified
`emergency-car-xxgus/1` as the deployed model. After testing the corrected
definition and receiving approval, the saved workflow was repaired and
`workflows_run` was successfully repeated.

The test used [Welsh ambulance (front)](https://commons.wikimedia.org/wiki/File:Welsh_ambulance_(front).jpg)
by Macaddct1984, licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
It was resized to 640 x 960 and JPEG-encoded at quality 85. The original image URL
returned HTTP 403 to Roboflow, so the successful call supplied base64 image data.
The image itself is not bundled with this project.

`tests/fixtures/roboflow_workflows_run.json` is the actual successful MCP tool
payload, including the unrounded confidence, bounding box, and detection ID:

```json
[
  {
    "predictions": {
      "image": {"width": 640, "height": 960},
      "predictions": [
        {
          "width": 504.0,
          "height": 643.0,
          "x": 273.0,
          "y": 615.5,
          "confidence": 0.8519337177276611,
          "class_id": 0,
          "class": "emergency-car",
          "detection_id": "b1c6007f-91dc-439f-9da5-38dca944c185",
          "parent_id": "image"
        }
      ]
    }
  }
]
```

MCP wraps this in `structuredContent.result`. The serverless HTTP response uses
an `outputs` envelope; that envelope was also observed in the corrected
`workflow_specs_run` test. The inner output is the same in both cases.
`tests/fixtures/roboflow_workflow_spec.json` records the corrected definition.

The response has only the class `emergency-car`, not separate ambulance, police,
or fire-truck labels. `(x, y)` is the box center in sampled-image pixels. The
example corners are `(21, 294)` and `(525, 937)`. The parser normalizes those
corners before drawing on each 640 x 480 display panel. Missing/malformed output
is treated as a service failure, not as a successful empty scene.

## How it operates

The existing `videos` and `names` arrays, in `config/config.py`, define direction by camera:

| Index | Direction |
| --- | --- |
| 0 | NORTH |
| 1 | SOUTH |
| 2 | WEST |
| 3 | EAST |

This assumes each feed represents its assigned approach. It does not infer a
vehicle's travel direction from a bounding box; a camera showing several
approaches would need separately configured regions of interest.

`RoboflowSampler` copies an unannotated OpenCV frame at most once every two
seconds per camera. Four daemon workers encode JPEGs and call the saved workflow
over HTTPS. Each road has at most one active request, one pending frame, and one
pending result. New frames replace queued older frames. Network requests never
run in the video-processing loop. At this interval, the upper limit is roughly
120 workflow requests per minute across all four cameras; increase the interval
in `EmergencySettings` if needed.

`EmergencyPriority` runs only on the main thread:

- Only `emergency-car` predictions with confidence >= 0.60 count.
- Three consecutive distinct positive samples from the same road confirm
  priority. A negative, failed, expired, or skipped result resets confirmation.
- Results older than six seconds are rejected, using capture time rather than
  arrival time. Requests use a four-second socket timeout. Evidence expiry also
  protects against a worker stuck longer than that timeout.
- The selected direction stays stable while valid; simultaneous requests are
  resolved by earliest confirmation, with camera order breaking ties.
- A conflicting green completes at least its existing four-second minimum,
  then two seconds of yellow and one second of all red before priority green.
  A request arriving during yellow/all red cannot skip those phases.
- A priority request for the current green extends that green. Priority green
  lasts at most 20 seconds, then that road has a 10-second cooldown and must
  confirm again using new samples.
- Six seconds without a positive sample releases priority. A service error
  releases that road's evidence immediately. Leaving emergency green still
  respects minimum green, yellow, and all-red clearance.
- Normal green selection and durations are unchanged. All transitions now use
  the one-second all-red clearance, including ordinary AI/AUTO transitions.

The overlay displays `RF: HITS 1/3`, `RF: PRIORITY`, `CLEAR`, `STALE`, `COOLDOWN`,
or `UNAVAILABLE`. Blue/orange boxes labeled `RF SAMPLE` are the latest sampled
boxes; they are not current-frame tracks. The original `MODE: AI/AUTO` label
continues showing the underlying controller mode.

These timings implement the requested simulation. The one-image test establishes
the response contract, not detection accuracy on all four traffic feeds. The
model recognizes vehicle appearance; this test does not establish active siren
or flashing-light detection.

## Setup and launch

Current installation, paths, environment precedence, Flask endpoints, website
examples and Git review commands are documented in [README](README.md).
Use the existing environment without changing its working Torch/CUDA installation:

```powershell
.\.venv\Scripts\python.exe main.py
# Or desktop-only:
.\.venv\Scripts\python.exe yooFinalMaybe.py
```

Private configuration may remain in `config/.env`; root `.env` overrides file
values, and nonempty process variables take precedence. Do not overwrite either
private file. A placeholder API key disables sampling. The default model path is
`AI-models/yolo26n.pt`. The active defaults are the four user-selected MP4s in
`config/config.py`, in NORTH/SOUTH/WEST/EAST order. Both launchers share this list;
explicit `VIDEO_*` variables can override individual inputs.

The emergency parser/sampler/policy remains in `emergency/emergency_priority.py`
and is unchanged by the Flask integration. Controller and detector modules from
an earlier refactor remain available for reference, but the active loop is in
`app/pipeline.py`. Model initialization is explicit, never triggered by API reads.

## Verification

```powershell
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe scripts/smoke_runtime.py
# Optional external probe; sends one local frame to your configured workflow:
.\.venv\Scripts\python.exe scripts/check_inputs.py --live --roboflow
```

The current results and limitations are in [docs/HANDOFF.md](docs/HANDOFF.md).
Mocked emergency/parser/worker tests and the actual offline GPU/Flask smoke pass.
The live Roboflow probe timed out and all four bounded YouTube probes failed;
this run does not establish live authorization or accuracy. Full strict lint/type
checking still has findings. The earlier `audit/REPORT.md` is historical.

For manual integration testing, select local clips in the four configured slots,
including one emergency-vehicle clip long enough for repeated samples and signal
clearance. Confirm ordinary counts continue during priority, failure/timeout
releases evidence, and normal control resumes through yellow/all red. Remove a
process key override and use the example placeholder to test disabled sampling
without changing your private stored key. Offline tests do not establish live
scene accuracy or visible GUI behavior.
