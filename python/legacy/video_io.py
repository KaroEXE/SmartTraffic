"""Video opening and the original OpenCV traffic-light overlays/grid."""

from urllib.parse import urlparse

import cv2
import numpy as np

from config.config import YELLOW_TIME, project_path


def open_video(source):
    hostname = (urlparse(source).hostname or "").lower()

    if hostname in {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}:
        from yt_dlp import YoutubeDL

        # Resolve a fresh stream URL on each run; YouTube stream URLs expire.
        options = {
            "format": "best[height<=720]/bestvideo[height<=720]/best/bestvideo",
            "noplaylist": True,
            "quiet": True,
        }

        with YoutubeDL(options) as downloader:
            info = downloader.extract_info(source, download=False)

        camera = cv2.VideoCapture(info["url"], cv2.CAP_FFMPEG)
    else:
        camera = cv2.VideoCapture(str(project_path(source)) if not hostname else source)

    if not camera.isOpened():
        camera.release()
        raise RuntimeError(f"Could not open video source: {source}")

    return camera


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

