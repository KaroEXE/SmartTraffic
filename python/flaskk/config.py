"""Web/display settings; these never alter inference parameters."""

import math
import os
from dataclasses import dataclass
from urllib.parse import urlsplit

# Loads project environment files using the same precedence as the AI settings.
from config.config import env_number


@dataclass(frozen=True)
class WebSettings:
    host: str = "127.0.0.1"
    port: int = 5000
    allowed_origins: tuple = ()
    display_fps: float = 8.0
    jpeg_quality: int = 70
    stale_seconds: float = 10.0
    max_stream_clients: int = 8

    def __post_init__(self):
        if not 1 <= self.port <= 65535:
            raise ValueError("FLASK_PORT must be between 1 and 65535")
        if not math.isfinite(self.display_fps) or not 0 < self.display_fps <= 60:
            raise ValueError("DISPLAY_FPS must be greater than 0 and at most 60")
        if not 1 <= self.jpeg_quality <= 100:
            raise ValueError("JPEG_QUALITY must be between 1 and 100")
        if not math.isfinite(self.stale_seconds) or self.stale_seconds <= 0:
            raise ValueError("FRAME_STALE_SECONDS must be positive")
        if not 1 <= self.max_stream_clients <= 64:
            raise ValueError("MAX_STREAM_CLIENTS must be between 1 and 64")
        for origin in self.allowed_origins:
            parsed = urlsplit(origin)
            if (parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path
                    or parsed.query or parsed.fragment or parsed.username or parsed.password
                    or "*" in origin):
                raise ValueError("ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths")

    @classmethod
    def from_env(cls):
        return cls(
            host=os.environ.get("FLASK_HOST", "127.0.0.1"),
            port=env_number("FLASK_PORT", 5000, int),
            allowed_origins=tuple(s.strip() for s in os.environ.get("ALLOWED_ORIGINS", "").split(",") if s.strip()),
            display_fps=env_number("DISPLAY_FPS", 8),
            jpeg_quality=env_number("JPEG_QUALITY", 70, int),
            stale_seconds=env_number("FRAME_STALE_SECONDS", 10),
            max_stream_clients=env_number("MAX_STREAM_CLIENTS", 8, int),
        )
