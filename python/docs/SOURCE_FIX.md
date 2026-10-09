# Source-selection correction

The reported HTTP 429 came from `YoutubeDL.extract_info()` in
`video_work/video_io.py`. The reason it was called despite the user's MP4 edits
was two independent source lists:

```text
main.py -> app/pipeline.py -> config/config.py -> YouTube defaults
yooFinalMaybe.py -> its own local videos list -> MP4s
```

The user's desktop script contained no algorithm changes relative to the original
Git baseline; its only executable change was source selection. Its exact bytes
were preserved in `.local/backups/yooFinalMaybe-before-shared-sources-20261009-103344.py`
before replacing it with the shared desktop launcher.

Now both launchers use `app/pipeline.py` and the `videos` list in `config/config.py`:

| Direction | Selected input |
| --- | --- |
| NORTH | `videos/1car8mins.mp4` |
| SOUTH | `videos/4cars.mp4` |
| WEST | `videos/5carsgood.mp4` |
| EAST | `videos/aFewMoreCars.mp4` |

The south filename uses the actual disk casing for portability. Private `.env`
files were not edited. Nonempty `VIDEO_*` environment values intentionally retain
their documented precedence. No YouTube cookie configuration was added because
the user intends to use MP4s. No AI settings or traffic decisions were changed.

`main.py --check-config` reports the resolved sources without starting inference.
Normal startup prints them as well. Camera-open failures name the failing direction
and configuration location, instead of suggesting a GPU issue for every error.
Remote source credentials and exception messages are not printed by these summaries.

`scripts/check_inputs.py --configured` now uses the application's real source
opener instead of sending every configured value to yt-dlp. The GPU smoke script
defaults to the real configured inputs rather than a separate hardcoded video list.
`run.ps1` selects `.venv` explicitly, regardless of the currently activated environment.

For the separate TLS/protocol error, use `http://127.0.0.1:5000`, not HTTPS. The
local development server does not implement TLS. Stop the old process with Ctrl+C
before restarting so it reloads the corrected source selection.

Validation: all four configured MP4s decode; actual CUDA inference produces all
four annotated MJPEG feeds and updating traffic JSON for six concurrent HTTP
viewers, with four independent trackers and clean shutdown. Roboflow was disabled
only for the offline smoke test. Regression tests also check source sharing,
override precedence, startup diagnostics and the original algorithm/image hashes.
