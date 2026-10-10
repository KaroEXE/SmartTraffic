"""Backend publication against a real local HTTP server; no production backend.

The server only imitates the Express route's responses (status codes and JSON
error bodies from controllers/trafficController.js). The end-to-end check
against the real Node.js backend is described in docs/RENDER_DEPLOYMENT.md.
"""

import json
import os
import socket
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from app.services.backend_publisher import (
    BackendPublisher,
    BackendSettings,
    build_observation,
    validate_observation,
)
from app.services.shared_state import SharedState
from flaskk.config import WebSettings

BASE_TIME = 1_760_000_000.0  # 2025-10-09T08:53:20Z
LOGGER = "app.services.backend_publisher"


def measured(trusted, stopped, wait, at):
    return {"detected_vehicles": trusted + 1, "trusted_vehicles": trusted,
            "tracked_vehicles": trusted, "stopped_vehicles": stopped,
            "stopped_score": float(stopped), "mean_wait_seconds": wait,
            "max_wait_seconds": wait, "measured_at": at}


def snapshot(base=BASE_TIME, emergency=None):
    return {
        "schema_version": 1,
        "updated_at": base + 1,
        "directions": {
            "north": {**measured(12, 8, 15.04, base + 0.5),
                      "class_counts": {"car": 10, "bus": 2}, "average_confidence": 0.71234},
            "south": measured(4, 3, 7.0, base + 0.25),  # oldest measurement
            "west": measured(5, 4, 10.0, base + 0.75),
            "east": measured(20, 15, 4000.0, base + 0.5),  # above the backend maximum
        },
        "emergency": emergency or {"enabled": False, "active": False,
                                   "direction": None, "confidence": None},
    }


def state(**kwargs):
    return {"available": True, "data": snapshot(**kwargs)}


class Backend:
    """Records POSTs and answers like the Express route would."""

    def __init__(self):
        self.requests: list[dict] = []
        self.reply = (200, {"ok": True, "intersectionId": "main"})
        self.delay = 0.0
        self.redirect_to = None
        backend = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                backend.requests.append({"path": self.path, "headers": dict(self.headers),
                                         "body": json.loads(body)})
                if backend.delay:
                    time.sleep(backend.delay)
                status, payload = backend.reply
                data = json.dumps(payload).encode()
                try:
                    self.send_response(status)
                    if backend.redirect_to:
                        self.send_header("Location", backend.redirect_to)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except OSError:
                    pass  # the client already gave up (timeout test)

            def log_message(self, *args):
                pass

        class Server(ThreadingHTTPServer):
            daemon_threads = True
            block_on_close = False

        self.server = Server(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


class ObservationTests(unittest.TestCase):
    def test_measured_values_map_to_the_backend_contract(self):
        observation = build_observation(state(), "main")
        self.assertEqual(observation, {
            "intersectionId": "main",
            "timestamp": "2025-10-09T08:53:20.250Z",
            "source": "python-ai",
            "traffic": {
                "north": {"vehicles": 12, "queueLength": 8, "waitingTime": 15.0,
                          "classes": {"bus": 2, "car": 10}, "confidence": 0.712},
                "south": {"vehicles": 4, "queueLength": 3, "waitingTime": 7.0,
                          "classes": {}, "confidence": None},
                "east": {"vehicles": 20, "queueLength": 15, "waitingTime": 3600,
                         "classes": {}, "confidence": None},
                "west": {"vehicles": 5, "queueLength": 4, "waitingTime": 10.0,
                         "classes": {}, "confidence": None},
            },
        })
        self.assertEqual(validate_observation(observation), [])

    def test_an_approach_without_its_video_is_sent_as_unavailable_not_zero(self):
        data = snapshot()
        data["directions"]["west"] = {"source_available": False}
        observation = build_observation({"available": True, "data": data}, "main")
        self.assertIsNone(observation["traffic"]["west"])
        self.assertEqual(observation["traffic"]["north"]["vehicles"], 12)
        self.assertEqual(validate_observation(observation), [])
        # A video that plays but has not been measured yet still holds everything back.
        data["directions"]["south"]["measured_at"] = None
        self.assertIsNone(build_observation({"available": True, "data": data}, "main"))
        # No video at all: nothing to send.
        nothing = snapshot()
        for name in nothing["directions"]:
            nothing["directions"][name] = {"source_available": False}
        self.assertIsNone(build_observation({"available": True, "data": nothing}, "main"))

    def test_nothing_is_built_until_every_approach_has_a_fresh_measurement(self):
        self.assertIsNone(build_observation({"available": False, "data": snapshot()}, "main"))
        self.assertIsNone(build_observation({"available": True, "data": None}, "main"))
        incomplete = snapshot()
        incomplete["directions"]["west"]["measured_at"] = None
        self.assertIsNone(build_observation({"available": True, "data": incomplete}, "main"))

    def test_emergency_and_pedestrian_fields_are_never_invented(self):
        self.assertNotIn("emergency", build_observation(state(), "main"))
        clear = build_observation(state(emergency={"enabled": True, "active": False,
                                                   "direction": None, "confidence": None}), "main")
        self.assertEqual(clear["emergency"],
                         {"detected": False, "type": None, "direction": None, "confidence": 0})
        active = build_observation(state(emergency={"enabled": True, "active": True,
                                                    "direction": "west",
                                                    "confidence": 0.8519337177276611}), "main")
        self.assertEqual(active["emergency"], {"detected": True, "type": "emergency",
                                               "direction": "west", "confidence": 0.852})
        self.assertNotIn("pedestrians", active)
        for observation in (clear, active):
            self.assertEqual(validate_observation(observation), [])

    def test_validation_mirrors_backend_rules(self):
        good = build_observation(state(), "main")

        def changed(**fields):
            return {**json.loads(json.dumps(good)), **fields}

        def approach(**fields):
            traffic = json.loads(json.dumps(good["traffic"]))
            traffic["north"].update(fields)
            return changed(traffic=traffic)

        west_missing = {k: v for k, v in good["traffic"].items() if k != "west"}
        cases = [
            (changed(intersectionId="no spaces"), "intersectionId"),
            (changed(source="mock"), "source"),
            (changed(timestamp="yesterday"), "timestamp"),
            (changed(traffic=west_missing), "exactly north, south, east and west"),
            (approach(vehicles=-1), "traffic.north.vehicles"),
            (approach(queueLength=True), "traffic.north.queueLength"),
            (approach(waitingTime=float("nan")), "traffic.north.waitingTime"),
            (approach(classes={"Car!": 1}), "traffic.north.classes"),
            (approach(classes={"car": -1}), "traffic.north.classes"),
            (approach(confidence=1.2), "traffic.north.confidence"),
            (changed(traffic=dict.fromkeys(good["traffic"])), "at least one available approach"),
            (changed(emergency={"detected": True, "type": None, "direction": "north",
                                "confidence": 0.9}), "emergency.type"),
            (changed(emergency={"detected": True, "type": "emergency", "direction": "north",
                                "confidence": 1.5}), "emergency.confidence"),
        ]
        for observation, text in cases:
            with self.subTest(text=text):
                self.assertIn(text, " | ".join(validate_observation(observation)))


class SettingsTests(unittest.TestCase):
    def test_endpoint_is_the_backend_route(self):
        for url, endpoint in (
            ("https://backend.example", "https://backend.example/api/traffic"),
            ("https://backend.example/", "https://backend.example/api/traffic"),
            ("http://127.0.0.1:3000/proxy", "http://127.0.0.1:3000/proxy/api/traffic"),
            ("https://backend.example/api/traffic", "https://backend.example/api/traffic"),
        ):
            self.assertEqual(BackendSettings(url=url).endpoint, endpoint)

    def test_invalid_settings_are_rejected(self):
        for kwargs in ({"url": "ftp://backend.example"}, {"url": "backend.example"},
                       {"url": "https://user@backend.example"},
                       {"url": "https://backend.example/?token=secret"},
                       {"intersection_id": "no spaces"}, {"token": "has space"},
                       {"interval": 0}, {"timeout": float("nan")}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                BackendSettings(**kwargs)

    def test_environment_configuration(self):
        names = ("BACKEND_URL", "INTERSECTION_ID", "TRAFFIC_INGEST_TOKEN",
                 "BACKEND_PUBLISH_INTERVAL", "BACKEND_TIMEOUT")
        with patch.dict(os.environ, {name: "" for name in names}):
            self.assertFalse(BackendSettings.from_env().enabled)
        with patch.dict(os.environ, {"BACKEND_URL": "https://backend.example",
                                     "INTERSECTION_ID": "market-square",
                                     "TRAFFIC_INGEST_TOKEN": "env-test-token",
                                     "BACKEND_PUBLISH_INTERVAL": "2.5", "BACKEND_TIMEOUT": "3"}):
            settings = BackendSettings.from_env()
        self.assertEqual((settings.endpoint, settings.intersection_id, settings.interval,
                          settings.timeout), ("https://backend.example/api/traffic",
                                              "market-square", 2.5, 3.0))
        self.assertNotIn("env-test-token", repr(settings))
        with patch.dict(os.environ, {"BACKEND_TIMEOUT": "soon"}), \
                self.assertRaisesRegex(ValueError, "BACKEND_TIMEOUT"):
            BackendSettings.from_env()


class PublisherTests(unittest.TestCase):
    TOKEN = "test-ingest-token-123"

    def setUp(self):
        self.backend = Backend()
        self.addCleanup(self.backend.close)
        self.shared = SharedState(WebSettings())
        self.addCleanup(self.shared.close)
        self.base = BASE_TIME

    def publisher(self, url=None, token=TOKEN, interval=0.05, timeout=2.0, max_backoff=1.0):
        settings = BackendSettings(url=url or self.backend.url, token=token, interval=interval,
                                   timeout=timeout, max_backoff=max_backoff)
        publisher = BackendPublisher(self.shared, settings)
        self.addCleanup(publisher.stop)
        return publisher

    def publish(self, **kwargs):
        self.base += 1  # every call is a new measurement
        self.shared.publish_snapshot(snapshot(self.base, **kwargs))

    def wait_for_requests(self, count, timeout=3.0):
        deadline = time.monotonic() + timeout
        while len(self.backend.requests) < count and time.monotonic() < deadline:
            time.sleep(0.01)
        return len(self.backend.requests)

    def test_posts_contract_json_with_bearer_token_once_per_measurement(self):
        publisher = self.publisher()
        self.assertEqual(publisher.publish_once(), "waiting")  # nothing measured yet
        self.publish()
        with self.assertLogs("app.services.backend_publisher", "INFO") as logs:
            self.assertEqual(publisher.publish_once(), "sent")
        request, = self.backend.requests
        self.assertEqual(request["path"], "/api/traffic")
        self.assertEqual(request["headers"]["Content-Type"], "application/json")
        self.assertEqual(request["headers"]["Authorization"], f"Bearer {self.TOKEN}")
        self.assertEqual(request["body"], build_observation(self.shared.traffic(), "main"))
        status = self.shared.health()["components"]["backend_publisher"]
        self.assertEqual((status["state"], status["sent"], status["last_http_status"]),
                         ("ok", 1, 200))
        self.assertNotIn(self.TOKEN, json.dumps(self.shared.health()))
        self.assertNotIn(self.TOKEN, "\n".join(logs.output))
        self.assertEqual(publisher.publish_once(), "unchanged")
        self.assertEqual(len(self.backend.requests), 1)

    def test_no_authorization_header_without_a_token(self):
        self.publish()
        self.assertEqual(self.publisher(token="").publish_once(), "sent")
        self.assertNotIn("Authorization", self.backend.requests[0]["headers"])

    def test_backend_rejections_are_reported_and_not_resent(self):
        cases = (
            (400, {"ok": False, "error": "Invalid traffic payload",
                   "details": ["traffic.north.vehicles must be a number"]},
             "rejected", "traffic.north.vehicles must be a number"),
            (404, {"ok": False, "error": 'Unknown intersectionId "main"'},
             "rejected", "Unknown intersectionId"),
            (401, {"ok": False, "error": "Missing or invalid ingest token"},
             "unauthorized", "TRAFFIC_INGEST_TOKEN"),
            (409, {"ok": False, "error": "Stale update"}, "stale", "Stale update"),
        )
        for status, body, outcome, text in cases:
            with self.subTest(status=status):
                self.backend.reply = (status, body)
                self.publish()
                publisher = self.publisher()
                sent = len(self.backend.requests)
                with self.assertLogs(LOGGER, "WARNING") as logs:
                    self.assertEqual(publisher.publish_once(), outcome)
                self.assertIn(outcome, logs.output[0])
                self.assertNotIn(self.TOKEN, "\n".join(logs.output))
                self.assertIn(text, publisher.status()["last_error"])
                self.assertNotIn(self.TOKEN, publisher.status()["last_error"])
                if outcome != "unauthorized":
                    # Resending the identical observation would be refused again.
                    self.assertEqual(publisher.publish_once(), "unchanged")
                self.assertEqual(len(self.backend.requests), sent + 1)

    def test_transient_server_errors_retry_the_newest_observation(self):
        self.backend.reply = (503, {"ok": False, "error": "Traffic state store is full"})
        self.publish()
        publisher = self.publisher()
        with self.assertLogs(LOGGER, "WARNING"):
            self.assertEqual(publisher.publish_once(), "server_error")
        self.backend.reply = (200, {"ok": True})
        self.assertEqual(publisher.publish_once(), "sent")
        self.assertEqual(len(self.backend.requests), 2)
        self.assertEqual(publisher.status()["consecutive_failures"], 0)

    def test_redirects_are_not_followed(self):
        target = Backend()
        self.addCleanup(target.close)
        self.backend.reply = (302, {})
        self.backend.redirect_to = target.url + "/api/traffic"
        self.publish()
        with self.assertLogs(LOGGER, "WARNING"):
            self.assertEqual(self.publisher().publish_once(), "redirect")
        self.assertEqual(target.requests, [])

    def test_timeouts_and_refused_connections_are_bounded_failures(self):
        self.backend.delay = 1.5
        publisher = self.publisher(timeout=0.2)
        self.publish()
        started = time.monotonic()
        with self.assertLogs(LOGGER, "WARNING"):
            self.assertEqual(publisher.publish_once(), "unreachable")
        self.assertLess(time.monotonic() - started, 1.2)
        self.assertIn("timed out", publisher.status()["last_error"].lower())

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        refused = self.publisher(url=f"http://127.0.0.1:{port}", timeout=1.0)
        with self.assertLogs(LOGGER, "WARNING"):
            self.assertEqual(refused.publish_once(), "unreachable")
        self.assertEqual(refused.status()["state"], "error")

    def test_failures_back_off_instead_of_flooding(self):
        publisher = self.publisher(interval=1, max_backoff=8)
        self.assertEqual(publisher._next_delay("sent"), 1)
        for failures, expected in ((1, 2), (2, 4), (3, 8), (9, 8)):
            publisher._status["consecutive_failures"] = failures
            self.assertEqual(publisher._next_delay("unreachable"), expected)
        self.assertEqual(publisher._next_delay("unauthorized"), 8)

        self.backend.reply = (503, {"ok": False, "error": "unavailable"})
        self.publish()
        looping = self.publisher(interval=0.01, max_backoff=0.16)
        with self.assertLogs(LOGGER, "WARNING") as logs:
            looping.start()
            time.sleep(0.6)
            looping.stop()
        self.assertEqual(len(logs.output), 1)  # an unchanged failure is logged once
        # Without backoff this would be about 60 attempts.
        self.assertLessEqual(len(self.backend.requests), 10)

    def test_background_thread_starts_once_and_stops_promptly(self):
        publisher = self.publisher()
        self.publish()
        self.assertTrue(publisher.start())
        self.assertFalse(publisher.start())
        self.assertEqual(self.wait_for_requests(1), 1)
        self.publish()
        self.assertEqual(self.wait_for_requests(2), 2)
        started = time.monotonic()
        publisher.stop()
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertNotIn("backend-publisher", [t.name for t in threading.enumerate()])
        self.assertFalse(publisher.start())

    def test_disabled_publisher_never_starts_a_thread(self):
        publisher = BackendPublisher(self.shared, BackendSettings())
        self.assertFalse(publisher.start())
        status = self.shared.health()["components"]["backend_publisher"]
        self.assertEqual((status["enabled"], status["state"]), (False, "disabled"))


if __name__ == "__main__":
    unittest.main()
