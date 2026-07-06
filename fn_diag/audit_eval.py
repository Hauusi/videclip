#!/usr/bin/env python3
"""Full eval audit: TP/FP/FN + bar-crop quality + root-cause per miss."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import cv2

EVAL = Path("/tmp/videclip-eval")
sys.path.insert(0, str(EVAL / "server" / "scripts"))
os.environ.setdefault("FFMPEG_PATH", "/opt/videclip/server/node_modules/ffmpeg-static/ffmpeg")
os.environ.setdefault("TESSERACT_CMD", "/usr/bin/tesseract")

from kill_feed_pipeline import (  # noqa: E402
    KillFeedConfig,
    build_trusted_pov_killers,
    classify_registry_entry,
    crop_roi,
    detect_red_bordered_entries,
    get_frame,
    is_valid_kill_fingerprint,
    kill_output_anchor,
    ocr_kill_bar,
    open_frame_reader,
    parse_kill_fingerprint,
    configure_tesseract,
)

VIDEO = str(EVAL / "testvid.mp4")
FFMPEG = os.environ["FFMPEG_PATH"]
GT_PATH = EVAL / "ground_truth.json"
OUT_DIR = EVAL / "fn_diag" / "audit"
REPORT = EVAL / "fn_diag" / "audit_report.txt"
TOLERANCE = 2.0
POV_HINT = "simple"


def load_gt() -> list[float]:
    data = json.loads(GT_PATH.read_text(encoding="utf-8"))
    return [float(e["timestamp_sec"]) for e in data["testvid.mp4"]]


def match_timestamps(gt: list[float], det: list[float], tol: float) -> dict:
    gt_rem = list(gt)
    matches: list[dict] = []
    fps: list[float] = []
    for det_t in sorted(det):
        best_i, best_d = None, None
        for i, gt_t in enumerate(gt_rem):
            d = abs(det_t - gt_t)
            if d <= tol and (best_d is None or d < best_d):
                best_i, best_d = i, d
        if best_i is not None:
            gt_t = gt_rem.pop(best_i)
            matches.append({"gt": gt_t, "det": det_t, "delta": round(det_t - gt_t, 2)})
        else:
            fps.append(det_t)
    return {"matches": matches, "fp": fps, "fn": gt_rem}


def run_pipeline() -> dict:
    proc = subprocess.run(
        ["python3", str(EVAL / "server" / "scripts" / "kill_feed_detect.py"), "--video", VIDEO],
        capture_output=True,
        text=True,
        cwd=str(EVAL / "server" / "scripts"),
        check=True,
    )
    return json.loads(proc.stdout)


def bar_at(reader, cfg, t: float) -> dict | None:
    frame = get_frame(reader, t)
    if frame is None:
        return None
    patch = crop_roi(frame, cfg)
    if patch is None:
        return None
    entries = detect_red_bordered_entries(patch, cfg)
    if not entries:
        return None
    ent = entries[0]
    raw, ocr_score = ocr_kill_bar(ent["crop"], cfg)
    fp = parse_kill_fingerprint(raw)
    h = ent["crop"].shape[0]
    return {
        "t": t,
        "h": h,
        "raw": raw,
        "fp": fp,
        "valid": is_valid_kill_fingerprint(fp),
        "crop": ent["crop"],
        "border_red": ent.get("border_red", 0),
        "border_score": ent.get("border_score", 0),
        "highlight": ent.get("highlight_score", 0),
    }


def sweep_bar(reader, cfg, center: float, span: int = 7) -> list[dict]:
    hits: list[dict] = []
    for off in range(-2, span):
        t = round(center + off, 2)
        if t < cfg.spawn_cutoff_sec:
            continue
        b = bar_at(reader, cfg, t)
        if b:
            hits.append(b)
    return hits


def classify_fn(reader, cfg, gt_t: float, pipe: dict, pov_rep, pov_cluster, all_clusters, trusted) -> str:
    hits = sweep_bar(reader, cfg, gt_t)
    if not hits:
        return "BAR_NONE — kein roter Bar im Fenster GT-2..GT+6"

    best = max(hits, key=lambda b: (b["valid"], b["border_red"]))
    fake = {
        "fingerprint": best["fp"],
        "killer": best["fp"].get("killer"),
        "victim": best["fp"].get("victim"),
        "assist": best["fp"].get("assist", ""),
    }
    cls, reason = classify_registry_entry(
        fake, pov_rep, pov_cluster, all_clusters, cfg, trusted
    )
    lag = round(best["t"] - gt_t, 1)
    ocr = repr((best["raw"] or "").strip()[:40])
    if not best["valid"]:
        return f"BAR_BAD_OCR @ t={best['t']}s (GT+{lag}s) h={best['h']}px raw={ocr}"
    if cls != "kill":
        return f"BAR_OK_SKIP @ t={best['t']}s (GT+{lag}s) -> {cls}/{reason} k={best['fp'].get('killer')!r} v={best['fp'].get('victim')!r}"
    # OCR ok, would be kill — check if pipeline missed anchor
    det_times = [k["anchor_s"] for k in pipe.get("kills", [])]
    near = [d for d in det_times if abs(d - gt_t) <= 5]
    if near:
        return f"ANCHOR_NEAR @ bar t={best['t']}s det={near} (Dedup/Lag?)"
    return f"PIPELINE_MISS @ t={best['t']}s (GT+{lag}s) OCR ok but kein Output-Kill"


def audit_fp(reader, cfg, det_t: float, kill: dict, registry: list) -> str:
    cfg_l = KillFeedConfig()
    # Reverse lag: bar likely at det + lag
    bar_t = det_t + cfg_l.kill_feed_lag_sec
    b = bar_at(reader, cfg, round(bar_t))
    if b is None:
        for off in (-1, 0, 1, 2, 3):
            b = bar_at(reader, cfg, round(det_t + off))
            if b:
                bar_t = det_t + off
                break
    parts = [
        f"killer={kill.get('killer','')!r} victim={kill.get('victim','')!r}",
        f"reason={kill.get('pov_reason','')}",
    ]
    if b:
        parts.append(f"bar@~{bar_t:.0f}s h={b['h']}px valid={b['valid']} raw={repr((b['raw'] or '')[:30])}")
        if b["h"] < 18 or b["h"] > 34:
            parts.append("WARN_BAR_HEIGHT")
    else:
        parts.append("BAR_NOT_FOUND_AT_ANCHOR")
    return " | ".join(parts)


def main() -> None:
    configure_tesseract()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for p in OUT_DIR.glob("*.png"):
        p.unlink()

    gt = load_gt()
    print("Running pipeline...", flush=True)
    pipe = run_pipeline()
    kills = pipe.get("kills") or []
    det = sorted(k["anchor_s"] for k in kills)
    m = match_timestamps(gt, det, TOLERANCE)

    pov_rep = pipe.get("pov_player") or ""
    pov_cluster = pipe.get("pov_cluster")
    all_clusters = pipe.get("clusters") or []
    trusted = build_trusted_pov_killers(pipe.get("registry") or [], pov_rep, pov_cluster)
    cfg = KillFeedConfig()
    reader = open_frame_reader(VIDEO, FFMPEG, cfg.spawn_cutoff_sec)

    tp, fp_n, fn_n = len(m["matches"]), len(m["fp"]), len(m["fn"])
    prec = tp / (tp + fp_n) if tp + fp_n else 0
    rec = tp / (tp + fn_n) if tp + fn_n else 0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0

    lines = [
        f"audit_eval {datetime.now(timezone.utc).isoformat()}",
        f"POV={pov_rep!r} tolerance=±{TOLERANCE}s",
        f"TP={tp} FP={fp_n} FN={fn_n} | P={prec:.1%} R={rec:.1%} F1={f1:.3f}",
        f"pipeline kills={len(kills)} registry={len(pipe.get('registry') or [])}",
        "",
        "=== FALSE NEGATIVES (root cause) ===",
    ]

    for gt_t in sorted(m["fn"]):
        cause = classify_fn(reader, cfg, gt_t, pipe, pov_rep, pov_cluster, all_clusters, trusted)
        lines.append(f"  FN GT {gt_t}s: {cause}")
        hits = sweep_bar(reader, cfg, gt_t)
        for b in hits[:3]:
            slug = f"fn_gt{int(gt_t)}_bar_{b['t']:.0f}s"
            cv2.imwrite(str(OUT_DIR / f"{slug}.png"), b["crop"])

    lines.append("")
    lines.append("=== FALSE POSITIVES ===")
    kill_by_t = {round(k["anchor_s"], 2): k for k in kills}
    for det_t in sorted(m["fp"]):
        k = kill_by_t.get(round(det_t, 2), {})
        info = audit_fp(reader, cfg, det_t, k, pipe.get("registry") or [])
        lines.append(f"  FP det {det_t}s: {info}")
        b = bar_at(reader, cfg, round(det_t + cfg.kill_feed_lag_sec))
        if b is None:
            b = bar_at(reader, cfg, round(det_t + 2))
        if b:
            cv2.imwrite(str(OUT_DIR / f"fp_det{int(det_t)}_bar.png"), b["crop"])

    lines.append("")
    lines.append("=== TRUE POSITIVES (timing + bar quality) ===")
    bad_tp = 0
    for match in m["matches"]:
        gt_t, det_t, delta = match["gt"], match["det"], match["delta"]
        b = bar_at(reader, cfg, round(det_t + cfg.kill_feed_lag_sec))
        if b is None:
            for off in (0, 1, 2, 3, 4):
                b = bar_at(reader, cfg, round(gt_t + off))
                if b:
                    break
        note = ""
        if b:
            if b["h"] < 18:
                note = f" WARN thin bar {b['h']}px"
                bad_tp += 1
            elif b["h"] > 34:
                note = f" WARN tall bar {b['h']}px"
                bad_tp += 1
            if abs(delta) > 1.5:
                note += f" WARN timing delta={delta:+.1f}s"
        else:
            note = " WARN no bar at expected feed time"
            bad_tp += 1
        lines.append(f"  TP GT {gt_t}s -> det {det_t}s (Δ{delta:+.1f}s){note}")

    lines.append("")
    lines.append(f"=== SUMMARY ===")
    lines.append(f"TP with bar/timing warnings: {bad_tp}/{tp}")
    lines.append(f"Audit PNGs: {OUT_DIR}")

    reader.close()
    text = "\n".join(lines)
    REPORT.write_text(text, encoding="utf-8")
    print(text)
    print(f"\nReport -> {REPORT}")


if __name__ == "__main__":
    main()
