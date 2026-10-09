"""Background Roboflow inference and emergency policy for the traffic simulation.

No camera, YOLO, GUI, or network work runs at import time. The controller remains
on the main thread; workers only return observations from their assigned camera.
"""

import base64
from dataclasses import dataclass
import json
import math
from queue import Empty, Full, Queue
import threading
import time
from urllib.request import Request, urlopen

from config import config


DIRECTIONS = tuple(config.names)
WORKFLOW_URL = config.WORKFLOW_URL


@dataclass(frozen=True)
class EmergencySettings:
    sample_seconds: float = 2.0
    request_timeout: float = config.ROBOFLOW_TIMEOUT
    max_result_age: float = 6.0
    confidence: float = 0.60
    confirmations: int = 3
    confirmation_gap: float = 6.0
    release_seconds: float = 6.0
    max_priority_seconds: float = 20.0
    cooldown_seconds: float = 10.0
    all_red_seconds: float = 1.0
    max_image_side: int = 960


@dataclass(frozen=True)
class EmergencyDetection:
    label: str
    confidence: float
    # Normalized corners relative to the sampled image, for any display size.
    xyxy: tuple


def parse_workflow_response(payload, min_confidence=0.60):
    """Parse the observed workflow output, rejecting malformed responses.

    Serverless JSON has an `outputs` envelope (also observed via specs_run).
    workflows_run MCP unwraps that envelope to a list. Both contain precisely
    output['predictions']['predictions']; a missing field is NOT an empty scene.
    """
    outputs = payload["outputs"] if isinstance(payload, dict) else payload
    if not isinstance(outputs, list) or len(outputs) != 1:
        raise ValueError("Expected exactly one image output")
    result = outputs[0]["predictions"]
    width, height = result["image"]["width"], result["image"]["height"]
    if not all(isinstance(v, (int, float)) and math.isfinite(v) and v > 0
               for v in (width, height)):
        raise ValueError("Invalid output image dimensions")
    predictions = result["predictions"]
    if not isinstance(predictions, list):
        raise ValueError("Expected a prediction list")
    detections = []
    for prediction in predictions:
        label = prediction["class"]
        confidence = prediction["confidence"]
        x, y, w, h = (prediction[k] for k in ("x", "y", "width", "height"))
        if not all(isinstance(v, (int, float)) and math.isfinite(v)
                   for v in (confidence, x, y, w, h)):
            raise ValueError("Invalid prediction numbers")
        if not 0 <= confidence <= 1 or w <= 0 or h <= 0:
            raise ValueError("Invalid confidence or bounding box")
        if label != "emergency-car" or confidence < min_confidence:
            continue
        corners = (max(0., (x - w / 2) / width),
                   max(0., (y - h / 2) / height),
                   min(1., (x + w / 2) / width),
                   min(1., (y + h / 2) / height))
        if corners[2] <= corners[0] or corners[3] <= corners[1]:
            raise ValueError("Bounding box outside image")
        detections.append(EmergencyDetection(label, confidence, corners))
    return tuple(detections)


@dataclass(frozen=True)
class InferenceResult:
    road: int
    captured_at: float
    detections: tuple = ()
    error: str = ""
    sequence: int = 0


def _replace_latest(queue, item):
    try:
        queue.put_nowait(item)
    except Full:
        try:
            queue.get_nowait()
        except Empty:
            pass
        queue.put_nowait(item)


class RoboflowSampler:
    """One daemon worker and one pending frame per road: bounded, fair queues.

    HTTP and JPEG encoding happen only in workers. A slow road cannot starve
    the other cameras. Pending frames are replaced rather than accumulating.
    """

    def __init__(self, settings=None, infer=None):
        self.settings = settings or EmergencySettings()
        self._api_key = config.ROBOFLOW_API_KEY
        self.enabled = bool(self._api_key) or infer is not None
        self._infer = infer or self._request
        self._stop = threading.Event()
        self._inputs = [Queue(maxsize=1) for _ in DIRECTIONS]
        self._outputs = [Queue(maxsize=1) for _ in DIRECTIONS]
        self._last_submit = [-math.inf] * len(DIRECTIONS)
        self._threads = []
        if self.enabled:
            for road in range(len(DIRECTIONS)):
                thread = threading.Thread(target=self._worker, args=(road,),
                                          name=f"roboflow-{DIRECTIONS[road]}", daemon=True)
                thread.start()
                self._threads.append(thread)

    def submit(self, road, frame, captured_at):
        if (not self.enabled or self._stop.is_set()
                or captured_at - self._last_submit[road] < self.settings.sample_seconds):
            return False
        self._last_submit[road] = captured_at
        # Own the image before the video loop adds annotations/reuses storage.
        _replace_latest(self._inputs[road], (captured_at, frame.copy()))
        return True

    def poll(self):
        results = []
        for queue in self._outputs:
            try:
                results.append(queue.get_nowait())
            except Empty:
                pass
        return results

    def close(self):
        # In-flight HTTP has a socket timeout; shutdown never waits on network.
        self._stop.set()

    def _worker(self, road):
        sequence = 0
        while not self._stop.is_set():
            try:
                captured_at, frame = self._inputs[road].get(timeout=0.1)
            except Empty:
                continue
            if self._stop.is_set():
                break
            sequence += 1
            try:
                if time.monotonic() - captured_at > self.settings.max_result_age:
                    raise TimeoutError("Queued frame expired")
                payload = self._infer(frame)
                detections = parse_workflow_response(payload, self.settings.confidence)
                result = InferenceResult(road, captured_at, detections, sequence=sequence)
            except Exception as exc:
                # Never print HTTP bodies, request payloads, or API credentials.
                result = InferenceResult(road, captured_at, error=type(exc).__name__,
                                         sequence=sequence)
            if not self._stop.is_set():
                _replace_latest(self._outputs[road], result)

    def _request(self, frame):
        import cv2

        height, width = frame.shape[:2]
        scale = min(1., self.settings.max_image_side / max(width, height))
        if scale < 1:
            frame = cv2.resize(frame, (round(width * scale), round(height * scale)))
        success, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if not success:
            raise ValueError("JPEG encoding failed")
        body = {
            "api_key": self._api_key,
            "inputs": {"image": {"type": "base64",
                                  "value": base64.b64encode(encoded).decode("ascii")}},
        }
        request = Request(WORKFLOW_URL, data=json.dumps(body).encode("utf-8"),
                          headers={"Content-Type": "application/json"}, method="POST")
        with urlopen(request, timeout=self.settings.request_timeout) as response:
            raw = response.read(1_000_001)
        if len(raw) > 1_000_000:
            raise ValueError("Workflow response too large")
        return json.loads(raw)


@dataclass
class _RoadEvidence:
    hits: int = 0
    last_sample: float = -math.inf
    last_sequence: int = 0
    last_positive: float = -math.inf
    confirmed_at: float | None = None
    cooldown_until: float = -math.inf
    detections: tuple = ()
    status: str = "WAITING"
    # Highest confidence in the latest positive sample; 0 once evidence clears.
    confidence: float = 0.0

    def clear(self):
        self.hits = 0
        self.last_positive = -math.inf
        self.confirmed_at = None
        self.detections = ()
        self.confidence = 0.0


class EmergencyPriority:
    """Main-thread evidence and priority policy; never changes YOLO counts."""

    def __init__(self, settings=None):
        self.settings = settings or EmergencySettings()
        self.roads = [_RoadEvidence() for _ in DIRECTIONS]
        self.target = None
        self.green_road = None
        self.green_since = None

    def observe(self, result, now):
        road = self.roads[result.road]
        if result.captured_at <= road.last_sample:
            return  # polling/replaying a result cannot confirm an emergency
        road.last_sample = result.captured_at
        if result.sequence:
            if road.last_sequence and result.sequence != road.last_sequence + 1:
                # A dropped observation might have been negative or an error.
                road.clear()
            road.last_sequence = result.sequence
        if result.error or not 0 <= now - result.captured_at <= self.settings.max_result_age:
            road.clear()
            road.status = "UNAVAILABLE" if result.error else "STALE"
            return
        road.detections = result.detections
        if result.captured_at < road.cooldown_until:
            road.status = "COOLDOWN"
            return
        if not result.detections:
            road.hits = 0
            road.status = "CLEAR"
            return
        if result.captured_at - road.last_positive > self.settings.confirmation_gap:
            road.hits = 0
            road.confirmed_at = None
        road.hits += 1
        road.last_positive = result.captured_at
        road.confidence = max(detection.confidence for detection in result.detections)
        road.status = f"HITS {min(road.hits, self.settings.confirmations)}/{self.settings.confirmations}"
        if road.hits >= self.settings.confirmations and road.confirmed_at is None:
            road.confirmed_at = result.captured_at

    def choose(self, now):
        for road in self.roads:
            if now - road.last_positive > self.settings.release_seconds:
                road.clear()
            if now - road.last_sample > self.settings.max_result_age:
                road.status = "STALE"
                road.clear()
        if (self.green_road is not None and self.green_since is not None
                and now - self.green_since >= self.settings.max_priority_seconds):
            road = self.roads[self.green_road]
            road.clear()
            road.cooldown_until = now + self.settings.cooldown_seconds
            road.status = "COOLDOWN"
            self.green_road = None
            self.green_since = None
        candidates = [i for i, road in enumerate(self.roads)
                      if road.confirmed_at is not None and now >= road.cooldown_until]
        # Keep the selected road stable while valid; otherwise oldest confirmed.
        if self.target not in candidates:
            self.target = min(candidates, key=lambda i: self.roads[i].confirmed_at,
                              default=None)
        return self.target

    def green_should_end(self, road, elapsed, normal_duration, min_green, now):
        if self.target == road:
            if self.green_road != road:
                self.green_road, self.green_since = road, now
            return False
        was_emergency_green = self.green_road is not None
        if self.target is not None or was_emergency_green:
            return elapsed >= min_green
        return elapsed >= normal_duration

    def on_green_started(self, road, now):
        self.green_road = road if self.target == road else None
        self.green_since = now if self.green_road is not None else None

    def on_yellow_started(self):
        self.green_road = None
        self.green_since = None

    def display(self, road, now):
        evidence = self.roads[road]
        fresh = 0 <= now - evidence.last_sample <= self.settings.max_result_age
        detections = evidence.detections if fresh else ()
        status = "PRIORITY" if self.target == road else evidence.status
        return status, detections
