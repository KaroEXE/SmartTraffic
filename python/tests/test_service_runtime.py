"""Service lifecycle, WSGI import and gunicorn hooks, without cameras or models."""

import contextlib
import os
import runpy
import signal
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import app.pipeline as pipeline_module
from app.services.backend_publisher import BackendSettings
from app.services.runtime import TrafficService
from flaskk.config import WebSettings

ROOT = Path(__file__).resolve().parents[1]
SERVICE_THREADS = ("traffic-ai", "display-jpeg", "backend-publisher")


class FakePipeline:
    """Fails `failures` times (or ends like a finished video), then runs until stopped."""

    def __init__(self, failures=0, error=None, end_instead=False):
        self.failures = failures
        self.error = error or RuntimeError("rtsp://user:secret@camera.test/stream?token=abc failed")
        self.end_instead = end_instead
        self.calls = []
        self.running = threading.Event()

    def __call__(self, *, stop_event, publisher, show_window):
        assert show_window is False
        self.calls.append(time.monotonic())
        publisher.set_lifecycle("starting")
        if len(self.calls) <= self.failures:
            if self.end_instead:
                publisher.set_lifecycle("stopped", "camera_read_ended")
                publisher.finish_pipeline()
                return
            publisher.set_lifecycle("failed", type(self.error).__name__)
            publisher.finish_pipeline()
            raise self.error
        self.running.set()
        stop_event.wait()
        publisher.finish_pipeline()


def service_threads():
    return [thread.name for thread in threading.enumerate() if thread.name in SERVICE_THREADS]


def wait_until(condition, timeout=3.0):
    deadline = time.monotonic() + timeout
    while not condition() and time.monotonic() < deadline:
        time.sleep(0.01)
    return condition()


class TrafficServiceTests(unittest.TestCase):
    def service(self, pipeline, restart_seconds=0.05, **kwargs):
        service = TrafficService(WebSettings(), BackendSettings(), pipeline=pipeline,
                                 restart_seconds=restart_seconds, **kwargs)
        self.addCleanup(service.stop)
        return service

    def test_creating_a_service_starts_nothing(self):
        before = set(threading.enumerate())
        pipeline = FakePipeline()
        service = self.service(pipeline)
        self.assertEqual(set(threading.enumerate()), before)
        self.assertEqual(pipeline.calls, [])
        client = service.app.test_client()
        self.assertEqual(client.get("/api/health/live").status_code, 200)
        self.assertEqual(client.get("/api/health").status_code, 503)

    def test_start_runs_exactly_one_pipeline_and_stop_is_prompt(self):
        pipeline = FakePipeline()
        service = self.service(pipeline)
        self.assertTrue(service.start())
        self.assertFalse(service.start())
        self.assertTrue(pipeline.running.wait(3))
        self.assertEqual(len(pipeline.calls), 1)
        self.assertEqual(sorted(service_threads()), ["display-jpeg", "traffic-ai"])
        started = time.monotonic()
        service.stop()
        service.stop()
        self.assertLess(time.monotonic() - started, 2)
        self.assertFalse(service.running)
        self.assertEqual(service_threads(), [])
        self.assertFalse(service.start())  # a stopped service stays stopped

    def test_failures_restart_with_backoff_and_redacted_logs(self):
        pipeline = FakePipeline(failures=2)
        service = self.service(pipeline, restart_seconds=0.05)
        with self.assertLogs("app.services.runtime", "INFO") as logs:
            service.start()
            self.assertTrue(pipeline.running.wait(3))
        self.assertEqual(len(pipeline.calls), 3)
        first, second = (b - a for a, b in zip(pipeline.calls, pipeline.calls[1:]))
        self.assertGreaterEqual(first, 0.04)
        self.assertGreaterEqual(second, 0.09)  # the delay doubled
        supervisor = service.shared.health()["components"]["supervisor"]
        self.assertEqual((supervisor["restarts"], supervisor["last_exit"]), (2, "RuntimeError"))
        output = "\n".join(logs.output)
        self.assertIn("rtsp://camera.test/stream", output)
        self.assertNotIn("secret", output)
        self.assertNotIn("token=abc", output)

    def test_ended_source_is_restarted_too(self):
        pipeline = FakePipeline(failures=1, end_instead=True)
        service = self.service(pipeline)
        with self.assertLogs("app.services.runtime", "INFO") as logs:
            service.start()
            self.assertTrue(pipeline.running.wait(3))
        self.assertIn("AI pipeline stopped: camera_read_ended", logs.output[0])
        supervisor = service.shared.health()["components"]["supervisor"]
        self.assertEqual((supervisor["restarts"], supervisor["last_exit"]), (1, "camera_read_ended"))

    def test_restart_can_be_disabled_and_the_web_service_stays_up(self):
        pipeline = FakePipeline(failures=1)
        service = self.service(pipeline, restart_seconds=0)
        with self.assertLogs("app.services.runtime", "WARNING"):
            service.start()
            self.assertTrue(wait_until(lambda: not service.running))
        self.assertEqual(len(pipeline.calls), 1)
        client = service.app.test_client()
        self.assertEqual(client.get("/api/health/live").json["pipeline_status"], "failed")
        health = client.get("/api/health")
        self.assertEqual((health.status_code, health.json["reason"]), (503, "RuntimeError"))

    def test_stop_during_a_long_backoff_returns_promptly(self):
        pipeline = FakePipeline(failures=100)
        service = self.service(pipeline, restart_seconds=30)
        with self.assertLogs("app.services.runtime", "INFO"):
            service.start()
            self.assertTrue(wait_until(lambda: service.shared.health()["components"]
                                       ["supervisor"].get("restarts") == 1))
        started = time.monotonic()
        service.stop()
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(len(pipeline.calls), 1)

    def test_repeated_initialization_leaves_no_threads(self):
        for _ in range(3):
            pipeline = FakePipeline()
            service = TrafficService(WebSettings(), BackendSettings(), pipeline=pipeline)
            service.start()
            self.assertTrue(pipeline.running.wait(3))
            service.stop()
        self.assertEqual(service_threads(), [])

    def test_missing_model_fails_before_cameras_and_keeps_http_alive(self):
        opened: list[str] = []
        service = TrafficService(WebSettings(), BackendSettings(), restart_seconds=0)
        self.addCleanup(service.stop)
        with mock.patch.object(pipeline_module, "MODEL_PATH", ROOT / "AI-models" / "absent.pt"), \
                mock.patch.object(pipeline_module, "open_video", side_effect=opened.append), \
                mock.patch.dict(sys.modules, {"ultralytics": SimpleNamespace(YOLO=None)}), \
                self.assertLogs("app.services.runtime", "WARNING") as logs:
            service.start()
            self.assertTrue(wait_until(lambda: not service.running))
        self.assertEqual(opened, [])
        self.assertIn("FileNotFoundError", "\n".join(logs.output))
        client = service.app.test_client()
        self.assertEqual(client.get("/api/health/live").status_code, 200)
        self.assertEqual(client.get("/api/health").json["reason"], "FileNotFoundError")


class WsgiEntryPointTests(unittest.TestCase):
    def test_importing_wsgi_builds_the_app_without_starting_anything(self):
        code = r'''
import sys, threading
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
def forbidden(*args, **kwargs):
    raise AssertionError("work started while importing wsgi")
sys.modules["ultralytics"] = SimpleNamespace(YOLO=forbidden)
import cv2
cv2.VideoCapture = forbidden
threading.Thread.start = forbidden
import wsgi
from flask import Flask
assert isinstance(wsgi.app, Flask) and wsgi.app is wsgi.service.app
assert "app.pipeline" not in sys.modules and "torch" not in sys.modules
client = wsgi.app.test_client()
assert client.get("/api/health/live").status_code == 200
assert client.get("/api/health").status_code == 503
assert client.get("/api/traffic").json["data"] is None
'''
        environment = {**os.environ, "BACKEND_URL": "", "LOG_LEVEL": "WARNING"}
        result = subprocess.run([sys.executable, "-c", code, str(ROOT)], cwd=ROOT.parent,
                                capture_output=True, text=True, env=environment, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)


class GunicornConfigTests(unittest.TestCase):
    def load(self, **environment):
        with mock.patch.dict(os.environ, environment):
            return runpy.run_path(str(ROOT / "gunicorn.conf.py"))

    def test_one_worker_process_with_threads_on_the_render_port(self):
        config = self.load(PORT="12345", WEB_CONCURRENCY="4", MAX_STREAM_CLIENTS="6",
                           GUNICORN_THREADS="")
        self.assertEqual((config["workers"], config["worker_class"]), (1, "gthread"))
        self.assertEqual(config["threads"], 10)
        self.assertEqual(config["bind"], "0.0.0.0:12345")
        self.assertEqual(config["wsgi_app"], "wsgi:app")
        self.assertFalse(config["preload_app"])
        self.assertEqual(config["max_requests"], 0)

    def test_hooks_start_and_stop_the_service_and_keep_gunicorns_sigterm(self):
        config = self.load()
        service = mock.Mock()
        fake_wsgi = SimpleNamespace(service=service)  # what `import wsgi` returns
        gunicorn_handled = []
        previous = signal.getsignal(signal.SIGTERM)
        self.addCleanup(signal.signal, signal.SIGTERM, previous)
        signal.signal(signal.SIGTERM, lambda signum, frame: gunicorn_handled.append(signum))
        with mock.patch.dict(sys.modules, {"wsgi": fake_wsgi}):
            config["post_worker_init"](object())
            service.start.assert_called_once_with()
            handler = signal.getsignal(signal.SIGTERM)
            assert callable(handler)
            handler(signal.SIGTERM, None)
            self.assertEqual(gunicorn_handled, [signal.SIGTERM])
            self.assertTrue(wait_until(lambda: service.stop.called))
            config["worker_exit"](None, None)
        self.assertEqual(service.stop.call_count, 2)
        with mock.patch.dict(sys.modules), contextlib.suppress(KeyError):
            del sys.modules["wsgi"]
            config["worker_exit"](None, None)  # the app never loaded: nothing to stop


if __name__ == "__main__":
    unittest.main()
