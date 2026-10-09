"""Decode local videos; optionally probe configured inputs and Roboflow.

External probes send requests only when --live or --roboflow is passed.
Roboflow uses one local video frame and the existing private configuration.
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    import cv2

    from config import config

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", "--configured", dest="configured", action="store_true",
                        help="Probe the actual configured sources (MP4, camera, or URL)")
    parser.add_argument("--roboflow", action="store_true")
    args = parser.parse_args()
    report = {"local_videos": []}
    sample = None
    for path in sorted((ROOT / "videos").glob("*.mp4")):
        camera = cv2.VideoCapture(str(path))
        try:
            ok, frame = camera.read()
            report["local_videos"].append({"file": path.name, "decoded": bool(ok)})
            if ok and sample is None:
                sample = frame
        finally:
            camera.release()
    if args.configured:
        from video_work.video_io import open_video

        report["live_sources"] = []
        for direction, source in zip(config.names, config.videos):
            camera = None
            result = {"direction": direction}
            try:
                camera = open_video(source)
                ok, _ = camera.read()
                result["decoded"] = bool(ok)
            except Exception as exc:
                result.update(decoded=False, error=type(exc).__name__)
            finally:
                if camera is not None:
                    camera.release()
            report["live_sources"].append(result)
            print(json.dumps(result), flush=True)
    if args.roboflow:
        from emergency.emergency_priority import (
            RoboflowSampler,
            parse_workflow_response,
        )

        sampler = RoboflowSampler()
        try:
            if not sampler.enabled:
                report["roboflow"] = {"executed": False, "reason": "No configured API key"}
            elif sample is None:
                report["roboflow"] = {"executed": False, "reason": "No local frame available"}
            else:
                try:
                    response = sampler._request(sample)
                    detections = parse_workflow_response(response)
                    report["roboflow"] = {"executed": True, "passed": True,
                                           "emergency_detections": len(detections)}
                except Exception as exc:
                    report["roboflow"] = {"executed": True, "passed": False, "error": type(exc).__name__}
        finally:
            sampler.close()
    print(json.dumps(report, indent=2))
    output = ROOT / ".local" / "smoke"
    output.mkdir(parents=True, exist_ok=True)
    (output / "inputs.json").write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
