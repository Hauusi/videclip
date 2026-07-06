#!/usr/bin/env python3
"""Compare registry dedup stats with KILL_FEED_DEBUG=1 (before/after dedup_time_window_sec fix)."""
import json
import os
import subprocess
import sys

EVAL = "/tmp/videclip-eval"
os.environ["FFMPEG_PATH"] = "/opt/videclip/server/node_modules/ffmpeg-static/ffmpeg"
os.environ["TESSERACT_CMD"] = "/usr/bin/tesseract"
os.environ["KILL_FEED_DEBUG"] = "1"

proc = subprocess.run(
    [
        "python3",
        f"{EVAL}/server/scripts/kill_feed_detect.py",
        "--video",
        f"{EVAL}/testvid.mp4",
        "--pov",
        "s1mple",
    ],
    capture_output=True,
    text=True,
    cwd=f"{EVAL}/server/scripts",
)
if proc.returncode != 0:
    print(proc.stderr[-8000:], file=sys.stderr)
    sys.exit(proc.returncode)

data = json.loads(proc.stdout)
s = data["stats"]
gt = [e["timestamp_sec"] for e in json.load(open(f"{EVAL}/ground_truth.json"))["testvid.mp4"]]
det = sorted(k["anchor_s"] for k in data["kills"])
gt_rem = list(gt)
tp = 0
for t in det:
    for i, g in enumerate(gt_rem):
        if abs(t - g) <= 2:
            tp += 1
            gt_rem.pop(i)
            break
fp = len(det) - tp
fn = len(gt_rem)
print(
    f"kills={len(det)} before_dedup={s.get('unique_fingerprints_before_dedup')} "
    f"after_dedup={s.get('unique_fingerprints_after_dedup')} "
    f"window_rejected={s.get('registry_dedup_window_rejected', 0)}"
)
print(f"TP={tp} FP={fp} FN={fn}")
for line in proc.stderr.splitlines():
    if "registry dedup window reject" in line:
        print(line)
