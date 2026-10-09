"""Publish measured traffic observations to the SmartTraffic Node.js backend.

The contract is the backend's own (SmartTraffic backend/backend):

  POST {BACKEND_URL}/api/traffic                 routes/trafficRoutes.js
  Content-Type: application/json                 controllers/trafficController.js
  Authorization: Bearer <TRAFFIC_INGEST_TOKEN>   only when the backend sets one
  {
    "intersectionId": "main",                    an id from config/intersections.js
    "timestamp": "2026-10-09T12:00:00.000Z",     oldest of the four measurement times
    "source": "python-ai",
    "traffic": {"north": {"vehicles": 3, "queueLength": 2, "waitingTime": 4.5},
                "south": {...}, "east": {...}, "west": {...}},
    "emergency": {"detected": false, "type": null, "direction": null, "confidence": 0}
  }

Per approach: vehicles = trusted vehicle detections (confidence >= 0.35),
queueLength = confirmed STOPPED vehicles, waitingTime = their mean stopped time
in video seconds. "emergency" is sent only when Roboflow sampling is enabled and
reports the pipeline's confirmed emergency (three positive samples). The active
pipeline measures no pedestrians, so "pedestrians" is omitted (the backend then
assumes none are waiting) rather than invented.

Nothing is sent until all four approaches have a fresh measurement. One daemon
thread posts the newest observation at most once per interval; failures back
off and nothing is queued, so an unreachable backend never grows memory.
"""

import json
import logging
import math
import os
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http.client import HTTPException
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from app.services.diagnostics import describe_error, redact
from config.config import env_number

log = logging.getLogger(__name__)

DIRECTIONS = ("north", "south", "east", "west")
# Mirrors LIMITS and EMERGENCY_TYPES in the backend's utils/validation.js.
LIMITS = {"vehicles": 1000, "queueLength": 1000, "waitingTime": 3600}
EMERGENCY_TYPES = ("ambulance", "police", "fire_truck", "emergency")
# The Roboflow workflow's only class is "emergency-car", so the service type
# (ambulance/police/fire) is unknown; the backend accepts the generic type.
EMERGENCY_TYPE = "emergency"
SOURCE = "python-ai"
RESERVED_SOURCES = ("mock", "simulation")
ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
TRAFFIC_PATH = "/api/traffic"
MAX_RESPONSE_BYTES = 65536

_SUCCESS = ("sent", "ignored")
_IDLE = ("waiting", "unchanged", "stale")
# Retrying sooner cannot fix these; wait the maximum backoff between attempts.
_PERMANENT = ("invalid", "rejected", "unauthorized", "redirect")


@dataclass(frozen=True)
class BackendSettings:
    url: str = ""  # backend base URL; empty disables publishing
    intersection_id: str = "main"
    token: str = field(default="", repr=False)
    interval: float = 1.0
    timeout: float = 5.0
    max_backoff: float = 30.0

    def __post_init__(self):
        if self.url:
            parts = urlsplit(self.url)
            if (parts.scheme not in ("http", "https") or not parts.hostname
                    or parts.username or parts.password or parts.query or parts.fragment):
                raise ValueError("BACKEND_URL must be an http(s) URL without credentials, "
                                 "query string or fragment")
        if not ID_PATTERN.match(self.intersection_id):
            raise ValueError("INTERSECTION_ID must be 1-64 characters [A-Za-z0-9_-]")
        if self.token and not re.fullmatch(r"[\x21-\x7e]+", self.token):
            raise ValueError("TRAFFIC_INGEST_TOKEN must be printable ASCII without spaces")
        for name, value in (("BACKEND_PUBLISH_INTERVAL", self.interval),
                            ("BACKEND_TIMEOUT", self.timeout)):
            if not math.isfinite(value) or value <= 0:
                raise ValueError(f"{name} must be a positive number of seconds")
        if not math.isfinite(self.max_backoff) or self.max_backoff < self.interval:
            raise ValueError("max_backoff must be at least the publish interval")

    @property
    def enabled(self):
        return bool(self.url)

    @property
    def endpoint(self):
        """The backend route; a URL that already ends in /api/traffic is kept."""
        parts = urlsplit(self.url)
        path = parts.path.rstrip("/")
        if not path.endswith(TRAFFIC_PATH):
            path += TRAFFIC_PATH
        return f"{parts.scheme}://{parts.netloc}{path}"

    @classmethod
    def from_env(cls):
        return cls(
            url=os.environ.get("BACKEND_URL", "").strip(),
            intersection_id=os.environ.get("INTERSECTION_ID", "").strip() or "main",
            token=os.environ.get("TRAFFIC_INGEST_TOKEN", "").strip(),
            interval=env_number("BACKEND_PUBLISH_INTERVAL", 1.0),
            timeout=env_number("BACKEND_TIMEOUT", 5.0),
        )


def _iso(timestamp):
    moment = datetime.fromtimestamp(timestamp, tz=UTC)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_observation(state, intersection_id):
    """Map SharedState.traffic() to the backend body; None until measurable."""
    if not state.get("available"):
        return None
    data = state.get("data") or {}
    directions = data.get("directions") or {}
    traffic, measured = {}, []
    for name in DIRECTIONS:
        entry = directions.get(name) or {}
        vehicles, queue = entry.get("trusted_vehicles"), entry.get("stopped_vehicles")
        wait, measured_at = entry.get("mean_wait_seconds"), entry.get("measured_at")
        if vehicles is None or queue is None or wait is None or measured_at is None:
            return None  # this approach has no measurement yet: send nothing
        traffic[name] = {
            "vehicles": int(vehicles),
            "queueLength": int(queue),
            # Backend maximum; only a vehicle parked in view for an hour exceeds it.
            "waitingTime": round(min(float(wait), LIMITS["waitingTime"]), 1),
        }
        measured.append(float(measured_at))
    observation = {"intersectionId": intersection_id, "timestamp": _iso(min(measured)),
                   "source": SOURCE, "traffic": traffic}
    emergency = data.get("emergency") or {}
    if emergency.get("enabled"):
        confidence = emergency.get("confidence")
        if not emergency.get("active"):
            observation["emergency"] = {"detected": False, "type": None,
                                        "direction": None, "confidence": 0}
        elif emergency.get("direction") in DIRECTIONS and confidence is not None:
            observation["emergency"] = {"detected": True, "type": EMERGENCY_TYPE,
                                        "direction": emergency["direction"],
                                        "confidence": round(float(confidence), 3)}
    return observation


def _in_range(value: Any, low: float, high: float) -> bool:
    """A finite real number (not bool) within [low, high]."""
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and low <= value <= high)


def validate_observation(observation):
    """Mirror utils/validation.js so a contract mismatch is caught before sending."""
    if not isinstance(observation, dict):
        return ["observation must be an object"]
    errors = []
    identifier = observation.get("intersectionId")
    if not isinstance(identifier, str) or not ID_PATTERN.match(identifier):
        errors.append("intersectionId must be 1-64 characters [A-Za-z0-9_-]")
    timestamp = observation.get("timestamp")
    if timestamp is not None:
        try:
            datetime.fromisoformat(str(timestamp))
        except ValueError:
            errors.append("timestamp must be an ISO-8601 string")
    source = observation.get("source")
    if source is not None and (not isinstance(source, str) or len(source) > 32
                               or source.strip().lower() in RESERVED_SOURCES):
        errors.append("source must be a live producer tag of at most 32 characters")
    traffic = observation.get("traffic")
    if not isinstance(traffic, dict) or set(traffic) != set(DIRECTIONS):
        errors.append("traffic must contain exactly north, south, east and west")
    else:
        for name in DIRECTIONS:
            entry = traffic[name] if isinstance(traffic[name], dict) else {}
            for key, limit in LIMITS.items():
                if not _in_range(entry.get(key), 0, limit):
                    errors.append(f"traffic.{name}.{key} must be a number between 0 and {limit}")
    emergency = observation.get("emergency")
    if emergency is not None:
        if not isinstance(emergency, dict) or not isinstance(emergency.get("detected"), bool):
            errors.append("emergency.detected must be a boolean")
        else:
            if not _in_range(emergency.get("confidence"), 0, 1):
                errors.append("emergency.confidence must be a number between 0 and 1")
            if emergency["detected"]:
                if emergency.get("type") not in EMERGENCY_TYPES:
                    errors.append(f"emergency.type must be one of {', '.join(EMERGENCY_TYPES)}")
                if emergency.get("direction") not in DIRECTIONS:
                    errors.append("emergency.direction must be north, south, east or west")
    return errors


def _read_json(response):
    try:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            return None
        value = json.loads(raw)
    except (OSError, HTTPException, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _backend_error(reply):
    """The backend's own error text (field names and limits, never secrets)."""
    if not reply:
        return "no JSON error body"
    parts = [str(reply.get("error") or "")]
    details = reply.get("details")
    if isinstance(details, list):
        parts.extend(str(detail) for detail in details[:5])
    return redact("; ".join(part for part in parts if part) or "no error message")


class _NoRedirect(HTTPRedirectHandler):
    """Never replay the POST, or its Authorization header, to another URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class BackendPublisher:
    """One background thread that posts the newest observation; start() is idempotent."""

    def __init__(self, shared, settings, *, opener=None):
        self.shared = shared
        self.settings = settings
        self._opener = opener or build_opener(_NoRedirect)
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread = None
        self._last_key: tuple[str, str] | None = None
        self._last_log: tuple[tuple[str, str] | None, float] = (None, -math.inf)
        self._status = {
            "enabled": settings.enabled,
            "endpoint": settings.endpoint if settings.enabled else None,
            "intersection_id": settings.intersection_id,
            "authorization": "bearer" if settings.token else "none",
            "state": "idle" if settings.enabled else "disabled",
            "sent": 0, "failed": 0, "consecutive_failures": 0,
            "last_attempt_at": None, "last_success_at": None,
            "last_http_status": None, "last_error": None,
        }
        self._report()

    def status(self):
        with self._lock:
            return dict(self._status)

    def start(self):
        with self._lock:
            if not self.settings.enabled or self._thread is not None or self._stop.is_set():
                return False
            self._thread = threading.Thread(target=self._run, name="backend-publisher", daemon=True)
            self._thread.start()
        log.info("Publishing traffic observations to %s as intersection '%s' (authorization: %s)",
                 self.settings.endpoint, self.settings.intersection_id, self._status["authorization"])
        return True

    def stop(self, timeout=None):
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(self.settings.timeout + 1 if timeout is None else timeout)

    def _run(self):
        delay = self.settings.interval
        while not self._stop.wait(delay):
            try:
                outcome = self.publish_once()
            except Exception as exc:  # a bug here must be visible, not a dead thread
                outcome = self._failure("error", None, describe_error(exc, (self.settings.token,)))
                log.debug("Backend publisher failure details", exc_info=True)
            delay = self._next_delay(outcome)

    def _next_delay(self, outcome):
        if outcome in _SUCCESS or outcome in _IDLE:
            return self.settings.interval
        if outcome in _PERMANENT:
            return self.settings.max_backoff
        failures = self.status()["consecutive_failures"]
        return min(self.settings.interval * 2 ** min(failures, 10), self.settings.max_backoff)

    def publish_once(self):
        """Send the newest unsent observation; return the outcome name."""
        observation = build_observation(self.shared.traffic(), self.settings.intersection_id)
        if observation is None:
            self._update(state="waiting_for_data")
            return "waiting"
        key = (observation["timestamp"], json.dumps(observation.get("emergency"), sort_keys=True))
        if key == self._last_key:
            return "unchanged"
        errors = validate_observation(observation)
        if errors:
            self._last_key = key
            return self._failure("invalid", None, "; ".join(errors))
        body = json.dumps(observation, allow_nan=False, separators=(",", ":")).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.settings.token:
            headers["Authorization"] = f"Bearer {self.settings.token}"
        request = Request(self.settings.endpoint, data=body, headers=headers, method="POST")
        self._update(last_attempt_at=time.time())
        try:
            with self._opener.open(request, timeout=self.settings.timeout) as response:
                status, reply = response.status, _read_json(response)
        except HTTPError as exc:
            with exc:
                status, reply = exc.code, _read_json(exc)
        except (OSError, HTTPException, ValueError) as exc:
            # Refused/reset connections, DNS and TLS failures, and timeouts.
            return self._failure("unreachable", None, describe_error(exc, (self.settings.token,)))
        return self._handle(status, reply, key)

    def _handle(self, status, reply, key):
        if status in (200, 202):
            self._last_key = key
            ignored = status == 202 or bool(reply and reply.get("ignored"))
            with self._lock:
                recovered = self._status["consecutive_failures"] > 0 or self._status["sent"] == 0
                self._status.update(state="ok", consecutive_failures=0, last_http_status=status,
                                    last_success_at=time.time(), last_error=None,
                                    sent=self._status["sent"] + 1)
            self._report()
            if recovered:
                log.info("Backend accepted traffic observation (HTTP %s)", status)
            return "ignored" if ignored else "sent"
        message = _backend_error(reply)
        if status == 409:
            # The backend already stores a newer observation (another producer
            # or a clock change); drop this one instead of retrying it.
            self._last_key = key
            self._update(last_http_status=status, last_error=f"stale: {message}")
            self._log_failure("stale", f"HTTP 409 {message}")
            return "stale"
        if status in (401, 403):
            return self._failure("unauthorized", status, f"HTTP {status}: backend rejected the "
                                 "ingest token; set the same TRAFFIC_INGEST_TOKEN on both services")
        if 300 <= status < 400:
            return self._failure("redirect", status, f"HTTP {status}: backend redirected; set "
                                 "BACKEND_URL to the final https:// URL")
        if status in (400, 404, 413, 415, 422):
            self._last_key = key  # the same observation would be refused again
            return self._failure("rejected", status, f"HTTP {status}: {message}")
        return self._failure("server_error", status, f"HTTP {status}: {message}")

    def _failure(self, outcome, status, message):
        with self._lock:
            self._status.update(state="error", last_http_status=status,
                                last_error=f"{outcome}: {message}",
                                failed=self._status["failed"] + 1,
                                consecutive_failures=self._status["consecutive_failures"] + 1)
        self._report()
        self._log_failure(outcome, message)
        return outcome

    def _log_failure(self, outcome, message):
        # Repeat an unchanged failure at most once a minute instead of every attempt.
        now = time.monotonic()
        signature = (outcome, message)
        if signature != self._last_log[0] or now - self._last_log[1] >= 60:
            self._last_log = (signature, now)
            level = logging.ERROR if outcome in ("invalid", "error") else logging.WARNING
            log.log(level, "Backend publish %s: %s", outcome, message)

    def _update(self, **fields):
        with self._lock:
            self._status.update(fields)
        self._report()

    def _report(self):
        self.shared.report_component("backend_publisher", self.status())
