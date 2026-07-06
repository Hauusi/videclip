#!/bin/bash
# Clean scoring run — kill stale eval jobs, run once with live logging.
set -euo pipefail
EVAL=/tmp/videclip-eval
export FFMPEG_PATH=/opt/videclip/server/node_modules/ffmpeg-static/ffmpeg
export TESSERACT_CMD=/usr/bin/tesseract
export PYTHONUNBUFFERED=1

echo "[cleanup] stopping stale eval jobs..."
pkill -f 'while pgrep.*scoring.py' 2>/dev/null || true
pkill -f 'diagnose_fn' 2>/dev/null || true
pkill -f 'python3 scoring.py' 2>/dev/null || true
pkill -f 'kill_feed_detect.py' 2>/dev/null || true
sleep 2
# Force-kill stragglers
pgrep -f 'kill_feed_detect.py' | xargs -r kill -9 2>/dev/null || true
pgrep -f 'python3 scoring.py' | xargs -r kill -9 2>/dev/null || true
sleep 1

remaining=$(pgrep -afc 'scoring.py|kill_feed_detect' || echo 0)
echo "[cleanup] remaining procs: $remaining"

LOG="$EVAL/fn_diag/scoring_clean.log"
mkdir -p "$EVAL/fn_diag"
echo "[run] $(date -Is) starting scoring.py -> $LOG"
cd "$EVAL"
python3 -u scoring.py 2>&1 | tee "$LOG"
echo "[run] $(date -Is) DONE" >> "$LOG"
