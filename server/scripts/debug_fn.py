#!/usr/bin/env python3
"""Quick FN diagnosis: pipeline kills near ground-truth misses."""
import json
import subprocess
import sys

GT_FNS = [97, 467, 759, 791, 806, 814, 826, 863, 878, 889, 931, 1008]
VIDEO = sys.argv[1] if len(sys.argv) > 1 else "/tmp/videclip-eval/testvid.mp4"
SCRIPT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/videclip-eval/server/scripts/kill_feed_detect.py"

proc = subprocess.run(
    ["python3", SCRIPT, "--video", VIDEO],
    capture_output=True,
    text=True,
    env={**dict(__import__("os").environ), "FFMPEG_PATH": "/opt/videclip/server/node_modules/ffmpeg-static/ffmpeg"},
    timeout=3600,
)
data = json.loads(proc.stdout)
kills = sorted(data.get("kills", []), key=lambda k: k["anchor_s"])
anchors = [k["anchor_s"] for k in kills]

print("=== FN near-miss (±5s) ===")
for gt in GT_FNS:
    near = [(k["anchor_s"], k.get("killer", "")[:12], k.get("victim", "")[:12]) for k in kills if abs(k["anchor_s"] - gt) <= 5]
    print(f"GT {gt:4.0f}: {near if near else 'NONE'}")

print("\n=== Cluster 95-105 ===")
for k in kills:
    if 95 <= k["anchor_s"] <= 105:
        print(f"  {k['anchor_s']:6.2f}  {k.get('killer','')[:16]:16} -> {k.get('victim','')[:16]}")

print("\n=== Cluster 460-470 ===")
for k in kills:
    if 460 <= k["anchor_s"] <= 470:
        print(f"  {k['anchor_s']:6.2f}  {k.get('killer','')[:16]:16} -> {k.get('victim','')[:16]}")

print("\n=== Cluster 785-895 ===")
for k in kills:
    if 785 <= k["anchor_s"] <= 895:
        print(f"  {k['anchor_s']:6.2f}  {k.get('killer','')[:16]:16} -> {k.get('victim','')[:16]}")
