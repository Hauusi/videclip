#!/usr/bin/env python3
"""Quick pipeline eval: event count + kill count."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

EVAL = Path("/tmp/videclip-eval")
VIDEO = str(EVAL / "testvid.mp4")
SCRIPT = str(EVAL / "server" / "scripts" / "kill_feed_detect.py")
GT = json.loads((EVAL / "ground_truth.json").read_text())["testvid.mp4"]
GT_N = len(GT)


def main() -> int:
    env = {
        **os.environ,
        "FFMPEG_PATH": "/opt/videclip/server/node_modules/ffmpeg-static/ffmpeg",
        "TESSERACT_CMD": "/usr/bin/tesseract",
        "PYTHONUNBUFFERED": "1",
    }
    proc = subprocess.run(
        ["python3", SCRIPT, "--video", VIDEO, "--pov", "s1mple"],
        capture_output=True,
        text=True,
        cwd=str(EVAL / "server" / "scripts"),
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        print(proc.stderr[-3000:], file=sys.stderr)
        return 1
    data = json.loads(proc.stdout)
    stats = data.get("stats") or {}
    kills = data.get("kills") or []
    events = stats.get("highlight_events", stats.get("coarse_hits", "?"))
    print(f"highlight_events={events} kills={len(kills)} pov={data.get('pov_player')!r}")
    print(f"ocr_calls={stats.get('ocr_calls')} frames={stats.get('highlight_frames_scanned')}")
    if kills:
        anchors = [k["anchor_s"] for k in kills[:8]]
        print(f"first_anchors={anchors}")
    ok = len(kills) >= 20
    print(f"TARGET_20={'PASS' if ok else 'FAIL'} (kills={len(kills)})")
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
