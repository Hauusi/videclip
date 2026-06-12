#!/usr/bin/env python3
"""Detect wide central UI panels (books, menus) that 9:16 crop would cut off."""
import json
import sys


def portrait_crop_w(w, h):
    return int(h * 9 / 16)


def iou(a, b):
    ax1, ay1, aw, ah = a
    bx1, by1, bw, bh = b
    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    union = aw * ah + bw * bh - inter
    return inter / max(union, 1)


def score_panel(x, y, bw, bh, w, h, crop_w):
    frame_area = w * h
    area = bw * bh
    if area < frame_area * 0.1 or area > frame_area * 0.88:
        return 0
    aspect = bw / max(bh, 1)
    if aspect < 0.85 or aspect > 4.2:
        return 0
    if bw < crop_w * 1.06:
        return 0
    cx, cy = x + bw / 2, y + bh / 2
    dist = ((cx - w / 2) ** 2 + (cy - h / 2) ** 2) ** 0.5
    if dist > min(w, h) * 0.38:
        return 0
    wider_than_crop = bw / max(crop_w, 1)
    center_w = 1 - dist / (min(w, h) * 0.5)
    return area * center_w * min(wider_than_crop, 2.2)


def find_panel_bbox(frame, crop_w):
    import cv2
    import numpy as np

    h, w = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (7, 7), 0)

    best = None
    best_score = 0

    for edges in (
        cv2.Canny(blur, 40, 120),
        cv2.adaptiveThreshold(
            blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 7
        ),
    ):
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (13, 13))
        morph = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)
        contours, _ = cv2.findContours(morph, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in contours:
            x, y, bw, bh = cv2.boundingRect(cnt)
            s = score_panel(x, y, bw, bh, w, h, crop_w)
            if s > best_score:
                best_score = s
                best = (x, y, bw, bh)

    return best, best_score


def pad_bbox(x, y, bw, bh, w, h, margin=0.02):
    mx = int(w * margin)
    my = int(h * margin)
    x1 = max(0, x - mx)
    y1 = max(0, y - my)
    x2 = min(w, x + bw + mx)
    y2 = min(h, y + bh + my)
    return x1, y1, x2 - x1, y2 - y1


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"ok": False}))
        return

    video_path = sys.argv[1]
    start = float(sys.argv[2])
    duration = float(sys.argv[3])

    try:
        import cv2
    except ImportError:
        print(json.dumps({"ok": False, "reason": "no_opencv"}))
        return

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(json.dumps({"ok": False}))
        return

    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    crop_w = portrait_crop_w(w, h)

    if w <= h or crop_w >= w * 0.98:
        cap.release()
        print(json.dumps({"ok": False, "reason": "not_landscape"}))
        return

    fast = len(sys.argv) > 4 and sys.argv[4] == "fast"
    sample_count = 4 if fast else max(4, min(12, int(duration / 2.5) + 2))
    step = max(1, int((duration * fps) / sample_count))
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(start * fps))

    hits = []
    frame_idx = 0
    read = 0

    while read < sample_count:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % step == 0:
            t = start + frame_idx / fps
            bbox, score = find_panel_bbox(frame, crop_w)
            if bbox and score > 0:
                hits.append({"t": t, "bbox": bbox, "score": score})
            read += 1
        frame_idx += 1

    cap.release()

    if len(hits) < 2:
        print(json.dumps({"ok": False, "reason": "no_panel"}))
        return

    hits.sort(key=lambda x: x["t"])
    segments = []
    seg = [hits[0]]

    for hit in hits[1:]:
        if hit["t"] - seg[-1]["t"] <= 4.5 and iou(seg[-1]["bbox"], hit["bbox"]) > 0.35:
            seg.append(hit)
        else:
            segments.append(seg)
            seg = [hit]
    segments.append(seg)

    best_seg = max(segments, key=lambda s: sum(h["score"] for h in s) * len(s))
    if len(best_seg) < 2:
        print(json.dumps({"ok": False, "reason": "unstable"}))
        return

    avg_score = sum(h["score"] for h in best_seg) / len(best_seg)
    if avg_score < crop_w * h * 0.015:
        print(json.dumps({"ok": False, "reason": "low_confidence"}))
        return

    bx = sum(h["bbox"][0] for h in best_seg) / len(best_seg)
    by = sum(h["bbox"][1] for h in best_seg) / len(best_seg)
    bw = sum(h["bbox"][2] for h in best_seg) / len(best_seg)
    bh = sum(h["bbox"][3] for h in best_seg) / len(best_seg)
    x, y, bw, bh = pad_bbox(int(bx), int(by), int(bw), int(bh), w, h)

    seg_start = max(start, best_seg[0]["t"] - 0.4)
    seg_end = min(start + duration, best_seg[-1]["t"] + 1.2)
    if seg_end - seg_start < 1.5:
        seg_end = min(start + duration, seg_start + 2.5)

    rel_start = max(0, seg_start - start)
    rel_end = min(duration, seg_end - start)

    print(
        json.dumps(
            {
                "ok": True,
                "wide": True,
                "bbox_x": int(x),
                "bbox_y": int(y),
                "bbox_w": int(bw),
                "bbox_h": int(bh),
                "start_time": round(rel_start, 2),
                "end_time": round(rel_end, 2),
                "confidence": round(min(1.0, avg_score / (crop_w * h * 0.08)), 3),
            }
        )
    )


if __name__ == "__main__":
    main()
