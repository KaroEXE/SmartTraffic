# Required model asset

The active pipeline expects **`yolo26n.pt`** in this directory, unless `MODEL_PATH`
explicitly points elsewhere. No alternate weight is downloaded automatically.

Reference for the exact model used in this project's validated runs:

- Size: 5,544,453 bytes
- SHA256: `9b09cc8bf347f0fc8a5f7657480587f25db09b34bf33b0652110fb03a8ad4fef`

If your checkout does not contain the weight, obtain that exact asset from the
project maintainer or a project release. No release/download link has been
published by this setup. Check the applicable model distribution terms before
redistributing it. Do not replace it with a similarly named custom-trained model.

The original Git commit contains this weight. Its removal from the next commit's
index was approved during repository cleanup; the local file remains untouched
and ignored. That change does not erase earlier history. Keeping the file locally
is required to run with the default path.
