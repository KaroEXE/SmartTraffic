import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from refactor_support import ROOT, run_demo

from controller.traffic_controller import TrafficState


class RefactorTests(unittest.TestCase):
    def test_publishing_does_not_change_original_results(self):
        from app.services.shared_state import SharedState
        from flaskk.config import WebSettings
        expected = json.loads((ROOT / "tests/fixtures/active_baseline.json").read_text())
        for scenario, baseline in expected.items():
            with self.subTest(scenario=scenario):
                shared = SharedState(WebSettings())
                self.assertEqual(run_demo(ROOT / "yooFinalMaybe.py", scenario, shared), baseline)
                data = shared.traffic()["data"]
                self.assertEqual(set(data["directions"]), {"north", "south", "west", "east"})
                self.assertIsNotNone(data["directions"]["north"]["detected_vehicles"])
                self.assertEqual(data["controller"]["fallback_active"], data["controller"]["mode"] == "AUTO")
                shared.close()

    def test_full_loop_matches_original_baselines(self):
        expected = json.loads((ROOT / "tests/fixtures/refactor_baseline.json").read_text())
        for scenario, baseline in expected.items():
            with self.subTest(scenario=scenario):
                self.assertEqual(run_demo(ROOT / "yooFinalMaybe.py", scenario), baseline)

    def test_state_and_camera_histories_are_independent(self):
        first, second = TrafficState(), TrafficState()
        first.track_states[0][7] = {"state": "STOPPED"}
        first.stopped_counts[0] = 1
        self.assertEqual(first.track_states[1], {})
        self.assertEqual(second.track_states, [{}, {}, {}, {}])
        self.assertEqual(second.stopped_counts, [0, 0, 0, 0])

    def test_imports_from_another_directory_do_not_start_application(self):
        code = r'''
import sys
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
def forbidden(*args, **kwargs):
    raise AssertionError('Application started while importing')
sys.modules['ultralytics'] = SimpleNamespace(YOLO=forbidden)
import cv2
cv2.VideoCapture = forbidden
from config import config
from emergency import emergency_priority
from controller import traffic_controller
from detection import vehicle_detection
from video_work import video_io
import yooFinalMaybe
assert config.ENV_FILE == config.PROJECT_ROOT / '.env'
assert config.MODEL_PATH.is_absolute()
assert callable(yooFinalMaybe.main)
'''
        result = subprocess.run([sys.executable, "-c", code, str(ROOT)],
                                cwd=ROOT.parent, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_local_camera_paths_and_failure_cleanup(self):
        from unittest.mock import MagicMock

        from video_work.video_io import open_video
        camera = MagicMock()
        camera.isOpened.return_value = True
        with patch("video_work.video_io.cv2.VideoCapture", return_value=camera) as capture:
            self.assertIs(open_video("5cars.mp4"), camera)
        self.assertEqual(Path(capture.call_args.args[0]), ROOT / "5cars.mp4")
        camera.isOpened.return_value = False
        with patch("video_work.video_io.cv2.VideoCapture", return_value=camera):
            with self.assertRaises(RuntimeError):
                open_video("missing.mp4")
        camera.release.assert_called_once()


class ConfigurationTests(unittest.TestCase):
    def load_config(self, directory, environment=None):
        # Run the actual config source with an isolated project root and process
        # environment. Sentinel credentials stay inside this process, never logs.
        namespace = {"__file__": str(Path(directory) / "config" / "config.py")}
        with patch.dict(os.environ, environment or {}, clear=True):
            exec(compile((ROOT / "config/config.py").read_text(), "config.py", "exec"), namespace)
        return namespace

    def test_file_lookup_and_nonempty_environment_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text('ROBOFLOW_API_KEY="file-test-$value"\nROBOFLOW_WORKSPACE=file-workspace\n')
            loaded = self.load_config(directory, {"ROBOFLOW_API_KEY": "process-test-value"})
            self.assertTrue(loaded["ROBOFLOW_API_KEY"] == "process-test-value")
            self.assertEqual(loaded["ROBOFLOW_WORKSPACE"], "file-workspace")
            loaded = self.load_config(directory, {"ROBOFLOW_API_KEY": ""})
            self.assertTrue(loaded["ROBOFLOW_API_KEY"] == "file-test-$value")
            # Editing the file doesn't change the already loaded configuration.
            path.write_text('ROBOFLOW_API_KEY=changed-test-value\n')
            self.assertTrue(loaded["ROBOFLOW_API_KEY"] == "file-test-$value")

    def test_missing_empty_or_placeholder_key_remains_disabled(self):
        with tempfile.TemporaryDirectory() as directory:
            for contents in (None, "ROBOFLOW_API_KEY=\n",
                             "ROBOFLOW_API_KEY=YOUR_ROBOFLOW_PRIVATE_API_KEY\n"):
                if contents is not None:
                    (Path(directory) / ".env").write_text(contents)
                loaded = self.load_config(directory)
                self.assertFalse(loaded["ROBOFLOW_API_KEY"])
                self.assertEqual(loaded["ROBOFLOW_TIMEOUT"], 4.)

    def test_timeout_validation_and_workflow_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            for value in ("nan", "0", "-1", "invalid"):
                with self.assertWarns(RuntimeWarning):
                    loaded = self.load_config(directory, {"ROBOFLOW_TIMEOUT": value})
                self.assertEqual(loaded["ROBOFLOW_TIMEOUT"], 4.)
            loaded = self.load_config(directory, {"ROBOFLOW_TIMEOUT": "4.5",
                                      "ROBOFLOW_WORKSPACE": "my-workspace",
                                      "ROBOFLOW_WORKFLOW_ID": "my-workflow"})
            self.assertEqual(loaded["ROBOFLOW_TIMEOUT"], 4.5)
            self.assertEqual(loaded["WORKFLOW_URL"],
                             "https://serverless.roboflow.com/my-workspace/workflows/my-workflow")

    def test_configuration_does_not_print_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.load_config(directory, {"ROBOFLOW_API_KEY": "private-test-sentinel"})
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(stderr.getvalue(), "")

    def test_selected_mp4_defaults_and_explicit_direction_override(self):
        with tempfile.TemporaryDirectory() as directory:
            expected = ["videos/1car8mins.mp4", "videos/4cars.mp4",
                        "videos/5carsgood.mp4", "videos/aFewMoreCars.mp4"]
            self.assertEqual(self.load_config(directory)["videos"], expected)
            overridden = self.load_config(directory, {"VIDEO_NORTH": "videos/custom.mp4"})
            self.assertEqual(overridden["videos"], ["videos/custom.mp4", *expected[1:]])

    def test_gitignore_with_real_git_rules_in_isolated_repository(self):
        # Check the exact ignore rules
        # in a disposable repo without initializing or changing the project.
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(["git", "init", "--quiet", directory], capture_output=True)
            self.assertEqual(result.returncode, 0)
            (Path(directory) / ".gitignore").write_bytes((ROOT / ".gitignore").read_bytes())
            result = subprocess.run(["git", "-C", directory, "check-ignore", "--no-index",
                                     ".env", ".env.local", ".env.example"],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout.splitlines(), [".env", ".env.local"])


if __name__ == "__main__":
    unittest.main()
