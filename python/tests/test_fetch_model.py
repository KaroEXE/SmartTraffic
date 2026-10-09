"""Model download for deployments: checksum-verified, atomic, never a substitute."""

import hashlib
import io
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from scripts import fetch_model

ROOT = Path(__file__).resolve().parents[1]


class FetchModelTests(unittest.TestCase):
    def setUp(self):
        self.data = b"test-model-bytes" * 4096
        self.digest = hashlib.sha256(self.data).hexdigest()
        self.hits = 0
        test = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                test.hits += 1
                self.send_response(200)
                self.send_header("Content-Length", str(len(test.data)))
                self.end_headers()
                self.wfile.write(test.data)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.url = f"http://127.0.0.1:{server.server_port}/yolo26n.pt"
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.target = Path(directory.name) / "AI-models" / "yolo26n.pt"

    def fetch(self, digest):
        with redirect_stdout(io.StringIO()):
            return fetch_model.fetch(self.url, digest, self.target)

    def test_downloads_verifies_and_is_idempotent(self):
        self.assertTrue(self.fetch(self.digest))
        self.assertEqual(self.target.read_bytes(), self.data)
        self.assertFalse(self.fetch(self.digest.upper()))
        self.assertEqual(self.hits, 1)
        self.assertEqual([p.name for p in self.target.parent.iterdir()], ["yolo26n.pt"])

    def test_checksum_mismatch_leaves_nothing_behind(self):
        with self.assertRaises(SystemExit):
            self.fetch("0" * 64)
        self.assertEqual(list(self.target.parent.iterdir()), [])

    def test_existing_different_weight_is_never_replaced(self):
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(b"custom weight")
        with self.assertRaises(SystemExit):
            self.fetch(self.digest)
        self.assertEqual(self.target.read_bytes(), b"custom weight")
        self.assertEqual(self.hits, 0)

    def test_default_asset_is_the_documented_weight(self):
        readme = (ROOT / "AI-models" / "README.md").read_text()
        self.assertIn(fetch_model.DEFAULT_SHA256, readme)
        self.assertTrue(fetch_model.DEFAULT_URL.endswith("/yolo26n.pt"))


if __name__ == "__main__":
    unittest.main()
