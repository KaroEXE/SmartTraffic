"""Load project-local configuration once; never print credential values."""

import math
import os
from pathlib import Path
from urllib.parse import quote
import warnings

from dotenv import dotenv_values


CONFIG_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = CONFIG_DIR.parent
ENV_FILE = PROJECT_ROOT / ".env"
LEGACY_ENV_FILE = CONFIG_DIR / ".env"

_ENV_NAMES = (
    "ROBOFLOW_API_KEY",
    "ROBOFLOW_WORKSPACE",
    "ROBOFLOW_WORKFLOW_ID",
    "ROBOFLOW_API_URL",
    "ROBOFLOW_TIMEOUT",
    "MODEL_PATH", "VIDEO_NORTH", "VIDEO_SOUTH", "VIDEO_WEST", "VIDEO_EAST",
    "FLASK_HOST", "FLASK_PORT", "ALLOWED_ORIGINS", "DISPLAY_FPS",
    "JPEG_QUALITY", "FRAME_STALE_SECONDS", "MAX_STREAM_CLIENTS",
    "YOLO_DEVICE", "PIPELINE_RESTART_SECONDS", "LOG_LEVEL",
    "BACKEND_URL", "INTERSECTION_ID", "TRAFFIC_INGEST_TOKEN",
    "BACKEND_PUBLISH_INTERVAL", "BACKEND_TIMEOUT",
)

def _load_environment():
    # Disable interpolation so a private key containing '$' stays literal.
    # A nonempty process environment always takes precedence over the file.
    # The original private config/.env stays in place. Root .env overrides it.
    values = {**dotenv_values(LEGACY_ENV_FILE, interpolate=False),
              **dotenv_values(ENV_FILE, interpolate=False)}
    for name in _ENV_NAMES:
        value = values.get(name)
        if not os.environ.get(name) and value is not None:
            os.environ[name] = value


def _value(name, default):
    return os.environ.get(name, "").strip() or default


def env_number(name, default, kind=float):
    """Parse a numeric environment value, naming the variable on failure."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return kind(default)
    try:
        return kind(raw)
    except ValueError:
        raise ValueError(f"{name} must be a number") from None


def _timeout():
    try:
        timeout = float(_value("ROBOFLOW_TIMEOUT", "4"))
        if math.isfinite(timeout) and timeout > 0:
            return timeout
    except ValueError:
        pass
    warnings.warn("Invalid ROBOFLOW_TIMEOUT; using the existing 4-second default.",
                  RuntimeWarning, stacklevel=2)
    return 4.0


def project_path(path):
    """Resolve project assets without relying on the launch directory."""
    path = Path(path)
    return path if path.is_absolute() else PROJECT_ROOT / path


_load_environment()
ROBOFLOW_API_KEY = _value("ROBOFLOW_API_KEY", "")
if ROBOFLOW_API_KEY == "YOUR_ROBOFLOW_PRIVATE_API_KEY":
    ROBOFLOW_API_KEY = ""  # The documented placeholder is not a credential.
ROBOFLOW_WORKSPACE = _value("ROBOFLOW_WORKSPACE", "nooc-5o5-gmail-com")
ROBOFLOW_WORKFLOW_ID = _value("ROBOFLOW_WORKFLOW_ID", "emergency-car-1-workflow")
ROBOFLOW_API_URL = _value("ROBOFLOW_API_URL", "https://serverless.roboflow.com").rstrip("/")
ROBOFLOW_TIMEOUT = _timeout()
WORKFLOW_URL = (f"{ROBOFLOW_API_URL}/{quote(ROBOFLOW_WORKSPACE, safe='')}/workflows/"
                f"{quote(ROBOFLOW_WORKFLOW_ID, safe='')}")
MODEL_PATH = project_path(_value("MODEL_PATH", "AI-models/yolo26n.pt"))
# "auto" selects CUDA device 0 when PyTorch reports CUDA, otherwise the CPU.
# Explicit values ("0", "cpu", "cuda:0") are passed to Ultralytics unchanged.
YOLO_DEVICE = _value("YOLO_DEVICE", "auto")


# EDIT VIDEO SOURCES HERE for BOTH main.py and yooFinalMaybe.py.
# These are the four MP4s selected in the user's desktop script.
# Nonempty VIDEO_* environment settings override individual entries below.
videos = [
    "videos/1car8mins.mp4",       # NORTH
    "videos/4cars.mp4",          # SOUTH (matches actual filename casing)
    "videos/5carsgood.mp4",      # WEST
    "videos/aFewMoreCars.mp4",   # EAST
]

names = [
    "NORTH",
    "SOUTH",
    "WEST",
    "EAST"
]

# Empty overrides preserve the shared defaults above.
videos = [_value(f"VIDEO_{direction}", source) for direction, source in zip(names, videos)]

vehicle_weights = {
    "motorcycle": 0.5,
    "car": 1.0,
    "bus": 2.0,
    "truck": 2.0,
    "police car": 2.5
}

vehicle_classes = set(
    vehicle_weights.keys()
)

MIN_DETECTION_CONF = 0.35

MIN_AVERAGE_CONF = 0.40

MIN_TRACK_RATIO = 0.60

MOTION_WINDOW_SECONDS = 0.60

MOVING_SPEED_THRESHOLD = 0.12

STOP_CONFIRM_SECONDS = 0.00

TRACK_FORGET_SECONDS = 2.00

WAIT_SCORE_PER_SECOND = 0.05

MAX_WAIT_SCORE_SECONDS = 20.0

MIN_GREEN = 4

MAX_GREEN = 12

BASE_GREEN = 4

SECONDS_PER_DENSITY = 1.2

YELLOW_TIME = 2

WAIT_BONUS = 1.5

AUTO_GREEN = 7

BAD_UPDATES_TO_FALLBACK = 8

GOOD_UPDATES_TO_RECOVER = 15

