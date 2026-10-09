"""Bounded, synchronized state shared by one AI loop and all HTTP viewers."""

import copy
import math
import threading
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np

DIRECTIONS = ("north", "south", "west", "east")


def json_safe(value):
    """Normalize NumPy scalars/arrays and nonfinite floats before publication."""
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [json_safe(v) for v in value]
    if hasattr(value, "tolist"):
        return json_safe(value.tolist())
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


class SharedState:
    def __init__(self, settings):
        self.settings = settings
        self.condition = threading.Condition()
        self._status = "not_started"
        self._reason: str | None = None
        self._snapshot: dict | None = None
        self._updated_mono: float | None = None
        self._cameras: list[dict[str, str | float | None]] = [
            {"direction": name, "status": "waiting", "last_read_at": None,
             "last_frame_at": None, "stream_url": f"/video/{name}"}
            for name in DIRECTIONS
        ]
        self._jpeg: list[bytes | None] = [None] * 4
        self._frame_mono: list[float | None] = [None] * 4
        self._sequences = [0] * 4
        self._pending: tuple[tuple["np.ndarray", ...], float, float] | None = None
        self._next_offer = 0.0
        self._closed = False
        self._thread: threading.Thread | None = None
        self._encoder_error: str | None = None
        # Status reported by background components (publisher, supervisor, ...).
        self._components: dict[str, dict] = {}
        self._stream_clients = 0

    def start_encoder(self):
        with self.condition:
            if self._closed:
                raise RuntimeError("Cannot restart a closed SharedState")
            if self._thread is not None:
                return
            self._thread = threading.Thread(target=self._encode, name="display-jpeg", daemon=True)
            self._thread.start()

    def set_lifecycle(self, status, reason=None):
        with self.condition:
            self._status, self._reason = status, reason
            self.condition.notify_all()

    def report_component(self, name, status):
        """Replace one component's diagnostic status (JSON-safe, never secrets)."""
        normalized = json_safe(status)
        with self.condition:
            self._components[name] = normalized

    def acquire_stream(self):
        """Reserve an MJPEG viewer slot; False when closed or at capacity.

        Each stream holds one server thread for its whole lifetime, so the cap
        keeps threads free for health checks and JSON requests.
        """
        with self.condition:
            if self._closed or self._stream_clients >= self.settings.max_stream_clients:
                return False
            self._stream_clients += 1
            return True

    def release_stream(self):
        with self.condition:
            self._stream_clients = max(0, self._stream_clients - 1)

    def camera_status(self, index, status):
        with self.condition:
            self._cameras[index]["status"] = status

    def camera_read(self, index):
        with self.condition:
            self._cameras[index].update(status="processing", last_read_at=time.time())

    def publish_snapshot(self, snapshot):
        normalized = json_safe(snapshot)
        with self.condition:
            if self._closed:
                return
            self._snapshot = normalized
            self._updated_mono = time.monotonic()
            self._status, self._reason = "running", None

    def offer_frames(self, frames):
        """Transfer ownership of completed display frames; never mutate them later.

        At most one batch is pending and one is encoding. No copies or JPEG work
        occur here, and slow viewers never hold this lock while writing sockets.
        """
        now = time.monotonic()
        with self.condition:
            if self._closed or now < self._next_offer:
                return
            self._next_offer = now + 1 / self.settings.display_fps
            self._pending = (tuple(frames), now, time.time())
            self.condition.notify_all()

    def _encode(self):
        import cv2

        while True:
            with self.condition:
                self.condition.wait_for(lambda: self._closed or self._pending is not None)
                if self._closed:
                    return
                pending = self._pending
                if pending is None:
                    continue
                frames, captured_mono, captured_at = pending
                self._pending = None
            try:
                encoded = []
                for frame in frames:
                    ok, jpeg_array = cv2.imencode(".jpg", frame,
                                            [cv2.IMWRITE_JPEG_QUALITY, self.settings.jpeg_quality])
                    if not ok:
                        raise ValueError("JPEG encoding failed")
                    encoded.append(jpeg_array.tobytes())
            except Exception as exc:
                with self.condition:
                    self._encoder_error = type(exc).__name__
                    self.condition.notify_all()
                continue
            with self.condition:
                if self._closed:
                    return
                for i, data in enumerate(encoded):
                    self._jpeg[i] = data
                    self._sequences[i] += 1
                    self._frame_mono[i] = captured_mono
                    self._cameras[i]["last_frame_at"] = captured_at
                self._encoder_error = None
                self.condition.notify_all()

    def _frame_available(self, index, now):
        captured = self._frame_mono[index]
        return (not self._closed and self._status == "running" and self._jpeg[index] is not None
                and captured is not None and now - captured <= self.settings.stale_seconds)

    def frame_available(self, index):
        with self.condition:
            return self._frame_available(index, time.monotonic())

    def wait_frame(self, index, after_sequence, timeout=1.0):
        with self.condition:
            self.condition.wait_for(
                lambda: self._sequences[index] > after_sequence or self._closed
                or self._status != "running", timeout=timeout)
            if not self._frame_available(index, time.monotonic()):
                return None
            if self._sequences[index] == after_sequence:
                return None
            return self._sequences[index], self._jpeg[index]

    def traffic(self):
        with self.condition:
            age = None if self._updated_mono is None else time.monotonic() - self._updated_mono
            return {
                "available": (not self._closed and self._status == "running"
                              and age is not None and age <= self.settings.stale_seconds),
                "pipeline_status": self._status, "age_seconds": age,
                "data": copy.deepcopy(self._snapshot),
            }

    def cameras(self):
        with self.condition:
            now = time.monotonic()
            return {"cameras": [{**camera, "available": self._frame_available(i, now),
                                 "frame_sequence": self._sequences[i],
                                 "frame_age_seconds": (now - captured)
                                 if (captured := self._frame_mono[i]) is not None else None}
                                for i, camera in enumerate(self._cameras)]}

    def health(self):
        with self.condition:
            now = time.monotonic()
            fresh = self._updated_mono is not None and now - self._updated_mono <= self.settings.stale_seconds
            ready = fresh and all(self._frame_available(i, now) for i in range(4))
            return {"service": "smart-traffic-ai", "ready": ready,
                    "pipeline_status": self._status, "reason": self._reason,
                    "encoder_error": self._encoder_error,
                    "updated_at": self._snapshot["updated_at"] if self._snapshot else None,
                    "stream_clients": self._stream_clients,
                    "components": copy.deepcopy(self._components)}

    def finish_pipeline(self):
        with self.condition:
            if self._status not in {"failed", "stopped"}:
                self._status = "stopped"
            for camera in self._cameras:
                if camera["status"] == "opening" and self._status == "failed":
                    camera["status"] = "open_failed"
                elif camera["status"] in {"opened", "processing"}:
                    camera["status"] = "released"
            self.condition.notify_all()

    def close(self):
        with self.condition:
            self._closed = True
            self._pending = None
            self.condition.notify_all()
        if self._thread is not None:
            self._thread.join(timeout=5)
