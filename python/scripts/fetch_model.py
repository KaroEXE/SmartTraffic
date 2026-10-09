"""Download the exact YOLO weight the pipeline expects, verified by SHA-256.

Usage (for example in the Render build command): python scripts/fetch_model.py

Writes MODEL_PATH (default AI-models/yolo26n.pt) only when it is missing. An
existing file must already match the checksum; it is never replaced with a
different model. The default is Ultralytics' official release asset, whose
size and SHA-256 match AI-models/README.md. For another weight, set both
MODEL_URL and MODEL_SHA256. The URL is never printed (it may be signed).
"""

import hashlib
import os
import sys
import tempfile
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

DEFAULT_URL = "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.pt"
DEFAULT_SHA256 = "9b09cc8bf347f0fc8a5f7657480587f25db09b34bf33b0652110fb03a8ad4fef"
MAX_BYTES = 500_000_000


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(url, expected, destination, timeout=60):
    """Return True after a verified download, False if a verified file exists."""
    destination = Path(destination)
    expected = expected.lower()
    if destination.is_file():
        if sha256(destination) != expected:
            raise SystemExit(f"{destination.name} exists but does not match the expected "
                             "SHA-256; refusing to replace it")
        print(f"{destination.name}: already present, SHA-256 verified")
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".part",
                                         dir=destination.parent)
    try:
        digest, size = hashlib.sha256(), 0
        with os.fdopen(handle, "wb") as output, urlopen(url, timeout=timeout) as response:
            while chunk := response.read(1 << 20):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise SystemExit("Model download exceeds the size limit")
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != expected:
            raise SystemExit(f"Downloaded {destination.name} does not match the expected SHA-256")
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f"{destination.name}: downloaded {size} bytes, SHA-256 verified")
    return True


def main():
    from config import config

    url = os.environ.get("MODEL_URL", "").strip() or DEFAULT_URL
    expected = os.environ.get("MODEL_SHA256", "").strip() or DEFAULT_SHA256
    fetch(url, expected, config.MODEL_PATH)


if __name__ == "__main__":
    main()
