#!/usr/bin/env python3
"""Regenerate fn_diag ROI + bar crops (fast — no full pipeline, key timestamps only)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import cv2

EVAL = Path("/tmp/videclip-eval")
sys.path.insert(0, str(EVAL / "server" / "scripts"))
os.environ.setdefault("FFMPEG_PATH", "/opt/videclip/server/node_modules/ffmpeg-static/ffmpeg")
os.environ.setdefault("TESSERACT_CMD", "/usr/bin/tesseract")

from kill_feed_pipeline import (  # noqa: E402
    KillFeedConfig,
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

VIDEO = str(EVAL / "testvid.mp4")
FFMPEG = os.environ["FFMPEG_PATH"]
OUT = EVAL / "fn_diag"
PICKS = [38.0, 61.0, 97.0]
POV_REP = "simple"


def nearest_coarse(t: float, cfg: KillFeedConfig) -> float:
    t0 = cfg.spawn_cutoff_sec
    best = t0
    best_d = abs(t0 - t)
    while t0 < 1200:
        step = (
            cfg.early_coarse_sample_sec
            if t0 < cfg.spawn_cutoff_sec + cfg.early_coarse_window_sec
            else cfg.coarse_sample_sec
        )
        d = abs(t0 - t)
        if d < best_d:
            best, best_d = t0, d
        t0 += step
    return round(best, 2)


def draw_entries(patch, entries) -> None:
    for ent in entries:
        _x, y0, _w, y1 = ent["bbox"]
        cv2.rectangle(patch, (2, y0), (patch.shape[1] - 2, y1), (0, 0, 255), 1)


def t_slug(t: float) -> str:
    return f"{t:.1f}".replace(".", "p")


def process_time(
    reader,
    cfg,
    tag: str,
    t: float,
    report: list[str],
) -> bool:
    frame = get_frame(reader, t)
    if frame is None:
        report.append(f"  {tag} t={t}s: no frame")
        return False
    patch = crop_roi(frame, cfg)
    if patch is None:
        report.append(f"  {tag} t={t}s: no roi")
        return False

    entries = detect_red_bordered_entries(patch, cfg)
    entries = entries[:1]  # one red-highlight bar = one kill
    slug = t_slug(t)

    if not entries:
        report.append(
            f"  {tag} t={t}s: 0 bars (kein Killfeed in ROI — HUD leer / Feed noch nicht da)"
        )
        return False

    annotated = patch.copy()
    draw_entries(annotated, entries)
    cv2.imwrite(str(OUT / f"{tag}_roi_{slug}s.png"), annotated)

    report.append(f"  {tag} t={t}s: {len(entries)} bar(s)")
    for i, ent in enumerate(entries):
        h = ent["crop"].shape[0]
        cv2.imwrite(str(OUT / f"{tag}_bar_{slug}s_{i}.png"), ent["crop"])
        raw, _ = ocr_kill_bar(ent["crop"], cfg)
        fp = parse_kill_fingerprint(raw)
        fake = {"fingerprint": fp, "killer": fp.get("killer"), "victim": fp.get("victim"), "assist": ""}
        cls, reason = classify_registry_entry(fake, POV_REP, None, [], cfg, set())
        report.append(
            f"    bar{i} h={h}px hs={ent.get('highlight_score', 0):.3f} raw={raw!r} "
            f"valid={is_valid_kill_fingerprint(fp)} -> {cls}/{reason}"
        )
    return True


def main() -> None:
    configure_tesseract()
    OUT.mkdir(exist_ok=True)
    for p in OUT.iterdir():
        if p.suffix.lower() in {".png", ".txt"}:
            p.unlink()

    cfg = KillFeedConfig()
    reader = open_frame_reader(VIDEO, FFMPEG, cfg.spawn_cutoff_sec)
    report = ["fn_diag regeneration (highlight v12 + feed persist 10s)", f"POV: {POV_REP}", ""]

    for n, gt in enumerate(PICKS, 1):
        coarse_t = nearest_coarse(gt, cfg)
        report.append(f"=== fn{n} GT {gt}s | pass1 sample {coarse_t}s ===")
        stamps = [(f"fn{n}_coarse", coarse_t), (f"fn{n}", gt)]
        for off in range(-3, 4):
            if off == 0:
                continue
            tt = gt + off
            if tt >= cfg.spawn_cutoff_sec:
                sign = f"+{off}" if off > 0 else str(off)
                stamps.append((f"fn{n}_s{sign}", tt))

        first_feed_t = None
        for tag, t in stamps:
            hit = process_time(reader, cfg, tag, t, report)
            if hit and first_feed_t is None:
                first_feed_t = t
        if first_feed_t is not None:
            lag = round(first_feed_t - gt, 1)
            report.append(f"  >> erster Feed in ROI: t={first_feed_t}s (GT+{lag}s)")
        else:
            report.append("  >> kein Feed in ROI im Sweep")
        report.append("")

    reader.close()
    (OUT / "report.txt").write_text("\n".join(report), encoding="utf-8")
    print("\n".join(report))
    pngs = sorted(OUT.glob("*.png"))
    print(f"\n{len(pngs)} PNGs -> {OUT / 'report.txt'}")


if __name__ == "__main__":
    main()
