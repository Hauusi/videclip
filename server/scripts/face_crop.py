#!/usr/bin/env python3
"""Optional face-centered crop hints via OpenCV. Outputs JSON to stdout."""
import json
import sys

def main():
    if len(sys.argv) < 4:
        print(json.dumps({"ok": False}))
        return
    video_path, start, duration = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    try:
        import cv2
    except ImportError:
        print(json.dumps({"ok": False}))
        return

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(json.dumps({"ok": False}))
        return

    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(start * fps))
    face_cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )

    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    target = 9 / 16
    samples = min(15, int(duration * 2))
    centers = []

    for _ in range(samples):
        ret, frame = cap.read()
        if not ret:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = face_cascade.detectMultiScale(gray, 1.2, 4)
        if len(faces):
            x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
            centers.append((x + fw // 2, y + fh // 2))

    cap.release()
    if not centers:
        print(json.dumps({"ok": False}))
        return

    cx = sum(c[0] for c in centers) // len(centers)
    cy = sum(c[1] for c in centers) // len(centers)

    if w / h > target:
        crop_h = h
        crop_w = int(h * target)
    else:
        crop_w = w
        crop_h = int(w / target)

    crop_x = max(0, min(cx - crop_w // 2, w - crop_w))
    crop_y = max(0, min(cy - crop_h // 2, h - crop_h))

    print(json.dumps({
        "ok": True,
        "crop_x": int(crop_x),
        "crop_y": int(crop_y),
        "crop_w": int(crop_w),
        "crop_h": int(crop_h),
    }))

if __name__ == "__main__":
    main()
