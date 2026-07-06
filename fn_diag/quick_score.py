#!/usr/bin/env python3
"""Match pipeline kills vs ground_truth (±2s)."""
import json
import os
import subprocess

EVAL = "/tmp/videclip-eval"
os.environ["FFMPEG_PATH"] = "/opt/videclip/server/node_modules/ffmpeg-static/ffmpeg"
os.environ["TESSERACT_CMD"] = "/usr/bin/tesseract"

proc = subprocess.run(
    ["python3", f"{EVAL}/server/scripts/kill_feed_detect.py", "--video", f"{EVAL}/testvid.mp4", "--pov", "s1mple"],
    capture_output=True,
    text=True,
    cwd=f"{EVAL}/server/scripts",
    check=True,
)
data = json.loads(proc.stdout)
gt = [e["timestamp_sec"] for e in json.load(open(f"{EVAL}/ground_truth.json"))["testvid.mp4"]]
det = sorted(k["anchor_s"] for k in data["kills"])
gt_rem = list(gt)
tp = 0
for t in det:
    best_i = None
    best_d = None
    for i, g in enumerate(gt_rem):
        d = abs(t - g)
        if d <= 2 and (best_d is None or d < best_d):
            best_i, best_d = i, d
    if best_i is not None:
        tp += 1
        gt_rem.pop(best_i)
fp = len(det) - tp
fn = len(gt_rem)
p = tp / (tp + fp) if tp + fp else 0
r = tp / (tp + fn) if tp + fn else 0
f1 = 2 * p * r / (p + r) if p + r else 0
print(f"events={data['stats'].get('highlight_events')} kills={len(det)}")
print(f"TP={tp} FP={fp} FN={fn} P={p:.1%} R={r:.1%} F1={f1:.3f}")
