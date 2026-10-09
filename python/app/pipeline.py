"""Original four-camera algorithm, with explicit lifecycle and read-only publishing.

The tightly coupled decision loop is intentionally kept together. Do not replace
it with the older experimental modules without a separate behavioral review.
"""

import math
import time
from collections import deque

import cv2
import numpy as np

from app.services.snapshot import build_snapshot
from config.config import MODEL_PATH, names, videos
from emergency.emergency_priority import (
    EmergencyPriority,
    EmergencySettings,
    RoboflowSampler,
)
from video_work.video_io import open_video


def run(*, stop_event=None, publisher=None, show_window=True, max_cycles=None):
    """Own all four trackers; route handlers never invoke this function.

    max_cycles is an optional test/smoke bound, not a frame-skipping setting.
    """
    from ultralytics import YOLO

    cameras = []
    emergency_sampler = None
    if publisher is not None:
        publisher.set_lifecycle("starting")
    try:
        if not MODEL_PATH.is_file():
            raise FileNotFoundError("Configured MODEL_PATH is missing; no replacement model downloaded")
        for i, video in enumerate(videos):
            if stop_event is not None and stop_event.is_set():
                return
            if publisher is not None:
                publisher.camera_status(i, "opening")
            cameras.append(open_video(video))
            if publisher is not None:
                publisher.camera_status(i, "opened")

        models = [
            YOLO(str(MODEL_PATH)),
            YOLO(str(MODEL_PATH)),
            YOLO(str(MODEL_PATH)),
            YOLO(str(MODEL_PATH))
        ]


        video_fps = []

        for camera in cameras:

            fps = camera.get(cv2.CAP_PROP_FPS)

            if fps is None or fps <= 1 or math.isnan(fps):

                fps = 30.0

            video_fps.append(fps)


        frames_read = [
            0,
            0,
            0,
            0
        ]


        last_frames = [
            None,
            None,
            None,
            None
        ]


        have_measurement = [
            False,
            False,
            False,
            False
        ]


        # ==================================================
        # VEHICLE SETTINGS
        # ==================================================

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


        # Minimum YOLO confidence before a vehicle is trusted
        MIN_DETECTION_CONF = 0.35

        # A camera is considered trustworthy if enough detections
        # have IDs and the average confidence is reasonable.
        MIN_AVERAGE_CONF = 0.40
        MIN_TRACK_RATIO = 0.60


        # ==================================================
        # STOPPED-VEHICLE DETECTION
        # ==================================================

        # How much history to use to decide whether a vehicle moved.
        MOTION_WINDOW_SECONDS = 0.60

        # Normalized movement speed:
        # movement distance / vehicle size / seconds
        #
        # Increase this if stationary boxes jitter too much.
        # Decrease it if very slowly moving cars are being marked stopped.
        MOVING_SPEED_THRESHOLD = 0.12

        # Count stationary vehicles as soon as a motion estimate is available.
        # Increase this only if you want an additional stop-confirmation delay.
        STOP_CONFIRM_SECONDS = 0.00

        # Forget a track if YOLO has not seen it for this many video seconds.
        TRACK_FORGET_SECONDS = 2.00

        # Longer-waiting vehicles add slightly more traffic score.
        WAIT_SCORE_PER_SECOND = 0.05
        MAX_WAIT_SCORE_SECONDS = 20.0


        # One dictionary per camera.
        # Each track ID has its own movement history and state.
        track_states = [
            {},
            {},
            {},
            {}
        ]


        stopped_counts = [
            0,
            0,
            0,
            0
        ]


        stopped_scores = [
            0.0,
            0.0,
            0.0,
            0.0
        ]


        camera_reliable = [
            True,
            True,
            True,
            True
        ]


        camera_status = [
            "WAITING",
            "WAITING",
            "WAITING",
            "WAITING"
        ]


        # ==================================================
        # TRAFFIC LIGHT SETTINGS
        # ==================================================

        MIN_GREEN = 4
        MAX_GREEN = 12
        BASE_GREEN = 4
        SECONDS_PER_DENSITY = 1.2
        YELLOW_TIME = 2

        WAIT_BONUS = 1.5

        wait_cycles = [
            0,
            0,
            0,
            0
        ]


        # Normal fixed-cycle fallback.
        AUTO_GREEN = 7


        # If vision is unreliable for several measurement updates,
        # switch from AI mode to fixed automatic mode.
        BAD_UPDATES_TO_FALLBACK = 8

        # AI must be stable again for several updates before taking control back.
        GOOD_UPDATES_TO_RECOVER = 15


        good_ai_updates = 0
        bad_ai_updates = 0

        control_mode = "AUTO"

        current_green = None
        light_phase = "GREEN"
        phase_start_time = None
        green_duration = AUTO_GREEN
        controller_started = False


        # ==================================================
        # TRAFFIC LIGHT FUNCTIONS
        # ==================================================

        def calculate_green_time(stopped_score):

            green_time = (
                BASE_GREEN
                + stopped_score * SECONDS_PER_DENSITY
            )

            green_time = max(
                MIN_GREEN,
                green_time
            )

            green_time = min(
                MAX_GREEN,
                green_time
            )

            return green_time


        def choose_next_road():

            nonlocal current_green

            # AI is ONLY allowed to choose roads that currently
            # have confirmed STOPPED vehicles. Moving vehicles
            # do not enter this candidate list at all.
            stopped_roads = [
                i
                for i in range(4)
                if stopped_counts[i] > 0
            ]

            # If there are no stopped vehicles anywhere, there is
            # nothing useful for adaptive AI to optimize. Use the
            # normal automatic sequence instead.
            if len(stopped_roads) == 0:

                if current_green is None:
                    return 0

                return (current_green + 1) % 4

            priority_scores = []

            for i in range(4):

                # stopped_scores itself is calculated ONLY from
                # confirmed STOPPED vehicles.
                priority = (
                    stopped_scores[i]
                    + wait_cycles[i] * WAIT_BONUS
                )

                priority_scores.append(priority)

            # Avoid immediately selecting the same road again when
            # another road also has stopped traffic.
            other_stopped_roads = [
                i
                for i in stopped_roads
                if i != current_green
            ]

            if len(other_stopped_roads) > 0:

                return max(
                    other_stopped_roads,
                    key=lambda i: priority_scores[i]
                )

            # The current road is the only road with a confirmed
            # stopped queue, so it may receive another green.
            return stopped_roads[0]


        def choose_next_auto_road():

            if current_green is None:

                return 0

            return (
                current_green + 1
            ) % 4


        # ==================================================
        # MAIN LOOP
        # ==================================================

        frame_counter = 0

        emergency_settings = EmergencySettings()
        emergency_sampler = RoboflowSampler(emergency_settings)
        emergency_priority = EmergencyPriority(emergency_settings)
        print("ROBOFLOW: background sampling enabled" if emergency_sampler.enabled
              else "ROBOFLOW: disabled (set ROBOFLOW_API_KEY); normal traffic control continues")


        measurements: list[dict | None] = [None] * 4
        while stop_event is None or not stop_event.is_set():
            if max_cycles is not None and frame_counter >= max_cycles:
                break

            frames = []

            frame_counter += 1

            video_ended = False

            did_measure_this_cycle = (
                frame_counter % 2 == 0
            )


            for i in range(4):

                success, frame = cameras[i].read()

                if not success:

                    video_ended = True
                    if publisher is not None:
                        publisher.camera_status(i, "eof_or_read_failure")
                        publisher.set_lifecycle("stopped", "camera_read_ended")

                    break


                frames_read[i] += 1
                if publisher is not None:
                    publisher.camera_read(i)

                # Sample unannotated frames; encoding/HTTP run in background workers.
                # Camera index carries NORTH/SOUTH/WEST/EAST through every response.
                emergency_sampler.submit(i, frame, time.monotonic())

                video_time = (
                    frames_read[i]
                    / video_fps[i]
                )


                if did_measure_this_cycle:

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

                    seen_track_ids = set()


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

                        seen_track_ids.add(
                            track_id
                        )


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
                        # CREATE NEW TRACK
                        # --------------------------------------

                        if track_id not in track_states[i]:

                            track_states[i][track_id] = {
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
                            track_states[i][track_id]
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


                        # Keep only recent movement history.
                        while (
                            len(history) > 1
                            and history[0][0]
                            < video_time - MOTION_WINDOW_SECONDS
                        ):

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

                    for track_id, data in track_states[i].items():

                        if (
                            video_time
                            - data["last_seen"]
                            > TRACK_FORGET_SECONDS
                        ):

                            stale_ids.append(
                                track_id
                            )


                    for track_id in stale_ids:

                        del track_states[i][track_id]


                    # ------------------------------------------
                    # DECIDE WHETHER THIS CAMERA IS RELIABLE
                    # ------------------------------------------

                    if candidate_vehicle_count == 0:

                        camera_reliable[i] = True

                        camera_status[i] = "OK - EMPTY"


                    elif trusted_vehicle_count == 0:

                        camera_reliable[i] = False

                        camera_status[i] = "LOW CONFIDENCE"


                    else:

                        average_confidence = (
                            sum(confidences)
                            / len(confidences)
                        )

                        track_ratio = (
                            tracked_vehicle_count
                            / trusted_vehicle_count
                        )


                        camera_reliable[i] = (
                            average_confidence >= MIN_AVERAGE_CONF
                            and track_ratio >= MIN_TRACK_RATIO
                        )


                        if camera_reliable[i]:

                            camera_status[i] = (
                                f"OK {average_confidence:.2f}"
                            )

                        else:

                            camera_status[i] = (
                                f"UNCERTAIN "
                                f"C:{average_confidence:.2f} "
                                f"T:{track_ratio:.2f}"
                            )


                    # ------------------------------------------
                    # SAVE TRAFFIC INFORMATION
                    # ------------------------------------------

                    stopped_counts[i] = (
                        waiting_count
                    )

                    # IMPORTANT: this score contains ONLY vehicles whose
                    # state is STOPPED. MOVING, NEW, STOPPING,
                    # low-confidence and untracked detections contribute 0.
                    stopped_scores[i] = (
                        waiting_score
                    )

                    have_measurement[i] = True
                    measurements[i] = {
                        "detected_vehicles": candidate_vehicle_count,
                        "trusted_vehicles": trusted_vehicle_count,
                        "tracked_vehicles": tracked_vehicle_count,
                        "average_confidence": (sum(confidences) / len(confidences)) if confidences else None,
                        "tracking_ratio": tracked_vehicle_count / trusted_vehicle_count if trusted_vehicle_count else None,
                        "measured_at": time.time(),
                    }


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
                        if camera_reliable[i]
                        else (0, 0, 255)
                    )


                    cv2.putText(
                        annotated_frame,
                        camera_status[i],
                        (30, 160),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.55,
                        status_color,
                        2
                    )


                    last_frames[i] = (
                        annotated_frame
                    )


                if last_frames[i] is not None:

                    frames.append(
                        last_frames[i]
                    )


            if video_ended:

                break


            if len(frames) != 4:

                continue


            # ==================================================
            # AI RELIABILITY / FAIL-SAFE MODE
            # ==================================================

            if (
                did_measure_this_cycle
                and all(have_measurement)
            ):

                vision_reliable = all(
                    camera_reliable
                )


                # If there are no stopped vehicles anywhere,
                # there is nothing useful for adaptive AI to optimize.
                adaptive_signal_present = (
                    sum(stopped_counts) > 0
                )


                ai_condition_good = (
                    vision_reliable
                    and adaptive_signal_present
                )


                if ai_condition_good:

                    good_ai_updates += 1

                    bad_ai_updates = 0

                else:

                    bad_ai_updates += 1

                    good_ai_updates = 0


                # ----------------------------------------------
                # FALL BACK TO NORMAL FIXED-CYCLE CONTROL
                # ----------------------------------------------

                if (
                    control_mode == "AI"
                    and bad_ai_updates >= BAD_UPDATES_TO_FALLBACK
                ):

                    control_mode = "AUTO"

                    print()
                    print(
                        "AI CONDITION UNRELIABLE -> "
                        "FALLING BACK TO FIXED AUTOMATIC MODE"
                    )

                    if not vision_reliable:

                        print(
                            "Reason: vision/tracking uncertainty"
                        )

                    elif not adaptive_signal_present:

                        print(
                            "Reason: no confirmed stopped queue"
                        )

                    print()


                # ----------------------------------------------
                # RETURN TO AI AFTER CONDITIONS RECOVER
                # ----------------------------------------------

                elif (
                    control_mode == "AUTO"
                    and good_ai_updates >= GOOD_UPDATES_TO_RECOVER
                ):

                    control_mode = "AI"

                    print()
                    print(
                        "VISION STABLE AGAIN -> "
                        "AI ADAPTIVE MODE RESTORED"
                    )
                    print()


            # ==================================================
            # TRAFFIC LIGHT CONTROLLER
            # ==================================================

            current_time = (
                time.monotonic()
            )

            for emergency_result in emergency_sampler.poll():
                emergency_priority.observe(emergency_result, current_time)
            previous_emergency_target = emergency_priority.target
            emergency_target = emergency_priority.choose(current_time)
            if emergency_target != previous_emergency_target:
                print("EMERGENCY PRIORITY:", names[emergency_target]
                      if emergency_target is not None else "ENDED - normal controller resumes")


            # Wait until every camera has produced
            # at least one measurement.
            if (
                not controller_started
                and all(have_measurement)
            ):

                vision_reliable = all(
                    camera_reliable
                )

                adaptive_signal_present = (
                    sum(stopped_counts) > 0
                )


                if (
                    vision_reliable
                    and adaptive_signal_present
                ):

                    control_mode = "AI"

                    current_green = max(
                        range(4),
                        key=lambda i: stopped_scores[i]
                    )

                    green_duration = (
                        calculate_green_time(
                            stopped_scores[current_green]
                        )
                    )

                else:

                    control_mode = "AUTO"

                    current_green = 0

                    green_duration = (
                        AUTO_GREEN
                    )


                light_phase = "GREEN"

                phase_start_time = (
                    current_time
                )

                controller_started = True


                print()
                print(
                    "CONTROLLER STARTED"
                )
                print(
                    "MODE:",
                    control_mode
                )
                print(
                    "FIRST GREEN:",
                    names[current_green]
                )
                print(
                    "Stopped vehicles:",
                    stopped_counts[current_green]
                )
                print(
                    "Score:",
                    round(
                        stopped_scores[current_green],
                        2
                    )
                )
                print(
                    "Green time:",
                    round(
                        green_duration,
                        1
                    ),
                    "seconds"
                )
                print()


            # --------------------------------------------------
            # CONTROLLER ALREADY RUNNING
            # --------------------------------------------------

            if controller_started:

                elapsed = (
                    current_time
                    - phase_start_time
                )


                # ----------------------------------------------
                # GREEN FINISHED
                # ----------------------------------------------

                if (
                    light_phase == "GREEN"
                    and emergency_priority.green_should_end(
                        current_green, elapsed, green_duration, MIN_GREEN, current_time
                    )
                ):

                    light_phase = "YELLOW"
                    emergency_priority.on_yellow_started()

                    phase_start_time = (
                        current_time
                    )


                    print(
                        names[current_green],
                        "YELLOW"
                    )


                # ----------------------------------------------
                # YELLOW FINISHED
                # ----------------------------------------------

                elif (
                    light_phase == "YELLOW"
                    and elapsed >= YELLOW_TIME
                ):

                    light_phase = "ALL_RED"
                    phase_start_time = current_time
                    print("ALL RED - intersection clearance")

                elif (
                    light_phase == "ALL_RED"
                    and elapsed >= emergency_settings.all_red_seconds
                ):

                    # Every road except the one that just had green
                    # has waited another controller cycle.
                    for i in range(4):

                        if (
                            i != current_green
                            and stopped_counts[i] > 0
                        ):

                            wait_cycles[i] += 1

                        elif stopped_counts[i] == 0:

                            # Empty/moving-only roads should never build
                            # priority just because time passed.
                            wait_cycles[i] = 0


                    # ------------------------------------------
                    # AI MODE
                    # ------------------------------------------

                    if emergency_target is not None:

                        next_road = emergency_target

                    elif control_mode == "AI":

                        next_road = (
                            choose_next_road()
                        )


                    # ------------------------------------------
                    # FIXED AUTOMATIC MODE
                    # ------------------------------------------

                    else:

                        next_road = (
                            choose_next_auto_road()
                        )


                    current_green = (
                        next_road
                    )
                    emergency_priority.on_green_started(current_green, current_time)


                    wait_cycles[current_green] = 0


                    if control_mode == "AI":

                        green_duration = (
                            calculate_green_time(
                                stopped_scores[current_green]
                            )
                        )

                    else:

                        green_duration = (
                            AUTO_GREEN
                        )


                    light_phase = "GREEN"

                    phase_start_time = (
                        current_time
                    )


                    print()
                    print(
                        "MODE:",
                        control_mode
                    )
                    print(
                        "NEW GREEN:",
                        names[current_green]
                    )
                    print(
                        "Stopped vehicles:",
                        stopped_counts[current_green]
                    )
                    print(
                        "Score:",
                        round(
                            stopped_scores[current_green],
                            2
                        )
                    )
                    print(
                        "Green time:",
                        round(
                            green_duration,
                            1
                        ),
                        "seconds"
                    )
                    print()


            # ==================================================
            # DRAW TRAFFIC LIGHT STATE
            # ==================================================

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
                    if control_mode == "AI"
                    else (255, 200, 0)
                )


                cv2.putText(
                    display_frame,
                    f"MODE: {control_mode}",
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
                if light_phase == "ALL_RED":
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


                if controller_started:

                    elapsed = (
                        current_time
                        - phase_start_time
                    )


                    if i == current_green and light_phase != "ALL_RED":

                        if light_phase == "GREEN":

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
                                green_duration - elapsed
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


                    if i == current_green:

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


            if publisher is not None:
                publisher.publish_snapshot(build_snapshot(locals()))
                publisher.offer_frames(display_frames)

            if not show_window:
                continue

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


            cv2.imshow(
                "AI Traffic Intersection",
                grid
            )


            if (
                cv2.waitKey(1) & 0xFF
                == ord("q")
            ):

                break


    except Exception as exc:
        if publisher is not None:
            # Exception messages can contain private camera URLs or credentials.
            publisher.set_lifecycle("failed", type(exc).__name__)
        raise
    finally:
        if emergency_sampler is not None:
            emergency_sampler.close()
        for camera in cameras:
            camera.release()
        if show_window:
            cv2.destroyAllWindows()
        if publisher is not None:
            publisher.finish_pipeline()
