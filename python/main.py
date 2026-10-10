"""Start the AI loop and Flask in one process; never use a debug reloader.

Local launcher (Werkzeug server, optional OpenCV window). Production servers use
wsgi.py with gunicorn.conf.py instead; see docs/RENDER_DEPLOYMENT.md.
"""

import argparse
import logging
import threading
from urllib.parse import urlparse

from app.services.backend_publisher import BackendPublisher, BackendSettings
from app.services.shared_state import SharedState
from flaskk.app import create_app
from flaskk.config import WebSettings


def describe_inputs():
    """Report effective inputs without exposing credentials in remote URLs."""
    from config.config import names, project_path, videos

    rows = []
    for direction, source in zip(names, videos):
        if isinstance(source, int) or str(source).startswith("camera:"):
            label = "camera device"
        else:
            hostname = (urlparse(str(source)).hostname or "").lower()
            if hostname:
                label = "YouTube stream" if hostname in {
                    "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"
                } else "remote stream"
            else:
                path = project_path(source)
                label = f"local file {path.name} ({'found' if path.is_file() else 'MISSING'})"
        rows.append(f"{direction}: {label}")
    return rows


def describe_video_files():
    """Files mode: the looping video for each direction and whether it exists."""
    from config.config import VIDEO_FILES, names, project_path

    return [f"{direction}: looping file {source} ({'found' if project_path(source).is_file() else 'MISSING'})"
            for direction, source in zip(names, VIDEO_FILES)]


def describe_backend(settings):
    """Where observations go; the ingest token itself is never printed."""
    if not settings.enabled:
        return "Backend publishing: disabled (set BACKEND_URL to the Node.js backend)"
    token = "with TRAFFIC_INGEST_TOKEN" if settings.token else "without a token"
    return (f"Backend publishing: POST {settings.endpoint} as intersection "
            f"'{settings.intersection_id}' {token}")


def report_pipeline_error(shared, exc):
    failed = [camera["direction"].upper() for camera in shared.cameras()["cameras"]
              if camera["status"] == "open_failed"]
    if failed:
        print(f"Could not open {failed[0]} input ({type(exc).__name__}).")
        print(f"Check config/config.py or its VIDEO_{failed[0]} environment override.")
    else:
        print(f"AI pipeline failed ({type(exc).__name__}); check the model and YOLO_DEVICE configuration.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--show-window", action="store_true", help="Also show the original OpenCV grid")
    parser.add_argument("--check-config", action="store_true",
                        help="Print effective input selection without starting cameras, YOLO or HTTP")
    args = parser.parse_args()
    from config.config import VIDEO_SOURCE_MODE

    if VIDEO_SOURCE_MODE == "files":
        print("Video sources: config/config.py, VIDEO_SOURCE_MODE=files (one looping video per direction)")
        descriptions = describe_video_files()
    else:
        print("Video sources: config/config.py (nonempty VIDEO_* environment values override it)")
        descriptions = describe_inputs()
    for description in descriptions:
        print(f"  {description}")
    backend_settings = BackendSettings.from_env()
    print(describe_backend(backend_settings))
    if args.check_config:
        return
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    settings = WebSettings.from_env()
    shared = SharedState(settings)
    publisher = BackendPublisher(shared, backend_settings)
    stop = threading.Event()
    # Lazy import: API factories and help do not import YOLO or open cameras.
    from werkzeug.serving import make_server

    from app.pipeline import run

    server = make_server(settings.host, settings.port, create_app(shared, settings), threaded=True)
    http_thread = threading.Thread(target=server.serve_forever, name="traffic-http", daemon=True)
    shared.start_encoder()
    publisher.start()
    http_thread.start()
    print(f"Traffic API: http://{settings.host}:{settings.port}/api/health")
    print("Open browser URLs with http://. This local server does not accept HTTPS.")
    try:
        try:
            run(stop_event=stop, publisher=shared, show_window=args.show_window)
        except Exception as exc:
            report_pipeline_error(shared, exc)
        print("AI pipeline stopped. Status API remains available; press Ctrl+C to exit.")
        stop.wait()
    except KeyboardInterrupt:
        stop.set()
    finally:
        publisher.stop()
        shared.close()
        server.shutdown()
        server.server_close()
        http_thread.join(timeout=5)


if __name__ == "__main__":
    main()
