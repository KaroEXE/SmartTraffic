"""Existing traffic state, reliability fallback, and signal decisions."""

from config.config import (
    AUTO_GREEN, BAD_UPDATES_TO_FALLBACK, BASE_GREEN, GOOD_UPDATES_TO_RECOVER,
    MAX_GREEN, MIN_GREEN, SECONDS_PER_DENSITY, WAIT_BONUS, YELLOW_TIME, names,
)


class TrafficState:
    """One state instance per running application; lists are never shared across runs."""

    def __init__(self):
        self.frames_read = [
            0,
            0,
            0,
            0
        ]

        self.last_frames = [
            None,
            None,
            None,
            None
        ]

        self.have_measurement = [
            False,
            False,
            False,
            False
        ]

        self.track_states = [
            {},
            {},
            {},
            {}
        ]

        self.stopped_counts = [
            0,
            0,
            0,
            0
        ]

        self.stopped_scores = [
            0.0,
            0.0,
            0.0,
            0.0
        ]

        self.camera_reliable = [
            True,
            True,
            True,
            True
        ]

        self.camera_status = [
            "WAITING",
            "WAITING",
            "WAITING",
            "WAITING"
        ]

        self.wait_cycles = [
            0,
            0,
            0,
            0
        ]

        self.good_ai_updates = 0

        self.bad_ai_updates = 0

        self.control_mode = "AUTO"

        self.current_green = None

        self.light_phase = "GREEN"

        self.phase_start_time = None

        self.green_duration = AUTO_GREEN

        self.controller_started = False


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


def choose_next_road(state):

    # AI is ONLY allowed to choose roads that currently
    # have confirmed STOPPED vehicles. Moving vehicles
    # do not enter this candidate list at all.
    stopped_roads = [
        i
        for i in range(4)
        if state.stopped_counts[i] > 0
    ]

    # If there are no stopped vehicles anywhere, there is
    # nothing useful for adaptive AI to optimize. Use the
    # normal automatic sequence instead.
    if len(stopped_roads) == 0:

        if state.current_green is None:
            return 0

        return (state.current_green + 1) % 4

    priority_scores = []

    for i in range(4):

        # stopped_scores itself is calculated ONLY from
        # confirmed STOPPED vehicles.
        priority = (
            state.stopped_scores[i]
            + state.wait_cycles[i] * WAIT_BONUS
        )

        priority_scores.append(priority)

    # Avoid immediately selecting the same road again when
    # another road also has stopped traffic.
    other_stopped_roads = [
        i
        for i in stopped_roads
        if i != state.current_green
    ]

    if len(other_stopped_roads) > 0:

        return max(
            other_stopped_roads,
            key=lambda i: priority_scores[i]
        )

    # The current road is the only road with a confirmed
    # stopped queue, so it may receive another green.
    return stopped_roads[0]


def choose_next_auto_road(state):

    if state.current_green is None:

        return 0

    return (
        state.current_green + 1
    ) % 4


def update_reliability(state, did_measure_this_cycle):
    if (
        did_measure_this_cycle
        and all(state.have_measurement)
    ):

        vision_reliable = all(
            state.camera_reliable
        )

        # If there are no stopped vehicles anywhere,
        # there is nothing useful for adaptive AI to optimize.
        adaptive_signal_present = (
            sum(state.stopped_counts) > 0
        )

        ai_condition_good = (
            vision_reliable
            and adaptive_signal_present
        )

        if ai_condition_good:

            state.good_ai_updates += 1

            state.bad_ai_updates = 0

        else:

            state.bad_ai_updates += 1

            state.good_ai_updates = 0

        # ----------------------------------------------
        # FALL BACK TO NORMAL FIXED-CYCLE CONTROL
        # ----------------------------------------------

        if (
            state.control_mode == "AI"
            and state.bad_ai_updates >= BAD_UPDATES_TO_FALLBACK
        ):

            state.control_mode = "AUTO"

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
            state.control_mode == "AUTO"
            and state.good_ai_updates >= GOOD_UPDATES_TO_RECOVER
        ):

            state.control_mode = "AI"

            print()
            print(
                "VISION STABLE AGAIN -> "
                "AI ADAPTIVE MODE RESTORED"
            )
            print()

def update_controller(state, current_time, emergency_priority, emergency_sampler, emergency_settings):
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
        not state.controller_started
        and all(state.have_measurement)
    ):

        vision_reliable = all(
            state.camera_reliable
        )

        adaptive_signal_present = (
            sum(state.stopped_counts) > 0
        )

        if (
            vision_reliable
            and adaptive_signal_present
        ):

            state.control_mode = "AI"

            state.current_green = max(
                range(4),
                key=lambda i: state.stopped_scores[i]
            )

            state.green_duration = (
                calculate_green_time(
                    state.stopped_scores[state.current_green]
                )
            )

        else:

            state.control_mode = "AUTO"

            state.current_green = 0

            state.green_duration = (
                AUTO_GREEN
            )

        state.light_phase = "GREEN"

        state.phase_start_time = (
            current_time
        )

        state.controller_started = True

        print()
        print(
            "CONTROLLER STARTED"
        )
        print(
            "MODE:",
            state.control_mode
        )
        print(
            "FIRST GREEN:",
            names[state.current_green]
        )
        print(
            "Stopped vehicles:",
            state.stopped_counts[state.current_green]
        )
        print(
            "Score:",
            round(
                state.stopped_scores[state.current_green],
                2
            )
        )
        print(
            "Green time:",
            round(
                state.green_duration,
                1
            ),
            "seconds"
        )
        print()

    # --------------------------------------------------
    # CONTROLLER ALREADY RUNNING
    # --------------------------------------------------

    if state.controller_started:

        elapsed = (
            current_time
            - state.phase_start_time
        )

        # ----------------------------------------------
        # GREEN FINISHED
        # ----------------------------------------------

        if (
            state.light_phase == "GREEN"
            and emergency_priority.green_should_end(
                state.current_green, elapsed, state.green_duration, MIN_GREEN, current_time
            )
        ):

            state.light_phase = "YELLOW"
            emergency_priority.on_yellow_started()

            state.phase_start_time = (
                current_time
            )

            print(
                names[state.current_green],
                "YELLOW"
            )

        # ----------------------------------------------
        # YELLOW FINISHED
        # ----------------------------------------------

        elif (
            state.light_phase == "YELLOW"
            and elapsed >= YELLOW_TIME
        ):

            state.light_phase = "ALL_RED"
            state.phase_start_time = current_time
            print("ALL RED - intersection clearance")

        elif (
            state.light_phase == "ALL_RED"
            and elapsed >= emergency_settings.all_red_seconds
        ):

            # Every road except the one that just had green
            # has waited another controller cycle.
            for i in range(4):

                if (
                    i != state.current_green
                    and state.stopped_counts[i] > 0
                ):

                    state.wait_cycles[i] += 1

                elif state.stopped_counts[i] == 0:

                    # Empty/moving-only roads should never build
                    # priority just because time passed.
                    state.wait_cycles[i] = 0

            # ------------------------------------------
            # AI MODE
            # ------------------------------------------

            if emergency_target is not None:

                next_road = emergency_target

            elif state.control_mode == "AI":

                next_road = (
                    choose_next_road(state)
                )

            # ------------------------------------------
            # FIXED AUTOMATIC MODE
            # ------------------------------------------

            else:

                next_road = (
                    choose_next_auto_road(state)
                )

            state.current_green = (
                next_road
            )
            emergency_priority.on_green_started(state.current_green, current_time)

            state.wait_cycles[state.current_green] = 0

            if state.control_mode == "AI":

                state.green_duration = (
                    calculate_green_time(
                        state.stopped_scores[state.current_green]
                    )
                )

            else:

                state.green_duration = (
                    AUTO_GREEN
                )

            state.light_phase = "GREEN"

            state.phase_start_time = (
                current_time
            )

            print()
            print(
                "MODE:",
                state.control_mode
            )
            print(
                "NEW GREEN:",
                names[state.current_green]
            )
            print(
                "Stopped vehicles:",
                state.stopped_counts[state.current_green]
            )
            print(
                "Score:",
                round(
                    state.stopped_scores[state.current_green],
                    2
                )
            )
            print(
                "Green time:",
                round(
                    state.green_duration,
                    1
                ),
                "seconds"
            )
            print()

