#!/usr/bin/env python3
"""
Detect game / content category from sampled gameplay frames (HUD OCR + layout).
Input (stdin JSON): { "video": "path", "duration": float, "sample_count": int }
Output (stdout JSON): { ok, category, game, confidence, scores, layout, ocr_available }
"""
import json
import os
import re
import subprocess
import sys
import tempfile

# Normalized ROIs: (name, x, y, w, h)
HUD_ROIS = (
    ("top_right", 0.68, 0.02, 0.30, 0.34),
    ("top_center", 0.22, 0.0, 0.56, 0.14),
    ("bottom_bar", 0.0, 0.82, 1.0, 0.18),
    ("bottom_left", 0.0, 0.62, 0.22, 0.38),
    ("center_banner", 0.18, 0.28, 0.64, 0.22),
    ("hotbar", 0.32, 0.86, 0.36, 0.12),
)

GAME_SIGNATURES = (
    {
        "category": "shooter",
        "game": "Counter-Strike 2",
        "patterns": (
            r"counter.?terrorist",
            r"\bterrorist",
            r"\bct\b",
            r"\bawp\b",
            r"defus",
            r"bomb",
            r"molotov",
            r"smoke",
            r"flash",
            r"round\s+\d",
            r"buy\s+zone",
        ),
        "weight": 14,
    },
    {
        "category": "shooter",
        "game": "Valorant",
        "patterns": (
            r"\bvalorant\b",
            r"\bspike\b",
            r"plant",
            r"defus",
            r"ultimate",
            r"\bult\b",
            r"operator",
            r"\bjett\b",
            r"\bsage\b",
            r"\bphoenix\b",
            r"round\s+\d",
        ),
        "weight": 14,
    },
    {
        "category": "shooter",
        "game": "Call of Duty",
        "patterns": (
            r"warzone",
            r"loadout",
            r"gulag",
            r"uav",
            r"killstreak",
            r"team\s+death",
        ),
        "weight": 12,
    },
    {
        "category": "shooter",
        "game": "Apex Legends",
        "patterns": (
            r"\bapex\b",
            r"knock",
            r"respawn",
            r"ring",
            r"champion",
            r"kill\s+leader",
        ),
        "weight": 12,
    },
    {
        "category": "moba",
        "game": "League of Legends",
        "patterns": (
            r"league\s+of\s+legends",
            r"\blol\b",
            r"baron",
            r"dragon",
            r"drake",
            r"elder",
            r"herald",
            r"inhib",
            r"nexus",
            r"penta",
            r"quadra",
            r"gold",
        ),
        "weight": 14,
    },
    {
        "category": "moba",
        "game": "Dota 2",
        "patterns": (
            r"\bdota\b",
            r"ancient",
            r"roshan",
            r"courier",
            r"rampage",
            r"beyond\s+godlike",
        ),
        "weight": 14,
    },
    {
        "category": "survival",
        "game": "Minecraft",
        "patterns": (
            r"minecraft",
            r"creeper",
            r"ender",
            r"nether",
            r"diamond",
            r"redstone",
        ),
        "weight": 13,
    },
    {
        "category": "survival",
        "game": "Rust",
        "patterns": (
            r"\brust\b",
            r"raid",
            r"tc\b",
            r"tool\s+cupboard",
            r"ak47",
            r"compound",
        ),
        "weight": 12,
    },
    {
        "category": "horror",
        "game": "Horror Game",
        "patterns": (
            r"phasmophobia",
            r"outlast",
            r"resident\s+evil",
            r"five\s+nights",
            r"fnaf",
        ),
        "weight": 12,
    },
    {
        "category": "racing",
        "game": "Racing",
        "patterns": (
            r"forza",
            r"gran\s+turismo",
            r"formula",
            r"podium",
            r"qualifying",
        ),
        "weight": 11,
    },
)

CATEGORY_LAYOUT = {
    "moba": {"bottom_bar": 0.09},
    "shooter": {"top_right": 0.05, "top_center": 0.04},
    "survival": {"hotbar": 0.06},
}


def ffmpeg_bin():
    return os.environ.get("FFMPEG_PATH", "ffmpeg")


def extract_frame(video_path, time_sec, out_path):
    cmd = [
        ffmpeg_bin(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        str(max(0, time_sec)),
        "-i",
        video_path,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        out_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True, timeout=45)


def crop_roi(frame, roi):
    import cv2

    h, w = frame.shape[:2]
    name, rx, ry, rw, rh = roi
    x1 = int(w * rx)
    y1 = int(h * ry)
    x2 = min(w, int(w * (rx + rw)))
    y2 = min(h, int(h * (ry + rh)))
    if x2 <= x1 or y2 <= y1:
        return None, name
    return frame[y1:y2, x1:x2], name


def roi_edge_density(patch):
    import cv2
    import numpy as np

    gray = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 50, 140)
    return float(np.mean(edges)) / 255.0


def try_ocr(patch_bgr):
    try:
        import pytesseract
        import cv2

        gray = cv2.cvtColor(patch_bgr, cv2.COLOR_BGR2GRAY)
        gray = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        _, th = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        text = pytesseract.image_to_string(th, config="--psm 6")
        return " ".join(text.split()).lower()
    except Exception:
        return ""


def sample_times(duration, count):
    duration = max(30.0, float(duration or 300))
    count = max(6, min(int(count or 10), 14))
    start = min(45.0, duration * 0.03)
    end = max(start + 30, duration * 0.92)
    if end - start < 20:
        return [duration * 0.5]
    step = (end - start) / max(1, count - 1)
    return [round(start + i * step, 2) for i in range(count)]


def score_text_blob(blob, layout_acc):
    scores = {}
    for sig in GAME_SIGNATURES:
        pts = 0
        for pat in sig["patterns"]:
            if re.search(pat, blob, re.I):
                pts += sig["weight"]
        if pts > 0:
            key = f"{sig['category']}::{sig['game']}"
            scores[key] = scores.get(key, 0) + pts

    for cat, rois in CATEGORY_LAYOUT.items():
        layout_pts = 0
        for roi_name, threshold in rois.items():
            if layout_acc.get(roi_name, 0) >= threshold:
                layout_pts += 8
        if layout_pts > 0:
            for sig in GAME_SIGNATURES:
                if sig["category"] == cat:
                    key = f"{sig['category']}::{sig['game']}"
                    scores[key] = scores.get(key, 0) + layout_pts * 0.35
    return scores


def pick_best(scores):
    if not scores:
        return {
            "category": "generic",
            "game": None,
            "confidence": 35,
            "score": 0,
        }

    best_key = max(scores, key=lambda k: scores[k])
    best_score = scores[best_key]
    category, game = best_key.split("::", 1)

    if best_score >= 45:
        conf = 94
    elif best_score >= 30:
        conf = 86
    elif best_score >= 18:
        conf = 76
    elif best_score >= 10:
        conf = 64
    else:
        conf = 50

    return {
        "category": category,
        "game": game,
        "confidence": conf,
        "score": best_score,
    }


def main():
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        print(json.dumps({"ok": False, "reason": "bad_json"}))
        return

    video = payload.get("video")
    if not video or not os.path.isfile(video):
        print(json.dumps({"ok": False, "reason": "no_video"}))
        return

    try:
        import cv2  # noqa: F401
    except ImportError:
        print(json.dumps({"ok": False, "reason": "no_opencv"}))
        return

    duration = float(payload.get("duration") or 0)
    times = sample_times(duration, payload.get("sample_count") or 10)
    all_scores = {}
    layout_acc = {name: 0.0 for name, *_ in HUD_ROIS}
    ocr_hits = []
    frames_used = 0

    with tempfile.TemporaryDirectory(prefix="gamedetect_") as tmp_dir:
        for t in times:
            frame_path = os.path.join(tmp_dir, f"f_{frames_used}.jpg")
            try:
                extract_frame(video, t, frame_path)
                import cv2

                frame = cv2.imread(frame_path)
            except Exception:
                continue
            finally:
                try:
                    os.unlink(frame_path)
                except OSError:
                    pass

            if frame is None:
                continue

            frames_used += 1
            blob_parts = []
            for roi in HUD_ROIS:
                patch, roi_name = crop_roi(frame, roi)
                if patch is None:
                    continue
                layout_acc[roi_name] += roi_edge_density(patch)
                text = try_ocr(patch)
                if text:
                    blob_parts.append(text)
                    if len(text) > 4:
                        ocr_hits.append({"time": t, "roi": roi_name, "text": text[:60]})

            blob = " ".join(blob_parts)
            frame_scores = score_text_blob(blob, layout_acc)
            for key, pts in frame_scores.items():
                all_scores[key] = all_scores.get(key, 0) + pts

    if frames_used:
        for key in layout_acc:
            layout_acc[key] = round(layout_acc[key] / frames_used, 4)

    best = pick_best(all_scores)

    print(
        json.dumps(
            {
                "ok": True,
                "category": best["category"],
                "game": best["game"],
                "confidence": best["confidence"],
                "score": best["score"],
                "scores": {k: round(v, 1) for k, v in sorted(all_scores.items(), key=lambda x: -x[1])[:8]},
                "layout": layout_acc,
                "frames_used": frames_used,
                "ocr_hits": ocr_hits[:12],
                "ocr_available": _ocr_available(),
            }
        )
    )


def _ocr_available():
    try:
        import pytesseract

        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False


if __name__ == "__main__":
    main()
