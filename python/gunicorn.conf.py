"""Gunicorn settings for the AI service (Render or any Linux host).

    gunicorn --config gunicorn.conf.py --bind 0.0.0.0:$PORT wsgi:app

The pipeline, the latest JPEG frames and the backend publisher live in one
process's memory (app/services/shared_state.py). Each extra worker process would
open all four cameras again, load four more YOLO models and post competing
observations for the same intersection, so exactly one worker runs. HTTP
concurrency comes from threads instead; MJPEG viewers are capped below the
thread count (MAX_STREAM_CLIENTS) so health checks always find a free thread.
"""

import os

wsgi_app = "wsgi:app"
bind = f"0.0.0.0:{os.environ.get('PORT', '10000')}"

# One worker on purpose; WEB_CONCURRENCY must not raise it (see module docstring).
workers = 1
worker_class = "gthread"
_max_streams = int(os.environ.get("MAX_STREAM_CLIENTS") or 8)
threads = int(os.environ.get("GUNICORN_THREADS") or _max_streams + 4)

# The service must be built in the worker, never inherited across fork().
preload_app = False
# Recycling the worker would reload every model and reopen every camera.
max_requests = 0
# The worker heartbeat runs on its main thread, unaffected by long streams.
timeout = 120
graceful_timeout = 20
keepalive = 5

accesslog = None
errorlog = "-"
loglevel = (os.environ.get("LOG_LEVEL") or "info").lower()


def post_worker_init(worker):
    """Start the single service after the worker has imported wsgi.py."""
    import signal
    import threading

    import wsgi

    wsgi.service.start()
    previous = signal.getsignal(signal.SIGTERM)

    def stop_service_then_exit(signum, frame):
        # Close MJPEG streams and stop the pipeline now, so gunicorn's graceful
        # shutdown is not held open by never-ending video responses.
        threading.Thread(target=wsgi.service.stop, name="traffic-shutdown", daemon=True).start()
        if callable(previous):
            previous(signum, frame)

    signal.signal(signal.SIGTERM, stop_service_then_exit)
    # Keep gunicorn's choice: SIGTERM must not interrupt in-flight system calls.
    if hasattr(signal, "siginterrupt"):
        signal.siginterrupt(signal.SIGTERM, False)


def worker_exit(server, worker):
    """Release cameras and threads when the worker process ends."""
    import sys

    # Absent when the app failed to import; there is nothing to stop then.
    wsgi = sys.modules.get("wsgi")
    if wsgi is not None and hasattr(wsgi, "service"):
        wsgi.service.stop()
