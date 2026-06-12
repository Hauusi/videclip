"""
CS2 kill-feed detection: two-pass pipeline (coarse color scan → fine OCR anchor).
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass, field
from difflib import SequenceMatcher
from typing import Any

import cv2
import numpy as np


@dataclass
class KillFeedConfig:
    """All tunables — defaults from product spec."""

    roi_x: float = 0.825
    roi_y: float = 0.03
    roi_w: float = 0.175
    roi_h: float = 0.15

    coarse_sample_sec: float = 3.0
    spawn_cutoff_sec: float = 32.0

    fine_step_sec: float = 0.5
    fine_max_back_sec: float = 12.0

    red_h1_low: int = 0
    red_h1_high: int = 10
    red_h2_low: int = 170
    red_h2_high: int = 180
    red_s_min: int = 70
    red_v_min: int = 70

    min_entry_width: int = 40
    min_entry_height: int = 8
    min_border_red_ratio: float = 0.035
    min_border_score: float = 0.028

    fuzzy_match_threshold: float = 0.85
    pov_cluster_threshold: float = 0.75
    pov_match_threshold: float = 0.75
    pov_coverage_min: float = 0.40

    merge_gap_sec: float = 5.0
    lead_sec: float = 4.0
    tail_sec: float = 2.0

    ocr_psm: int = 7
    ocr_upscale: float = 3.5

    debug_ocr: bool = False
    debug_dir: str | None = None


@dataclass
class PipelineStats:
    frames_sampled_pass1: int = 0
    coarse_hits: int = 0
    ocr_calls: int = 0
    ocr_nonempty: int = 0
    ocr_parsed_as_kill_entry: int = 0
    unique_fingerprints_before_dedup: int = 0
    unique_fingerprints_after_dedup: int = 0
    kills_found: int = 0
    pov_deaths_excluded: int = 0
    clips_produced: int = 0
    pov_fallback_mode: bool = False
    pov_cluster_coverage: float = 0.0


class OcrDebugLogger:
    """Pass-2 OCR debug: PNG crops + JSONL per call."""

    def __init__(self, enabled: bool, debug_dir: str | None):
        self.enabled = enabled and bool(debug_dir)
        self.debug_dir = debug_dir
        self._ocr_idx = 0
        self.jsonl_path: str | None = None
        if self.enabled and debug_dir:
            os.makedirs(debug_dir, exist_ok=True)
            self.jsonl_path = os.path.join(debug_dir, "ocr_log.jsonl")

    def log(
        self,
        time_sec: float,
        crop_bgr: np.ndarray,
        raw_ocr: str,
        fp: dict[str, str],
        red_border: bool,
        status: str,
        reason: str,
    ) -> None:
        if not self.enabled or not self.debug_dir:
            return
        self._ocr_idx += 1
        ts_tag = f"{time_sec:.2f}".replace(".", "_")
        png_name = f"{self._ocr_idx:05d}_{ts_tag}.png"
        png_path = os.path.join(self.debug_dir, png_name)
        try:
            cv2.imwrite(png_path, crop_bgr)
        except Exception:
            png_path = ""

        row = {
            "idx": self._ocr_idx,
            "time_s": round(time_sec, 2),
            "png": png_name if png_path else None,
            "raw_ocr": raw_ocr,
            "killer": fp.get("killer", ""),
            "assist": fp.get("assist", ""),
            "victim": fp.get("victim", ""),
            "red_border": red_border,
            "status": status,
            "reason": reason,
        }
        if self.jsonl_path:
            with open(self.jsonl_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")


_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_\-]{2,}")


def normalize_name(name: str) -> str:
    n = re.sub(r"[^a-z0-9_-]", "", (name or "").lower())
    return n


def fuzzy_ratio(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def cluster_names(names: list[str], threshold: float = 0.75) -> list[dict[str, Any]]:
    clusters: list[dict[str, Any]] = []
    for raw in names:
        norm = normalize_name(raw)
        if len(norm) < 3:
            continue
        placed = False
        for cluster in clusters:
            rep = cluster["representative"]
            if fuzzy_ratio(norm, rep) >= threshold:
                cluster["members"].append(norm)
                cluster["count"] += 1
                members = cluster["members"]
                cluster["representative"] = max(
                    set(members), key=lambda m: (members.count(m), len(m))
                )
                placed = True
                break
        if not placed:
            clusters.append({"representative": norm, "members": [norm], "count": 1})
    return sorted(clusters, key=lambda c: (-c["count"], -len(c["representative"])))


def name_matches_cluster(name: str, cluster_rep: str, threshold: float) -> bool:
    n = normalize_name(name)
    if len(n) < 3 or not cluster_rep:
        return False
    return fuzzy_ratio(n, cluster_rep) >= threshold


def _red_mask(hsv: np.ndarray, cfg: KillFeedConfig) -> np.ndarray:
    lo1 = np.array([cfg.red_h1_low, cfg.red_s_min, cfg.red_v_min])
    hi1 = np.array([cfg.red_h1_high, 255, 255])
    lo2 = np.array([cfg.red_h2_low, cfg.red_s_min, cfg.red_v_min])
    hi2 = np.array([cfg.red_h2_high, 255, 255])
    return cv2.bitwise_or(cv2.inRange(hsv, lo1, hi1), cv2.inRange(hsv, lo2, hi2))


def crop_roi(frame: np.ndarray, cfg: KillFeedConfig) -> np.ndarray | None:
    h, w = frame.shape[:2]
    x1 = int(w * cfg.roi_x)
    y1 = int(h * cfg.roi_y)
    x2 = min(w, int(w * (cfg.roi_x + cfg.roi_w)))
    y2 = min(h, int(h * (cfg.roi_y + cfg.roi_h)))
    if x2 <= x1 or y2 <= y1:
        return None
    return frame[y1:y2, x1:x2]


def _split_dark_bars(patch: np.ndarray) -> list[tuple[int, int]]:
    """Segment kill-feed into dark horizontal bars (one bar = one entry)."""
    gray = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY)
    row_mean = np.mean(gray, axis=1)
    thresh = float(np.percentile(row_mean, 42))
    dark = row_mean <= max(thresh, 55)
    bands: list[tuple[int, int]] = []
    start = None
    for i, on in enumerate(dark):
        if on and start is None:
            start = i
        elif not on and start is not None:
            if i - start >= 5:
                bands.append((start, i))
            start = None
    if start is not None and patch.shape[0] - start >= 5:
        bands.append((start, patch.shape[0]))
    if not bands:
        return _split_feed_bands_fallback(patch)
    return bands


def _split_feed_bands_fallback(patch: np.ndarray) -> list[tuple[int, int]]:
    gray = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY)
    row_mean = np.mean(gray, axis=1)
    active = row_mean > 38
    bands: list[tuple[int, int]] = []
    start = None
    for i, on in enumerate(active):
        if on and start is None:
            start = i
        elif not on and start is not None:
            if i - start >= 6:
                bands.append((start, i))
            start = None
    if start is not None and patch.shape[0] - start >= 6:
        bands.append((start, patch.shape[0]))
    return bands


def _border_score(band_bgr: np.ndarray, red_mask: np.ndarray) -> float:
    h, w = band_bgr.shape[:2]
    if h < 6 or w < 20:
        return 0.0
    t = max(1, min(3, h // 4))
    border = np.zeros((h, w), dtype=bool)
    border[:t, :] = True
    border[-t:, :] = True
    border[:, :t] = True
    border[:, -t:] = True
    inner = ~border
    if not np.any(inner):
        return 0.0
    border_red = float(np.mean(red_mask[border] > 0))
    inner_red = float(np.mean(red_mask[inner] > 0))
    return max(0.0, border_red - inner_red * 0.45)


def detect_red_bordered_entries(patch_bgr: np.ndarray, cfg: KillFeedConfig) -> list[dict[str, Any]]:
    if patch_bgr is None or patch_bgr.size == 0:
        return []

    hsv = cv2.cvtColor(patch_bgr, cv2.COLOR_BGR2HSV)
    red = _red_mask(hsv, cfg)
    entries: list[dict[str, Any]] = []

    for y0, y1 in _split_dark_bars(patch_bgr):
        band = patch_bgr[y0:y1, :]
        red_band = red[y0:y1, :]
        bw = band.shape[1]
        bh = band.shape[0]
        if bw < cfg.min_entry_width or bh < cfg.min_entry_height:
            continue
        score = _border_score(band, red_band)
        border_red = float(np.mean(red_band > 0))
        has_red = score >= cfg.min_border_score or border_red >= cfg.min_border_red_ratio
        if not has_red:
            continue
        pad = 2
        y0p = max(0, y0 - pad)
        y1p = min(patch_bgr.shape[0], y1 + pad)
        crop = patch_bgr[y0p:y1p, :]
        entries.append(
            {
                "bbox": (0, y0p, bw, y1p),
                "crop": crop,
                "border_score": score,
                "border_red": border_red,
                "red_border": True,
            }
        )
    return entries


def ocr_kill_bar(bar_bgr: np.ndarray, cfg: KillFeedConfig) -> tuple[str, float]:
    """Upscale + dual-threshold OCR on a single kill-feed bar."""
    try:
        import pytesseract
        from pytesseract import Output
    except ImportError:
        return "", 0.0

    gray = cv2.cvtColor(bar_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(
        gray,
        None,
        fx=cfg.ocr_upscale,
        fy=cfg.ocr_upscale,
        interpolation=cv2.INTER_LANCZOS4,
    )
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    tess_cfg = (
        f"--psm {cfg.ocr_psm} "
        "-c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-. "
    )

    best_text, best_score = "", -1.0
    for invert in (False, True):
        src = 255 - gray if invert else gray
        _, th = cv2.threshold(src, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        try:
            data = pytesseract.image_to_data(th, config=tess_cfg, output_type=Output.DICT)
            text = pytesseract.image_to_string(th, config=tess_cfg)
        except Exception:
            text = ""
            data = {"conf": []}
        text = " ".join(text.split())
        confs = [int(c) for c in data.get("conf", []) if str(c).isdigit() and int(c) >= 0]
        avg_conf = sum(confs) / len(confs) if confs else 0.0
        names = _NAME_RE.findall(text)
        score = len(names) * 12.0 + avg_conf + min(len(text), 40) * 0.15
        if score > best_score:
            best_text, best_score = text, score
    return best_text, best_score


def parse_kill_fingerprint(ocr_text: str) -> dict[str, str]:
    names = [normalize_name(n) for n in _NAME_RE.findall(ocr_text or "")]
    names = [n for n in names if len(n) >= 3]
    if not names:
        return {"killer": "", "assist": "", "victim": "", "raw": ocr_text or ""}
    if len(names) == 1:
        return {"killer": names[0], "assist": "", "victim": names[0], "raw": ocr_text}
    if len(names) == 2:
        return {"killer": names[0], "assist": "", "victim": names[1], "raw": ocr_text}
    return {
        "killer": names[0],
        "assist": names[1],
        "victim": names[-1],
        "raw": ocr_text,
    }


def is_valid_kill_fingerprint(fp: dict[str, str]) -> bool:
    k = normalize_name(fp.get("killer", ""))
    v = normalize_name(fp.get("victim", ""))
    return len(k) >= 3 and len(v) >= 3 and k != v


def fingerprint_key(fp: dict[str, str]) -> str:
    k = normalize_name(fp.get("killer", ""))
    a = normalize_name(fp.get("assist", ""))
    v = normalize_name(fp.get("victim", ""))
    if not k and not v:
        return ""
    return f"{k}|{a}|{v}"


def fingerprint_match(a: dict[str, str], b: dict[str, str], threshold: float) -> bool:
    ka = fingerprint_key(a)
    kb = fingerprint_key(b)
    if not ka or not kb:
        return False
    if fuzzy_ratio(ka, kb) >= threshold:
        return True
    killer_a = normalize_name(a.get("killer", ""))
    killer_b = normalize_name(b.get("killer", ""))
    victim_a = normalize_name(a.get("victim", ""))
    victim_b = normalize_name(b.get("victim", ""))
    if len(killer_a) < 3 or len(killer_b) < 3 or len(victim_a) < 3 or len(victim_b) < 3:
        return False
    if fuzzy_ratio(killer_a, killer_b) < threshold:
        return False
    if fuzzy_ratio(victim_a, victim_b) < threshold:
        return False
    assist_a = normalize_name(a.get("assist", ""))
    assist_b = normalize_name(b.get("assist", ""))
    if assist_a and assist_b and fuzzy_ratio(assist_a, assist_b) < threshold:
        return False
    return True


def find_registry_match(
    fp: dict[str, str], registry: list[dict[str, Any]], threshold: float
) -> dict[str, Any] | None:
    for entry in registry:
        if fingerprint_match(fp, entry["fingerprint"], threshold):
            return entry
    return None


def extract_frame_ffmpeg(video_path: str, time_sec: float, ffmpeg_bin: str) -> np.ndarray | None:
    import subprocess
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        out = tmp.name
    try:
        cmd = [
            ffmpeg_bin,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            str(max(0.0, time_sec)),
            "-i",
            video_path,
            "-frames:v",
            "1",
            "-q:v",
            "2",
            out,
        ]
        subprocess.run(cmd, check=True, capture_output=True, timeout=45)
        return cv2.imread(out)
    except Exception:
        return None
    finally:
        try:
            os.unlink(out)
        except OSError:
            pass


def read_frame_at(cap: cv2.VideoCapture, time_sec: float) -> np.ndarray | None:
    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, time_sec) * 1000.0)
    ok, frame = cap.read()
    return frame if ok else None


def get_frame(
    video_path: str,
    time_sec: float,
    cap: cv2.VideoCapture | None,
    ffmpeg_bin: str | None,
) -> np.ndarray | None:
    if cap is not None and cap.isOpened():
        frame = read_frame_at(cap, time_sec)
        if frame is not None:
            return frame
    if ffmpeg_bin:
        return extract_frame_ffmpeg(video_path, time_sec, ffmpeg_bin)
    return None


def fingerprints_at_time(
    video_path: str,
    time_sec: float,
    cfg: KillFeedConfig,
    cap: cv2.VideoCapture | None,
    ffmpeg_bin: str | None,
    stats: PipelineStats,
    debug: OcrDebugLogger,
) -> list[dict[str, Any]]:
    frame = get_frame(video_path, time_sec, cap, ffmpeg_bin)
    if frame is None:
        return []
    patch = crop_roi(frame, cfg)
    if patch is None:
        return []

    results: list[dict[str, Any]] = []
    for entry in detect_red_bordered_entries(patch, cfg):
        stats.ocr_calls += 1
        raw, _ocr_score = ocr_kill_bar(entry["crop"], cfg)
        if len((raw or "").strip()) > 2:
            stats.ocr_nonempty += 1

        fp = parse_kill_fingerprint(raw)
        valid = is_valid_kill_fingerprint(fp)
        if valid:
            stats.ocr_parsed_as_kill_entry += 1

        key = fingerprint_key(fp)
        status = "accepted" if valid and key else "rejected"
        reason = "ok" if status == "accepted" else "invalid_fingerprint"
        debug.log(time_sec, entry["crop"], raw, fp, entry.get("red_border", True), status, reason)

        if not valid or not key:
            continue
        results.append(
            {
                "fingerprint": fp,
                "key": key,
                "confidence": round(min(0.99, 0.55 + entry["border_score"] * 4.0), 3),
                "border_score": entry["border_score"],
            }
        )
    return results


def coarse_scan(
    video_path: str,
    duration: float,
    cfg: KillFeedConfig,
    cap: cv2.VideoCapture | None,
    ffmpeg_bin: str | None,
    stats: PipelineStats,
) -> list[float]:
    hits: list[float] = []
    t = cfg.spawn_cutoff_sec
    while t < duration:
        stats.frames_sampled_pass1 += 1
        frame = get_frame(video_path, t, cap, ffmpeg_bin)
        if frame is not None:
            patch = crop_roi(frame, cfg)
            if patch is not None and detect_red_bordered_entries(patch, cfg):
                hits.append(t)
        t += cfg.coarse_sample_sec
    stats.coarse_hits = len(hits)
    return hits


def dedupe_coarse_hits(hits: list[float], min_gap: float = 2.0) -> list[float]:
    if not hits:
        return []
    sorted_hits = sorted(hits)
    out = [sorted_hits[0]]
    for t in sorted_hits[1:]:
        if t - out[-1] >= min_gap:
            out.append(t)
    return out


def backward_anchor(
    video_path: str,
    coarse_t: float,
    seed_fp: dict[str, str],
    cfg: KillFeedConfig,
    cap: cv2.VideoCapture | None,
    ffmpeg_bin: str | None,
    stats: PipelineStats,
    debug: OcrDebugLogger,
) -> tuple[float, dict[str, str], float]:
    anchor = coarse_t
    best_conf = 0.5
    t = coarse_t
    limit = max(cfg.spawn_cutoff_sec, coarse_t - cfg.fine_max_back_sec)
    while t >= limit:
        found = False
        for item in fingerprints_at_time(
            video_path, t, cfg, cap, ffmpeg_bin, stats, debug
        ):
            if fingerprint_match(seed_fp, item["fingerprint"], cfg.fuzzy_match_threshold):
                anchor = t
                best_conf = max(best_conf, item["confidence"])
                found = True
                break
        if not found:
            break
        t -= cfg.fine_step_sec
    return anchor, seed_fp, best_conf


def select_pov_cluster(
    registry: list[dict[str, Any]],
    title_hint_tokens: list[str] | None,
    cfg: KillFeedConfig,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], float]:
    killers = [
        normalize_name(e.get("killer", ""))
        for e in registry
        if normalize_name(e.get("killer", ""))
    ]
    clusters = cluster_names(killers, cfg.pov_cluster_threshold)
    if not clusters:
        return None, clusters, 0.0

    if title_hint_tokens and len(clusters) >= 2:
        top, second = clusters[0], clusters[1]
        if second["count"] >= top["count"] * 0.8:
            best_swap = False
            best_delta = 0.0
            for hint in title_hint_tokens:
                h = normalize_name(hint)
                if len(h) < 3:
                    continue
                delta = fuzzy_ratio(h, second["representative"]) - fuzzy_ratio(
                    h, top["representative"]
                )
                if delta > best_delta + 0.05:
                    best_delta = delta
                    best_swap = True
            if best_swap:
                clusters[0], clusters[1] = second, top

    total = max(1, len(registry))
    coverage = clusters[0]["count"] / total
    return clusters[0], clusters, coverage


def classify_registry_entry(
    entry: dict[str, Any],
    pov_rep: str,
    cfg: KillFeedConfig,
    fallback_mode: bool,
) -> tuple[str, str]:
    killer = entry.get("killer", "")
    victim = entry.get("victim", "")

    if fallback_mode:
        if pov_rep and name_matches_cluster(victim, pov_rep, cfg.pov_match_threshold):
            return "death", "pov_death_fallback"
        return "kill", "fallback_red_border"

    if pov_rep and name_matches_cluster(killer, pov_rep, cfg.pov_match_threshold):
        return "kill", "pov_killer_match"
    if pov_rep and name_matches_cluster(victim, pov_rep, cfg.pov_match_threshold):
        return "death", "pov_victim_match"
    return "skip", "not_pov"


def merge_clips(
    kill_anchors: list[float],
    cfg: KillFeedConfig,
    duration: float,
) -> list[dict[str, Any]]:
    if not kill_anchors:
        return []
    sorted_a = sorted(kill_anchors)
    groups: list[list[float]] = [[sorted_a[0]]]
    for a in sorted_a[1:]:
        if a - groups[-1][-1] <= cfg.merge_gap_sec:
            groups[-1].append(a)
        else:
            groups.append([a])

    clips: list[dict[str, Any]] = []
    for g in groups:
        start = max(0.0, g[0] - cfg.lead_sec)
        end = min(duration, g[-1] + cfg.tail_sec)
        clips.append(
            {
                "start_s": round(start, 2),
                "end_s": round(end, 2),
                "kill_count": len(g),
                "kill_anchors": [round(x, 2) for x in g],
            }
        )

    merged: list[dict[str, Any]] = []
    for c in clips:
        if merged and c["start_s"] <= merged[-1]["end_s"]:
            prev = merged[-1]
            prev["end_s"] = round(max(prev["end_s"], c["end_s"]), 2)
            prev["kill_anchors"] = sorted(set(prev["kill_anchors"] + c["kill_anchors"]))
            prev["kill_count"] = len(prev["kill_anchors"])
        else:
            merged.append(c)
    return merged


def run_pipeline(
    video_path: str,
    duration: float,
    cfg: KillFeedConfig | None = None,
    pov_player_override: str | None = None,
    title_hint_tokens: list[str] | None = None,
    ffmpeg_bin: str | None = None,
) -> dict[str, Any]:
    cfg = cfg or KillFeedConfig()
    if os.environ.get("KILL_FEED_DEBUG", "").strip() in ("1", "true", "yes"):
        cfg.debug_ocr = True

    stats = PipelineStats()
    debug = OcrDebugLogger(cfg.debug_ocr, cfg.debug_dir)
    duration = float(duration or 0)

    hints = list(title_hint_tokens or [])
    if pov_player_override and is_plausible_gamertag(pov_player_override):
        hints.append(pov_player_override)

    if duration <= cfg.spawn_cutoff_sec:
        return _empty_result(video_path, cfg, stats)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        cap = None

    seen_before_dedup: set[str] = set()

    try:
        coarse = dedupe_coarse_hits(
            coarse_scan(video_path, duration, cfg, cap, ffmpeg_bin, stats)
        )
        registry: list[dict[str, Any]] = []

        for coarse_t in coarse:
            seed_items = fingerprints_at_time(
                video_path, coarse_t, cfg, cap, ffmpeg_bin, stats, debug
            )
            for item in seed_items:
                seen_before_dedup.add(item["key"])
                if find_registry_match(item["fingerprint"], registry, cfg.fuzzy_match_threshold):
                    continue
                anchor, fp, conf = backward_anchor(
                    video_path,
                    coarse_t,
                    item["fingerprint"],
                    cfg,
                    cap,
                    ffmpeg_bin,
                    stats,
                    debug,
                )
                seen_before_dedup.add(fingerprint_key(fp))
                if find_registry_match(fp, registry, cfg.fuzzy_match_threshold):
                    continue
                registry.append(
                    {
                        "anchor_s": round(anchor, 2),
                        "killer": fp.get("killer", ""),
                        "assist": fp.get("assist", ""),
                        "victim": fp.get("victim", ""),
                        "fingerprint": fp,
                        "confidence": round(conf, 3),
                    }
                )

        stats.unique_fingerprints_before_dedup = len(seen_before_dedup)
        stats.unique_fingerprints_after_dedup = len(registry)

        pov_cluster, _clusters, coverage = select_pov_cluster(registry, hints, cfg)
        pov_rep = pov_cluster["representative"] if pov_cluster else ""
        stats.pov_cluster_coverage = round(coverage, 3)
        fallback_mode = bool(pov_cluster) and coverage < cfg.pov_coverage_min
        if not pov_cluster:
            fallback_mode = True
        stats.pov_fallback_mode = fallback_mode

        if fallback_mode:
            import sys

            print(
                f"[kill-feed] POV fallback mode (coverage={coverage:.2f}, "
                f"rep={pov_rep or '?'})",
                file=sys.stderr,
                flush=True,
            )

        kills: list[dict[str, Any]] = []
        for entry in sorted(registry, key=lambda e: e["anchor_s"]):
            kind, reason = classify_registry_entry(entry, pov_rep, cfg, fallback_mode)
            if kind == "death":
                stats.pov_deaths_excluded += 1
                continue
            if kind != "kill":
                continue
            kills.append(
                {
                    "anchor_s": entry["anchor_s"],
                    "killer": entry["killer"],
                    "assist": entry.get("assist", ""),
                    "victim": entry["victim"],
                    "confidence": entry["confidence"],
                    "pov_reason": reason,
                }
            )

        stats.kills_found = len(kills)
        anchors = [k["anchor_s"] for k in kills]
        clips = merge_clips(anchors, cfg, duration)
        stats.clips_produced = len(clips)

        return {
            "video": video_path,
            "pov_player": pov_rep,
            "kills": kills,
            "clips": clips,
            "config": asdict(cfg),
            "stats": asdict(stats),
            "debug_dir": cfg.debug_dir if cfg.debug_ocr else None,
        }
    finally:
        if cap is not None:
            cap.release()


_CHANNEL_BAD = (
    "pov",
    "highlights",
    "gameplay",
    "youtube",
    "twitch",
    "official",
    "channel",
    "gaming",
    "counter",
    "strike",
    "limcs",
)


def is_plausible_gamertag(name: str) -> bool:
    n = (name or "").strip()
    if len(n) < 3 or len(n) > 22:
        return False
    if " " in n:
        return False
    if not re.match(r"^[A-Za-z0-9_\-]+$", n):
        return False
    low = re.sub(r"[^a-z0-9]", "", n.lower())
    if any(b in low for b in _CHANNEL_BAD):
        return False
    return True


def _empty_result(video: str, cfg: KillFeedConfig, stats: PipelineStats) -> dict[str, Any]:
    return {
        "video": video,
        "pov_player": "",
        "kills": [],
        "clips": [],
        "config": asdict(cfg),
        "stats": asdict(stats),
        "debug_dir": cfg.debug_dir if cfg.debug_ocr else None,
    }


def kills_to_legacy_events(kills: list[dict[str, Any]], pov_player: str = "") -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for k in kills:
        anchor = k["anchor_s"]
        events.append(
            {
                "time": anchor,
                "raw_time": anchor,
                "kill_anchor_time": anchor,
                "confidence": k.get("confidence", 0.8),
                "roi": "top_right",
                "player_kill": True,
                "red_highlight": True,
                "killer": k.get("killer", ""),
                "assist": k.get("assist", ""),
                "victim": k.get("victim", ""),
                "highlight_score": k.get("confidence", 0.8),
                "highlight_color": "red",
                "method": "two-pass-ocr",
                "pov_player": pov_player,
            }
        )
    return events
