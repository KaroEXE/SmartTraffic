"""Real JPEG/HTTP route tests; inference is never required for web viewers."""

import threading
import time
import unittest
from unittest.mock import patch

import cv2
import numpy as np

from app.services.shared_state import SharedState
from flaskk.app import create_app
from flaskk.config import WebSettings


class FlaskTests(unittest.TestCase):
    def setUp(self):
        self.settings = WebSettings(allowed_origins=("http://localhost:3000",), display_fps=60)
        self.shared = SharedState(self.settings)
        self.addCleanup(self.shared.close)
        self.app = create_app(self.shared, self.settings)
        self.client = self.app.test_client()

    def publish(self, value=0):
        frames = [np.full((48, 64, 3), value + i * 40, dtype=np.uint8) for i in range(4)]
        cv2.rectangle(frames[0], (4, 4), (40, 40), (0, 255, 0), 2)
        self.shared.publish_snapshot({"updated_at": time.time(), "directions": {
            "north": {"detected_vehicles": np.int64(3), "stopped_score": np.float32(1.5)}}})
        self.shared.offer_frames(frames)
        return frames

    def wait_ready(self):
        with self.shared.condition:
            self.assertTrue(self.shared.condition.wait_for(lambda: self.shared.health()["ready"], timeout=3))

    def test_startup_unavailable_no_fabricated_counts(self):
        self.assertEqual(self.client.get("/api/health").status_code, 503)
        self.assertIsNone(self.client.get("/api/traffic").json["data"])
        for name in ("north", "south", "west", "east"):
            self.assertEqual(self.client.get(f"/video/{name}").status_code, 503)
        self.assertEqual(self.client.get("/video/invalid").status_code, 404)

    def test_four_streams_numpy_json_readonly_and_exact_cors(self):
        self.shared.start_encoder()
        frames = self.publish()
        self.wait_ready()
        with patch("ultralytics.YOLO", side_effect=AssertionError("request started YOLO")):
            self.assertEqual(self.client.get("/api/health").status_code, 200)
            traffic = self.client.get("/api/traffic").json
            self.assertEqual(traffic["data"]["directions"]["north"]["detected_vehicles"], 3)
            self.assertTrue(traffic["available"])
            for i, camera in enumerate(self.client.get("/api/cameras").json["cameras"]):
                response = self.client.get(camera["stream_url"], buffered=False)
                self.assertEqual(response.status_code, 200)
                part = next(response.response)
                jpeg = part.split(b"\r\n\r\n", 1)[1][:-2]
                image = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
                self.assertEqual(image.shape, frames[i].shape)
                self.assertLess(np.abs(image.astype(float) - frames[i]).mean(), 12)
                self.assertIn(b"Content-Length: " + str(len(jpeg)).encode(), part)
                response.close()  # Browser disconnection must leave the pipeline running.
            self.assertTrue(self.shared.health()["ready"])
        for path in ("/api/traffic", "/api/cameras", "/api/health", "/video/north"):
            self.assertEqual(self.client.post(path).status_code, 405)
        allowed = self.client.get("/api/traffic", headers={"Origin": "http://localhost:3000"})
        denied = self.client.get("/api/traffic", headers={"Origin": "http://localhost:3000.evil.test"})
        self.assertEqual(allowed.headers["Access-Control-Allow-Origin"], "http://localhost:3000")
        self.assertNotIn("Access-Control-Allow-Origin", denied.headers)
        self.assertEqual(allowed.headers["Cache-Control"], "no-store")

    def test_multiple_viewers_share_encoding_and_slow_viewer_skips_old_frames(self):
        with patch.object(cv2, "imencode", wraps=cv2.imencode) as encode:
            self.shared.start_encoder()
            self.publish()
            self.wait_ready()
            viewers = [self.client.get("/video/north", buffered=False) for _ in range(6)]
            try:
                first = [next(v.response) for v in viewers]
                self.assertTrue(all(part == first[0] for part in first))
                self.assertEqual(encode.call_count, 4)
                # Clear the 1/60 s display throttle even on a 15.6 ms
                # monotonic clock (Python 3.12 on Windows).
                time.sleep(.05)
                self.publish(20)
                with self.shared.condition:
                    self.assertTrue(self.shared.condition.wait_for(lambda: self.shared._sequences[0] >= 2, 3))
                self.assertNotEqual(next(viewers[-1].response), first[-1])
                self.assertEqual(encode.call_count, 8)
                self.assertEqual(len(self.shared._jpeg), 4)
            finally:
                for viewer in viewers:
                    viewer.close()

    def test_slow_encoder_has_bounded_pending_storage_and_does_not_block_producer(self):
        started, release = threading.Event(), threading.Event()
        original = cv2.imencode

        def slow(*args):
            started.set()
            release.wait(3)
            return original(*args)

        with patch.object(cv2, "imencode", side_effect=slow):
            self.shared.start_encoder()
            self.publish()
            self.assertTrue(started.wait(2))
            try:
                before = time.monotonic()
                for _ in range(100):
                    self.shared.offer_frames([np.zeros((4, 4, 3), dtype=np.uint8)] * 4)
                self.assertLess(time.monotonic() - before, .5)
                self.assertTrue(self.shared._pending is None or len(self.shared._pending[0]) == 4)
            finally:
                release.set()

    def test_stale_or_stopped_frames_are_not_served_as_live(self):
        self.shared.start_encoder()
        self.publish()
        self.wait_ready()
        with self.shared.condition:
            self.shared._frame_mono[0] -= 20
            self.shared._updated_mono -= 20
        self.assertEqual(self.client.get("/video/north").status_code, 503)
        self.assertFalse(self.client.get("/api/traffic").json["available"])
        self.shared.finish_pipeline()
        self.assertEqual(self.client.get("/video/south").status_code, 503)

    def test_close_wakes_stream_waiters_and_stops_encoder(self):
        self.shared.start_encoder()
        self.publish()
        self.wait_ready()
        result = []
        waiter = threading.Thread(target=lambda: result.append(self.shared.wait_frame(0, 1, 10)))
        waiter.start()
        self.shared.close()
        waiter.join(2)
        self.assertFalse(waiter.is_alive())
        self.assertFalse(self.shared._thread.is_alive())
        self.assertEqual(result, [None])

    def test_display_config_rejects_invalid_values(self):
        for kwargs in ({"display_fps": float("nan")}, {"display_fps": 0}, {"jpeg_quality": 101},
                       {"allowed_origins": ("*",)}, {"allowed_origins": ("http://localhost:3000/",)},
                       {"max_stream_clients": 0}):
            with self.assertRaises(ValueError):
                WebSettings(**kwargs)

    def test_invalid_numeric_environment_names_the_variable(self):
        with patch.dict("os.environ", {"MAX_STREAM_CLIENTS": "many"}), \
                self.assertRaisesRegex(ValueError, "MAX_STREAM_CLIENTS"):
            WebSettings.from_env()

    def test_liveness_answers_while_readiness_reports_no_detections(self):
        self.shared.report_component("supervisor", {"restarts": 2, "last_exit": "RuntimeError"})
        live = self.client.get("/api/health/live")
        self.assertEqual(live.status_code, 200)
        self.assertEqual(live.json, {"service": "smart-traffic-ai", "alive": True, "ready": False,
                                     "pipeline_status": "not_started", "reason": None})
        health = self.client.get("/api/health")
        self.assertEqual(health.status_code, 503)
        self.assertEqual(health.json["components"]["supervisor"]["last_exit"], "RuntimeError")
        self.shared.start_encoder()
        self.publish()
        self.wait_ready()
        self.assertEqual(self.client.get("/api/health/live").json["ready"], True)

    def test_unknown_routes_and_methods_return_json(self):
        missing = self.client.get("/api/nothing")
        self.assertEqual((missing.status_code, missing.json), (404, {"error": "Not Found"}))
        wrong = self.client.post("/api/health/live")
        self.assertEqual((wrong.status_code, wrong.json), (405, {"error": "Method Not Allowed"}))
        self.assertIn("GET", wrong.headers["Allow"])

    def test_video_viewers_are_capped_and_slots_are_released(self):
        settings = WebSettings(display_fps=60, max_stream_clients=2)
        self.shared = SharedState(settings)
        self.addCleanup(self.shared.close)
        self.client = create_app(self.shared, settings).test_client()
        self.shared.start_encoder()
        self.publish()
        self.wait_ready()
        first = self.client.get("/video/north", buffered=False)
        second = self.client.get("/video/south", buffered=False)
        try:
            self.assertEqual((first.status_code, second.status_code), (200, 200))
            third = self.client.get("/video/west")
            self.assertEqual(third.status_code, 503)
            self.assertEqual(third.headers["Retry-After"], "5")
            self.assertEqual(self.shared.health()["stream_clients"], 2)
            next(first.response)
            first.close()  # browser disconnected
            replacement = self.client.get("/video/west", buffered=False)
            self.assertEqual(replacement.status_code, 200)
            replacement.close()
        finally:
            second.close()
        head = self.client.head("/video/east")  # a WSGI server closes it, like here
        self.assertEqual(head.status_code, 200)
        head.close()
        self.assertEqual(self.shared.health()["stream_clients"], 0)
