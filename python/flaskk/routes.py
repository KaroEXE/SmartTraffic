"""Read-only dashboard routes backed exclusively by published snapshots."""

from flask import Blueprint, Response, jsonify, request

from app.services.shared_state import DIRECTIONS
from flaskk.video_stream import stream_frames


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
        value = shared.health()
        return jsonify(value), 200 if value["ready"] else 503

    @routes.get("/video/<direction>")
    def video(direction):
        if direction not in DIRECTIONS:
            return jsonify(error="Unknown direction"), 404
        index = DIRECTIONS.index(direction)
        if not shared.frame_available(index):
            return jsonify(error="Annotated frame unavailable", direction=direction), 503, {"Retry-After": "2"}
        return Response(stream_frames(shared, index),
                        content_type="multipart/x-mixed-replace; boundary=frame",
                        headers={"X-Accel-Buffering": "no"})

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
