# Required model asset

The active pipeline expects **`yolo26n.pt`** in this directory, unless `MODEL_PATH`
explicitly points elsewhere. No alternate weight is downloaded automatically.

Reference for the exact model used in this project's validated runs:

- Size: 5,544,453 bytes
- SHA256: `9b09cc8bf347f0fc8a5f7657480587f25db09b34bf33b0652110fb03a8ad4fef`

If your checkout does not contain the weight, run `python scripts/fetch_model.py`
from the project root. It downloads Ultralytics' official release asset
`https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.pt`
(byte-identical to the size and SHA256 above; verified 2026-10-09) and keeps it
only if the checksum matches. An existing file with a different checksum is never
replaced. The Render build runs the same script. Ultralytics models are
AGPL-3.0 licensed; check those terms before redistributing the weight. Do not
replace it with a similarly named custom-trained model.

The original Git commit contains this weight. Its removal from the next commit's
index was approved during repository cleanup; the local file remains untouched
and ignored. That change does not erase earlier history. Keeping the file locally
is required to run with the default path.
