# Historical source snapshots

These two files are preserved reference copies. Neither launcher nor the tests
imports them. They were moved byte-for-byte during repository cleanup:

| Current file | Original location |
| --- | --- |
| `video_io.py` | `VideoWork/video_io.py` |
| `vehicle_detection.py` | `vehicle detection/vehicle_detection.py` |

Do not edit these to change the running application. Active detection, tracking
and controller behavior lives in `app/pipeline.py`; shared video selection lives
in `config/config.py`; active source opening lives in `video_work/video_io.py`.

The older `controller/` and `detection/` packages remain in their existing locations
because regression tests still exercise them. Some experimental motion behavior
differs from the active loop. They are not drop-in replacements for it.
