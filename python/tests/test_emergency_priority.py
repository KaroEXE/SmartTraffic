import contextlib
import copy
import io
import json
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from controller.traffic_controller import TrafficState, update_controller
from emergency.emergency_priority import (
    WORKFLOW_URL,
    EmergencyPriority,
    EmergencySettings,
    InferenceResult,
    RoboflowSampler,
    parse_workflow_response,
)

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = json.loads((ROOT / "tests/fixtures/roboflow_workflows_run.json").read_text())
DETECTIONS = parse_workflow_response(FIXTURE)


class ResponseTests(unittest.TestCase):
    def test_actual_mcp_response_and_http_envelope(self):
        for payload in (FIXTURE, {"outputs": FIXTURE}):
            detection, = parse_workflow_response(payload)
            self.assertEqual(detection.label, "emergency-car")
            self.assertAlmostEqual(detection.confidence, 0.8519337177276611)
            self.assertEqual(detection.xyxy, (21 / 640, 294 / 960, 525 / 640, 937 / 960))

    def test_low_confidence_and_other_classes_are_ignored(self):
        payload = copy.deepcopy(FIXTURE)
        p = payload[0]["predictions"]["predictions"][0]
        p["confidence"] = 0.59
        self.assertEqual(parse_workflow_response(payload), ())
        p.update(confidence=0.99, **{"class": "car"})
        self.assertEqual(parse_workflow_response(payload), ())

    def test_missing_or_invalid_response_fails_closed(self):
        for payload in ({}, [], {"outputs": []}, [{"predictions": []}]):
            with self.subTest(payload=payload), self.assertRaises((KeyError, ValueError, TypeError)):
                parse_workflow_response(payload)
        payload = copy.deepcopy(FIXTURE)
        payload[0]["predictions"]["predictions"][0]["confidence"] = float("nan")
        with self.assertRaises(ValueError):
            parse_workflow_response(payload)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = EmergencyPriority()

    def hit(self, road, at, **kwargs):
        self.policy.observe(InferenceResult(road, at, DETECTIONS, **kwargs), at)
        return self.policy.choose(at)

    def confirm(self, road=2, start=0):
        for at in (start, start + 2, start + 4):
            self.hit(road, at)

    def test_three_distinct_samples_per_direction(self):
        self.assertIsNone(self.hit(2, 0))
        self.assertIsNone(self.hit(2, 0))
        self.assertIsNone(self.hit(2, 2))
        self.assertIsNone(self.hit(1, 3))
        self.assertEqual(self.hit(2, 4), 2)

    def test_negative_and_skipped_results_reset_confirmation(self):
        self.hit(2, 0)
        self.hit(2, 2)
        self.policy.observe(InferenceResult(2, 3), 3)
        self.assertIsNone(self.hit(2, 4))
        self.assertIsNone(self.hit(2, 6))
        self.assertEqual(self.hit(2, 8), 2)
        self.policy = EmergencyPriority()
        self.hit(2, 0, sequence=1)
        self.hit(2, 2, sequence=2)
        self.assertIsNone(self.hit(2, 4, sequence=4))

    def test_stale_response_error_and_missing_updates_release(self):
        for failure in (InferenceResult(2, 6, error="TimeoutError"),
                        InferenceResult(2, 6, error="HTTPError"),
                        InferenceResult(2, 6, DETECTIONS)):
            self.policy = EmergencyPriority()
            self.confirm()
            now = 6 if failure.error else 13
            self.policy.observe(failure, now)
            self.assertIsNone(self.policy.choose(now))
        self.confirm(start=20)
        self.assertIsNone(self.policy.choose(31))

    def test_negative_scene_releases_after_grace(self):
        self.confirm()
        self.policy.observe(InferenceResult(2, 6), 6)
        self.assertEqual(self.policy.choose(6), 2)
        self.assertIsNone(self.policy.choose(10.01))

    def test_sticky_priority_then_other_direction(self):
        self.confirm(2)
        self.confirm(1, start=4)
        self.assertEqual(self.policy.choose(8), 2)
        self.assertEqual(self.policy.choose(11), 1)

    def test_maximum_hold_and_cooldown_require_new_confirmation(self):
        self.confirm()
        self.policy.on_green_started(2, 4)
        for at in range(6, 26, 2):
            self.hit(2, at)
        self.assertIsNone(self.policy.target)
        self.assertEqual(self.policy.roads[2].status, "COOLDOWN")
        self.assertIsNone(self.hit(2, 26))
        self.assertIsNone(self.hit(2, 34))
        self.assertIsNone(self.hit(2, 36))
        self.assertEqual(self.hit(2, 38), 2)


class ControllerHarness:
    """Execute the extracted controller, without opening cameras or GPU."""

    def __init__(self, mode="AUTO"):
        self.policy = EmergencyPriority()
        self.state = TrafficState()
        self.env = vars(self.state)
        self.env.update(controller_started=True, current_green=0, light_phase="GREEN",
                        phase_start_time=0., green_duration=7., current_time=0.,
                        MIN_GREEN=4, MAX_GREEN=12, BASE_GREEN=4, SECONDS_PER_DENSITY=1.2,
                        YELLOW_TIME=2, AUTO_GREEN=7, WAIT_BONUS=1.5,
                        names=["NORTH", "SOUTH", "WEST", "EAST"], control_mode=mode,
                        stopped_counts=[0]*4, stopped_scores=[0.]*4, wait_cycles=[0]*4,
                        emergency_priority=self.policy, emergency_settings=EmergencySettings())

    def tick(self, at):
        self.env.update(current_time=at, emergency_target=self.policy.choose(at))
        with contextlib.redirect_stdout(io.StringIO()):
            from types import SimpleNamespace
            update_controller(self.state, at, self.policy, SimpleNamespace(poll=lambda: []),
                              EmergencySettings())
        return self.env["light_phase"], self.env["current_green"]

    def confirm(self, road, start=0):
        for at in (start, start+1, start+2):
            self.policy.observe(InferenceResult(road, at, DETECTIONS), at)


class ControllerTests(unittest.TestCase):
    def test_emergency_preemption_and_normal_return_use_clearance(self):
        h = ControllerHarness()
        h.confirm(2)
        self.assertEqual(h.tick(2), ("GREEN", 0))  # respect MIN_GREEN
        self.assertEqual(h.tick(4), ("YELLOW", 0))
        self.assertEqual(h.tick(5.99), ("YELLOW", 0))
        self.assertEqual(h.tick(6), ("ALL_RED", 0))
        self.assertEqual(h.tick(6.99), ("ALL_RED", 0))
        self.assertEqual(h.tick(7), ("GREEN", 2))
        # Failure immediately revokes evidence, then respects green/yellow/all-red.
        h.policy.observe(InferenceResult(2, 8, error="TimeoutError"), 8)
        self.assertEqual(h.tick(8), ("GREEN", 2))
        self.assertEqual(h.tick(11), ("YELLOW", 2))
        self.assertEqual(h.tick(13), ("ALL_RED", 2))
        self.assertEqual(h.tick(14), ("GREEN", 3))
        self.assertEqual(h.env["control_mode"], "AUTO")

    def test_expired_pending_emergency_is_not_granted_green(self):
        h = ControllerHarness()
        h.confirm(2)
        h.tick(4)
        h.tick(6)
        self.assertEqual(h.tick(10), ("GREEN", 1))

    def test_current_green_is_extended_but_capped(self):
        h = ControllerHarness()
        h.confirm(0)
        self.assertEqual(h.tick(2), ("GREEN", 0))
        for at in range(4, 22, 2):
            h.policy.observe(InferenceResult(0, at, DETECTIONS), at)
            self.assertEqual(h.tick(at), ("GREEN", 0))
        h.policy.observe(InferenceResult(0, 22, DETECTIONS), 22)
        self.assertEqual(h.tick(22), ("YELLOW", 0))

    def test_existing_auto_and_ai_road_selection(self):
        for mode, expected in (("AUTO", 1), ("AI", 3)):
            h = ControllerHarness(mode)
            h.env.update(stopped_counts=[0, 1, 2, 5], stopped_scores=[0., 1., 2., 5.])
            self.assertEqual(h.tick(7), ("YELLOW", 0))
            self.assertEqual(h.tick(9), ("ALL_RED", 0))
            self.assertEqual(h.tick(10), ("GREEN", expected))
            self.assertEqual(h.env["stopped_counts"], [0, 1, 2, 5])


class WorkerTests(unittest.TestCase):
    def test_missing_key_disables_network(self):
        with patch("config.config.ROBOFLOW_API_KEY", ""):
            sampler = RoboflowSampler()
        self.assertFalse(sampler.enabled)
        self.assertFalse(sampler.submit(0, None, 0))
        self.assertEqual(sampler.poll(), [])
        sampler.close()

    def test_slow_network_is_bounded_and_other_roads_still_run(self):
        started, release = threading.Event(), threading.Event()
        import numpy as np

        def infer(frame):
            if frame[0, 0] == 1:
                started.set()
                release.wait(3)
            return {"outputs": FIXTURE}

        sampler = RoboflowSampler(EmergencySettings(sample_seconds=0), infer=infer)
        try:
            now = time.monotonic()
            sampler.submit(0, np.ones((2, 2)), now)
            self.assertTrue(started.wait(1))
            before = time.monotonic()
            for _ in range(20):
                sampler.submit(0, np.ones((2, 2)), time.monotonic())
            sampler.submit(1, np.zeros((2, 2)), time.monotonic())
            self.assertLess(time.monotonic() - before, .5)
            self.assertEqual(sampler._inputs[0].qsize(), 1)
            deadline = time.monotonic() + 2
            results = []
            while time.monotonic() < deadline and not results:
                results = sampler.poll()
                release.wait(.01)
            self.assertEqual(results[0].road, 1)
            self.assertTrue(results[0].detections)
            self.assertFalse(release.is_set())
        finally:
            sampler.close()
            release.set()
            for thread in sampler._threads:
                thread.join(1)

    def test_worker_error_is_a_result_and_worker_recovers(self):
        import numpy as np
        attempts = []
        def infer(frame):
            attempts.append(1)
            if len(attempts) == 1:
                raise TimeoutError("must not leak this message")
            return {"outputs": FIXTURE}
        sampler = RoboflowSampler(EmergencySettings(sample_seconds=0), infer=infer)
        try:
            for expected_error in ("TimeoutError", ""):
                sampler.submit(0, np.zeros((2, 2)), time.monotonic())
                deadline = time.monotonic() + 2
                results = []
                while time.monotonic() < deadline and not results:
                    results = sampler.poll()
                    threading.Event().wait(.01)
                self.assertEqual(results[0].error, expected_error)
        finally:
            sampler.close()
            for thread in sampler._threads:
                thread.join(1)

    def test_http_image_encoding_key_and_timeout(self):
        from unittest.mock import MagicMock

        import numpy as np
        with patch("config.config.ROBOFLOW_API_KEY", ""):
            sampler = RoboflowSampler()
        sampler._api_key = "test-only-secret"
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({"outputs": FIXTURE}).encode()
        with patch("emergency.emergency_priority.urlopen", return_value=response) as send:
            result = sampler._request(np.zeros((480, 640, 3), dtype=np.uint8))
        request = send.call_args.args[0]
        self.assertEqual(request.full_url, WORKFLOW_URL)
        self.assertNotIn("test-only-secret", request.full_url)
        body = json.loads(request.data)
        self.assertEqual(body["api_key"], "test-only-secret")
        self.assertEqual(body["inputs"]["image"]["type"], "base64")
        self.assertTrue(body["inputs"]["image"]["value"])
        self.assertEqual(send.call_args.kwargs["timeout"], 4.)
        self.assertEqual(parse_workflow_response(result), DETECTIONS)


if __name__ == "__main__":
    unittest.main()
