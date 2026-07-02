#!/usr/bin/env python3
"""
Score CS2 kill-feed detection against ground_truth.json.

Runs kill_feed_detect.py on the same video, matches timestamps within a
tolerance window, and appends metrics to results.json for run-over-run history.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
DEFAULT_GROUND_TRUTH = REPO_ROOT / "ground_truth.json"
DEFAULT_RESULTS = REPO_ROOT / "results.json"
DEFAULT_VIDEO = REPO_ROOT / "testvid.mp4"
DETECT_SCRIPT = REPO_ROOT / "server" / "scripts" / "kill_feed_detect.py"
FFMPEG_STATIC = REPO_ROOT / "server" / "node_modules" / "ffmpeg-static" / "ffmpeg.exe"

# Seconds within which a detection counts as matching a ground-truth kill.
MATCH_TOLERANCE_SEC = 2.0

# Common Windows install paths when Tesseract is not on PATH.
_TESSERACT_CANDIDATES = (
    Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe"),
    Path(r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"),
)


def resolve_ffmpeg_path() -> str | None:
    env = os.environ.get("FFMPEG_PATH")
    if env and Path(env).is_file():
        return env
    if FFMPEG_STATIC.is_file():
        return str(FFMPEG_STATIC)
    return None


def resolve_tesseract_cmd() -> str | None:
    env = os.environ.get("TESSERACT_CMD")
    if env and Path(env).is_file():
        return env
    for candidate in _TESSERACT_CANDIDATES:
        if candidate.is_file():
            return str(candidate)
    return None


def ensure_runtime_deps() -> None:
    ffmpeg = resolve_ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError(
            "ffmpeg not found. Install server deps (npm install in server/) "
            "or set FFMPEG_PATH."
        )
    os.environ["FFMPEG_PATH"] = ffmpeg

    tess = resolve_tesseract_cmd()
    if not tess:
        raise RuntimeError(
            "Tesseract OCR not found. Install it (e.g. apt install tesseract-ocr "
            "on Linux, or UB Mannheim build on Windows) and ensure it is on PATH, "
            "or set TESSERACT_CMD to the tesseract executable."
        )
    os.environ["TESSERACT_CMD"] = tess


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def save_json(path: Path, data: object) -> None:
    with path.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")


def run_detection(video_path: Path, python_exe: str) -> dict:
    """Invoke the existing kill-feed pipeline (--video CLI mode)."""
    cmd = [
        python_exe,
        str(DETECT_SCRIPT),
        "--video",
        str(video_path),
    ]
    env = os.environ.copy()
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        env=env,
        cwd=str(REPO_ROOT / "server" / "scripts"),
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"kill_feed_detect.py failed (exit {proc.returncode}):\n{proc.stderr[-4000:]}"
        )

    # Script prints JSON then a stderr funnel line; stdout may have trailing noise.
    stdout = proc.stdout.strip()
    decoder = json.JSONDecoder()
    result, _ = decoder.raw_decode(stdout)
    return result


def extract_detected_timestamps(pipeline_result: dict) -> list[float]:
    kills = pipeline_result.get("kills") or []
    times: list[float] = []
    for kill in kills:
        anchor = kill.get("anchor_s")
        if anchor is None:
            anchor = kill.get("time") or kill.get("raw_time")
        if anchor is not None:
            times.append(float(anchor))
    times.sort()
    return times


def match_timestamps(
    ground_truth: list[float],
    detected: list[float],
    tolerance_sec: float,
) -> dict:
    """Greedy one-to-one matching: each GT kill matches at most one detection."""
    gt_remaining = list(ground_truth)
    det_remaining = list(detected)
    matches: list[dict] = []
    false_positives: list[float] = []

    for det_t in sorted(det_remaining):
        best_idx = None
        best_dist = None
        for i, gt_t in enumerate(gt_remaining):
            dist = abs(det_t - gt_t)
            if dist <= tolerance_sec and (best_dist is None or dist < best_dist):
                best_idx = i
                best_dist = dist
        if best_idx is not None:
            gt_t = gt_remaining.pop(best_idx)
            matches.append(
                {
                    "ground_truth_sec": gt_t,
                    "detected_sec": det_t,
                    "delta_sec": round(det_t - gt_t, 3),
                }
            )
        else:
            false_positives.append(det_t)

    false_negatives = list(gt_remaining)
    tp = len(matches)
    fp = len(false_positives)
    fn = len(false_negatives)

    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    timing_deltas = [abs(m["delta_sec"]) for m in matches]
    mean_abs_timing_sec = (
        round(sum(timing_deltas) / len(timing_deltas), 3) if timing_deltas else None
    )

    return {
        "tolerance_sec": tolerance_sec,
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "mean_abs_timing_sec": mean_abs_timing_sec,
        "matches": matches,
        "false_positive_timestamps": [round(t, 2) for t in false_positives],
        "false_negative_timestamps": [round(t, 2) for t in false_negatives],
        "detected_timestamps": [round(t, 2) for t in detected],
        "ground_truth_timestamps": [round(t, 2) for t in ground_truth],
    }


def append_run(
    results_path: Path,
    video_name: str,
    metrics: dict,
    pipeline_stats: dict | None,
) -> dict:
    history = []
    if results_path.is_file():
        history = load_json(results_path)
        if not isinstance(history, list):
            history = [history]

    run = {
        "run_at": datetime.now(timezone.utc).isoformat(),
        "video": video_name,
        "metrics": metrics,
        "pipeline_stats": pipeline_stats or {},
    }
    history.append(run)
    save_json(results_path, history)
    return run


def main() -> int:
    parser = argparse.ArgumentParser(description="Score kill-feed detection vs ground truth")
    parser.add_argument("--video", type=Path, default=DEFAULT_VIDEO)
    parser.add_argument("--ground-truth", type=Path, default=DEFAULT_GROUND_TRUTH)
    parser.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    parser.add_argument("--tolerance", type=float, default=MATCH_TOLERANCE_SEC)
    parser.add_argument("--python", dest="python_exe", default=sys.executable)
    args = parser.parse_args()

    if not args.ground_truth.is_file():
        print(f"Missing ground truth: {args.ground_truth}", file=sys.stderr)
        return 1
    if not args.video.is_file():
        print(f"Missing video: {args.video}", file=sys.stderr)
        return 1
    if not DETECT_SCRIPT.is_file():
        print(f"Missing detection script: {DETECT_SCRIPT}", file=sys.stderr)
        return 1

    gt_all = load_json(args.ground_truth)
    video_key = args.video.name
    gt_entries = gt_all.get(video_key) or gt_all.get(str(args.video))
    if not gt_entries:
        print(f"No ground truth for {video_key}", file=sys.stderr)
        return 1

    gt_times = [float(e["timestamp_sec"]) for e in gt_entries]

    try:
        ensure_runtime_deps()
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(f"Running kill detection on {args.video} …", file=sys.stderr)
    pipeline = run_detection(args.video.resolve(), args.python_exe)
    detected = extract_detected_timestamps(pipeline)
    metrics = match_timestamps(gt_times, detected, args.tolerance)

    run = append_run(
        args.results,
        video_key,
        metrics,
        pipeline.get("stats"),
    )

    print(json.dumps(run, indent=2))
    print(
        f"\nTP={metrics['true_positives']} FP={metrics['false_positives']} "
        f"FN={metrics['false_negatives']} | "
        f"Precision={metrics['precision']:.1%} Recall={metrics['recall']:.1%} "
        f"F1={metrics['f1']:.3f}",
        file=sys.stderr,
    )
    if metrics["false_negative_timestamps"]:
        print(f"FN @ {metrics['false_negative_timestamps']}", file=sys.stderr)
    if metrics["false_positive_timestamps"]:
        print(f"FP @ {metrics['false_positive_timestamps']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
