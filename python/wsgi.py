"""Production WSGI entry point for the AI service.

    gunicorn --config gunicorn.conf.py --bind 0.0.0.0:$PORT wsgi:app

Importing this module only builds the Flask app around a fresh SharedState. It
never opens cameras, loads YOLO or starts threads: gunicorn.conf.py starts the
single TrafficService in the worker process after this module is loaded, and
stops it when the worker exits. Run it with exactly one worker process.
"""

import logging
import os
import sys

# Server defaults; explicit environment values still win. Ultralytics would
# otherwise pip-install missing packages and send usage telemetry at runtime.
os.environ.setdefault("YOLO_AUTOINSTALL", "false")
os.environ.setdefault("YOLO_OFFLINE", "true")

from app.services.runtime import TrafficService


def _configure_logging():
    level = logging.getLevelName(os.environ.get("LOG_LEVEL", "").strip().upper() or "INFO")
    if not isinstance(level, int):
        level = logging.INFO
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(level=level, stream=sys.stdout,
                            format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    else:
        root.setLevel(level)
    # The pipeline reports with print(); flush each line so logs arrive in order.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)


_configure_logging()
service = TrafficService.from_env()
app = service.app
