"""Active-loop motion fixes and new measurements, with scripted detections.

No camera, GPU, or model weight is used: open_video, YOLO and the Roboflow
sampler are replaced, and every published snapshot is recorded.
"""

import contextlib
import copy
import io
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np

from app import pipeline


class Coordinates:
    def __init__(self, values):
        self.values = values

    def cpu(self):
        return self

    def tolist(self):
        return self.values


class Camera:
    def __init__(self, fps):
        self.fps = fps

    def get(self, prop):
        return self.fps

    def read(self):
        return True, np.zeros((120, 160, 3), dtype=np.uint8)

    def release(self):
        pass


class ScriptedModel:
    """One stationary car (track 7) on the measurements where visible(n) is true."""

    def __init__(self, visible):
        self.names = {0: "car"}
        self.visible = visible
        self.calls = 0

    def track(self, frame, **options):
        self.calls += 1
        if not self.visible(self.calls):
            return [SimpleNamespace(boxes=[])]
        box = SimpleNamespace(cls=[0], conf=[0.9], id=[7],
                              xyxy=[Coordinates([20.0, 20.0, 80.0, 60.0])])
        return [SimpleNamespace(boxes=[box])]


class Recorder:
    """Publisher that keeps every snapshot (SharedState keeps only the latest)."""

    def __init__(self):
        self.snapshots = []
        self.components = {}

    def set_lifecycle(self, status, reason=None):
        pass

    def camera_status(self, index, status):
        pass

    def camera_read(self, index):
        pass

    def offer_frames(self, frames):
        pass

    def finish_pipeline(self):
        pass

    def report_component(self, name, status):
        self.components[name] = status

    def publish_snapshot(self, snapshot):
        self.snapshots.append(copy.deepcopy(snapshot))


def run_pipeline(fps, measurements, visible=lambda n: True, device="cpu", opened=None):
    """Run the real loop; return the recorder and the snapshot after each measurement."""
    recorder = Recorder()
    with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
        model_path = Path(directory) / "model.pt"
        model_path.write_bytes(b"test")

        def open_video(source):
            if opened is not None:
                opened.append(source)
            return Camera(fps)

        stack.enter_context(mock.patch.object(pipeline, "MODEL_PATH", model_path))
        stack.enter_context(mock.patch.object(pipeline, "videos", ["test"] * 4))
        stack.enter_context(mock.patch.object(pipeline, "open_video", side_effect=open_video))
        resolve = {"side_effect": device} if isinstance(device, Exception) else {"return_value": device}
        stack.enter_context(mock.patch.object(pipeline, "resolve_device", **resolve))
        stack.enter_context(mock.patch.dict(sys.modules, {
            "ultralytics": SimpleNamespace(YOLO=lambda path: ScriptedModel(visible))}))
        sampler = stack.enter_context(mock.patch.object(pipeline, "RoboflowSampler")).return_value
        sampler.enabled = False
        sampler.poll.return_value = []
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        pipeline.run(publisher=recorder, show_window=False, max_cycles=2 * measurements)
    # Inference runs on even cycles and snapshots start at cycle 2, so every
    # other snapshot directly follows a measurement.
    return recorder, [s["directions"]["north"] for s in recorder.snapshots[::2]]


class MotionHistoryTests(unittest.TestCase):
    def test_stationary_car_counts_when_measurements_exceed_motion_window(self):
        # 2 FPS with inference every second frame: measurements are 1 s apart,
        # longer than the 0.6 s window. Before the fix the car stayed NEW forever.
        recorder, north = run_pipeline(fps=2.0, measurements=4)
        self.assertEqual([m["stopped_vehicles"] for m in north], [0, 1, 1, 1])
        self.assertEqual([m["mean_wait_seconds"] for m in north], [0.0, 0.0, 1.0, 2.0])
        self.assertEqual(north[-1]["max_wait_seconds"], 2.0)
        self.assertEqual(north[-1]["trusted_vehicles"], 1)
        self.assertEqual(recorder.components["inference"], {"device": "cpu", "model": "model.pt"})
        self.assertEqual(recorder.snapshots[-1]["emergency"],
                         {"enabled": False, "active": False, "direction": None, "confidence": None})

    def test_track_id_returning_after_forget_window_does_not_inherit_wait(self):
        # Visible on measurements 1-5 (0.2-1.0 s), hidden until 3.2 s: the ID
        # returns 2.2 s after it was last seen, beyond TRACK_FORGET_SECONDS.
        _, north = run_pipeline(fps=10.0, measurements=17, visible=lambda n: n <= 5 or n >= 16)
        self.assertEqual(north[4]["stopped_vehicles"], 1)
        self.assertAlmostEqual(north[4]["mean_wait_seconds"], 0.6)
        self.assertEqual(north[15]["stopped_vehicles"], 0)  # a new presence starts as NEW
        self.assertEqual(north[16]["stopped_vehicles"], 1)
        # Before the fix the stale stopped_since gave 3.0 s of invented waiting.
        self.assertEqual(north[16]["mean_wait_seconds"], 0.0)

    def test_empty_approach_reports_zero_queue_and_wait(self):
        _, north = run_pipeline(fps=10.0, measurements=2, visible=lambda n: False)
        self.assertEqual(north[-1]["detected_vehicles"], 0)
        self.assertEqual(north[-1]["stopped_vehicles"], 0)
        self.assertEqual(north[-1]["mean_wait_seconds"], 0.0)
        self.assertEqual(north[-1]["max_wait_seconds"], 0.0)


class DeviceTests(unittest.TestCase):
    def resolve(self, setting, cuda):
        with mock.patch("torch.cuda.is_available", return_value=cuda):
            return pipeline.resolve_device(setting)

    def test_auto_uses_cuda_only_when_pytorch_reports_it(self):
        self.assertEqual(self.resolve("auto", True), 0)
        self.assertEqual(self.resolve("auto", False), "cpu")
        self.assertEqual(self.resolve("", False), "cpu")

    def test_explicit_devices_are_kept(self):
        self.assertEqual(self.resolve(" CPU ", True), "cpu")
        self.assertEqual(self.resolve("0", True), 0)
        self.assertEqual(self.resolve("cuda:1", True), "cuda:1")

    def test_explicit_cuda_without_cuda_is_an_error(self):
        with self.assertRaisesRegex(RuntimeError, "YOLO_DEVICE"):
            self.resolve("0", False)

    def test_device_failure_happens_before_any_camera_opens(self):
        opened: list[str] = []
        with self.assertRaisesRegex(RuntimeError, "YOLO_DEVICE"):
            run_pipeline(fps=10.0, measurements=1, opened=opened,
                         device=RuntimeError("YOLO_DEVICE requests CUDA"))
        self.assertEqual(opened, [])


if __name__ == "__main__":
    unittest.main()
