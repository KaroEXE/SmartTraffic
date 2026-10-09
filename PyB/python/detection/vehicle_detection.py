"""Per-camera YOLO inference, motion history, stopped counts, and annotations."""

import math
from collections import deque

import cv2
from ultralytics import YOLO

from config.config import (
    MAX_WAIT_SCORE_SECONDS,
    MIN_AVERAGE_CONF,
    MIN_DETECTION_CONF,
    MIN_TRACK_RATIO,
    MODEL_PATH,
    MOTION_WINDOW_SECONDS,
    MOVING_SPEED_THRESHOLD,
    STOP_CONFIRM_SECONDS,
    TRACK_FORGET_SECONDS,
    WAIT_SCORE_PER_SECOND,
    names,
    vehicle_classes,
    vehicle_weights,
)


def load_models():
    # Four independent model/tracker instances, in the original camera order.
    return [YOLO(str(MODEL_PATH)), YOLO(str(MODEL_PATH)),
            YOLO(str(MODEL_PATH)), YOLO(str(MODEL_PATH))]


def process_vehicle_frame(i, frame, video_time, models, state):
    previous_video_time = state.last_video_times[i]
    state.last_video_times[i] = video_time
    results = models[i].track(
        frame,
        persist=True,
        imgsz=640,
        tracker="bytetrack.yaml",
        device=0,
        conf=0.25,
        verbose=False
    )

    waiting_count = 0
    waiting_score = 0.0

    annotated_frame = frame.copy()

    # ------------------------------------------
    # RELIABILITY INFORMATION
    # ------------------------------------------

    candidate_vehicle_count = 0
    trusted_vehicle_count = 0
    tracked_vehicle_count = 0

    confidences = []

    # ------------------------------------------
    # PROCESS YOLO DETECTIONS
    # ------------------------------------------

    for box in results[0].boxes:

        class_id = int(box.cls[0])

        class_name = (
            models[i]
            .names[class_id]
            .lower()
        )

        if class_name not in vehicle_classes:

            continue

        confidence = float(
            box.conf[0]
        )

        candidate_vehicle_count += 1

        confidences.append(
            confidence
        )

        x1, y1, x2, y2 = (
            box.xyxy[0]
            .cpu()
            .tolist()
        )

        # Low-confidence vehicle:
        # draw it, but do NOT use it for traffic logic.
        if confidence < MIN_DETECTION_CONF:

            cv2.rectangle(
                annotated_frame,
                (int(x1), int(y1)),
                (int(x2), int(y2)),
                (150, 150, 150),
                1
            )

            cv2.putText(
                annotated_frame,
                f"UNCERTAIN {confidence:.2f}",
                (
                    int(x1),
                    max(20, int(y1) - 8)
                ),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                (150, 150, 150),
                1
            )

            continue

        trusted_vehicle_count += 1

        # A tracked ID is required to compare vehicle positions
        # across frames and distinguish stationary from moving.
        if box.id is None:

            cv2.rectangle(
                annotated_frame,
                (int(x1), int(y1)),
                (int(x2), int(y2)),
                (255, 0, 255),
                2
            )

            cv2.putText(
                annotated_frame,
                "UNTRACKED",
                (
                    int(x1),
                    max(20, int(y1) - 8)
                ),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                (255, 0, 255),
                2
            )

            continue

        track_id = int(
            box.id[0]
        )

        tracked_vehicle_count += 1

        center_x = (
            x1 + x2
        ) / 2

        center_y = (
            y1 + y2
        ) / 2

        width = max(
            1.0,
            x2 - x1
        )

        height = max(
            1.0,
            y2 - y1
        )

        vehicle_size = max(
            width,
            height
        )

        # --------------------------------------
        # CREATE NEW TRACK OR RESET AN EXPIRED ID
        # --------------------------------------

        if (
            track_id not in state.track_states[i]
            or video_time - state.track_states[i][track_id]["last_seen"] > TRACK_FORGET_SECONDS
        ):

            state.track_states[i][track_id] = {
                "history": deque(),
                "stopped_since": None,
                "last_seen": video_time,
                "state": "NEW",
                "speed": None
            }

            print(
                f"NEW TRACK ({names[i]}):",
                track_id,
                class_name
            )

        data = (
            state.track_states[i][track_id]
        )

        data["last_seen"] = (
            video_time
        )

        history = data["history"]

        history.append(
            (
                video_time,
                center_x,
                center_y,
                vehicle_size
            )
        )

        # Retain consecutive low-FPS observations even when farther apart than
        # the motion window. Missing detections still expire from the window.
        while (
            len(history) > 1
            and history[0][0]
            < video_time - MOTION_WINDOW_SECONDS
        ):

            if len(history) == 2 and history[0][0] == previous_video_time:
                break

            history.popleft()

        normalized_speed = None

        # --------------------------------------
        # CALCULATE NORMALIZED MOVEMENT SPEED
        # --------------------------------------

        if len(history) >= 2:

            old_time, old_x, old_y, old_size = (
                history[0]
            )

            dt = (
                video_time
                - old_time
            )

            if dt > 0.15:

                distance = math.hypot(
                    center_x - old_x,
                    center_y - old_y
                )

                average_size = max(
                    1.0,
                    (
                        vehicle_size
                        + old_size
                    ) / 2
                )

                normalized_speed = (
                    distance
                    / average_size
                    / dt
                )

        data["speed"] = (
            normalized_speed
        )

        # --------------------------------------
        # DECIDE MOVING / STOPPING / STOPPED
        # --------------------------------------

        if normalized_speed is None:

            data["state"] = "NEW"

        elif normalized_speed > MOVING_SPEED_THRESHOLD:

            data["stopped_since"] = None

            data["state"] = "MOVING"

        else:

            # Already-stationary cars are waiting too; they do
            # not need to move first to contribute to traffic.
            if data["stopped_since"] is None:

                data["stopped_since"] = video_time

            stopped_for = video_time - data["stopped_since"]

            if stopped_for >= STOP_CONFIRM_SECONDS:

                data["state"] = "STOPPED"

            else:

                data["state"] = "STOPPING"

        # --------------------------------------
        # COUNT ONLY STOPPED / WAITING VEHICLES
        # --------------------------------------

        wait_seconds = 0.0

        if data["state"] == "STOPPED":

            waiting_count += 1

            wait_seconds = (
                video_time
                - data["stopped_since"]
            )

            waiting_multiplier = (
                1.0
                + min(
                    wait_seconds,
                    MAX_WAIT_SCORE_SECONDS
                )
                * WAIT_SCORE_PER_SECOND
            )

            waiting_score += (
                vehicle_weights[class_name]
                * waiting_multiplier
            )

        # --------------------------------------
        # DRAW TRACK STATE
        # --------------------------------------

        if data["state"] == "STOPPED":

            box_color = (
                0,
                0,
                255
            )

        elif data["state"] == "STOPPING":

            box_color = (
                0,
                255,
                255
            )

        elif data["state"] == "MOVING":

            box_color = (
                0,
                255,
                0
            )

        else:

            box_color = (
                180,
                180,
                180
            )

        cv2.rectangle(
            annotated_frame,
            (int(x1), int(y1)),
            (int(x2), int(y2)),
            box_color,
            2
        )

        label = (
            f"{class_name} "
            f"ID:{track_id} "
            f"{data['state']}"
        )

        if data["state"] == "MOVING":
            label += " IGNORED"

        if data["state"] == "STOPPED":

            label += (
                f" {wait_seconds:.1f}s"
            )

        cv2.putText(
            annotated_frame,
            label,
            (
                int(x1),
                max(
                    20,
                    int(y1) - 8
                )
            ),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            box_color,
            2
        )

    # ------------------------------------------
    # REMOVE OLD TRACKS
    # ------------------------------------------

    stale_ids = []

    for track_id, data in state.track_states[i].items():

        if (
            video_time
            - data["last_seen"]
            > TRACK_FORGET_SECONDS
        ):

            stale_ids.append(
                track_id
            )

    for track_id in stale_ids:

        del state.track_states[i][track_id]

    # ------------------------------------------
    # DECIDE WHETHER THIS CAMERA IS RELIABLE
    # ------------------------------------------

    if candidate_vehicle_count == 0:

        state.camera_reliable[i] = True

        state.camera_status[i] = "OK - EMPTY"

    elif trusted_vehicle_count == 0:

        state.camera_reliable[i] = False

        state.camera_status[i] = "LOW CONFIDENCE"

    else:

        average_confidence = (
            sum(confidences)
            / len(confidences)
        )

        track_ratio = (
            tracked_vehicle_count
            / trusted_vehicle_count
        )

        state.camera_reliable[i] = (
            average_confidence >= MIN_AVERAGE_CONF
            and track_ratio >= MIN_TRACK_RATIO
        )

        if state.camera_reliable[i]:

            state.camera_status[i] = (
                f"OK {average_confidence:.2f}"
            )

        else:

            state.camera_status[i] = (
                f"UNCERTAIN "
                f"C:{average_confidence:.2f} "
                f"T:{track_ratio:.2f}"
            )

    # ------------------------------------------
    # SAVE TRAFFIC INFORMATION
    # ------------------------------------------

    state.stopped_counts[i] = (
        waiting_count
    )

    # IMPORTANT: this score contains ONLY vehicles whose
    # state is STOPPED. MOVING, NEW, STOPPING,
    # low-confidence and untracked detections contribute 0.
    state.stopped_scores[i] = (
        waiting_score
    )

    state.have_measurement[i] = True

    # ------------------------------------------
    # RESIZE
    # ------------------------------------------

    annotated_frame = cv2.resize(
        annotated_frame,
        (640, 480)
    )

    # ------------------------------------------
    # INFORMATION OVERLAY
    # ------------------------------------------

    cv2.putText(
        annotated_frame,
        f"STOPPED: {waiting_count}",
        (30, 50),
        cv2.FONT_HERSHEY_SIMPLEX,
        1,
        (0, 0, 255),
        2
    )

    cv2.putText(
        annotated_frame,
        names[i],
        (30, 90),
        cv2.FONT_HERSHEY_SIMPLEX,
        1,
        (255, 255, 255),
        2
    )

    cv2.putText(
        annotated_frame,
        f"stopped score: {waiting_score:.1f}",
        (30, 125),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        (0, 255, 255),
        2
    )

    status_color = (
        (0, 255, 0)
        if state.camera_reliable[i]
        else (0, 0, 255)
    )

    cv2.putText(
        annotated_frame,
        state.camera_status[i],
        (30, 160),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.55,
        status_color,
        2
    )

    state.last_frames[i] = (
        annotated_frame
    )

