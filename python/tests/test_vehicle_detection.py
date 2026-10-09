"""Motion regressions with deterministic detections and no model inference."""

import contextlib
import io
import unittest
from types import SimpleNamespace

import numpy as np

from controller.traffic_controller import TrafficState
from detection.vehicle_detection import process_vehicle_frame


class Coordinates:
    def __init__(self, values: list[float]):
        self.values = values

    def cpu(self):
        return self

    def tolist(self):
        return self.values


class TrackedCar:
    def __init__(self):
        self.names = {0: "car"}
        self.x = 20.0
        self.visible = True

    def track(self, frame, **options):
        if not self.visible:
            return [SimpleNamespace(boxes=[])]
        box = SimpleNamespace(cls=[0], conf=[0.9], id=[7],
                              xyxy=[Coordinates([self.x, 20.0, self.x + 60.0, 80.0])])
        return [SimpleNamespace(boxes=[box])]


class MotionTests(unittest.TestCase):
    def setUp(self):
        self.state = TrafficState()
        # This inactive experimental detector expects an extra timestamp field.
        # Supply its expected input without changing the active traffic algorithm.
        self.state.last_video_times = [None] * 4
        self.model = TrackedCar()
        self.frame = np.zeros((240, 320, 3), dtype=np.uint8)

    def measure(self, at: float, x: float = 20.0):
        self.model.x = x
        with contextlib.redirect_stdout(io.StringIO()):
            process_vehicle_frame(0, self.frame, at, [self.model], self.state)
        return self.state.track_states[0][7]

    def test_stationary_car_is_counted_at_low_frame_rate(self):
        self.assertEqual(self.measure(0.0)["state"], "NEW")
        self.assertEqual(self.state.stopped_counts[0], 0)
        for at in (1.0, 2.0):
            with self.subTest(at=at):
                self.assertEqual(self.measure(at)["state"], "STOPPED")
                self.assertEqual(self.state.stopped_counts[0], 1)
                self.assertTrue(self.state.camera_reliable[0])

    def test_moving_car_is_not_counted_at_low_frame_rate(self):
        self.assertEqual(self.measure(0.0)["state"], "NEW")
        for at in (1.0, 2.0):
            with self.subTest(at=at):
                self.assertEqual(self.measure(at, x=20.0 + at * 40.0)["state"], "MOVING")
                self.assertEqual(self.state.stopped_counts[0], 0)
                self.assertEqual(self.state.stopped_scores[0], 0.0)

    def test_moving_car_is_not_counted_at_normal_frame_rate(self):
        self.measure(0.0)
        for at in (0.2, 0.4, 0.6):
            self.assertEqual(self.measure(at, x=20.0 + at * 40.0)["state"], "MOVING")
            self.assertEqual(self.state.stopped_counts[0], 0)

    def test_expired_track_id_restarts_its_motion_and_wait_history(self):
        self.measure(0.0)
        self.assertEqual(self.measure(0.2)["state"], "STOPPED")
        track = self.measure(3.0)
        self.assertEqual(track["state"], "NEW")
        self.assertIsNone(track["stopped_since"])
        self.assertEqual(len(track["history"]), 1)
        self.assertEqual(self.state.stopped_counts[0], 0)
        track = self.measure(3.2)
        self.assertEqual(track["state"], "STOPPED")
        self.assertEqual(track["stopped_since"], 3.2)
        self.assertEqual(self.state.stopped_scores[0], 1.0)

    def test_detection_gap_does_not_extend_the_normal_motion_window(self):
        self.measure(0.0)
        self.assertEqual(self.measure(0.2)["state"], "STOPPED")
        self.model.visible = False
        for at in (0.4, 0.6, 0.8):
            self.measure(at)
        self.model.visible = True
        track = self.measure(1.0)
        self.assertEqual(track["state"], "NEW")
        self.assertEqual(len(track["history"]), 1)
        self.assertEqual(self.state.stopped_counts[0], 0)


if __name__ == "__main__":
    unittest.main()
