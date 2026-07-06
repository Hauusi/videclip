#!/bin/bash
# Deploy pipeline, clean fn_diag, regen PNGs, quick eval.
set -euo pipefail
EVAL=/tmp/videclip-eval
export FFMPEG_PATH=/opt/videclip/server/node_modules/ffmpeg-static/ffmpeg
export TESSERACT_CMD=/usr/bin/tesseract

echo "=== quick eval ==="
cd "$EVAL"
python3 fn_diag/quick_eval.py
EV=$?

echo "=== regen fn_diag ==="
rm -f "$EVAL/fn_diag"/*.png "$EVAL/fn_diag/audit"/*.png 2>/dev/null || true
python3 fn_diag/regen_diag.py | tail -25

exit $EV
