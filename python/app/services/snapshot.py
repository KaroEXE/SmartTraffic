"""Read-only projection of the active loop's values into the dashboard schema."""

import time


def build_snapshot(values):
    names = ("north", "south", "west", "east")
    current = values["current_green"]
    phase = values["light_phase"]
    started = values["controller_started"]
    now = values["current_time"]
    policy = values["emergency_priority"]
    settings = values["emergency_settings"]
    sampler = values["emergency_sampler"]
    remaining = None
    if started:
        duration = {"GREEN": values["green_duration"], "YELLOW": values["YELLOW_TIME"],
                    "ALL_RED": settings.all_red_seconds}[phase]
        remaining = max(0.0, duration - (now - values["phase_start_time"]))
        if phase == "GREEN" and policy.green_road == current:
            remaining = max(0.0, settings.max_priority_seconds - (now - policy.green_since))

    directions = {}
    for i, name in enumerate(names):
        measurement = values["measurements"][i]
        status, boxes = policy.display(i, now)
        directions[name] = {
            **(measurement or {}),
            "stopped_vehicles": values["stopped_counts"][i] if measurement else None,
            "stopped_score": values["stopped_scores"][i] if measurement else None,
            "priority_score": (values["stopped_scores"][i]
                               + values["wait_cycles"][i] * values["WAIT_BONUS"]) if measurement else None,
            "wait_cycles": values["wait_cycles"][i],
            "reliable": values["camera_reliable"][i] if measurement else None,
            "vision_status": values["camera_status"][i],
            "signal": (phase if i == current and phase != "ALL_RED" else "RED") if started else None,
            "emergency_status": status if sampler.enabled else "DISABLED",
            "emergency_detections": [{"label": box.label, "confidence": box.confidence,
                                      "xyxy": list(box.xyxy)} for box in boxes],
            "frames_read": values["frames_read"][i],
        }
    return {
        "schema_version": 1,
        "updated_at": time.time(),
        "directions": directions,
        "controller": {
            "started": started, "mode": values["control_mode"],
            "effective_mode": "EMERGENCY" if policy.target is not None else values["control_mode"],
            "phase": phase if started else None,
            "selected_direction": names[current] if current is not None else None,
            "active_green_direction": names[current] if started and phase == "GREEN" else None,
            "remaining_seconds": remaining,
            "timer_is_estimate": policy.target is not None,
            "fallback_active": values["control_mode"] == "AUTO",
            "good_ai_updates": values["good_ai_updates"],
            "bad_ai_updates": values["bad_ai_updates"],
        },
        "emergency": {"enabled": sampler.enabled, "active": policy.target is not None,
                      "direction": names[policy.target] if policy.target is not None else None,
                      # Latest positive sample on the confirmed road (not a new detection).
                      "confidence": (policy.roads[policy.target].confidence
                                     if policy.target is not None else None)},
        "warnings": [f"{names[i]}: {values['camera_status'][i]}" for i in range(4)
                     if not values["camera_reliable"][i]],
    }
