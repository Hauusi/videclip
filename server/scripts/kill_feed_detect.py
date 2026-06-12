#!/usr/bin/env python3
"""
CS2 POV kill-feed detection (stdin JSON → stdout JSON).

Two-pass pipeline: coarse red-border scan (3s) → fine backward OCR anchors.
"""
import json
import os
import sys

from kill_feed_pipeline import KillFeedConfig, kills_to_legacy_events, run_pipeline


def ffmpeg_bin():
    p = os.environ.get("FFMPEG_PATH", "ffmpeg")
    return p if p else "ffmpeg"


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--video":
        video = sys.argv[2]
        duration = 0.0
        debug = False
        i = 3
        while i < len(sys.argv):
            if sys.argv[i] == "--duration" and i + 1 < len(sys.argv):
                duration = float(sys.argv[i + 1])
                i += 2
            elif sys.argv[i] == "--debug":
                debug = True
                i += 1
            else:
                i += 1
        if duration <= 0:
            try:
                import cv2

                cap = cv2.VideoCapture(video)
                duration = cap.get(cv2.CAP_PROP_FRAME_COUNT) / max(1, cap.get(cv2.CAP_PROP_FPS))
                cap.release()
            except Exception:
                duration = 0.0
        cfg = KillFeedConfig()
        if debug:
            cfg.debug_ocr = True
            cfg.debug_dir = os.path.join(os.path.dirname(video) or ".", "killfeed_debug")
        result = run_pipeline(video, duration, cfg=cfg, ffmpeg_bin=ffmpeg_bin())
        print(json.dumps(result, indent=2))
        s = result.get("stats", {})
        print(
            f"\n# funnel: pass1={s.get('frames_sampled_pass1')} ocr={s.get('ocr_calls')} "
            f"nonempty={s.get('ocr_nonempty')} parsed={s.get('ocr_parsed_as_kill_entry')} "
            f"fp_before={s.get('unique_fingerprints_before_dedup')} "
            f"fp_after={s.get('unique_fingerprints_after_dedup')} "
            f"kills={s.get('kills_found')} fallback={s.get('pov_fallback_mode')}",
            file=sys.stderr,
        )
        return

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
    title_hints = payload.get("title_hint_tokens") or []

    cfg = KillFeedConfig()
    roi = payload.get("roi")
    if isinstance(roi, dict):
        cfg.roi_x = float(roi.get("x", cfg.roi_x))
        cfg.roi_y = float(roi.get("y", cfg.roi_y))
        cfg.roi_w = float(roi.get("w", cfg.roi_w))
        cfg.roi_h = float(roi.get("h", cfg.roi_h))
    if payload.get("coarse_sample_sec"):
        cfg.coarse_sample_sec = float(payload["coarse_sample_sec"])
    if payload.get("kill_feed_debug") or payload.get("debug_ocr"):
        cfg.debug_ocr = True
    debug_dir = payload.get("debug_dir")
    if debug_dir:
        cfg.debug_dir = debug_dir
    elif cfg.debug_ocr:
        cfg.debug_dir = os.path.join(os.path.dirname(video), "debug", "killfeed")

    result = run_pipeline(
        video,
        duration,
        cfg=cfg,
        title_hint_tokens=title_hints,
        ffmpeg_bin=ffmpeg_bin(),
    )

    kills = result.get("kills") or []
    events = kills_to_legacy_events(kills, result.get("pov_player") or "")
    stats = result.get("stats") or {}

    print(
        json.dumps(
            {
                "ok": True,
                "events": events,
                "kills": kills,
                "clips": result.get("clips") or [],
                "pov_player": result.get("pov_player") or "",
                "kill_count": len(kills),
                "player_kill_count": len(kills),
                "samples_used": stats.get("frames_sampled_pass1", 0),
                "ocr_calls": stats.get("ocr_calls", 0),
                "coarse_hits": stats.get("coarse_hits", 0),
                "clips_produced": stats.get("clips_produced", 0),
                "detection_mode": "two_pass_ocr",
                "stats": stats,
                "debug_dir": result.get("debug_dir"),
                "debug": {
                    "duration": duration,
                    "ffmpeg": ffmpeg_bin(),
                    "ffmpeg_exists": os.path.isfile(ffmpeg_bin()),
                },
            }
        )
    )


if __name__ == "__main__":
    main()
