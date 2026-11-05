"""Video opening and the original OpenCV traffic-light overlays/grid."""

import math
import time
from urllib.parse import urlparse

import cv2
import numpy as np

from config.config import YELLOW_TIME, project_path


def open_video(source):
    if isinstance(source, int) or str(source).startswith("camera:"):
        index = source if isinstance(source, int) else int(str(source).split(":", 1)[1])
        camera = cv2.VideoCapture(index)
        if not camera.isOpened():
            camera.release()
            raise RuntimeError("Could not open configured camera device")
        return camera

    source = str(source)
    hostname = (urlparse(source).hostname or "").lower()

    if hostname in {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}:
        from yt_dlp import YoutubeDL

        # Resolve a fresh stream URL on each run; YouTube stream URLs expire.
        with YoutubeDL({
            "format": "best[height<=720]/bestvideo[height<=720]/best/bestvideo",
            "noplaylist": True,
            "quiet": True,
        }) as downloader:
            info = downloader.extract_info(source, download=False)

        stream_url = info.get("url")
        if not stream_url:
            raise RuntimeError("YouTube did not provide a playable stream URL")
        camera = cv2.VideoCapture(stream_url, cv2.CAP_FFMPEG)
    else:
        camera = cv2.VideoCapture(str(project_path(source)) if not hostname else source)

    if not camera.isOpened():
        camera.release()
        raise RuntimeError("Could not open configured video source")

    return camera


class LoopingVideoFile:
    """A local video file that plays forever at its own frame rate.

    read() has the cv2.VideoCapture signature and returns the frame that is due
    now on a wall clock started by the first read. A caller that falls behind
    (slow inference) gets later frames, with the skipped ones only grabbed, so
    playback keeps real speed instead of slowing down. A caller that is early
    waits for the next frame, so playback never runs fast either.

    At the end of the file it rewinds to frame 0 (or reopens the file when
    seeking fails) and increments `loops`; the caller resets its per-stream
    tracking state when that number changes. `video_time` counts video seconds
    played since the start, across loops, so it never jumps backwards.
    """

    # Skip at most this many seconds in one read; a longer stall re-anchors the
    # clock instead of decoding through a large part of the file.
    MAX_SKIP_SECONDS = 2.0

    def __init__(self, path, *, stop_event=None, clock=time.monotonic):
        self.path = project_path(path)
        if not self.path.is_file():
            raise FileNotFoundError(f"Video file not found: {self.path.name}")
        self._clock = clock
        self._stop_event = stop_event
        self._capture = self._open()
        fps = self._capture.get(cv2.CAP_PROP_FPS)
        self.fps = fps if fps and fps > 1 and math.isfinite(fps) else 30.0
        self.loops = 0
        self.frames_played = 0
        self._position = -1  # index of the last frame returned in this pass
        self._started = None  # clock time at which frame 0 of this pass was due

    @property
    def video_time(self):
        return self.frames_played / self.fps

    def _open(self):
        capture = cv2.VideoCapture(str(self.path))
        if not capture.isOpened():
            capture.release()
            raise RuntimeError(f"Could not open video file {self.path.name}")
        return capture

    def _wait(self, seconds):
        if self._stop_event is not None:
            self._stop_event.wait(seconds)
        else:
            time.sleep(seconds)

    def _rewind(self):
        """Back to frame 0, reopening the file if seeking fails; None on failure.

        A file deleted while it played (possible on Linux) is noticed here, so
        the caller reports it unavailable instead of replaying a stale handle.
        """
        self.loops += 1
        self._position = -1
        self._started = self._clock()
        if not self.path.is_file():
            return None
        if self._capture.set(cv2.CAP_PROP_POS_FRAMES, 0):
            success, frame = self._capture.read()
            if success:
                return frame
        self._capture.release()
        try:
            self._capture = self._open()
        except RuntimeError:
            return None
        success, frame = self._capture.read()
        return frame if success else None

    def read(self):
        now = self._clock()
        if self._started is None:
            self._started = now
        due = int((now - self._started) * self.fps)
        if due <= self._position:
            # Early: wait until the next frame is due.
            due = self._position + 1
            delay = self._started + due / self.fps - now
            if delay > 0:
                self._wait(delay)
        max_skip = max(1, int(self.MAX_SKIP_SECONDS * self.fps))
        if due - self._position > max_skip:
            due = self._position + max_skip
            self._started = self._clock() - due / self.fps
        for _ in range(due - self._position - 1):
            if not self._capture.grab():
                break
            self._position += 1
            self.frames_played += 1
        success, frame = self._capture.read()
        if not success:
            frame = self._rewind()
            if frame is None:
                return False, None
        self._position += 1
        self.frames_played += 1
        return True, frame

    def get(self, prop):
        return self.fps if prop == cv2.CAP_PROP_FPS else self._capture.get(prop)

    def isOpened(self):
        return self._capture.isOpened()

    def release(self):
        self._capture.release()


def fit_frame(frame, size=(860, 640)):
    """Scale a frame into `size` keeping its aspect ratio, padded with black.

    Returns (frame, (x, y, width, height)): the content rectangle lets
    overlays given in normalized source coordinates land on the picture.
    A portrait video is pillarboxed instead of being stretched.
    """
    target_w, target_h = size
    height, width = frame.shape[:2]
    scale = min(target_w / width, target_h / height)
    content_w, content_h = max(1, round(width * scale)), max(1, round(height * scale))
    x, y = (target_w - content_w) // 2, (target_h - content_h) // 2
    if (content_w, content_h) == (target_w, target_h):
        return cv2.resize(frame, size), (0, 0, target_w, target_h)
    canvas = np.zeros((target_h, target_w, 3), dtype=frame.dtype)
    canvas[y:y + content_h, x:x + content_w] = cv2.resize(frame, (content_w, content_h))
    return canvas, (x, y, content_w, content_h)


def unavailable_frame(direction, size=(640, 480)):
    """Black frame naming a direction whose source is missing (drawing only, never published)."""
    frame = np.zeros((size[1], size[0], 3), dtype=np.uint8)
    cv2.putText(frame, direction, (30, 90), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
    cv2.putText(frame, "VIDEO UNAVAILABLE", (30, 140), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
    return frame


def draw_traffic_state(frames, state, current_time, emergency_priority, emergency_sampler, emergency_settings):
    display_frames = []

    for i in range(4):

        display_frame = (
            frames[i].copy()
        )

        # ----------------------------------------------
        # CONTROL MODE
        # ----------------------------------------------

        mode_color = (
            (0, 255, 255)
            if state.control_mode == "AI"
            else (255, 200, 0)
        )

        cv2.putText(
            display_frame,
            f"MODE: {state.control_mode}",
            (400, 135),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            mode_color,
            2
        )

        emergency_status, emergency_boxes = emergency_priority.display(i, current_time)
        if not emergency_sampler.enabled:
            emergency_status = "OFF - NO API KEY"
        cv2.putText(display_frame, f"RF: {emergency_status}", (30, 190),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 180, 0), 2)
        if state.light_phase == "ALL_RED":
            cv2.putText(display_frame, "ALL RED - CLEARANCE", (30, 220),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 255), 2)
        for detection in emergency_boxes:
            # These are the latest sampled boxes, not live YOLO tracks.
            x1, y1, x2, y2 = detection.xyxy
            p1, p2 = (int(x1 * 640), int(y1 * 480)), (int(x2 * 640), int(y2 * 480))
            cv2.rectangle(display_frame, p1, p2, (255, 180, 0), 2)
            cv2.putText(display_frame, f"RF SAMPLE {detection.confidence:.2f}",
                        (p1[0], max(20, p1[1] - 8)), cv2.FONT_HERSHEY_SIMPLEX,
                        0.5, (255, 180, 0), 2)

        if state.controller_started:

            elapsed = (
                current_time
                - state.phase_start_time
            )

            if i == state.current_green and state.light_phase != "ALL_RED":

                if state.light_phase == "GREEN":

                    light_text = (
                        "GREEN"
                    )

                    light_color = (
                        0,
                        255,
                        0
                    )

                    remaining = max(
                        0,
                        state.green_duration - elapsed
                    )
                    if emergency_priority.green_road == i:
                        remaining = max(0, emergency_settings.max_priority_seconds
                                        - (current_time - emergency_priority.green_since))

                else:

                    light_text = (
                        "YELLOW"
                    )

                    light_color = (
                        0,
                        255,
                        255
                    )

                    remaining = max(
                        0,
                        YELLOW_TIME - elapsed
                    )

            else:

                light_text = (
                    "RED"
                )

                light_color = (
                    0,
                    0,
                    255
                )

                remaining = 0

            cv2.putText(
                display_frame,
                light_text,
                (400, 50),
                cv2.FONT_HERSHEY_SIMPLEX,
                1.2,
                light_color,
                3
            )

            if i == state.current_green:

                cv2.putText(
                    display_frame,
                    f"{remaining:.1f}s",
                    (400, 95),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.9,
                    light_color,
                    2
                )

        display_frames.append(
            display_frame
        )

    # ==================================================
    # FOUR CAMERA GRID
    # ==================================================

    top = np.hstack(
        (
            display_frames[0],
            display_frames[1]
        )
    )

    bottom = np.hstack(
        (
            display_frames[2],
            display_frames[3]
        )
    )

    grid = np.vstack(
        (
            top,
            bottom
        )
    )

    return grid

