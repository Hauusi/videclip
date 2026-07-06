#!/usr/bin/env python3
"""Quick FN diagnosis at remaining miss timestamps."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

EVAL = Path("/tmp/videclip-eval")
sys.path.insert(0, str(EVAL / "server" / "scripts"))
os.environ["FFMPEG_PATH"] = "/opt/videclip/server/node_modules/ffmpeg-static/ffmpeg"
os.environ["TESSERACT_CMD"] = "/usr/bin/tesseract"

from kill_feed_pipeline import (  # noqa: E402
    KillFeedConfig,
    build_trusted_pov_killers,
    classify_registry_entry,
    crop_roi,
    detect_red_bordered_entries,
    get_frame,
    is_valid_kill_fingerprint,
    ocr_kill_bar,
    open_frame_reader,
    parse_kill_fingerprint,
    configure_tesseract,
)

PICKS = [38.0, 97.0, 791.0, 821.0, 759.0, 467.0]
VIDEO = str(EVAL / "testvid.mp4")
FFMPEG = os.environ["FFMPEG_PATH"]


def main() -> None:
    configure_tesseract()
    last = json.loads((EVAL / "results.json").read_text())[-1]
    detected = last["metrics"]["detected_timestamps"]
    proc = subprocess.run(
        ["python3", str(EVAL / "server" / "scripts" / "kill_feed_detect.py"), "--video", VIDEO],
        capture_output=True,
        text=True,
        cwd=str(EVAL / "server" / "scripts"),
        check=True,
    )
    pipe = json.loads(proc.stdout)
    pov_rep = pipe.get("pov_player") or ""
    pov_cluster = pipe.get("pov_cluster")
    all_clusters = pipe.get("clusters") or []
    trusted = build_trusted_pov_killers(pipe.get("registry") or [], pov_rep, pov_cluster)
    cfg = KillFeedConfig()
    reader = open_frame_reader(VIDEO, FFMPEG, 38.0)

    kills = {round(k["anchor_s"], 2): k for k in pipe.get("kills", [])}
    print("POV:", pov_rep, "kills:", len(kills))

    for t in PICKS:
        nd = min(detected, key=lambda d: abs(d - t))
        near_kill = [a for a in kills if abs(a - t) <= 5]
        print(f"\n=== GT {t}s det={nd} delta={abs(nd-t):.2f} kills_near={near_kill}")
        for off in range(-4, 5):
            tt = t + off
            if tt < 32:
                continue
            frame = get_frame(reader, tt)
            if frame is None:
                continue
            patch = crop_roi(frame, cfg)
            if patch is None:
                continue
            for ent in detect_red_bordered_entries(patch, cfg):
                raw, _ = ocr_kill_bar(ent["crop"], cfg)
                if not (raw or "").strip():
                    continue
                fp = parse_kill_fingerprint(raw)
                fake = {"fingerprint": fp, "killer": fp.get("killer"), "victim": fp.get("victim"), "assist": fp.get("assist")}
                cls, reason = classify_registry_entry(fake, pov_rep, pov_cluster, all_clusters, cfg, trusted)
                print(
                    f"  t={tt}s raw={raw!r} k={fp.get('killer')!r} v={fp.get('victim')!r} "
                    f"valid={is_valid_kill_fingerprint(fp)} -> {cls}/{reason}"
                )
    reader.close()


if __name__ == "__main__":
    main()
