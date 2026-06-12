#!/usr/bin/env python3
"""Pick best frame, detect webcam corner, remove background, export assets for 16:9 thumbnails."""
import json
import os
import subprocess
import sys
import tempfile


def corner_regions(w, h):
    return {
        "top-right": (int(w * 0.52), 0, int(w * 0.48), int(h * 0.48)),
        "top-left": (0, 0, int(w * 0.48), int(h * 0.48)),
        "bottom-right": (int(w * 0.52), int(h * 0.52), int(w * 0.48), int(h * 0.48)),
        "bottom-left": (0, int(h * 0.52), int(w * 0.48), int(h * 0.48)),
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
        str(time_sec),
        "-i",
        video_path,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        out_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def face_in_region(fx, fy, fw, fh, rx, ry, rw, rh):
    cx, cy = fx + fw / 2, fy + fh / 2
    return rx <= cx <= rx + rw and ry <= cy <= ry + rh


def laplacian_variance(gray):
    import cv2

    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def expand_bbox(x, y, bw, bh, w, h, pad_ratio=0.35):
    pad_x = int(bw * pad_ratio)
    pad_y = int(bh * pad_ratio)
    x1 = max(0, x - pad_x)
    y1 = max(0, y - pad_y)
    x2 = min(w, x + bw + pad_x)
    y2 = min(h, y + bh + pad_y)
    return x1, y1, x2 - x1, y2 - y1


def add_stroke_rgba(im, width=7, color=(255, 255, 255, 255)):
    from PIL import Image, ImageFilter

    if im.mode != "RGBA":
        im = im.convert("RGBA")
    alpha = im.split()[-1]
    mask = alpha.filter(ImageFilter.MaxFilter(width * 2 + 1))
    outline = Image.new("RGBA", im.size, color)
    outline.putalpha(mask)
    return Image.alpha_composite(outline, im)


def remove_bg(im):
    if os.environ.get("THUMBNAIL_SKIP_REMBG") == "1":
        return im.convert("RGBA") if im.mode != "RGBA" else im
    try:
        from rembg import remove

        out = remove(im)
        if hasattr(out, "mode"):
            return out
        from PIL import Image
        import io

        return Image.open(io.BytesIO(out)).convert("RGBA")
    except Exception:
        if im.mode != "RGBA":
            return im.convert("RGBA")
        return im


def blur_darken_bg(frame_bgr, blur_ksize=31):
    import cv2

    blurred = cv2.GaussianBlur(frame_bgr, (blur_ksize, blur_ksize), 0)
    return (blurred * 0.72).astype("uint8")


def load_frame_bgr(frame_path):
    import cv2

    frame = cv2.imread(frame_path)
    if frame is None:
        raise RuntimeError(f"cannot read frame: {frame_path}")
    return frame


def main():
    if len(sys.argv) < 5:
        print(json.dumps({"ok": False, "error": "usage: thumbnail_prep.py <video> <start> <end> <out_dir>"}))
        return

    video_path = sys.argv[1]
    start = float(sys.argv[2])
    end = float(sys.argv[3])
    out_dir = sys.argv[4]
    os.makedirs(out_dir, exist_ok=True)

    try:
        import cv2
        from PIL import Image
    except ImportError as exc:
        print(json.dumps({"ok": False, "error": f"missing deps: {exc}"}))
        return

    face_cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )

    t0 = max(0.0, start)
    t1 = max(t0 + 0.5, end)
    sample_count = min(12, max(4, int((t1 - t0) * 2)))
    times = [t0 + (t1 - t0) * i / max(sample_count - 1, 1) for i in range(sample_count)]

    regions = None
    corner_scores = None
    best = None
    w = h = 0

    with tempfile.TemporaryDirectory(prefix="thumb_frames_") as tmp:
        for i, t in enumerate(times):
            frame_path = os.path.join(tmp, f"frame_{i:03d}.jpg")
            try:
                extract_frame(video_path, t, frame_path)
            except subprocess.CalledProcessError:
                continue

            frame = load_frame_bgr(frame_path)
            if w == 0:
                h, w = frame.shape[:2]
                regions = corner_regions(w, h)
                corner_scores = {k: 0.0 for k in regions}

            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = face_cascade.detectMultiScale(gray, 1.15, 5, minSize=(40, 40))
            sharp = laplacian_variance(gray)

            for fx, fy, fw, fh in faces:
                area = fw * fh
                for name, (rx, ry, rw, rh) in regions.items():
                    if face_in_region(fx, fy, fw, fh, rx, ry, rw, rh):
                        corner_scores[name] += area

                score = area * (1 + sharp / 500.0)
                if best is None or score > best["score"]:
                    best = {
                        "score": score,
                        "time": t,
                        "frame": frame.copy(),
                        "faces": list(faces),
                    }

        if best is None:
            mid = (t0 + t1) / 2
            frame_path = os.path.join(tmp, "fallback.jpg")
            try:
                extract_frame(video_path, mid, frame_path)
                frame = load_frame_bgr(frame_path)
                h, w = frame.shape[:2]
                regions = corner_regions(w, h)
                corner_scores = {k: 0.0 for k in regions}
                best = {"score": 1, "time": mid, "frame": frame, "faces": []}
            except Exception as exc:
                print(json.dumps({"ok": False, "error": f"no frames: {exc}"}))
                return

    frame = best["frame"]
    webcam_corner = max(corner_scores, key=corner_scores.get)
    if corner_scores[webcam_corner] <= 0:
        webcam_corner = "bottom-right"

    rx, ry, rw, rh = regions[webcam_corner]
    faces = best["faces"]

    if len(faces):
        in_corner = [
            f for f in faces if face_in_region(f[0], f[1], f[2], f[3], rx, ry, rw, rh)
        ]
        if in_corner:
            xs = [f[0] for f in in_corner]
            ys = [f[1] for f in in_corner]
            ws = [f[2] for f in in_corner]
            hs = [f[3] for f in in_corner]
            x1 = min(xs)
            y1 = min(ys)
            x2 = max(x + ww for x, ww in zip(xs, ws))
            y2 = max(y + hh for y, hh in zip(ys, hs))
            sx, sy, sw, sh = expand_bbox(x1, y1, x2 - x1, y2 - y1, w, h, 0.45)
        else:
            sx, sy, sw, sh = rx, ry, rw, rh
    else:
        sx, sy, sw, sh = rx, ry, rw, rh

    subject_bgr = frame[sy : sy + sh, sx : sx + sw]
    subject_rgb = cv2.cvtColor(subject_bgr, cv2.COLOR_BGR2RGB)
    subject_im = Image.fromarray(subject_rgb)
    subject_cut = remove_bg(subject_im)
    subject_stroke = add_stroke_rgba(subject_cut, width=8)

    subject_path = os.path.join(out_dir, "subject.png")
    subject_stroke.save(subject_path, "PNG")

    gameplay_side = "left" if "right" in webcam_corner else "right"
    if gameplay_side == "left":
        bg_crop = frame[:, : int(w * 0.68)]
    else:
        bg_crop = frame[:, int(w * 0.32) :]

    bg_proc = blur_darken_bg(bg_crop)
    bg_rgb = cv2.cvtColor(bg_proc, cv2.COLOR_BGR2RGB)
    bg_im = Image.fromarray(bg_rgb)
    bg_path = os.path.join(out_dir, "bg.jpg")
    bg_im.save(bg_path, "JPEG", quality=88)

    print(
        json.dumps(
            {
                "ok": True,
                "best_time": round(best["time"], 2),
                "webcam_corner": webcam_corner,
                "gameplay_side": gameplay_side,
                "subject_box": {"x": int(sx), "y": int(sy), "w": int(sw), "h": int(sh)},
                "bg_path": bg_path,
                "subject_path": subject_path,
            }
        )
    )


if __name__ == "__main__":
    main()
