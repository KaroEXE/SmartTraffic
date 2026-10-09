"""Run real YOLO tracking and HTTP MJPEG against four supplied local videos.

Usage: python scripts/smoke_runtime.py [--sources N S W E]
Inference uses the configured YOLO_DEVICE ("auto": CUDA device 0 if PyTorch
reports CUDA, otherwise CPU); the device actually used is reported.
Only smoke-test configuration is overridden; .env and inference settings stay intact.
Roboflow HTTP is disabled explicitly for this offline test.
"""

import argparse
import json
import logging
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    import cv2
    import numpy as np
    import ultralytics
    from werkzeug.serving import make_server

    from app import pipeline
    from app.services.shared_state import SharedState
    from config import config
    from flaskk.app import create_app
    from flaskk.config import WebSettings

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", nargs=4, default=config.videos,
                        help="Override the configured sources for this smoke test only")
    args = parser.parse_args()
    # Raises if YOLO_DEVICE explicitly requests CUDA that PyTorch cannot see.
    device = pipeline.resolve_device()
    for source in args.sources:
        if not config.project_path(source).is_file():
            raise FileNotFoundError("A smoke-test input video is missing")
    settings = WebSettings(display_fps=8)
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    shared = SharedState(settings)
    stop = threading.Event()
    server = make_server("127.0.0.1", 0, create_app(shared, settings), threaded=True)
    base = f"http://127.0.0.1:{server.server_port}"
    http = threading.Thread(target=server.serve_forever, daemon=True)
    models, failures = [], []
    original_yolo = ultralytics.YOLO

    def load(path):
        model = original_yolo(path)
        models.append(model)
        return model

    def run():
        try:
            pipeline.run(stop_event=stop, publisher=shared, show_window=False, max_cycles=120)
        except Exception as exc:
            failures.append(type(exc).__name__)

    def get_json(path):
        with urlopen(base + path, timeout=5) as response:
            return json.load(response)

    def read_jpeg(direction):
        with urlopen(base + f"/video/{direction}", timeout=10) as response:
            assert response.headers.get_content_type() == "multipart/x-mixed-replace"
            assert response.readline().strip() == b"--frame"
            headers = {}
            while line := response.readline().strip():
                key, value = line.split(b":", 1)
                headers[key.lower()] = value.strip()
            data = response.read(int(headers[b"content-length"]))
            decoded = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
            assert decoded is not None and decoded.shape == (480, 640, 3)
            return direction, data

    worker = threading.Thread(target=run, name="smoke-ai", daemon=True)
    output = ROOT / ".local" / "smoke"
    output.mkdir(parents=True, exist_ok=True)
    try:
        with patch.object(pipeline, "videos", args.sources), patch.object(config, "ROBOFLOW_API_KEY", ""), \
                patch.object(ultralytics, "YOLO", side_effect=load):
            shared.start_encoder()
            http.start()
            worker.start()
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                if failures:
                    raise RuntimeError(f"Pipeline failed: {failures[0]}")
                try:
                    health = get_json("/api/health")
                    if health["ready"]:
                        break
                except HTTPError as exc:
                    if exc.code != 503:
                        raise
                stop.wait(.1)
            else:
                raise TimeoutError("Four real annotated streams were not ready within 90 seconds")
            traffic = get_json("/api/traffic")
            cameras = get_json("/api/cameras")
            assert traffic["available"] and len(cameras["cameras"]) == 4
            with ThreadPoolExecutor(max_workers=6) as viewers:
                images = list(viewers.map(read_jpeg, ["north", "south", "west", "east", "north", "north"]))
            for direction, data in images[:4]:
                (output / f"{direction}.jpg").write_bytes(data)
            first_update = traffic["data"]["updated_at"]
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                traffic = get_json("/api/traffic")
                if traffic["data"]["updated_at"] > first_update:
                    break
                stop.wait(.05)
            assert traffic["data"]["updated_at"] > first_update
            assert len(models) == 4
            trackers = [model.predictor.trackers[0] for model in models]
            assert len({id(tracker) for tracker in trackers}) == 4
            assert all(tracker.frame_id >= 2 for tracker in trackers)
            stop.set()
            worker.join(30)
            assert not worker.is_alive() and not failures
            assert shared.health()["pipeline_status"] == "stopped"
            assert all(c["status"] == "released" for c in shared.cameras()["cameras"])
            report = {"device": str(device), "models": len(models), "independent_trackers": 4,
                      "tracker_frame_ids": [t.frame_id for t in trackers],
                      "simultaneous_viewers": len(images), "jpeg_dimensions": [640, 480],
                      "live_updates": True, "shutdown": "passed", "roboflow": "disabled for offline smoke",
                      "traffic": traffic, "health_while_running": health}
            (output / "result.json").write_text(json.dumps(report, indent=2))
            print(json.dumps({k: v for k, v in report.items() if k != "traffic"}, indent=2))
    finally:
        stop.set()
        worker.join(30) if worker.ident else None
        shared.close()
        if http.ident:
            server.shutdown()
            http.join(5)
        server.server_close()


if __name__ == "__main__":
    main()
