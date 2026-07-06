#!/usr/bin/env python3
"""Print kill-feed pipeline output summary for debugging."""
import json
import subprocess
import sys

video = sys.argv[1] if len(sys.argv) > 1 else "/tmp/videclip-eval/testvid.mp4"
script = sys.argv[2] if len(sys.argv) > 2 else "/tmp/videclip-eval/server/scripts/kill_feed_detect.py"

proc = subprocess.run(
    ["python3", script, "--video", video],
    capture_output=True,
    text=True,
    env={**dict(__import__("os").environ), "FFMPEG_PATH": "/opt/videclip/server/node_modules/ffmpeg-static/ffmpeg"},
)
# stdout is JSON; stderr has funnel logs
raw = proc.stdout
data = json.loads(raw)
print("pov_player:", data.get("pov_player"))
stats = data.get("stats", {})
print("stats:", json.dumps(stats, indent=2))
print("\nKILLS:")
for k in sorted(data.get("kills", []), key=lambda x: x["anchor_s"]):
    print(
        f"  {k['anchor_s']:8.2f}  killer={k.get('killer','')[:18]:18}  "
        f"victim={k.get('victim','')[:18]:18}  reason={k.get('pov_reason','')}"
    )
print("\nSTDERR tail:")
print(proc.stderr[-3000:])
