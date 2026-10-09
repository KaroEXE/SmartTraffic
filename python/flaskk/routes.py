"""Read-only dashboard routes backed exclusively by published snapshots."""

from flask import Blueprint, Response, jsonify, request
from werkzeug.exceptions import HTTPException

from app.services.shared_state import DIRECTIONS
from flaskk.video_stream import MJPEGStream


def register_routes(app, shared, settings):
    routes = Blueprint("traffic", __name__)

    @routes.get("/api/traffic")
    def traffic():
        return jsonify(shared.traffic())

    @routes.get("/api/cameras")
    def cameras():
        return jsonify(shared.cameras())

    @routes.get("/api/health")
    def health():
        # Readiness: 200 only while all four annotated streams and data are fresh.
        value = shared.health()
        return jsonify(value), 200 if value["ready"] else 503

    @routes.get("/api/health/live")
    def live():
        # Liveness: the web process answers even while the AI pipeline is
        # starting, restarting, or waiting for a camera. Use this for platform
        # health checks; /api/health reports whether detections are flowing.
        value = shared.health()
        return jsonify(service=value["service"], alive=True, ready=value["ready"],
                       pipeline_status=value["pipeline_status"], reason=value["reason"])

    @routes.get("/video/<direction>")
    def video(direction):
        if direction not in DIRECTIONS:
            return jsonify(error="Unknown direction"), 404
        index = DIRECTIONS.index(direction)
        if not shared.frame_available(index):
            return jsonify(error="Annotated frame unavailable", direction=direction), 503, {"Retry-After": "2"}
        if not shared.acquire_stream():
            return jsonify(error="Too many video viewers", direction=direction), 503, {"Retry-After": "5"}
        return Response(MJPEGStream(shared, index),
                        content_type="multipart/x-mixed-replace; boundary=frame",
                        headers={"X-Accel-Buffering": "no"})

    @app.errorhandler(HTTPException)
    def http_error(error):
        # JSON instead of HTML error pages; keeps headers such as Allow on 405.
        response = error.get_response()
        response.data = jsonify(error=error.name).get_data()
        response.content_type = "application/json"
        return response

    @app.after_request
    def response_headers(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        origin = request.headers.get("Origin")
        if origin in settings.allowed_origins:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
        response.vary.add("Origin")
        return response

    app.register_blueprint(routes)
