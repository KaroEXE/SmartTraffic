"""Main-loop resource and timestamp regressions, without cameras or HTTP."""

import contextlib
import io
import unittest
from types import SimpleNamespace
from unittest import mock

import numpy as np

import app.pipeline as app
from app.services.shared_state import SharedState
from flaskk.config import WebSettings


class MainLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.contexts = contextlib.ExitStack()
        self.addCleanup(self.contexts.close)
        self.contexts.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.contexts.enter_context(mock.patch("atexit.register"))
        self.frame = np.zeros((2, 2, 3), dtype=np.uint8)
        self.cameras = [mock.Mock(spec=("get", "read", "release")) for _ in range(4)]
        for camera in self.cameras:
            camera.get.return_value = 30.0
            camera.read.side_effect = [
                (True, self.frame), (True, self.frame), (False, None),
            ]
        self.contexts.enter_context(mock.patch.object(app, "videos", ["test"] * 4))
        self.open_video = self.contexts.enter_context(mock.patch.object(
            app, "open_video", side_effect=self.cameras))
        self.load_models = self.contexts.enter_context(mock.patch("ultralytics.YOLO"))
        self.process_frame = self.load_models.return_value.track
        self.process_frame.return_value = [SimpleNamespace(boxes=[])]
        sampler_factory = self.contexts.enter_context(mock.patch.object(app, "RoboflowSampler"))
        self.sampler = sampler_factory.return_value
        self.sampler.enabled = False
        self.sampler.poll.return_value = []
        self.destroy_windows = self.contexts.enter_context(mock.patch.object(
            app.cv2, "destroyAllWindows"))
        self.contexts.enter_context(mock.patch.object(app.cv2, "imshow"))
        self.contexts.enter_context(mock.patch.object(app.cv2, "waitKey", return_value=-1))

    def test_model_load_failure_releases_all_cameras(self):
        self.load_models.side_effect = RuntimeError("model failed to load")

        with self.assertRaisesRegex(RuntimeError, "model failed to load"):
            app.run()

        for camera in self.cameras:
            camera.release.assert_called_once_with()
        self.destroy_windows.assert_called_once_with()

    def test_camera_open_failure_releases_previously_opened_cameras(self):
        self.open_video.side_effect = [self.cameras[0], RuntimeError("camera unavailable")]

        with self.assertRaisesRegex(RuntimeError, "camera unavailable"):
            app.run()

        self.cameras[0].release.assert_called_once_with()
        for camera in self.cameras[1:]:
            camera.release.assert_not_called()
        self.destroy_windows.assert_called_once_with()

    def test_processing_failure_stops_sampler_and_releases_cameras(self):
        self.process_frame.side_effect = RuntimeError("frame processing failed")

        with self.assertRaisesRegex(RuntimeError, "frame processing failed"):
            app.run()

        self.sampler.close.assert_called_once_with()
        for camera in self.cameras:
            camera.release.assert_called_once_with()
        self.destroy_windows.assert_called_once_with()

    def test_nan_fps_uses_existing_fallback(self):
        self.cameras[0].get.return_value = float("nan")
        self.cameras[1].get.return_value = 10.0

        app.run()

        self.assertEqual(self.process_frame.call_count, 4)
        for call in self.process_frame.call_args_list:
            self.assertEqual(call.kwargs["imgsz"], 640)
            self.assertTrue(call.kwargs["persist"])
        self.sampler.close.assert_called_once_with()
        for camera in self.cameras:
            camera.release.assert_called_once_with()
        self.destroy_windows.assert_called_once_with()


class PublishedLifecycleTests(MainLifecycleTests):
    def test_eof_releases_inputs_and_marks_api_unavailable(self):
        shared = SharedState(WebSettings())
        app.run(publisher=shared, show_window=False)
        self.assertEqual(shared.health()["pipeline_status"], "stopped")
        self.assertEqual(shared.health()["reason"], "camera_read_ended")
        self.assertFalse(shared.traffic()["available"])
        self.assertEqual(shared.cameras()["cameras"][0]["status"], "eof_or_read_failure")
        for camera in self.cameras:
            camera.release.assert_called_once_with()

    def test_inference_error_is_redacted_in_health(self):
        shared = SharedState(WebSettings())
        self.process_frame.side_effect = RuntimeError("private-url-test-sentinel")
        with self.assertRaises(RuntimeError):
            app.run(publisher=shared, show_window=False)
        self.assertEqual(shared.health()["reason"], "RuntimeError")
        self.assertNotIn("private-url-test-sentinel", str(shared.health()))


if __name__ == "__main__":
    unittest.main()
