"""Deterministic full-loop regression harness (no cameras, GPU, or HTTP)."""

import contextlib
import hashlib
import inspect
import io
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np

import config.config as project_config
import emergency.emergency_priority as emergency_priority

ROOT = Path(__file__).resolve().parents[1]


def run_demo(source_path, scenario, publisher=None):
    clock = [0.0]
    snapshots, displays, cameras, models = [], [], [], []
    detections = emergency_priority.parse_workflow_response(json.loads(
        (ROOT / "tests/fixtures/roboflow_workflows_run.json").read_text()))

    class Coordinates:
        def __init__(self, values):
            self.values = values

        def cpu(self):
            return self

        def tolist(self):
            return self.values

    class Camera:
        def __init__(self, source, *args):
            self.road = len(cameras)
            self.open = True
            self.frames = 0
            cameras.append(self)

        def isOpened(self):
            return self.open

        def get(self, prop):
            return 10.0

        def read(self):
            self.frames += 1
            return True, np.full((240, 320, 3), self.road * 20, dtype=np.uint8)

        def release(self):
            self.open = False

    class Model:
        names = {0: "car", 1: "truck", 2: "motorcycle", 3: "bus", 4: "person"}

        def __init__(self, path):
            self.road = len(models)
            self.calls = 0
            self.options = []
            self.weight = Path(path).name
            models.append(self)

        def track(self, frame, **options):
            self.calls += 1
            self.options.append(options)
            boxes = []
            phase = (self.calls // (24 if scenario == "adaptive" else 8)) % 6
            if scenario != "empty" and phase != 4:
                confidence = .30 if phase == 2 else (.38 if phase == 3 else .90)
                ident = None if phase == 5 else [7]
                x = 10 + self.road * 5
                if self.road == 1:
                    x += (self.calls % 8) * 10
                boxes.append(SimpleNamespace(cls=[self.road], conf=[confidence], id=ident,
                                              xyxy=[Coordinates([x, 40, x+50, 100])]))
                boxes.append(SimpleNamespace(cls=[4], conf=[.99], id=[9],
                                              xyxy=[Coordinates([200, 20, 220, 80])]))
            return [SimpleNamespace(boxes=boxes)]

    class Downloader:
        def __init__(self, options):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def extract_info(self, source, download=False):
            return {"url": "mock-stream"}

    class Sampler:
        def __init__(self, settings):
            self.enabled = scenario == "emergency"
            self.closed = False
            self.last_sample = -100

        def submit(self, road, frame, captured_at):
            pass

        def poll(self):
            now = clock[0]
            if not self.enabled or now - self.last_sample < 2:
                return []
            self.last_sample = now
            return [emergency_priority.InferenceResult(
                road, now, detections if road == 2 and 4 <= now <= 32 else (),
                error="TimeoutError" if road == 2 and now == 18 else "")
                for road in range(4)]

        def close(self):
            self.closed = True

    def imshow(title, frame):
        displays.append((title, list(frame.shape), hashlib.sha256(frame.tobytes()).hexdigest()))

    def wait_key(delay):
        # The original uses module globals; the refactor uses one explicit state.
        local = inspect.currentframe().f_back.f_locals
        state = vars(local["state"]) if "state" in local else local
        keys = ("frames_read", "have_measurement", "track_states", "stopped_counts",
                "stopped_scores", "camera_reliable", "camera_status", "wait_cycles",
                "good_ai_updates", "bad_ai_updates", "control_mode", "current_green",
                "light_phase", "phase_start_time", "green_duration", "controller_started")
        record = {key: state[key] for key in keys}
        record.update(frame_counter=local["frame_counter"], display=displays[-1],
                      target=local["emergency_priority"].target)
        # Snapshot now: lists and dictionaries will mutate on the next frame.
        snapshots.append(json.loads(json.dumps(record, default=list)))
        clock[0] += .5
        return ord("q") if len(snapshots) == 96 else -1

    namespace = {"__name__": "__main__" if publisher is None else "regression_import",
                 "__file__": str(source_path)}
    output = io.StringIO()
    # Baselines were recorded on a CUDA machine: YOLO_DEVICE=auto resolves to device 0.
    with patch.dict(sys.modules, {"ultralytics": SimpleNamespace(YOLO=Model),
                                  "yt_dlp": SimpleNamespace(YoutubeDL=Downloader)}), \
            patch.object(cv2, "VideoCapture", Camera), patch.object(cv2, "imshow", imshow), \
            patch.object(cv2, "waitKey", wait_key), patch.object(cv2, "destroyAllWindows"), \
            patch.object(emergency_priority, "RoboflowSampler", Sampler), \
            patch.object(project_config, "YOLO_DEVICE", "auto"), \
            patch.object(project_config, "VIDEO_SOURCE_MODE", "cameras"), \
            patch("torch.cuda.is_available", return_value=True), \
            patch("time.monotonic", side_effect=lambda: clock[0]), \
            patch("atexit.register"), contextlib.redirect_stdout(output):
        # Clear cached refactor imports so every run sees the mock YOLO constructor.
        sys.modules.pop("vehicle_detection", None)
        sys.modules.pop("video_io", None)
        sys.modules.pop("app.pipeline", None)
        sys.modules.pop("yooFinalMaybe", None)
        exec(compile(Path(source_path).read_text(), str(source_path), "exec"), namespace)
        if publisher is not None:
            namespace["main"](publisher=publisher)
    return {
        "trace_sha256": hashlib.sha256(json.dumps(snapshots, sort_keys=True).encode()).hexdigest(),
        "stdout_sha256": hashlib.sha256(output.getvalue().encode()).hexdigest(),
        "frames": [c.frames for c in cameras],
        "released": [not c.isOpened() for c in cameras],
        "models": [{"weight": m.weight, "calls": m.calls, "options": m.options[0]} for m in models],
        "phases": sorted({s["light_phase"] for s in snapshots}),
        "modes": sorted({s["control_mode"] for s in snapshots}),
        "priorities": sorted({s["target"] for s in snapshots if s["target"] is not None}),
    }
