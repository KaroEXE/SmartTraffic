"""Flask factory; importing or creating the web app never starts AI workers."""

from flask import Flask

from flaskk.config import WebSettings
from flaskk.routes import register_routes


def create_app(shared, settings=None):
    settings = settings or WebSettings.from_env()
    app = Flask(__name__)
    app.config.update(DEBUG=False, TESTING=False)
    app.extensions["traffic_state"] = shared
    register_routes(app, shared, settings)
    return app
