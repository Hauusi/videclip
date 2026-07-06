#!/usr/bin/env python3
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, "/tmp/videclip-eval/server/scripts")
os.environ["FFMPEG_PATH"] = "/opt/videclip/server/node_modules/ffmpeg-static/ffmpeg"

from kill_feed_pipeline import (  # noqa: E402
    KillFeedConfig,
    crop_roi,
    detect_highlight_bar,
    get_frame,
    open_frame_reader,
    _kill_feed_row_sanity,
)

cfg = KillFeedConfig()
reader = open_frame_reader("/tmp/videclip-eval/testvid.mp4", os.environ["FFMPEG_PATH"], 32)
for t in [58, 62, 40, 99]:
    patch = crop_roi(get_frame(reader, t), cfg)
    ents = detect_highlight_bar(patch, cfg)
    if not ents:
        print(f"t={t}: no bar")
        continue
    ent = ents[0]
    g = cv2.cvtColor(ent["crop"], cv2.COLOR_BGR2GRAY)
    bright = float(np.mean(g > 165))
    ok = _kill_feed_row_sanity(ent["crop"], float(ent.get("frame_edge", 0)))
    print(
        f"t={t} h={ent['crop'].shape[0]} hs={ent['highlight_score']:.3f} "
        f"fe={ent['frame_edge']:.3f} mean={np.mean(g):.1f} std={np.std(g):.1f} "
        f"bright={bright:.3f} sanity={ok}"
    )
reader.close()
