#!/usr/bin/env python3
"""Compare user-marked kill-feed box vs CS2_KILL_FEED_ROI."""
import json
import sys

import cv2
import numpy as np

from kill_feed_pipeline import KillFeedConfig, crop_roi


def detect_black_frame(img):
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    mask = gray < 25
    tr = mask[0 : int(h * 0.35), int(w * 0.55) :]
    ys, xs = np.where(tr)
    if len(xs) == 0:
        return None
    x1 = int(xs.min() + w * 0.55)
    x2 = int(xs.max() + w * 0.55)
    y1 = int(ys.min())
    y2 = int(ys.max())
    return {
        "px": [x1, y1, x2, y2],
        "norm": [
            round(x1 / w, 4),
            round(y1 / h, 4),
            round((x2 - x1) / w, 4),
            round((y2 - y1) / h, 4),
        ],
    }


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/roi_check.png"
    out_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/roi_compare.jpg"
    img = cv2.imread(path)
    if img is None:
        print(json.dumps({"ok": False, "reason": "no_image", "path": path}))
        return

    h, w = img.shape[:2]
    cfg = KillFeedConfig()
    rx, ry, rw, rh = cfg.roi_x, cfg.roi_y, cfg.roi_w, cfg.roi_h
    cx1, cy1 = int(w * rx), int(h * ry)
    cx2, cy2 = int(w * (rx + rw)), int(h * (ry + rh))
    user = detect_black_frame(img)

    out = img.copy()
    cv2.rectangle(out, (cx1, cy1), (cx2, cy2), (0, 255, 0), 3)
    if user:
        x1, y1, x2, y2 = user["px"]
        cv2.rectangle(out, (x1, y1), (x2, y2), (0, 0, 255), 2)
    cv2.imwrite(out_path, out)

    patch = crop_roi(img, cfg)
    cv2.imwrite(out_path.replace(".jpg", "_crop.jpg"), patch)

    print(
        json.dumps(
            {
                "ok": True,
                "image": [w, h],
                "user_black_frame": user,
                "code_roi": {
                    "norm": [rx, ry, rw, rh],
                    "px": [cx1, cy1, cx2, cy2],
                },
                "compare_image": out_path,
                "crop_image": out_path.replace(".jpg", "_crop.jpg"),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
