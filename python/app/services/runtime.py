"""One process-wide owner of the AI pipeline, JPEG encoder and backend publisher.

Creating a TrafficService builds the Flask app and its SharedState only: no
camera, model, or thread starts. start() launches the background work exactly
once per service and stop() is idempotent. The production server (wsgi.py +
gunicorn.conf.py) runs exactly one service per process.

The supervisor restarts the whole four-camera pipeline after it fails or a
source ends, waiting PIPELINE_RESTART_SECONDS (doubling up to five minutes
while runs keep failing quickly). One input cannot be dropped and the rest
kept: the backend contract needs all four approaches, and the pipeline would
otherwise have to invent the missing one. The web service stays up meanwhile
and /api/health reports what failed.
"""

import logging
import threading
import time

from app.services.backend_publisher import BackendPublisher, BackendSettings
from app.services.diagnostics import describe_error
from app.services.shared_state import SharedState
from config.config import env_number
from flaskk.app import create_app
from flaskk.config import WebSettings

log = logging.getLogger(__name__)


class TrafficService:
    def __init__(self, settings, backend_settings, *, restart_seconds=10.0,
                 max_restart_seconds=300.0, healthy_run_seconds=60.0, pipeline=None):
        if restart_seconds < 0:
            raise ValueError("PIPELINE_RESTART_SECONDS must be 0 (disabled) or positive")
        self.settings = settings
        self.shared = SharedState(settings)
        self.app = create_app(self.shared, settings)
        self.publisher = BackendPublisher(self.shared, backend_settings)
        self.restart_seconds = restart_seconds
        self.max_restart_seconds = max(restart_seconds, max_restart_seconds)
        self.healthy_run_seconds = healthy_run_seconds
        self._pipeline = pipeline  # injectable for tests; app.pipeline.run by default
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread = None
        self._started = False
        self._stopped = False
        self._report(restarts=0, last_exit=None, next_restart_at=None)

    @classmethod
    def from_env(cls, **kwargs):
        return cls(WebSettings.from_env(), BackendSettings.from_env(),
                   restart_seconds=env_number("PIPELINE_RESTART_SECONDS", 10.0), **kwargs)

    @property
    def running(self):
        thread = self._thread
        return thread is not None and thread.is_alive()

    def start(self):
        """Start the encoder, publisher and supervised pipeline once; later calls do nothing."""
        with self._lock:
            if self._started or self._stopped:
                return False
            self._started = True
            self.shared.start_encoder()
            self.publisher.start()
            self._thread = threading.Thread(target=self._supervise, name="traffic-ai", daemon=True)
            self._thread.start()
        return True

    def stop(self, timeout=10.0):
        """Stop every background thread; cameras are released by the pipeline's cleanup.

        Safe to call repeatedly and concurrently; every call waits (up to
        timeout) for the pipeline thread to finish its cleanup.
        """
        with self._lock:
            first = not self._stopped
            self._stopped = True
        if first:
            self._stop.set()
            self.publisher.stop()
            # Closing wakes MJPEG viewers and the encoder so open streams end now.
            self.shared.close()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout)
            if thread.is_alive():
                log.warning("AI pipeline did not stop within %.0f s (a capture may be blocked)", timeout)

    def _report(self, **fields):
        self.shared.report_component("supervisor", {
            "restart_seconds": self.restart_seconds, **fields})

    def _supervise(self):
        if self._pipeline is None:
            from app.pipeline import run  # cv2/numpy only load when the service starts
        else:
            run = self._pipeline
        delay = self.restart_seconds
        restarts = 0
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                run(stop_event=self._stop, publisher=self.shared, show_window=False)
                health = self.shared.health()
                last_exit = health["reason"] or health["pipeline_status"]
                if not self._stop.is_set():
                    log.warning("AI pipeline stopped: %s", last_exit)
            except Exception as exc:
                last_exit = type(exc).__name__
                log.error("AI pipeline failed: %s", describe_error(exc))
                log.debug("AI pipeline failure details", exc_info=True)
            if self._stop.is_set():
                break
            if self.restart_seconds == 0:
                log.warning("Automatic restart disabled (PIPELINE_RESTART_SECONDS=0); "
                            "the status API stays available")
                self._report(restarts=restarts, last_exit=last_exit, next_restart_at=None)
                break
            if time.monotonic() - started >= self.healthy_run_seconds:
                delay = self.restart_seconds
            restarts += 1
            self._report(restarts=restarts, last_exit=last_exit, next_restart_at=time.time() + delay)
            log.info("Restarting AI pipeline in %.0f s (restart %d)", delay, restarts)
            if self._stop.wait(delay):
                break
            delay = min(delay * 2, self.max_restart_seconds)
