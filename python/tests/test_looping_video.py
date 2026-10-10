"""Files mode: looping, real-time pacing, per-stream reset and missing videos.

Small synthetic clips stand in for the real videos; each frame's brightness
encodes its index. YOLO is replaced by a scripted model, so no weights or GPU
are needed. The last tests check the four videos that ship in videos/.
"""

import contextlib
import io
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import ClassVar
from unittest import mock

import cv2
import numpy as np

# Imported before tests swap sys.modules["ultralytics"] for a scripted model;
# pipeline.reset_tracker imports it from there.
import ultralytics.trackers.basetrack  # noqa: F401

from app import pipeline
from app.services.shared_state import SharedState
from flaskk.config import WebSettings
from video_work.video_io import LoopingVideoFile, fit_frame

ROOT = Path(__file__).resolve().parents[1]
DIRECTIONS = ("north", "south", "west", "east")
# The user's videos, one per direction in DIRECTIONS order.
SHIPPED = ("video1", "video2", "video3", "video4")


def write_clip(path, frames, fps, step=20):
    """Frame k is a flat image of brightness step * k, so the index survives compression."""
    assert step * (frames - 1) <= 255
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), fps, (64, 48))
    try:
        if not writer.isOpened():
            raise unittest.SkipTest("OpenCV cannot write MJPG test clips here")
        for k in range(frames):
            writer.write(np.full((48, 64, 3), step * k, dtype=np.uint8))
    finally:
        writer.release()
    return path


def frame_index(frame, step=20):
    return round(float(frame.mean()) / step)


class FakeClock:
    """Clock and stop event in one: waiting advances time instead of sleeping."""

    def __init__(self):
        self.now = 100.0
        self.waits = []

    def __call__(self):
        return self.now

    def wait(self, seconds):
        self.waits.append(seconds)
        self.now += seconds
        return False


class LoopingVideoFileTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = write_clip(Path(directory.name) / "clip.avi", frames=10, fps=20)
        self.clock = FakeClock()
        self.video = LoopingVideoFile(self.path, stop_event=self.clock, clock=self.clock)
        self.addCleanup(self.video.release)

    def read_index(self):
        success, frame = self.video.read()
        self.assertTrue(success)
        return frame_index(frame)

    def test_plays_forever_and_restarts_at_frame_zero_without_a_gap(self):
        seen = []
        for _ in range(35):
            seen.append(self.read_index())
            self.clock.now += 1 / 20
        self.assertEqual(seen, list(range(10)) * 3 + list(range(5)))
        self.assertEqual(self.video.loops, 3)
        # Video time keeps counting across loops; it never jumps backwards.
        self.assertAlmostEqual(self.video.video_time, 35 / 20)
        self.assertEqual(self.video.get(cv2.CAP_PROP_FPS), 20)

    def test_a_slow_reader_skips_frames_instead_of_slowing_down(self):
        self.assertEqual(self.read_index(), 0)
        self.clock.now += 5 / 20  # inference took five frame periods
        self.assertEqual(self.read_index(), 5)
        self.assertEqual(self.video.frames_played, 6)
        self.clock.now += 7 / 20  # past the end: rewinds instead of failing
        self.assertEqual(self.read_index(), 0)
        self.assertEqual(self.video.loops, 1)

    def test_an_early_reader_waits_for_the_next_frame(self):
        self.assertEqual(self.read_index(), 0)
        self.assertEqual(self.read_index(), 1)  # no time passed: waits one frame period
        self.assertEqual(len(self.clock.waits), 1)
        self.assertAlmostEqual(self.clock.waits[0], 1 / 20)

    def test_a_long_stall_does_not_decode_through_the_file(self):
        self.assertEqual(self.read_index(), 0)
        self.clock.now += 60  # far longer than the clip
        with mock.patch.object(LoopingVideoFile, "MAX_SKIP_SECONDS", 0.2):
            self.assertEqual(self.read_index(), 4)  # skipped at most 0.2 s of frames
            self.clock.now += 1 / 20
            self.assertEqual(self.read_index(), 5)  # then plays on in real time

    def test_a_file_deleted_while_playing_is_reported_at_the_loop(self):
        for _ in range(10):
            self.read_index()
            self.clock.now += 1 / 20
        # Linux lets a playing file be deleted; the loop must notice it.
        with mock.patch.object(type(self.video.path), "is_file", return_value=False):
            self.assertEqual(self.video.read(), (False, None))

    def test_missing_file_names_only_the_file(self):
        with self.assertRaises(FileNotFoundError) as caught:
            LoopingVideoFile(self.path.with_name("absent.mp4"))
        self.assertIn("absent.mp4", str(caught.exception))
        self.assertNotIn(str(self.path.parent), str(caught.exception))


class FitFrameTests(unittest.TestCase):
    def test_portrait_video_is_pillarboxed_not_stretched(self):
        portrait = np.full((850, 478, 3), 200, dtype=np.uint8)
        frame, (x, y, width, height) = fit_frame(portrait, (640, 480))
        self.assertEqual(frame.shape, (480, 640, 3))
        self.assertEqual((y, height), (0, 480))
        self.assertEqual(width, round(478 * 480 / 850))
        self.assertEqual(x, (640 - width) // 2)
        self.assertEqual(int(frame[:, :x].max()), 0)  # black bars
        self.assertEqual(int(frame[:, x + width:].max()), 0)
        self.assertEqual(int(frame[240, 320, 0]), 200)  # picture in the middle

    def test_matching_aspect_ratio_fills_the_frame(self):
        frame, rect = fit_frame(np.zeros((240, 320, 3), dtype=np.uint8), (640, 480))
        self.assertEqual((frame.shape, rect), ((480, 640, 3), (0, 0, 640, 480)))


class TrackerResetTests(unittest.TestCase):
    def setUp(self):
        from ultralytics.trackers.basetrack import BaseTrack

        self.BaseTrack = BaseTrack
        saved = BaseTrack._count
        self.addCleanup(setattr, BaseTrack, "_count", saved)

    def test_real_bytetrack_reset_zeroes_the_shared_counter(self):
        # Why reset_tracker must restore the counter. If an Ultralytics upgrade
        # changes this, revisit reset_tracker.
        from ultralytics.trackers.byte_tracker import BYTETracker
        from ultralytics.utils import YAML, IterableSimpleNamespace
        from ultralytics.utils.checks import check_yaml

        tracker = BYTETracker(IterableSimpleNamespace(**YAML.load(check_yaml("bytetrack.yaml"))))
        self.BaseTrack._count = 41
        tracker.reset()
        self.assertEqual(self.BaseTrack._count, 0)

    def test_one_stream_is_reset_without_renumbering_the_others(self):
        from ultralytics.trackers.byte_tracker import BYTETracker
        from ultralytics.utils import YAML, IterableSimpleNamespace
        from ultralytics.utils.checks import check_yaml

        tracker = BYTETracker(IterableSimpleNamespace(**YAML.load(check_yaml("bytetrack.yaml"))))
        tracker.frame_id = 99
        tracker.tracked_stracks.append(object())
        self.BaseTrack._count = 41
        pipeline.reset_tracker(SimpleNamespace(predictor=SimpleNamespace(trackers=[tracker])))
        self.assertEqual((tracker.frame_id, tracker.tracked_stracks), (0, []))
        self.assertEqual(self.BaseTrack._count, 41)
        self.assertEqual(self.BaseTrack.next_id(), 42)

    def test_a_model_that_has_not_tracked_yet_is_left_alone(self):
        pipeline.reset_tracker(SimpleNamespace())
        pipeline.reset_tracker(SimpleNamespace(predictor=SimpleNamespace()))


class Box:
    def __init__(self, track_id):
        self.cls = [0]
        self.conf = [0.9]
        self.id = [track_id]
        self.xyxy = [SimpleNamespace(cpu=lambda: SimpleNamespace(tolist=lambda: [10.0, 10.0, 40.0, 30.0]))]


class FakeTracker:
    def __init__(self):
        self.resets = 0

    def reset(self):
        self.resets += 1


class StationaryCarModel:
    """One parked car, always track 7, in every frame; one instance per stream."""

    instances: ClassVar[list] = []

    def __init__(self, path):
        self.names = {0: "car"}
        self.calls = 0
        self.predictor = SimpleNamespace(trackers=[FakeTracker()])
        StationaryCarModel.instances.append(self)

    def track(self, frame, **options):
        self.calls += 1
        return [SimpleNamespace(boxes=[Box(7)])]


class SteppingClock:
    """Each read sees exactly one more frame period: real-time pacing without sleeping."""

    def __init__(self, fps):
        self.now = 0.0
        self.step = 1 / fps

    def __call__(self):
        self.now += self.step
        return self.now


class Recorder:
    def __init__(self, on_snapshot=None):
        self.snapshots, self.offers, self.statuses, self.components = [], [], [], {}
        self.on_snapshot = on_snapshot

    def set_lifecycle(self, status, reason=None):
        pass

    def camera_status(self, index, status):
        self.statuses.append((index, status))

    def camera_read(self, index):
        pass

    def report_component(self, name, status):
        self.components[name] = status

    def publish_snapshot(self, snapshot):
        self.snapshots.append(snapshot)
        if self.on_snapshot is not None:
            self.on_snapshot(len(self.snapshots))

    def offer_frames(self, frames):
        self.offers.append(list(frames))

    def finish_pipeline(self):
        pass


class FilesModePipelineTests(unittest.TestCase):
    FPS = 10
    FRAMES = 20  # 2 s of video per pass

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.files = [self.directory / f"{name}.avi" for name in DIRECTIONS]
        for path in self.files:
            write_clip(path, self.FRAMES, self.FPS, step=10)
        model_path = self.directory / "model.pt"
        model_path.write_bytes(b"test")
        StationaryCarModel.instances = []

        def looping_file(path, stop_event=None):
            return LoopingVideoFile(path, stop_event=stop_event, clock=SteppingClock(self.FPS))

        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(mock.patch.object(pipeline, "VIDEO_SOURCE_MODE", "files"))
        stack.enter_context(mock.patch.object(pipeline, "VIDEO_FILES", [str(p) for p in self.files]))
        stack.enter_context(mock.patch.object(pipeline, "LoopingVideoFile", side_effect=looping_file))
        stack.enter_context(mock.patch.object(pipeline, "MODEL_PATH", model_path))
        stack.enter_context(mock.patch.object(pipeline, "resolve_device", return_value="cpu"))
        stack.enter_context(mock.patch.object(pipeline, "MISSING_RETRY_SECONDS", 0.0))
        stack.enter_context(mock.patch.dict("sys.modules", {
            "ultralytics": SimpleNamespace(YOLO=StationaryCarModel)}))
        sampler = stack.enter_context(mock.patch.object(pipeline, "RoboflowSampler")).return_value
        sampler.enabled = False
        sampler.poll.return_value = []
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def run_pipeline(self, cycles, recorder):
        pipeline.run(publisher=recorder, show_window=False, max_cycles=cycles)
        return recorder

    def test_every_stream_loops_three_times_and_resets_only_its_own_tracking(self):
        recorder = self.run_pipeline(3 * self.FRAMES + 10, Recorder())
        loops = recorder.components["sources"]["loops"]
        self.assertEqual(loops, {name: 3 for name in DIRECTIONS})
        self.assertEqual(recorder.components["sources"]["missing"], [])
        # One tracker reset per loop, on that stream's own model only.
        self.assertEqual([m.predictor.trackers[0].resets for m in StationaryCarModel.instances], [3] * 4)
        waits = [s["directions"][name]["max_wait_seconds"] for s in recorder.snapshots for name in DIRECTIONS
                 if s["directions"][name].get("max_wait_seconds") is not None]
        # The parked car is counted once per measurement, and its wait restarts
        # with each pass instead of growing across loops (6 s of video ran).
        self.assertGreater(max(waits), 1.0)
        self.assertLessEqual(max(waits), self.FRAMES / self.FPS)
        counts = {s["directions"][name].get("detected_vehicles") for s in recorder.snapshots for name in DIRECTIONS}
        self.assertEqual(counts - {None}, {1})
        # Every published frame set has all four directions.
        self.assertTrue(all(frame is not None for offer in recorder.offers for frame in offer))

    def test_detection_stride_sets_how_often_yolo_runs(self):
        with mock.patch.object(pipeline, "DETECTION_FRAME_STRIDE", 3):
            self.run_pipeline(30, Recorder())
        self.assertEqual([m.calls for m in StationaryCarModel.instances], [10] * 4)

    def test_a_missing_video_leaves_the_others_running_and_recovers_when_restored(self):
        north = self.files[0]
        backup = self.directory / "north-backup.avi"
        shutil.move(north, backup)
        restored_at = 30

        def restore(snapshot_count):
            if snapshot_count == restored_at:
                shutil.copy(backup, north)

        recorder = self.run_pipeline(80, Recorder(on_snapshot=restore))
        self.assertIn((0, "open_failed"), recorder.statuses)
        before = recorder.snapshots[restored_at - 5]
        self.assertIsNone(before["directions"]["north"].get("detected_vehicles"))
        self.assertIs(before["directions"]["north"]["source_available"], False)
        self.assertIs(recorder.snapshots[-1]["directions"]["north"]["source_available"], True)
        for name in DIRECTIONS[1:]:
            self.assertEqual(before["directions"][name]["detected_vehicles"], 1)
        offers_before = recorder.offers[:restored_at - 1]
        self.assertTrue(offers_before)
        self.assertTrue(all(offer[0] is None and all(f is not None for f in offer[1:])
                            for offer in offers_before))
        # Restored: north is measured and streamed again, without a restart.
        self.assertEqual(recorder.snapshots[-1]["directions"]["north"]["detected_vehicles"], 1)
        self.assertIsNotNone(recorder.offers[-1][0])
        self.assertEqual(recorder.components["sources"]["missing"], [])


class SharedStateMissingFrameTests(unittest.TestCase):
    def test_a_missing_direction_does_not_block_the_other_three(self):
        shared = SharedState(WebSettings(display_fps=60))
        self.addCleanup(shared.close)
        shared.start_encoder()
        shared.publish_snapshot({"updated_at": time.time(), "directions": {}})
        frame = np.zeros((48, 64, 3), dtype=np.uint8)
        shared.offer_frames([frame, None, frame, frame])
        with shared.condition:
            self.assertTrue(shared.condition.wait_for(lambda: shared._sequences[0] > 0, timeout=3))
        self.assertEqual([shared.frame_available(i) for i in range(4)], [True, False, True, True])
        self.assertFalse(shared.health()["ready"])
        # A direction that disappears stops serving its last frame at once.
        time.sleep(0.05)  # offers are throttled to DISPLAY_FPS
        shared.offer_frames([None, frame, frame, frame])
        with shared.condition:
            self.assertTrue(shared.condition.wait_for(lambda: shared._sequences[1] > 0, timeout=3))
        self.assertEqual([shared.frame_available(i) for i in range(4)], [False, True, True, True])


class SourceSettingsTests(unittest.TestCase):
    def load_config(self, environment):
        # The real config source with an isolated project root, so no .env file applies.
        with tempfile.TemporaryDirectory() as directory:
            namespace = {"__file__": str(Path(directory) / "config" / "config.py")}
            with mock.patch.dict("os.environ", environment, clear=True):
                exec(compile((ROOT / "config/config.py").read_text(), "config.py", "exec"), namespace)
        return namespace

    def test_files_mode_is_the_default_with_one_video_per_direction(self):
        loaded = self.load_config({})
        self.assertEqual(loaded["VIDEO_SOURCE_MODE"], "files")
        self.assertEqual(loaded["VIDEO_FILES"], [f"videos/{name}.mp4" for name in SHIPPED])
        self.assertEqual(loaded["DETECTION_FRAME_STRIDE"], 2)

    def test_explicit_values_and_invalid_values(self):
        loaded = self.load_config({"VIDEO_SOURCE_MODE": "Cameras", "DETECTION_FRAME_STRIDE": "4"})
        self.assertEqual((loaded["VIDEO_SOURCE_MODE"], loaded["DETECTION_FRAME_STRIDE"]), ("cameras", 4))
        with self.assertWarns(RuntimeWarning):
            self.assertEqual(self.load_config({"VIDEO_SOURCE_MODE": "webcam"})["VIDEO_SOURCE_MODE"], "files")
        for bad in ("0", "-1", "fast"):
            with self.assertWarns(RuntimeWarning):
                self.assertEqual(self.load_config({"DETECTION_FRAME_STRIDE": bad})["DETECTION_FRAME_STRIDE"], 2)


class ShippedVideoTests(unittest.TestCase):
    """The four videos in videos/ are what the deployed service plays."""

    def test_four_small_h264_videos_one_per_direction(self):
        for direction, name in zip(DIRECTIONS, SHIPPED):
            with self.subTest(direction=direction):
                path = ROOT / "videos" / f"{name}.mp4"
                self.assertTrue(path.is_file(), f"videos/{name}.mp4 is missing")
                self.assertLess(path.stat().st_size, 50_000_000)
                capture = cv2.VideoCapture(str(path))
                try:
                    self.assertTrue(capture.isOpened())
                    self.assertTrue(capture.read()[0], f"videos/{name}.mp4 has no readable frame")
                    fps = capture.get(cv2.CAP_PROP_FPS)
                    fourcc = int(capture.get(cv2.CAP_PROP_FOURCC)).to_bytes(4, "little").decode(errors="replace")
                finally:
                    capture.release()
                self.assertGreater(fps, 0)
                self.assertIn(fourcc.lower(), {"avc1", "h264"})

    def test_git_tracks_exactly_these_four_videos(self):
        if shutil.which("git") is None:
            self.skipTest("git is not available")
        names = [f"videos/{name}.mp4" for name in SHIPPED] + ["videos/other.mp4", "videos/north.mp4"]
        result = subprocess.run(["git", "check-ignore", "--no-index", *names], cwd=ROOT,
                                capture_output=True, text=True, check=False)
        if result.returncode == 128:
            self.skipTest("not a git checkout")
        self.assertEqual(result.stdout.split(), ["videos/other.mp4", "videos/north.mp4"])


if __name__ == "__main__":
    unittest.main()
