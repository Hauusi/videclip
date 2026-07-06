#!/usr/bin/env python3
"""FN timestamp-only diagnosis (reuses kill_feed_detect JSON for POV/registry)."""
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

import pytesseract  # noqa: E402

PICKS = [38.0, 61.0, 97.0]
VIDEO = str(EVAL / "testvid.mp4")
FFMPEG = os.environ["FFMPEG_PATH"]
DETECT = str(EVAL / "server" / "scripts" / "kill_feed_detect.py")
OUT = EVAL / "fn_diag"
OUT.mkdir(exist_ok=True)
TOL = 2.0


def load_pipeline_context() -> dict:
    proc = subprocess.run(
        ["python3", DETECT, "--video", VIDEO],
        capture_output=True,
        text=True,
        cwd=str(EVAL / "server" / "scripts"),
        check=True,
    )
    return json.loads(proc.stdout)


def nearest_coarse(t: float, cfg: KillFeedConfig) -> tuple[float, float]:
    t0 = cfg.spawn_cutoff_sec
    samples = []
    while t0 < 1200:
        samples.append(round(t0, 2))
        t0 += cfg.coarse_sample_sec
    best = min(samples, key=lambda s: abs(s - t))
    return best, abs(best - t)


def bars_at(reader, t, cfg, trusted, pov_rep, pov_cluster, all_clusters):
    frame = get_frame(reader, t)
    if frame is None:
        return []
    patch = crop_roi(frame, cfg)
    if patch is None:
        return []
    rows = []
    for ent in detect_red_bordered_entries(patch, cfg):
        raw, _ = ocr_kill_bar(ent["crop"], cfg)
        fp = parse_kill_fingerprint(raw)
        fake = {
            "fingerprint": fp,
            "killer": fp.get("killer"),
            "victim": fp.get("victim"),
            "assist": fp.get("assist"),
            "anchor_s": t,
        }
        cls, reason = classify_registry_entry(
            fake, pov_rep, pov_cluster, all_clusters, cfg, trusted
        )
        rows.append(
            {
                "time": t,
                "raw": raw,
                "killer": fp.get("killer"),
                "victim": fp.get("victim"),
                "partial": fp.get("partial"),
                "valid": is_valid_kill_fingerprint(fp),
                "classify": cls,
                "reason": reason,
            }
        )
    return rows


def summarize(gt_t, detected, coarse_t, coarse_dist, gt_rows, sweep_rows):
    nd = min(detected, key=lambda d: abs(d - gt_t))
    ndist = abs(nd - gt_t)
    all_rows = gt_rows + sweep_rows
    text_rows = [r for r in all_rows if (r.get("raw") or "").strip()]
    valid_rows = [r for r in text_rows if r.get("valid")]
    kill_rows = [r for r in text_rows if r.get("classify") == "kill"]

    if ndist <= TOL:
        return "unexpected: innerhalb Toleranz erkannt"
    if kill_rows:
        return "OCR+POV ok im Sweep, Kill nicht in scoring (Anchor-Shift/Dedup)"
    if valid_rows and not kill_rows:
        r = valid_rows[0]
        return f"Text erkannt, POV-/Matching-Filter: {r['classify']}/{r['reason']}"
    if text_rows and not valid_rows:
        r = text_rows[0]
        return f"Text erkannt aber Filter zu streng (invalid_fingerprint): raw={r['raw']!r}"
    if coarse_dist > 1.0:
        return (
            f"kein Text erkannt / Timing: GT {coarse_dist:.1f}s vom Coarse-Sample "
            f"({coarse_t}s) entfernt"
        )
    return "kein Text erkannt (OCR leer oder kein roter Border)"


def main() -> None:
    configure_tesseract()
    last = json.loads((EVAL / "results.json").read_text())[-1]
    detected = last["metrics"]["detected_timestamps"]
    gt_map = {
        e["timestamp_sec"]: e
        for e in json.loads((EVAL / "ground_truth.json").read_text())["testvid.mp4"]
    }
    cfg = KillFeedConfig()

    print("kill_feed_detect fuer POV/Registry...")
    pipe = load_pipeline_context()
    pov_rep = pipe.get("pov_player") or ""
    pov_cluster = pipe.get("pov_cluster")
    all_clusters = pipe.get("clusters") or []
    registry = pipe.get("registry") or []
    trusted = build_trusted_pov_killers(registry, pov_rep, pov_cluster)
    reader = open_frame_reader(VIDEO, FFMPEG, 38.0)

    print("=== 3 False Negatives (letzter scoring.py Run auf VPS) ===")
    print("Run:", last["run_at"])
    print("POV:", pov_rep)
    print()

    for i, t in enumerate(PICKS, 1):
        coarse_t, coarse_dist = nearest_coarse(t, cfg)
        frame_path = OUT / f"frame_{int(t)}.png"
        subprocess.run(
            [FFMPEG, "-y", "-ss", str(t), "-i", VIDEO, "-vframes", "1", str(frame_path)],
            check=True,
            capture_output=True,
        )
        full_ocr = pytesseract.image_to_string(str(frame_path)).strip()
        gt_rows = bars_at(reader, t, cfg, trusted, pov_rep, pov_cluster, all_clusters)
        sweep_rows = []
        for off in range(-3, 4):
            tt = t + off
            if tt < cfg.spawn_cutoff_sec:
                continue
            sweep_rows.extend(
                bars_at(reader, tt, cfg, trusted, pov_rep, pov_cluster, all_clusters)
            )
        nd = min(detected, key=lambda d: abs(d - t))
        reason = summarize(t, detected, coarse_t, coarse_dist, gt_rows, sweep_rows)

        print("=" * 72)
        print(f"Event {i}")
        print(f"  Timestamp:       {t}s")
        print(f"  Ground Truth:    {gt_map[int(t)]}")
        print(f"  Naechste Det.:   {nd}s (delta={abs(nd-t):.2f}s)")
        print(f"  Coarse-Sample:   {coarse_t}s (delta={coarse_dist:.2f}s)")
        print(f"  Full-frame OCR:  {full_ocr[:600]!r}")
        print(f"  Killfeed @ GT:   {len(gt_rows)} Zeile(n)")
        for r in gt_rows:
            print(
                f"    pipeline-OCR raw={r['raw']!r} k={r['killer']!r} v={r['victim']!r} "
                f"valid={r['valid']} -> {r['classify']}/{r['reason']}"
            )
        if not gt_rows:
            print("    (kein roter Border am exakten GT-Zeitpunkt)")
        print("  Sweep t-3..t+3 (Pipeline-OCR auf Killfeed-ROI):")
        seen = set()
        for r in sweep_rows:
            if not (r.get("raw") or "").strip():
                continue
            key = (r["time"], r["raw"])
            if key in seen:
                continue
            seen.add(key)
            print(
                f"    t={r['time']}s raw={r['raw']!r} valid={r['valid']} "
                f"-> {r['classify']}/{r['reason']}"
            )
        print(f"  Grund: {reason}\n")

    reader.close()


if __name__ == "__main__":
    main()
