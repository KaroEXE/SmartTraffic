"""Prevent conflicting launcher inputs and misleading startup diagnostics."""

import contextlib
import importlib
import io
import unittest
from unittest.mock import patch

import main as launcher
from app.services.shared_state import SharedState
from config import config
from flaskk.config import WebSettings


class StartupTests(unittest.TestCase):
    def test_desktop_launcher_uses_the_same_pipeline_and_shared_video_list(self):
        import yooFinalMaybe

        # The full-loop harness temporarily swaps sys.modules; resolve the
        # canonical module instead of its potentially retained package attribute.
        pipeline = importlib.import_module("app.pipeline")
        self.assertIs(yooFinalMaybe.main, pipeline.run)
        self.assertIs(pipeline.videos, config.videos)
        self.assertFalse(hasattr(yooFinalMaybe, "videos"))

    def test_check_config_does_not_open_cameras_or_start_workers(self):
        output = io.StringIO()
        with patch("sys.argv", ["main.py", "--check-config"]), \
                patch("cv2.VideoCapture", side_effect=AssertionError("opened camera")), \
                patch("threading.Thread.start", side_effect=AssertionError("started worker")), \
                contextlib.redirect_stdout(output):
            launcher.main()
        self.assertIn("Video sources: config/config.py", output.getvalue())
        self.assertIn("NORTH:", output.getvalue())

    def test_remote_input_summary_never_prints_url_credentials(self):
        sources = ["rtsp://test-user:private-sentinel@example.test/feed?token=private-sentinel"] * 4
        with patch.object(config, "videos", sources):
            descriptions = "\n".join(launcher.describe_inputs())
        self.assertNotIn("private-sentinel", descriptions)
        self.assertNotIn("test-user", descriptions)
        self.assertIn("remote stream", descriptions)

    def test_input_failure_identifies_direction_without_exposing_exception_body(self):
        shared = SharedState(WebSettings())
        shared.camera_status(2, "opening")
        shared.set_lifecycle("failed", "DownloadError")
        shared.finish_pipeline()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            launcher.report_pipeline_error(shared, RuntimeError("private-url-sentinel"))
        self.assertIn("WEST", output.getvalue())
        self.assertIn("VIDEO_WEST", output.getvalue())
        self.assertNotIn("private-url-sentinel", output.getvalue())
