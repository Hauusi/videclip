"""
CS2 kill-feed detection: highlight-event scan (red frame) → OCR → POV filter.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from typing import Any

import cv2
import numpy as np

# Cyrillic word chars for CS2 nicknames (Latin + Cyrillic).
_NAME_RE = re.compile(
    r"(?:[A-Za-z0-9_\u0400-\u04FF][A-Za-z0-9_\-\u0400-\u04FF]{2,})"
)
_RUS_OCR_WARNED = False
_TESSERACT_CONFIGURED = False


def configure_tesseract() -> bool:
    """Resolve Tesseract binary from env or common install paths."""
    global _TESSERACT_CONFIGURED
    if _TESSERACT_CONFIGURED:
        return True

    import pytesseract

    cmd = os.environ.get("TESSERACT_CMD", "").strip()
    if cmd and os.path.isfile(cmd):
        pytesseract.pytesseract.tesseract_cmd = cmd
        _TESSERACT_CONFIGURED = True
        return True

    for candidate in (
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        "/usr/bin/tesseract",
        "/usr/local/bin/tesseract",
    ):
        if os.path.isfile(candidate):
            pytesseract.pytesseract.tesseract_cmd = candidate
            _TESSERACT_CONFIGURED = True
            return True

    return False


@dataclass
class KillFeedConfig:
    """All tunables — defaults from product spec."""

    roi_x: float = 0.825
    roi_y: float = 0.03
    roi_w: float = 0.175
    roi_h: float = 0.15

    coarse_sample_sec: float = 2.5
    # Denser pass-1 sampling right after spawn (weak OCR / feed lag in first ~90s).
    early_coarse_sample_sec: float = 1.5
    early_coarse_window_sec: float = 90.0
    # Spawn/warmup filter — owned here only (Node killDetect.js must not duplicate).
    spawn_cutoff_sec: float = 32.0

    # Finer backward steps improve kill-anchor timing for montage cuts (was 0.5s).
    fine_step_sec: float = 0.33
    fine_max_back_sec: float = 15.0
    # Kill-feed lines often appear 1–4s after a coarse sample; scan forward before giving up.
    fine_forward_sec: float = 5.0
    fine_miss_budget: int = 5

    red_h1_low: int = 0
    red_h1_high: int = 10
    red_h2_low: int = 170
    red_h2_high: int = 180
    red_s_min: int = 70
    red_v_min: int = 70
    min_red_v_std: float = 16.0

    min_entry_width: int = 40
    min_entry_height: int = 14
    # Full kill-feed row height for OCR (dark-bar split alone clips text).
    kill_bar_min_height: int = 22
    kill_bar_pad_y: int = 4
    kill_bar_max_height: int = 32
    # Slightly lower for compressed YouTube/H.264 footage (was 0.035 / 0.028 / 0.030 / 0.024).
    min_border_red_ratio: float = 0.026
    min_border_score: float = 0.020
    # CS2 highlight frame: red on all four edges of the kill line (not name-color bleed).
    min_highlight_edge_red: float = 0.022
    # Event-driven highlight scan (replaces coarse+fine OCR walk).
    highlight_scan_idle_sec: float = 2.0
    highlight_scan_hunt_sec: float = 0.45
    highlight_scan_lock_sec: float = 0.25
    min_highlight_event_score: float = 0.32
    highlight_event_dedupe_sec: float = 4.5
    highlight_weak_signal_score: float = 0.18
    min_highlight_frame_edge: float = 0.004
    # CS2 kill-feed row stays visible ~8–12s; same names = same kill.
    kill_feed_persist_sec: float = 10.0

    fuzzy_match_threshold: float = 0.85
    # Registry dedup window — same as killDetect.js sameKillWindowSec (HUD line ~6s on screen).
    dedup_time_window_sec: float = 7.0
    pov_cluster_threshold: float = 0.55
    pov_match_threshold: float = 0.58
    pov_coverage_min: float = 0.40
    # Collapse duplicate anchors from multiple coarse seeds on one engagement.
    kill_dedupe_gap_sec: float = 4.0
    # Kill-feed appears after the frag; shift anchors earlier for cut alignment.
    kill_feed_lag_sec: float = 2.25
    # Extra lag scale when OCR seed was found forward of the coarse sample (feed delay).
    forward_lag_scale: float = 0.48
    forward_lag_cap_sec: float = 2.5
    # Merge duplicate output anchors from multiple coarse seeds on one engagement.
    output_dedupe_gap_sec: float = 2.5

    merge_gap_sec: float = 5.0
    lead_sec: float = 4.0
    tail_sec: float = 2.0

    ocr_psm: int = 7
    ocr_upscale: float = 3.5

    debug_ocr: bool = False
    debug_dir: str | None = None

    card_roi_x0: float = 0.450
    card_roi_x1: float = 0.550
    card_roi_y0: float = 0.850
    card_roi_y1: float = 1.000
    card_cyan_threshold: int = 300
    card_event_gap_sec: float = 1.0
    card_confirm_window_sec: float = 1.0
    # 7.0s statt 2.0s: derselbe Kill kann über Karten-Signal und Namens-OCR
    # mit spürbarem zeitlichem Versatz gemeldet werden (z.B. GT=61s wurde per
    # Namens-OCR bei 61.5s erfasst, dieselbe Karte aber erst bei 65.5s erkannt)
    # - 7.0s deckt sich mit dem bestehenden dedup_time_window_sec Standard.
    card_dedupe_vs_existing_sec: float = 6.5


@dataclass
class PipelineStats:
    frames_sampled_pass1: int = 0
    coarse_hits: int = 0
    ocr_calls: int = 0
    ocr_nonempty: int = 0
    ocr_parsed_as_kill_entry: int = 0
    ocr_partial_reads: int = 0
    partial_upgraded_to_full: int = 0
    fingerprint_cache_hits: int = 0
    unique_fingerprints_before_dedup: int = 0
    unique_fingerprints_after_dedup: int = 0
    kills_found: int = 0
    pov_deaths_excluded: int = 0
    clips_produced: int = 0
    pov_fallback_mode: bool = False
    pov_cluster_coverage: float = 0.0
    highlight_events: int = 0
    highlight_frames_scanned: int = 0
    feed_persist_skipped: int = 0
    highlight_transition_skipped: int = 0
    registry_dedup_window_rejected: int = 0
    killstreak_card_events: int = 0
    killstreak_card_confirmed: int = 0


@dataclass
class FrameReader:
    """Frame source for pass-1/2 scans; AV1 sources use ffmpeg only."""

    video_path: str
    cap: cv2.VideoCapture | None = None
    ffmpeg_bin: str | None = None
    force_ffmpeg: bool = False
    coarse_frames: dict[float, np.ndarray] | None = None
    _coarse_tmp_dir: str | None = None

    def close(self) -> None:
        if self.cap is not None:
            self.cap.release()
            self.cap = None
        if self._coarse_tmp_dir:
            import shutil

            try:
                shutil.rmtree(self._coarse_tmp_dir, ignore_errors=True)
            except OSError:
                pass
            self._coarse_tmp_dir = None
        self.coarse_frames = None


def _kf_log(msg: str) -> None:
    print(f"[kill-feed] {msg}", file=sys.stderr, flush=True)


_AV1_FOURCC = frozenset({"av01", "av1 ", "dav1"})


def _fourcc_string(cap: cv2.VideoCapture) -> str:
    raw = int(cap.get(cv2.CAP_PROP_FOURCC))
    return "".join(chr((raw >> (8 * i)) & 0xFF) for i in range(4))


def open_frame_reader(
    video_path: str,
    ffmpeg_bin: str | None,
    probe_time_sec: float,
) -> FrameReader:
    """Open cv2 unless AV1 or probe read fails — then force ffmpeg for the run."""
    cap: cv2.VideoCapture | None = None
    force = False
    codec = "?"

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        cap = None
        force = bool(ffmpeg_bin)
    else:
        codec = _fourcc_string(cap).strip().lower()
        if codec in _AV1_FOURCC or codec.startswith("av1"):
            force = True
        elif ffmpeg_bin and read_frame_at(cap, probe_time_sec) is None:
            force = True

    if force:
        if ffmpeg_bin:
            _kf_log(f"force_ffmpeg=True (codec={codec}) — cv2 cannot decode this source")
            if cap is not None:
                cap.release()
                cap = None
        else:
            _kf_log("WARNING: source needs ffmpeg decode but ffmpeg_bin is missing")

    return FrameReader(
        video_path=video_path,
        cap=cap,
        ffmpeg_bin=ffmpeg_bin,
        force_ffmpeg=force and bool(ffmpeg_bin),
    )


class FingerprintCache:
    """Per-run cache keyed on round(time_sec, 1)."""

    def __init__(self) -> None:
        self._store: dict[float, list[dict[str, Any]]] = {}

    def get(self, time_sec: float) -> list[dict[str, Any]] | None:
        key = round(time_sec, 1)
        if key in self._store:
            return self._store[key]
        return None

    def put(self, time_sec: float, items: list[dict[str, Any]]) -> None:
        self._store[round(time_sec, 1)] = items


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
        fp: dict[str, Any],
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
            "partial": bool(fp.get("partial")),
            "red_border": red_border,
            "status": status,
            "reason": reason,
        }
        if self.jsonl_path:
            with open(self.jsonl_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")


def normalize_name(name: str) -> str:
    """Normalize a name for comparison.
    
    Preserves alphanumeric chars, underscore, hyphen, and Cyrillic letters.
    Note: This is for fuzzy matching - it removes common separators that
    don't affect name identity (spaces, dots, brackets, etc.).
    """
    n = (name or "").lower()
    # Keep: alphanumeric, underscore, hyphen, Cyrillic
    # Remove: spaces, dots, brackets, and other decorative chars used in gamertags
    # These don't change the core identity of the name for matching purposes
    cleaned = re.sub(r"[^a-z0-9_\-\u0430-\u044f\u0451]", "", n)
    return cleaned


def fuzzy_ratio(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def is_partial_fingerprint(fp: dict[str, Any]) -> bool:
    return bool(fp.get("partial"))


def is_full_fingerprint(fp: dict[str, Any]) -> bool:
    return not is_partial_fingerprint(fp) and is_valid_kill_fingerprint(fp)


def is_garbage_ocr_name(name: str) -> bool:
    """Reject OCR noise that should not drive POV clustering or matching."""
    n = normalize_name(name)
    if len(n) < 3:
        return True
    if len(n) > 18:
        return True
    if re.search(r"(.)\1{3,}", n):
        return True
    if len(n) >= 7 and len(set(n)) / len(n) < 0.38:
        return True
    alnum = sum(ch.isalnum() for ch in n)
    if len(n) >= 5 and alnum / len(n) < 0.72:
        return True
    return False


def entry_has_pov_name(
    entry: dict[str, Any],
    fp: dict[str, Any],
    pov_rep: str,
    pov_cluster: dict[str, Any] | None,
    cfg: KillFeedConfig,
) -> bool:
    return any(
        name_matches_pov(name, pov_rep, pov_cluster, cfg)
        for name in entry_names(entry, fp)
    )


def merge_meta_clusters(
    clusters: list[dict[str, Any]], threshold: float
) -> list[dict[str, Any]]:
    """Merge OCR-variant name clusters (simple / sianple / sinpleofea)."""
    merged: list[dict[str, Any]] = []
    for cluster in sorted(clusters, key=lambda c: -c["count"]):
        rep = cluster["representative"]
        if is_garbage_ocr_name(rep):
            continue
        placed = False
        for existing in merged:
            if fuzzy_ratio(rep, existing["representative"]) >= threshold:
                existing["members"].extend(cluster["members"])
                existing["count"] += cluster["count"]
                members = existing["members"]
                existing["representative"] = max(
                    set(members), key=lambda m: (members.count(m), len(m))
                )
                placed = True
                break
        if not placed:
            merged.append(
                {
                    "representative": rep,
                    "members": list(cluster["members"]),
                    "count": cluster["count"],
                }
            )
    return sorted(merged, key=lambda c: (-c["count"], -len(c["representative"])))


def collapse_kill_events(
    kills: list[dict[str, Any]], gap_sec: float, pov_rep: str = ""
) -> list[dict[str, Any]]:
    if not kills:
        return kills
    ordered = sorted(kills, key=lambda k: k["anchor_s"])
    out: list[dict[str, Any]] = [ordered[0]]
    for kill in ordered[1:]:
        prev = out[-1]
        gap = kill["anchor_s"] - prev["anchor_s"]
        if gap > gap_sec:
            out.append(kill)
            continue
        prev_victim = normalize_name(prev.get("victim", ""))
        kill_victim = normalize_name(kill.get("victim", ""))
        if prev_victim and kill_victim and prev_victim != kill_victim:
            if _partial_ocr_same_engagement(prev, kill, pov_rep):
                if kill.get("confidence", 0) >= prev.get("confidence", 0):
                    out[-1] = kill
                continue
            out.append(kill)
            continue
        if kill.get("confidence", 0) >= prev.get("confidence", 0):
            out[-1] = kill
    return out


def _partial_ocr_same_engagement(
    prev: dict[str, Any], kill: dict[str, Any], pov_rep: str
) -> bool:
    """Noisy OCR on one feed line — killer variants with garbage/different victims."""
    gap = kill["anchor_s"] - prev["anchor_s"]
    if gap > 4.0:
        return False
    pk = prev.get("killer", "")
    kk = kill.get("killer", "")
    if pov_rep and is_likely_pov_ocr_spelling(pk, pov_rep) and is_likely_pov_ocr_spelling(
        kk, pov_rep
    ):
        return True
    prev_partial = "partial" in str(prev.get("pov_reason", ""))
    kill_partial = "partial" in str(kill.get("pov_reason", ""))
    if prev_partial and kill_partial:
        return True
    pv = normalize_name(prev.get("victim", ""))
    kv = normalize_name(kill.get("victim", ""))
    if (prev_partial or kill_partial) and (
        is_garbage_ocr_name(pv) or len(pv) <= 4
    ) and (is_garbage_ocr_name(kv) or len(kv) <= 4):
        return True
    return False


def dedupe_output_kills(
    kills: list[dict[str, Any]], gap_sec: float, pov_rep: str = ""
) -> list[dict[str, Any]]:
    """Drop duplicate anchors from multiple coarse seeds (same engagement, OCR variants)."""
    if not kills:
        return kills
    ordered = sorted(kills, key=lambda k: k["anchor_s"])
    out: list[dict[str, Any]] = [ordered[0]]
    for kill in ordered[1:]:
        merged = False
        for i, prev in enumerate(out):
            gap = kill["anchor_s"] - prev["anchor_s"]
            pov_merge = pov_rep and gap <= 4.0 and is_likely_pov_ocr_spelling(
                prev.get("killer", ""), pov_rep
            ) and is_likely_pov_ocr_spelling(kill.get("killer", ""), pov_rep)
            partial_merge = _partial_ocr_same_engagement(prev, kill, pov_rep)
            if gap > gap_sec and not pov_merge and not partial_merge:
                continue
            pk = normalize_name(prev.get("killer", ""))
            kk = normalize_name(kill.get("killer", ""))
            pv = normalize_name(prev.get("victim", ""))
            kv = normalize_name(kill.get("victim", ""))
            same_k = len(pk) >= 3 and len(kk) >= 3 and fuzzy_ratio(pk, kk) >= 0.72
            same_v = len(pv) >= 3 and len(kv) >= 3 and fuzzy_ratio(pv, kv) >= 0.72
            if pov_merge or partial_merge:
                same_k = True
            if same_k or same_v:
                if kill.get("confidence", 0) >= prev.get("confidence", 0):
                    out[i] = kill
                merged = True
                break
        if not merged:
            out.append(kill)
    return dedupe_exact_anchors(out)


def dedupe_exact_anchors(
    kills: list[dict[str, Any]], eps: float = 0.5
) -> list[dict[str, Any]]:
    if not kills:
        return kills
    ordered = sorted(kills, key=lambda k: k["anchor_s"])
    out: list[dict[str, Any]] = [ordered[0]]
    for kill in ordered[1:]:
        if abs(kill["anchor_s"] - out[-1]["anchor_s"]) <= eps:
            if kill.get("confidence", 0) >= out[-1].get("confidence", 0):
                out[-1] = kill
        else:
            out.append(kill)
    return out


def kill_output_anchor(entry: dict[str, Any], cfg: KillFeedConfig) -> float:
    """Cut anchor = red-highlight bar time minus feed lag."""
    base = float(entry.get("bar_detection_s") or entry["anchor_s"])
    lag = cfg.kill_feed_lag_sec
    fp = entry.get("fingerprint") or {}
    if fp.get("highlight_only") or entry.get("highlight_only"):
        return round(max(cfg.spawn_cutoff_sec, base - lag), 2)
    coarse = entry.get("coarse_origin_s")
    forward = float(entry.get("forward_lag_sec") or 0.0)
    if forward > cfg.fine_step_sec:
        lag += min(cfg.forward_lag_cap_sec, forward * cfg.forward_lag_scale)
    elif coarse is not None:
        delta = base - float(coarse)
        if delta > cfg.fine_step_sec:
            lag += min(cfg.forward_lag_cap_sec, delta * cfg.forward_lag_scale)
        elif delta < -cfg.fine_step_sec:
            lag = max(2.0, lag - min(0.5, abs(delta) * 0.125))
    return round(max(cfg.spawn_cutoff_sec, base - lag), 2)


def cluster_names(names: list[str], threshold: float = 0.75) -> list[dict[str, Any]]:
    clusters: list[dict[str, Any]] = []
    for raw in names:
        norm = normalize_name(raw)
        if len(norm) < 3 or is_garbage_ocr_name(norm):
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


def name_matches_pov(
    name: str,
    pov_rep: str,
    pov_cluster: dict[str, Any] | None,
    cfg: KillFeedConfig,
) -> bool:
    """Name ≈ POV player — fuzzy + cluster members only (no loose suffix rules)."""
    k = normalize_name(name)
    pn = normalize_name(pov_rep)
    if len(k) < 3 or not pn or is_garbage_ocr_name(k):
        return False

    threshold = cfg.pov_match_threshold
    if fuzzy_ratio(k, pn) >= threshold:
        return True

    # OCR typos on the POV rep (e.g. s1mple → simple) — require reasonable length.
    if len(k) >= 4 and len(pn) >= 4 and fuzzy_ratio(k, pn) >= 0.55:
        return True

    # Shared prefix for longer reads (simp… / s1mp…)
    if len(k) >= 6 and len(pn) >= 6 and k[:4] == pn[:4]:
        return True

    if pov_cluster:
        for member in pov_cluster.get("members", []):
            member_norm = normalize_name(member)
            if len(member_norm) < 3 or is_garbage_ocr_name(member_norm):
                continue
            if member_norm == k:
                return True
            if fuzzy_ratio(k, member_norm) >= max(0.55, threshold - 0.05):
                return True

    return False


def killer_matches_pov(
    killer: str,
    pov_rep: str,
    pov_cluster: dict[str, Any] | None,
    cfg: KillFeedConfig,
    *,
    pov_from_hint: bool = False,
) -> bool:
    """Backward-compatible alias."""
    return name_matches_pov(killer, pov_rep, pov_cluster, cfg)


def entry_names(entry: dict[str, Any], fp: dict[str, Any]) -> list[str]:
    """All OCR names on a red-border feed line."""
    seen: set[str] = set()
    out: list[str] = []
    for field in ("killer", "assist", "victim"):
        n = normalize_name(entry.get(field) or fp.get(field, ""))
        if len(n) >= 3 and n not in seen:
            seen.add(n)
            out.append(n)
    for raw in _NAME_RE.findall(fp.get("raw") or ""):
        n = normalize_name(raw)
        if len(n) >= 3 and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def killer_is_foreign(
    killer: str,
    pov_cluster: dict[str, Any] | None,
    all_clusters: list[dict[str, Any]],
    cfg: KillFeedConfig,
) -> bool:
    """Killer clearly belongs to a non-POV OCR cluster (enemy/teammate)."""
    k = normalize_name(killer)
    if len(k) < 4 or not pov_cluster:
        return False
    pov_rep = pov_cluster["representative"]
    if name_matches_pov(killer, pov_rep, pov_cluster, cfg):
        return False
    for oc in all_clusters:
        orep = oc["representative"]
        if fuzzy_ratio(orep, pov_rep) >= 0.62:
            continue
        if oc["count"] < 2:
            continue
        if fuzzy_ratio(k, orep) >= 0.82:
            return True
    return False


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


def _merge_nearby_bands(
    bands: list[tuple[int, int]], gap: int = 3
) -> list[tuple[int, int]]:
    if not bands:
        return bands
    merged: list[tuple[int, int]] = [bands[0]]
    for y0, y1 in bands[1:]:
        py0, py1 = merged[-1]
        if y0 - py1 <= gap:
            merged[-1] = (py0, y1)
        else:
            merged.append((y0, y1))
    return merged


def _expand_kill_bar_bounds(
    patch: np.ndarray, y0: int, y1: int, cfg: KillFeedConfig
) -> tuple[int, int]:
    """Pad a red/dark seed band to a full kill-feed row without bleeding into neighbors."""
    h = patch.shape[0]
    pad = cfg.kill_bar_pad_y
    y0e = max(0, y0 - pad)
    y1e = min(h, y1 + pad)
    min_h = cfg.kill_bar_min_height
    if y1e - y0e < min_h:
        center = (y0 + y1) // 2
        half = (min_h + 1) // 2
        y0e = max(0, center - half)
        y1e = min(h, center + half)
        if y1e - y0e < min_h:
            y1e = min(h, y0e + min_h)
    return y0e, y1e


def _split_feed_lines(patch: np.ndarray) -> list[tuple[int, int]]:
    """Initial row seeds from dark kill-feed backgrounds (expanded later per band)."""
    return _split_dark_bars(patch)


def _split_oversized_band(
    red: np.ndarray, y0: int, y1: int, max_h: int = 34
) -> list[tuple[int, int]]:
    if y1 - y0 <= max_h:
        return [(y0, y1)]
    band = red[y0:y1, :]
    row_red = np.mean(band > 0, axis=1)
    if len(row_red) < 10:
        return [(y0, y1)]
    inner = row_red[4:-4]
    gap_rel = int(np.argmin(inner))
    gap = gap_rel + 4
    if inner[gap_rel] > 0.01:
        return [(y0, y1)]
    top = (y0, y0 + gap)
    bot = (y0 + gap, y1)
    if top[1] - top[0] < 6 or bot[1] - bot[0] < 6:
        return [(y0, y1)]
    return [top, bot]


def _bands_from_red_rows(red: np.ndarray, min_h: int = 6) -> list[tuple[int, int]]:
    """One band per red-bordered kill-feed rectangle."""
    if red is None or red.size == 0:
        return []
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 1))
    closed = cv2.morphologyEx(red, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    bands: list[tuple[int, int]] = []
    for contour in contours:
        _x, y, w, h = cv2.boundingRect(contour)
        if h < min_h or w < 30:
            continue
        bands.append((y, y + h))
    if bands:
        split: list[tuple[int, int]] = []
        for y0, y1 in sorted(bands):
            split.extend(_split_oversized_band(red, y0, y1))
        return split

    row_red = np.mean(red > 0, axis=1)
    active = row_red > 0.012
    start = None
    for i, on in enumerate(active):
        if on and start is None:
            start = i
        elif not on and start is not None:
            if i - start >= min_h:
                bands.append((start, i))
            start = None
    if start is not None and red.shape[0] - start >= min_h:
        bands.append((start, red.shape[0]))
    return _merge_nearby_bands(bands, gap=2)


def _split_dark_bars(patch: np.ndarray) -> list[tuple[int, int]]:
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
            if i - start >= 8:
                bands.append((start, i))
            start = None
    if start is not None and patch.shape[0] - start >= 8:
        bands.append((start, patch.shape[0]))
    if not bands:
        return _split_feed_bands_fallback(patch)
    return _merge_nearby_bands(bands, gap=3)


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


def _red_highlight_frame_score(red_band: np.ndarray) -> float:
    """Top+bottom red edges = CS2 highlight frame (stronger than name-color bleed)."""
    h, w = red_band.shape[:2]
    if h < 8 or w < 20:
        return 0.0
    t = max(1, min(2, h // 5))
    top = float(np.mean(red_band[:t, :] > 0))
    bot = float(np.mean(red_band[-t:, :] > 0))
    if top < 0.015 or bot < 0.015:
        return min(top, bot)
    return (top + bot) / 2.0


def _kill_feed_row_sanity(band_bgr: np.ndarray, frame_edge: float = 0.0) -> bool:
    """Reject uniform wall/sky strips; keep dark or text-contrast feed rows."""
    if band_bgr is None or band_bgr.size == 0:
        return False
    gray = cv2.cvtColor(band_bgr, cv2.COLOR_BGR2GRAY)
    mean = float(np.mean(gray))
    std = float(np.std(gray))
    bright_frac = float(np.mean(gray > 165))
    # Text + icons on feed → high variance.
    if std >= 20.0 and bright_frac >= 0.03:
        return True
    # Clear red highlight frame (true CS2 new-kill row).
    if frame_edge >= 0.06:
        return True
    # Uniform mid/dark band without text (wood wall, orange glow) — e.g. fn2 @58s.
    if mean < 105.0 and std < 18.0:
        return False
    if bright_frac < 0.025 and frame_edge < 0.055:
        return False
    # Bright uniform strip without contrast (sky/hotspot).
    if mean > 145.0 and std < 18.0:
        return False
    return mean < 140.0


def _build_highlight_entry(
    patch_bgr: np.ndarray,
    y0: int,
    y1: int,
    red: np.ndarray,
    gray: np.ndarray,
    cfg: KillFeedConfig,
) -> dict[str, Any] | None:
    """Score one kill-feed band for CS2 red highlight frame (top+bottom edges)."""
    band = patch_bgr[y0:y1, :]
    red_band = red[y0:y1, :]
    bh, bw = band.shape[:2]
    if bw < cfg.min_entry_width or bh < cfg.min_entry_height:
        return None
    if bh > cfg.kill_bar_max_height + 4:
        center = (y0 + y1) // 2
        half = cfg.kill_bar_max_height // 2
        y0 = max(0, center - half)
        y1 = min(patch_bgr.shape[0], center + half)
        band = patch_bgr[y0:y1, :]
        red_band = red[y0:y1, :]
        bh = band.shape[0]

    t = max(1, min(2, bh // 5))
    top_red = float(np.mean(red_band[:t, :] > 0))
    bot_red = float(np.mean(red_band[-t:, :] > 0))
    mid = red_band[t : max(t, bh - t), :]
    inner_red = float(np.mean(mid > 0)) if mid.size else 1.0
    center_gray = float(np.mean(gray[y0:y1, :]))
    darkness = max(0.0, (148.0 - center_gray) / 88.0)

    frame_edge = (
        min(top_red, bot_red)
        if top_red >= 0.005 and bot_red >= 0.005
        else 0.0
    )
    border_score = _border_score(band, red_band)
    red_ratio = float(np.mean(red_band > 0))

    band_hsv = cv2.cvtColor(band, cv2.COLOR_BGR2HSV)
    v_masked = band_hsv[:, :, 2][red_band > 0]
    v_std = float(np.std(v_masked)) if v_masked.size >= 10 else 0.0
    if v_std < cfg.min_red_v_std:
        return None

    if frame_edge < cfg.min_highlight_frame_edge and border_score < 0.015:
        if red_ratio < 0.09:
            return None

    highlight_score = (
        frame_edge * 4.0
        + border_score * 2.5
        + max(0.0, (top_red + bot_red) / 2.0 - inner_red * 0.55) * 2.0
        + min(red_ratio, 0.22) * 1.2
        + darkness * 0.45
    )

    passes = highlight_score >= cfg.min_highlight_event_score or _bar_candidate_passes(
        border_score, frame_edge, red_ratio, cfg
    )
    if not passes:
        return None
    if darkness < 0.03 and red_ratio < 0.035 and frame_edge < 0.008:
        return None
    if not _kill_feed_row_sanity(band, frame_edge):
        return None

    return {
        "bbox": (0, y0, bw, y1),
        "crop": band,
        "border_score": border_score,
        "border_red": red_ratio,
        "highlight_score": highlight_score,
        "frame_edge": frame_edge,
        "red_border": True,
        "rect": (y0, y1),
    }


def detect_highlight_bar(
    patch_bgr: np.ndarray, cfg: KillFeedConfig
) -> list[dict[str, Any]]:
    """Best single red-highlight kill-feed row in ROI (one kill line)."""
    if patch_bgr is None or patch_bgr.size == 0:
        return []

    hsv = cv2.cvtColor(patch_bgr, cv2.COLOR_BGR2HSV)
    red = _red_mask(hsv, cfg)
    gray = cv2.cvtColor(patch_bgr, cv2.COLOR_BGR2GRAY)

    seeds: list[tuple[int, int]] = list(_split_feed_lines(patch_bgr))
    seeds.extend(_bands_from_red_rows(red, min_h=8))
    if not seeds:
        return []

    merged: list[tuple[int, int]] = []
    for y0, y1 in sorted(seeds):
        merged.append((y0, y1))
    seeds = _merge_nearby_bands(merged, gap=4)

    best: dict[str, Any] | None = None
    best_score = -1.0
    for y0, y1 in seeds:
        y0e, y1e = _expand_kill_bar_bounds(patch_bgr, y0, y1, cfg)
        for dy in (-3, -1, 0, 1, 3):
            ya = max(0, y0e + dy)
            yb = min(patch_bgr.shape[0], y1e + dy)
            if yb - ya < cfg.kill_bar_min_height:
                continue
            ent = _build_highlight_entry(patch_bgr, ya, yb, red, gray, cfg)
            if ent is None:
                continue
            sc = float(ent["highlight_score"])
            if sc > best_score:
                best_score = sc
                best = ent

    return [best] if best else []


def _rect_matches_recent(
    y0: int,
    y1: int,
    t: float,
    recent: list[tuple[float, int, int]],
    cfg: KillFeedConfig,
) -> bool:
    cy = (y0 + y1) / 2.0
    for pt, py0, py1 in recent:
        if t - pt > cfg.highlight_event_dedupe_sec:
            continue
        pcy = (py0 + py1) / 2.0
        if abs(pcy - cy) <= 14 and abs((py1 - py0) - (y1 - y0)) <= 10:
            return True
    return False


@dataclass
class _PersistedFeedHit:
    t: float
    keys: list[str]
    fp: dict[str, Any]
    y_center: float


def _feed_identity_keys(fp: dict[str, Any]) -> list[str]:
    keys: list[str] = []
    fk = fingerprint_key(fp)
    if fk:
        keys.append(fk)
    k = normalize_name(fp.get("killer", ""))
    v = normalize_name(fp.get("victim", ""))
    a = normalize_name(fp.get("assist", ""))
    if k and len(k) >= 3:
        keys.append(f"k|{k}")
    if v and len(v) >= 3:
        keys.append(f"v|{v}")
    if k and v:
        keys.append(f"{k}|{v}")
    if a and len(a) >= 3:
        keys.append(f"a|{a}")
    return keys


class FeedPersistTracker:
    """Suppress re-counting the same feed line while it scrolls (~10s on screen)."""

    def __init__(self, cfg: KillFeedConfig) -> None:
        self.cfg = cfg
        self.hits: list[_PersistedFeedHit] = []

    def prune(self, t: float) -> None:
        window = self.cfg.kill_feed_persist_sec
        self.hits = [h for h in self.hits if t - h.t <= window]

    def is_duplicate(self, t: float, fp: dict[str, Any], y0: int, y1: int) -> tuple[bool, str]:
        self.prune(t)
        keys = _feed_identity_keys(fp)
        yc = (y0 + y1) / 2.0
        for h in self.hits:
            age = t - h.t
            if age > self.cfg.kill_feed_persist_sec:
                continue
            if keys and (h.keys or h.fp):
                for k in keys:
                    if k in h.keys:
                        return True, "same_feed_names"
                if fingerprint_match(fp, h.fp, self.cfg.fuzzy_match_threshold):
                    return True, "fuzzy_feed_fp"
            # Unreadable OCR: only suppress rapid re-fire on the same row (not 10s band).
            if not keys and not h.keys:
                if age < 2.5 and abs(yc - h.y_center) < 14:
                    return True, "same_feed_band"
        return False, ""

    def record(self, t: float, fp: dict[str, Any], y0: int, y1: int) -> None:
        self.prune(t)
        self.hits.append(
            _PersistedFeedHit(
                t=t,
                keys=_feed_identity_keys(fp),
                fp=fp,
                y_center=(y0 + y1) / 2.0,
            )
        )


def _highlight_just_appeared(
    y0: int,
    y1: int,
    frame_edge: float,
    patch_h: int,
    band_edges: dict[int, tuple[float, float]],
    cfg: KillFeedConfig,
) -> bool:
    """True when the red frame is new — not a gray row still sitting in the feed."""
    band = y0 // 10
    _prev_t, prev_edge = band_edges.get(band, (0.0, 0.0))
    edge_now = frame_edge >= cfg.min_highlight_frame_edge
    edge_rising = edge_now and prev_edge < cfg.min_highlight_frame_edge * 0.55
    new_band = band not in band_edges and edge_now
    # CS2 pushes new kills to the top of the ROI (low y).
    top_slot = y0 < patch_h * 0.4 and edge_now
    new_at_top = top_slot and (not band_edges or y0 < min(b * 10 for b in band_edges) - 8)
    return edge_rising or new_band or new_at_top


def _patch_has_weak_highlight(patch_bgr: np.ndarray, cfg: KillFeedConfig) -> bool:
    for ent in detect_highlight_bar(patch_bgr, cfg):
        if float(ent.get("highlight_score", 0)) >= cfg.highlight_weak_signal_score:
            return True
    return False


def highlight_event_scan(
    duration: float,
    cfg: KillFeedConfig,
    reader: FrameReader,
    stats: PipelineStats,
    debug: OcrDebugLogger,
) -> list[dict[str, Any]]:
    """Adaptive scan: new red-highlight bar = one kill-feed event (no OCR gate)."""
    events: list[dict[str, Any]] = []
    recent_rects: list[tuple[float, int, int]] = []
    band_edges: dict[int, tuple[float, float]] = {}
    t = cfg.spawn_cutoff_sec
    mode = "idle"
    lock_until = 0.0
    t0 = time.monotonic()

    _kf_log(
        f"highlight scan start: idle={cfg.highlight_scan_idle_sec}s "
        f"hunt={cfg.highlight_scan_hunt_sec}s lock={cfg.highlight_scan_lock_sec}s"
    )

    while t < duration:
        if mode == "idle":
            step = cfg.highlight_scan_idle_sec
        elif mode == "hunt":
            step = cfg.highlight_scan_hunt_sec
        else:
            step = cfg.highlight_scan_lock_sec

        stats.highlight_frames_scanned += 1
        stats.frames_sampled_pass1 += 1
        if stats.highlight_frames_scanned % 80 == 0:
            _kf_log(
                f"highlight progress: t={t:.0f}s events={len(events)} "
                f"mode={mode} elapsed={time.monotonic() - t0:.0f}s"
            )

        weak = False
        frame = get_frame(reader, t)
        if frame is not None:
            patch = crop_roi(frame, cfg)
            if patch is not None:
                bars = detect_highlight_bar(patch, cfg)
                weak = _patch_has_weak_highlight(patch, cfg)

                if bars:
                    ent = bars[0]
                    y0, y1 = ent["rect"]
                    hs = float(ent["highlight_score"])
                    fe = float(ent.get("frame_edge", 0))
                    ph = patch.shape[0]
                    is_new = (
                        hs >= cfg.min_highlight_event_score
                        and fe >= cfg.min_highlight_frame_edge
                        and not _rect_matches_recent(y0, y1, t, recent_rects, cfg)
                    )
                    band_edges[y0 // 10] = (t, fe)
                    band_edges = {
                        b: (bt, be)
                        for b, (bt, be) in band_edges.items()
                        if t - bt <= cfg.kill_feed_persist_sec
                    }
                    if is_new:
                        ev = {
                            "t_bar": round(t, 2),
                            "crop": ent["crop"],
                            "highlight_score": hs,
                            "frame_edge": fe,
                            "rect": (y0, y1),
                            "border_score": ent.get("border_score", 0.0),
                        }
                        events.append(ev)
                        stats.highlight_events += 1
                        recent_rects.append((t, y0, y1))
                        recent_rects = [
                            r
                            for r in recent_rects
                            if t - r[0] <= cfg.highlight_event_dedupe_sec + 2.0
                        ]
                        lock_until = t + 3.5
                        mode = "lock"
                        debug.log(
                            t,
                            ent["crop"],
                            "",
                            {},
                            True,
                            "highlight_event",
                            f"score={hs:.3f}",
                        )
                    elif weak or hs >= cfg.highlight_weak_signal_score:
                        mode = "hunt"
                        lock_until = max(lock_until, t + 2.0)
                elif weak:
                    mode = "hunt"
                    lock_until = max(lock_until, t + 2.0)

        if mode == "lock" and t >= lock_until:
            mode = "hunt"
        elif mode == "hunt" and t >= lock_until and not weak:
            mode = "idle"

        t += step

    stats.coarse_hits = len(events)
    _kf_log(
        f"highlight scan done: {stats.highlight_frames_scanned} frames, "
        f"{len(events)} events in {time.monotonic() - t0:.1f}s"
    )
    return events


def _bar_candidate_passes(
    border_score: float, highlight: float, red_ratio: float, cfg: KillFeedConfig
) -> bool:
    return (
        border_score >= cfg.min_border_score
        or highlight >= cfg.min_highlight_edge_red
        or red_ratio >= cfg.min_border_red_ratio
    )


def detect_red_bordered_entries(patch_bgr: np.ndarray, cfg: KillFeedConfig) -> list[dict[str, Any]]:
    """Public API for diagnostics — delegates to highlight bar detector."""
    return detect_highlight_bar(patch_bgr, cfg)


def _has_red_highlight_in_roi(patch_bgr: np.ndarray, cfg: KillFeedConfig) -> bool:
    if patch_bgr is None or patch_bgr.size == 0:
        return False
    return bool(detect_highlight_bar(patch_bgr, cfg))


def _ocr_score_text(text: str, data: dict[str, Any]) -> float:
    text = " ".join((text or "").split())
    confs = [int(c) for c in data.get("conf", []) if str(c).isdigit() and int(c) >= 0]
    avg_conf = sum(confs) / len(confs) if confs else 0.0
    names = _NAME_RE.findall(text)
    return len(names) * 12.0 + avg_conf + min(len(text), 40) * 0.15


def _ocr_threshold_passes(gray: np.ndarray, tess_cfg: str, lang: str | None = None) -> tuple[str, float]:
    import pytesseract
    from pytesseract import Output, TesseractNotFoundError

    configure_tesseract()
    best_text, best_score = "", -1.0
    config = tess_cfg if lang is None else tess_cfg
    for invert in (False, True):
        src = 255 - gray if invert else gray
        _, th = cv2.threshold(src, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        try:
            if lang:
                data = pytesseract.image_to_data(
                    th, config=config, lang=lang, output_type=Output.DICT
                )
                text = pytesseract.image_to_string(th, config=config, lang=lang)
            else:
                data = pytesseract.image_to_data(th, config=config, output_type=Output.DICT)
                text = pytesseract.image_to_string(th, config=config)
        except TesseractNotFoundError:
            raise
        except Exception:
            text = ""
            data = {"conf": []}
        score = _ocr_score_text(text, data)
        if score > best_score:
            best_text, best_score = text, score
    return best_text, best_score


def ocr_kill_bar(bar_bgr: np.ndarray, cfg: KillFeedConfig) -> tuple[str, float]:
    """Upscale + dual-threshold OCR; Cyrillic retry when Latin pass is sparse."""
    global _RUS_OCR_WARNED
    try:
        import pytesseract  # noqa: F401
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
    # Extended whitelist to support common CS2 gamertag characters
    # Includes: letters, numbers, underscore, hyphen, dot, space, and common brackets
    tess_whitelist = (
        f"--psm {cfg.ocr_psm} "
        r"-c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_\-. []|()@<> "
    )
    best_text, best_score = _ocr_threshold_passes(gray, tess_whitelist)

    if len(_NAME_RE.findall(best_text)) == 0:
        blur = cv2.GaussianBlur(gray, (0, 0), 3)
        sharp = cv2.addWeighted(gray, 1.5, blur, -0.5, 0)
        sharp_text, sharp_score = _ocr_threshold_passes(sharp, tess_whitelist)
        if len(_NAME_RE.findall(sharp_text)) > 0:
            best_text, best_score = sharp_text, sharp_score

    if len(_NAME_RE.findall(best_text)) == 0:
        tess_open = f"--psm {cfg.ocr_psm}"
        try:
            rus_text, rus_score = _ocr_threshold_passes(gray, tess_open, lang="eng+rus")
            if rus_score > best_score:
                best_text, best_score = rus_text, rus_score
        except Exception:
            if not _RUS_OCR_WARNED:
                _RUS_OCR_WARNED = True
                print(
                    "[kill-feed] Cyrillic OCR retry unavailable (install tesseract-ocr-rus)",
                    file=sys.stderr,
                    flush=True,
                )

    return best_text, best_score


def parse_kill_fingerprint(ocr_text: str) -> dict[str, Any]:
    _cleaned_for_names = re.sub(r"_-+", " ", ocr_text or "")
    names = [normalize_name(n) for n in _NAME_RE.findall(_cleaned_for_names)]
    names = [n for n in names if len(n) >= 3 and not is_garbage_ocr_name(n)]
    if not names:
        return {"killer": "", "assist": "", "victim": "", "partial": False, "raw": ocr_text or ""}
    if len(names) == 1:
        return {
            "killer": names[0],
            "assist": "",
            "victim": "",
            "partial": True,
            "raw": ocr_text,
        }
    return {
        "killer": names[0],
        "assist": names[1] if len(names) > 2 else "",
        "victim": names[-1],
        "partial": False,
        "raw": ocr_text,
    }


def is_valid_kill_fingerprint(fp: dict[str, Any]) -> bool:
    if is_partial_fingerprint(fp):
        return len(normalize_name(fp.get("killer", ""))) >= 3
    k = normalize_name(fp.get("killer", ""))
    v = normalize_name(fp.get("victim", ""))
    return len(k) >= 3 and len(v) >= 3 and k != v


def fingerprint_key(fp: dict[str, Any]) -> str:
    if is_partial_fingerprint(fp):
        k = normalize_name(fp.get("killer", ""))
        return f"partial|{k}" if k else ""
    k = normalize_name(fp.get("killer", ""))
    a = normalize_name(fp.get("assist", ""))
    v = normalize_name(fp.get("victim", ""))
    if not k and not v:
        return ""
    return f"{k}|{a}|{v}"


def partial_matches_full(partial: dict[str, Any], full: dict[str, Any], threshold: float) -> bool:
    name = normalize_name(partial.get("killer", ""))
    if len(name) < 3:
        return False
    killer = normalize_name(full.get("killer", ""))
    victim = normalize_name(full.get("victim", ""))
    if killer and fuzzy_ratio(name, killer) >= threshold:
        return True
    if victim and fuzzy_ratio(name, victim) >= threshold:
        return True
    return False


def fingerprint_match(a: dict[str, Any], b: dict[str, Any], threshold: float) -> bool:
    if is_partial_fingerprint(a) and is_full_fingerprint(b):
        return partial_matches_full(a, b, threshold)
    if is_partial_fingerprint(b) and is_full_fingerprint(a):
        return partial_matches_full(b, a, threshold)
    if is_partial_fingerprint(a) and is_partial_fingerprint(b):
        na = normalize_name(a.get("killer", ""))
        nb = normalize_name(b.get("killer", ""))
        return len(na) >= 3 and len(nb) >= 3 and fuzzy_ratio(na, nb) >= threshold

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
    fp: dict[str, Any],
    registry: list[dict[str, Any]],
    threshold: float,
    anchor: float,
    window_sec: float,
    *,
    debug: bool = False,
    stats: PipelineStats | None = None,
) -> dict[str, Any] | None:
    for entry in registry:
        entry_anchor = float(entry["anchor_s"])
        if abs(entry_anchor - anchor) > window_sec:
            if fingerprint_match(fp, entry["fingerprint"], threshold):
                if stats is not None:
                    stats.registry_dedup_window_rejected += 1
                if debug:
                    _kf_log(
                        f"registry dedup window reject: candidate={anchor:.2f}s "
                        f"matched entry@{entry_anchor:.2f}s "
                        f"(delta={abs(entry_anchor - anchor):.1f}s > {window_sec}s) "
                        f"fp={fingerprint_key(fp)!r}"
                    )
            continue
        if fingerprint_match(fp, entry["fingerprint"], threshold):
            return entry
    return None


def upsert_registry_entry(
    registry: list[dict[str, Any]],
    fp: dict[str, Any],
    anchor: float,
    confidence: float,
    threshold: float,
    stats: PipelineStats,
    forward_lag_sec: float = 0.0,
    coarse_origin_s: float | None = None,
    bar_detection_s: float | None = None,
    highlight_score: float = 0.0,
    highlight_only: bool = False,
    frame_edge: float = 0.0,
    dedup_window_sec: float = 7.0,
    debug_dedup: bool = False,
) -> dict[str, Any]:
    bar_t = round(bar_detection_s if bar_detection_s is not None else anchor, 2)
    existing = find_registry_match(
        fp,
        registry,
        threshold,
        anchor,
        dedup_window_sec,
        debug=debug_dedup,
        stats=stats,
    )
    if existing is None:
        entry = {
            "anchor_s": round(anchor, 2),
            "bar_detection_s": bar_t,
            "killer": fp.get("killer", ""),
            "assist": fp.get("assist", ""),
            "victim": fp.get("victim", ""),
            "fingerprint": fp,
            "confidence": round(confidence, 3),
            "forward_lag_sec": round(max(0.0, forward_lag_sec), 2),
            "coarse_origin_s": round(coarse_origin_s, 2) if coarse_origin_s is not None else None,
            "highlight_score": round(highlight_score, 3),
            "highlight_only": highlight_only,
            "frame_edge": round(frame_edge, 4),
        }
        registry.append(entry)
        return entry

    was_partial = is_partial_fingerprint(existing["fingerprint"])
    now_full = is_full_fingerprint(fp)
    if was_partial and now_full:
        stats.partial_upgraded_to_full += 1
        existing["fingerprint"] = fp
        existing["killer"] = fp.get("killer", "")
        existing["assist"] = fp.get("assist", "")
        existing["victim"] = fp.get("victim", "")
    prev_bar = float(existing.get("bar_detection_s") or existing["anchor_s"])
    existing["bar_detection_s"] = round(min(prev_bar, bar_t), 2)
    existing["anchor_s"] = existing["bar_detection_s"]
    existing["confidence"] = round(max(existing["confidence"], confidence), 3)
    existing["forward_lag_sec"] = round(
        max(float(existing.get("forward_lag_sec") or 0.0), forward_lag_sec), 2
    )
    if coarse_origin_s is not None:
        prev = existing.get("coarse_origin_s")
        if prev is None:
            existing["coarse_origin_s"] = round(coarse_origin_s, 2)
        else:
            existing["coarse_origin_s"] = round(min(float(prev), coarse_origin_s), 2)
    return existing


def extract_frame_ffmpeg(video_path: str, time_sec: float, ffmpeg_bin: str) -> np.ndarray | None:
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
            "-an",
            "-sn",
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


def get_frame(reader: FrameReader, time_sec: float) -> np.ndarray | None:
    if reader.coarse_frames is not None:
        key = round(time_sec, 1)
        cached = reader.coarse_frames.get(key)
        if cached is not None:
            return cached
    if reader.force_ffmpeg:
        if reader.ffmpeg_bin:
            return extract_frame_ffmpeg(reader.video_path, time_sec, reader.ffmpeg_bin)
        return None
    if reader.cap is not None and reader.cap.isOpened():
        frame = read_frame_at(reader.cap, time_sec)
        if frame is not None:
            return frame
    if reader.ffmpeg_bin:
        return extract_frame_ffmpeg(reader.video_path, time_sec, reader.ffmpeg_bin)
    return None


def preload_coarse_frame_cache(
    reader: FrameReader,
    duration: float,
    cfg: KillFeedConfig,
) -> None:
    """One ffmpeg fps pass for pass-1 when force_ffmpeg (AV1)."""
    if not reader.force_ffmpeg or not reader.ffmpeg_bin:
        return
    span = max(0.0, duration - cfg.spawn_cutoff_sec)
    if span <= 0:
        return
    fps = 1.0 / cfg.coarse_sample_sec
    tmp_dir = tempfile.mkdtemp(prefix="kf_coarse_")
    pattern = os.path.join(tmp_dir, "frame_%06d.jpg")
    cmd = [
        reader.ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        str(cfg.spawn_cutoff_sec),
        "-i",
        reader.video_path,
        "-t",
        str(span),
        "-an",
        "-sn",
        "-vf",
        f"fps={fps}",
        "-q:v",
        "2",
        pattern,
    ]
    t0 = time.monotonic()
    expected = int(span / cfg.coarse_sample_sec) + 1
    _kf_log(
        f"batch coarse extract start: fps={fps:.4f} span={span:.0f}s ~{expected} frames"
    )
    try:
        subprocess.run(
            cmd,
            check=True,
            capture_output=True,
            timeout=max(300, int(span * 0.35)),
        )
    except Exception as exc:
        _kf_log(f"batch coarse extract FAILED ({exc}) — falling back to per-frame ffmpeg")
        import shutil

        shutil.rmtree(tmp_dir, ignore_errors=True)
        return

    cache: dict[float, np.ndarray] = {}
    idx = 0
    while True:
        path = os.path.join(tmp_dir, f"frame_{idx + 1:06d}.jpg")
        if not os.path.isfile(path):
            break
        frame = cv2.imread(path)
        if frame is not None:
            t_sec = round(cfg.spawn_cutoff_sec + idx * cfg.coarse_sample_sec, 1)
            cache[t_sec] = frame
        idx += 1

    reader.coarse_frames = cache
    reader._coarse_tmp_dir = tmp_dir
    _kf_log(
        f"batch coarse extract done: {len(cache)} frames in {time.monotonic() - t0:.1f}s"
    )


def _compute_fingerprints_at_time(
    time_sec: float,
    cfg: KillFeedConfig,
    reader: FrameReader,
    stats: PipelineStats,
    debug: OcrDebugLogger,
) -> list[dict[str, Any]]:
    frame = get_frame(reader, time_sec)
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
            if is_partial_fingerprint(fp):
                stats.ocr_partial_reads += 1

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
        break  # one red-highlight bar = one kill detection per timestamp
    return results


def fingerprints_at_time(
    time_sec: float,
    cfg: KillFeedConfig,
    reader: FrameReader,
    stats: PipelineStats,
    debug: OcrDebugLogger,
    fp_cache: FingerprintCache,
) -> list[dict[str, Any]]:
    cached = fp_cache.get(time_sec)
    if cached is not None:
        stats.fingerprint_cache_hits += 1
        return cached
    results = _compute_fingerprints_at_time(time_sec, cfg, reader, stats, debug)
    fp_cache.put(time_sec, results)
    return results


def _coarse_step_at(t: float, cfg: KillFeedConfig) -> float:
    early_end = cfg.spawn_cutoff_sec + cfg.early_coarse_window_sec
    if t < early_end:
        return cfg.early_coarse_sample_sec
    return cfg.coarse_sample_sec


def coarse_scan(
    duration: float,
    cfg: KillFeedConfig,
    reader: FrameReader,
    stats: PipelineStats,
) -> list[float]:
    # spawn_cutoff_sec: skip buy/spawn period (only enforced in Python).
    hits: list[float] = []
    t = cfg.spawn_cutoff_sec
    _kf_log(
        f"pass1 coarse scan start: step={cfg.coarse_sample_sec}s "
        f"(early {cfg.early_coarse_sample_sec}s for {cfg.early_coarse_window_sec}s)"
    )
    t0 = time.monotonic()
    while t < duration:
        stats.frames_sampled_pass1 += 1
        if stats.frames_sampled_pass1 % 50 == 0 or stats.frames_sampled_pass1 == 1:
            _kf_log(
                f"pass1 progress: frame={stats.frames_sampled_pass1} "
                f"t={t:.0f}s hits={len(hits)} elapsed={time.monotonic() - t0:.0f}s"
            )
        frame = get_frame(reader, t)
        if frame is not None:
            patch = crop_roi(frame, cfg)
            if patch is not None and _has_red_highlight_in_roi(patch, cfg):
                hits.append(t)
        t += _coarse_step_at(t, cfg)
    stats.coarse_hits = len(hits)
    _kf_log(
        f"pass1 done: {stats.frames_sampled_pass1} samples, {stats.coarse_hits} red-border hits "
        f"in {time.monotonic() - t0:.1f}s"
    )
    return hits


def backward_anchor(
    coarse_t: float,
    seed_fp: dict[str, Any],
    cfg: KillFeedConfig,
    reader: FrameReader,
    stats: PipelineStats,
    debug: OcrDebugLogger,
    fp_cache: FingerprintCache,
    coarse_origin: float | None = None,
) -> tuple[float, dict[str, Any], float]:
    anchor = coarse_t
    best_conf = 0.5
    t = coarse_t
    misses = 0
    limit = max(cfg.spawn_cutoff_sec, coarse_t - cfg.fine_max_back_sec)
    if coarse_origin is not None and coarse_t > coarse_origin + cfg.fine_step_sec:
        limit = max(cfg.spawn_cutoff_sec, coarse_origin - cfg.fine_step_sec)
    lag_steps = 0
    if coarse_origin is not None and coarse_t > coarse_origin:
        lag_steps = int((coarse_t - coarse_origin) / cfg.fine_step_sec)
    miss_budget = cfg.fine_miss_budget + lag_steps
    while t >= limit:
        found = False
        for item in fingerprints_at_time(t, cfg, reader, stats, debug, fp_cache):
            if fingerprint_match(seed_fp, item["fingerprint"], cfg.fuzzy_match_threshold):
                anchor = t
                best_conf = max(best_conf, item["confidence"])
                found = True
                break
        if found:
            misses = 0
        else:
            misses += 1
            if misses > miss_budget:
                break
        t -= cfg.fine_step_sec
    return anchor, seed_fp, best_conf


def seeds_near_coarse(
    coarse_t: float,
    cfg: KillFeedConfig,
    reader: FrameReader,
    stats: PipelineStats,
    debug: OcrDebugLogger,
    fp_cache: FingerprintCache,
) -> list[dict[str, Any]]:
    """OCR seeds for a coarse hit; forward-scan only when feed lags the sample."""
    seen_keys: set[str] = set()
    items: list[dict[str, Any]] = []

    def add_from(t: float) -> list[dict[str, Any]]:
        added: list[dict[str, Any]] = []
        for item in fingerprints_at_time(t, cfg, reader, stats, debug, fp_cache):
            key = item.get("key") or fingerprint_key(item["fingerprint"])
            if not key or key in seen_keys:
                continue
            seen_keys.add(key)
            entry = {**item, "seed_time": round(t, 2)}
            items.append(entry)
            added.append(entry)
            return added  # one red-bar kill per timestamp
        return added

    coarse_items = add_from(coarse_t)
    if any(not is_partial_fingerprint(i["fingerprint"]) for i in coarse_items):
        return coarse_items

    t = coarse_t + cfg.fine_step_sec
    while t <= coarse_t + cfg.fine_forward_sec:
        if add_from(t):
            return items
        t += cfg.fine_step_sec

    t = coarse_t - cfg.fine_step_sec
    back_limit = max(cfg.spawn_cutoff_sec, coarse_t - cfg.fine_step_sec * 3)
    while t >= back_limit:
        if add_from(t):
            return items
        t -= cfg.fine_step_sec

    return items


def expand_pov_cluster_members(
    registry: list[dict[str, Any]],
    pov_cluster: dict[str, Any] | None,
    pov_rep: str,
) -> dict[str, Any] | None:
    """Add recurring killer OCR spellings from the registry to the POV cluster."""
    if not pov_rep:
        return pov_cluster
    pn = normalize_name(pov_rep)
    members = list((pov_cluster or {}).get("members", []))
    if pn and pn not in members:
        members.append(pn)
    for entry in registry:
        k = normalize_name(entry.get("killer", ""))
        if len(k) < 4 or is_garbage_ocr_name(k):
            continue
        if fuzzy_ratio(k, pn) >= 0.48 or (len(k) >= 5 and len(pn) >= 5 and k[:4] == pn[:4]):
            members.append(k)
    if not members:
        return pov_cluster
    unique = list(dict.fromkeys(members))
    return {
        "representative": pov_rep,
        "members": unique,
        "count": (pov_cluster or {}).get("count", len(unique)),
    }


def seed_pov_from_first_kill(registry: list[dict[str, Any]], cfg: KillFeedConfig) -> str | None:
    """POV reference requires >=2 independent registry entries (different anchor
    times) with fuzzy-matching killer names. A single OCR read is not trusted,
    since misreads (e.g. 'katka', 'ises') can otherwise seed the wrong identity."""
    candidates: list[tuple[float, str, str]] = []
    for entry in sorted(registry, key=lambda e: e["anchor_s"]):
        fp = entry.get("fingerprint", {})
        killer = entry.get("killer", "") or fp.get("killer", "")
        k = normalize_name(killer)
        if len(k) >= 4 and not is_garbage_ocr_name(k) and is_valid_kill_fingerprint(fp):
            candidates.append((entry["anchor_s"], killer, k))

    for i, (t_i, killer_i, k_i) in enumerate(candidates):
        confirmations = 1
        best_alt = killer_i
        for j, (t_j, killer_j, k_j) in enumerate(candidates):
            if i == j:
                continue
            if fuzzy_ratio(k_i, k_j) >= 0.72:
                confirmations += 1
                if len(killer_j) > len(best_alt):
                    best_alt = killer_j
        if confirmations >= 2:
            return best_alt
    return None


def select_pov_cluster(
    registry: list[dict[str, Any]],
    cfg: KillFeedConfig,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], float]:
    """POV player = dominant OCR name cluster (killer + victim), not YouTube metadata."""
    killers: list[str] = []
    victims: list[str] = []
    for e in registry:
        fp = e.get("fingerprint", {})
        k = normalize_name(e.get("killer") or fp.get("killer", ""))
        v = normalize_name(e.get("victim") or fp.get("victim", ""))
        if k:
            killers.append(k)
        if v:
            victims.append(v)

    k_clusters = merge_meta_clusters(
        cluster_names(killers, cfg.pov_cluster_threshold), threshold=0.48
    )
    v_clusters = cluster_names(victims, cfg.pov_cluster_threshold)
    if not k_clusters and not v_clusters:
        return None, [], 0.0

    def pov_cluster_score(kc: dict[str, Any]) -> float:
        rep = kc["representative"]
        if len(rep) < 4:
            return -1.0
        score = float(kc["count"] * 10)
        if len(rep) >= 6:
            score += 20.0
        elif len(rep) <= 4:
            score *= 0.45
        for vc in v_clusters:
            if fuzzy_ratio(rep, vc["representative"]) >= 0.62:
                score += vc["count"] * 5.0
        return score

    if k_clusters:
        best = max(k_clusters, key=pov_cluster_score)
        if pov_cluster_score(best) < 0:
            best = k_clusters[0]
        clusters = k_clusters
    else:
        best = max(v_clusters, key=lambda c: c["count"])
        clusters = v_clusters

    total = max(1, len(registry))
    coverage = best["count"] / total
    return best, clusters, coverage


def resolve_pov_rep(
    pov_cluster: dict[str, Any] | None,
    pov_player_override: str | None = None,
) -> str:
    """Canonical POV name from OCR cluster and/or explicit override.

    Key insight: OCR is deterministic about some glitches (e.g. CS2 renders
    ``s1mple`` and Tesseract reliably reads ``simple`` — the digit becomes ``i``).
    When the override and the cluster refer to the *same* player, the OCR
    spelling matches the rest of the feed reads better, so we keep the cluster
    rep. The override only wins when it clearly *disagrees* with the cluster
    (cluster picked the wrong player) or when there is no cluster at all.
    """
    cluster_rep = normalize_name(pov_cluster["representative"]) if pov_cluster else ""
    override = (
        normalize_name(pov_player_override)
        if pov_player_override and is_plausible_gamertag(pov_player_override)
        else ""
    )
    if override and cluster_rep:
        same_player = (
            fuzzy_ratio(override, cluster_rep) >= 0.55
            or override in cluster_rep
            or cluster_rep in override
        )
        return cluster_rep if same_player else override
    return override or cluster_rep


_POV_TITLE_STOP = frozenset(
    {
        "vs", "pov", "cs2", "csgo", "faceit", "premier", "rank", "rated",
        "highlights", "highlight", "stream", "twitch", "live", "full",
        "match", "demo", "clip", "clips", "gameplay", "the", "and",
    }
)


def derive_pov_hint(channel: str | None, title: str | None) -> str | None:
    """Best-effort POV gamertag from channel/title metadata.

    Channel handle is the reliable signal (POV uploads are usually on the
    player's own channel). For titles we only trust a ``<name> POV`` pattern,
    otherwise the first plausible non-stopword token. Returns ``None`` when
    nothing confident is found so the OCR cluster stays in charge.
    """
    chan = (channel or "").strip().lstrip("@")
    if is_plausible_gamertag(chan):
        return chan

    text = title or ""
    m = re.search(r"([A-Za-z0-9_\-]{3,})\s+pov\b", text, re.IGNORECASE)
    if m and is_plausible_gamertag(m.group(1)):
        return m.group(1)

    for tok in _NAME_RE.findall(text):
        if tok.lower() in _POV_TITLE_STOP:
            continue
        if is_plausible_gamertag(tok):
            return tok
    return None


def build_trusted_pov_killers(
    registry: list[dict[str, Any]],
    pov_rep: str,
    pov_cluster: dict[str, Any] | None,
) -> set[str]:
    """Killer spellings that belong to the POV player (frequency + fuzzy)."""
    pn = normalize_name(pov_rep)
    trusted: set[str] = set()
    if pn:
        trusted.add(pn)
    if pov_cluster:
        for member in pov_cluster.get("members", []):
            mn = normalize_name(member)
            if len(mn) >= 3 and not is_garbage_ocr_name(mn):
                trusted.add(mn)

    killer_counts: dict[str, int] = {}
    for entry in registry:
        k = normalize_name(entry.get("killer", ""))
        if len(k) >= 4 and not is_garbage_ocr_name(k):
            killer_counts[k] = killer_counts.get(k, 0) + 1

    for k, count in killer_counts.items():
        if fuzzy_ratio(k, pn) >= 0.58:
            trusted.add(k)
        elif count >= 2 and fuzzy_ratio(k, pn) >= 0.46:
            trusted.add(k)
        elif len(k) >= 5 and len(pn) >= 5 and k[:4] == pn[:4]:
            trusted.add(k)
    return trusted


def is_likely_pov_ocr_spelling(name: str, pov_rep: str) -> bool:
    """Heuristic: OCR reads of ``simple`` often contain simp/mple/impl fragments."""
    k = normalize_name(name).lower()
    pn = normalize_name(pov_rep).lower()
    if len(k) < 4 or is_garbage_ocr_name(name):
        return False
    if fuzzy_ratio(k, pn) >= 0.58:
        return True
    if len(k) >= 5 and len(pn) >= 5 and k[:4] == pn[:4]:
        return True
    if any(tag in k for tag in (
        "simp", "mpl", "impl", "lmpl", "mple", "aimpt", "imple", "eimp", "impt", "sinp", "clmp"
    )):
        return fuzzy_ratio(k, pn) >= 0.40
    return False


def raw_has_pov_killer_fragment(
    raw: str,
    pov_rep: str,
    pov_cluster: dict[str, Any] | None,
    cfg: KillFeedConfig,
) -> bool:
    """Detect POV killer spelling buried in noisy OCR (e.g. aimpte within a garbled line)."""
    for name in _NAME_RE.findall(raw or ""):
        if partial_killer_matches_pov(name, pov_rep, pov_cluster, cfg):
            return True
    compact = re.sub(r"[^A-Za-z0-9]", "", raw or "").lower()
    pn = normalize_name(pov_rep).lower()
    if len(pn) >= 5 and pn[:4] in compact and fuzzy_ratio(compact, pn) >= 0.42:
        return True
    return False


def classify_registry_relaxed(
    entry: dict[str, Any],
    pov_rep: str,
    pov_cluster: dict[str, Any] | None,
    all_clusters: list[dict[str, Any]],
    cfg: KillFeedConfig,
    trusted_killers: set[str],
) -> tuple[str, str]:
    """Second pass: full OCR lines with plausible POV killer spelling."""
    fp = entry.get("fingerprint", {})
    if is_partial_fingerprint(fp):
        return "skip", "partial"

    killer = entry.get("killer", "") or fp.get("killer", "")
    victim = entry.get("victim", "") or fp.get("victim", "")
    vk = normalize_name(victim)
    kk = normalize_name(killer)

    if len(kk) < 4 or len(vk) < 3 or kk == vk or is_garbage_ocr_name(killer):
        return "skip", "invalid"
    if victim and name_matches_pov(victim, pov_rep, pov_cluster, cfg):
        return "skip", "death"
    if killer_is_foreign(killer, pov_cluster, all_clusters, cfg):
        return "skip", "foreign"
    if killer_is_trusted_pov(killer, trusted_killers, pov_rep, pov_cluster, cfg):
        return "kill", "pov_relaxed_match"
    if fuzzy_ratio(kk, normalize_name(pov_rep)) >= 0.50:
        return "kill", "pov_relaxed_match"
    return "skip", "not_pov"


def killer_is_trusted_pov(
    killer: str,
    trusted: set[str],
    pov_rep: str,
    pov_cluster: dict[str, Any] | None,
    cfg: KillFeedConfig,
) -> bool:
    k = normalize_name(killer)
    if k in trusted:
        return True
    return name_matches_pov(killer, pov_rep, pov_cluster, cfg)


def partial_killer_matches_pov(
    killer: str,
    pov_rep: str,
    pov_cluster: dict[str, Any] | None,
    cfg: KillFeedConfig,
) -> bool:
    """POV gate for partial OCR reads (single name only)."""
    k = normalize_name(killer)
    if len(k) < 4 or is_garbage_ocr_name(k):
        return False
    if is_likely_pov_ocr_spelling(killer, pov_rep):
        return True
    if not name_matches_pov(killer, pov_rep, pov_cluster, cfg):
        return False
    pn = normalize_name(pov_rep)
    return fuzzy_ratio(k, pn) >= 0.52


def _victim_is_weak_ocr(victim: str) -> bool:
    v = normalize_name(victim)
    return not v or len(v) <= 4 or is_garbage_ocr_name(victim)


def classify_registry_entry(
    entry: dict[str, Any],
    pov_rep: str,
    pov_cluster: dict[str, Any] | None,
    all_clusters: list[dict[str, Any]],
    cfg: KillFeedConfig,
    trusted_killers: set[str] | None = None,
) -> tuple[str, str]:
    """Red-border line + POV name in OCR → kill. Highlight event → kill when POV known."""
    if not pov_rep:
        return "skip", "no_pov"

    fp = entry.get("fingerprint", {})
    trusted = trusted_killers or set()
    if entry.get("highlight_only") or fp.get("highlight_only"):
        hs = float(entry.get("highlight_score") or fp.get("highlight_score") or 0)
        killer = entry.get("killer", "") or fp.get("killer", "")
        raw = fp.get("raw", "")
        if killer and killer_is_trusted_pov(killer, trusted, pov_rep, pov_cluster, cfg):
            return "kill", "highlight_anchor"
        if killer and partial_killer_matches_pov(killer, pov_rep, pov_cluster, cfg):
            return "kill", "highlight_anchor"
        for name in entry_names(entry, fp):
            if partial_killer_matches_pov(name, pov_rep, pov_cluster, cfg):
                return "kill", "highlight_anchor"
        if raw_has_pov_killer_fragment(raw, pov_rep, pov_cluster, cfg):
            return "kill", "highlight_anchor"
        if killer and killer_is_foreign(killer, pov_cluster, all_clusters, cfg):
            return "skip", "highlight_foreign"
        return "skip", "highlight_not_pov"

    killer = entry.get("killer", "") or fp.get("killer", "")
    victim = entry.get("victim", "") or fp.get("victim", "")
    assist = entry.get("assist", "") or fp.get("assist", "")

    trusted = trusted_killers or set()

    if victim and name_matches_pov(victim, pov_rep, pov_cluster, cfg):
        if killer and killer_is_trusted_pov(killer, trusted, pov_rep, pov_cluster, cfg):
            pass  # OCR swapped killer/victim on a POV frag
        else:
            return "death", "pov_death"

    if killer and killer_is_trusted_pov(killer, trusted, pov_rep, pov_cluster, cfg):
        if is_partial_fingerprint(fp):
            if not partial_killer_matches_pov(killer, pov_rep, pov_cluster, cfg):
                return "skip", "partial_weak_pov"
        elif is_garbage_ocr_name(killer):
            return "skip", "garbage_killer"
        elif is_full_fingerprint(fp):
            k_strict = name_matches_pov(killer, pov_rep, pov_cluster, cfg)
            k_likely = is_likely_pov_ocr_spelling(killer, pov_rep)
            if k_likely and not k_strict and _victim_is_weak_ocr(victim):
                return "skip", "weak_ocr_line"
        reason = "pov_partial_killer" if is_partial_fingerprint(fp) else "pov_killer_match"
        return "kill", reason

    if assist and name_matches_pov(assist, pov_rep, pov_cluster, cfg):
        if killer and killer_is_foreign(killer, pov_cluster, all_clusters, cfg):
            return "kill", "pov_assist_swap"
        return "skip", "assist_only"

    if is_partial_fingerprint(fp):
        for name in entry_names(entry, fp):
            if partial_killer_matches_pov(name, pov_rep, pov_cluster, cfg):
                return "kill", "pov_partial_any"
        if raw_has_pov_killer_fragment(fp.get("raw", ""), pov_rep, pov_cluster, cfg):
            return "kill", "pov_raw_fragment"
        # Red border + single enemy name = OCR read victim only (common CS2 misread).
        names = entry_names(entry, fp)
        if len(names) == 1 and len(names[0]) >= 4:
            only = names[0]
            if not name_matches_pov(only, pov_rep, pov_cluster, cfg):
                if killer_is_foreign(only, pov_cluster, all_clusters, cfg):
                    return "skip", "partial_foreign_skip"
        return "skip", "partial_not_pov"

    if killer and killer_is_foreign(killer, pov_cluster, all_clusters, cfg):
        if entry_has_pov_name(entry, fp, pov_rep, pov_cluster, cfg):
            return "kill", "pov_foreign_killer_ocr"
        return "skip", "foreign_killer"

    if killer and not name_matches_pov(killer, pov_rep, pov_cluster, cfg):
        if entry_has_pov_name(entry, fp, pov_rep, pov_cluster, cfg):
            return "kill", "pov_name_in_line"
        if is_partial_fingerprint(fp) and raw_has_pov_killer_fragment(
            fp.get("raw", ""), pov_rep, pov_cluster, cfg
        ):
            return "kill", "pov_raw_fragment"
        return "skip", "not_pov"

    for name in entry_names(entry, fp):
        if name_matches_pov(name, pov_rep, pov_cluster, cfg):
            return "kill", "pov_name_in_line"

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


def scan_killstreak_cards(
    reader: FrameReader,
    cfg: KillFeedConfig,
    stats: PipelineStats,
    duration: float,
) -> list[float]:
    """Detect POV kills via the CS2 killstreak card (bottom-center HUD element,
    cyan-colored, shows a rising kill count). Independent of kill-feed OCR —
    confirmed via a nearby red kill-feed bar (presence only, no name match)."""
    NORM_W, NORM_H = 1280, 720

    def cyan_count(frame: np.ndarray) -> int:
        if frame.shape[:2] != (NORM_H, NORM_W):
            frame = cv2.resize(frame, (NORM_W, NORM_H), interpolation=cv2.INTER_AREA)
        x0 = int(NORM_W * cfg.card_roi_x0)
        x1 = int(NORM_W * cfg.card_roi_x1)
        y0 = int(NORM_H * cfg.card_roi_y0)
        y1 = int(NORM_H * cfg.card_roi_y1)
        crop = frame[y0:y1, x0:x1]
        b = crop[:, :, 0].astype(int)
        g = crop[:, :, 1].astype(int)
        r = crop[:, :, 2].astype(int)
        mask = (g > 110) & (b > 100) & (g > r + 20) & (b > r + 8)
        return int(mask.sum())

    def has_nearby_bar(t_center: float, window: float, step: float = 0.5) -> bool:
        tt = t_center - window
        while tt <= t_center + window:
            frame = get_frame(reader, tt)
            if frame is not None:
                patch = crop_roi(frame, cfg)
                if patch is not None and detect_highlight_bar(patch, cfg):
                    return True
            tt += step
        return False

    hits: list[tuple[float, int]] = []
    t = cfg.spawn_cutoff_sec
    while t < duration:
        frame = get_frame(reader, t)
        if frame is not None:
            n = cyan_count(frame)
            if n >= cfg.card_cyan_threshold:
                hits.append((round(t, 2), n))
        t += 0.5

    events: list[list[tuple[float, int]]] = []
    for ht, hn in hits:
        if events and ht - events[-1][-1][0] < cfg.card_event_gap_sec:
            events[-1].append((ht, hn))
        else:
            events.append([(ht, hn)])

    confirmed: list[float] = []
    for ev in events:
        ev_t = ev[0][0]
        if has_nearby_bar(ev_t, cfg.card_confirm_window_sec):
            confirmed.append(ev_t)

    stats.killstreak_card_events = len(events)
    stats.killstreak_card_confirmed = len(confirmed)
    _kf_log(
        f"killstreak card scan: {len(events)} events, {len(confirmed)} confirmed"
    )
    return confirmed


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

    if not configure_tesseract():
        _kf_log(
            "WARNING: Tesseract OCR not found — OCR pass will return empty "
            "(set TESSERACT_CMD or install tesseract-ocr)"
        )

    stats = PipelineStats()
    debug = OcrDebugLogger(cfg.debug_ocr, cfg.debug_dir)
    fp_cache = FingerprintCache()
    duration = float(duration or 0)

    if duration <= cfg.spawn_cutoff_sec:
        return _empty_result(video_path, cfg, stats)

    reader = open_frame_reader(video_path, ffmpeg_bin, cfg.spawn_cutoff_sec)
    seen_before_dedup: set[str] = set()

    try:
        preload_coarse_frame_cache(reader, duration, cfg)
        registry: list[dict[str, Any]] = []

        events = highlight_event_scan(duration, cfg, reader, stats, debug)
        _kf_log(
            f"highlight OCR pass: {len(events)} events "
            f"(transition_skip={stats.highlight_transition_skipped})"
        )
        feed_tracker = FeedPersistTracker(cfg)
        for ev_i, ev in enumerate(events, start=1):
            if ev_i == 1 or ev_i % 15 == 0 or ev_i == len(events):
                _kf_log(
                    f"OCR progress: {ev_i}/{len(events)} t={ev['t_bar']:.1f}s "
                    f"ocr_calls={stats.ocr_calls} registry={len(registry)}"
                )
            t_bar = float(ev["t_bar"])
            crop = ev["crop"]
            stats.ocr_calls += 1
            raw, _ocr_score = ocr_kill_bar(crop, cfg)
            best_raw, best_score = raw, _ocr_score
            if len(_NAME_RE.findall(best_raw)) == 0:
                for extra_delay in (0.5, 1.0, 1.5):
                    t_try = t_bar + extra_delay
                    frame_try = get_frame(reader, t_try)
                    if frame_try is None:
                        continue
                    patch_try = crop_roi(frame_try, cfg)
                    if patch_try is None:
                        continue
                    bars_try = detect_highlight_bar(patch_try, cfg)
                    if not bars_try:
                        break
                    y0t, y1t = bars_try[0]["rect"]
                    band_try = patch_try[y0t:y1t, :]
                    text_try, score_try = ocr_kill_bar(band_try, cfg)
                    stats.ocr_calls += 1
                    if len(_NAME_RE.findall(text_try)) > len(_NAME_RE.findall(best_raw)):
                        best_raw, best_score = text_try, score_try
                        if len(_NAME_RE.findall(best_raw)) >= 2:
                            break
            raw, _ocr_score = best_raw, best_score
            if len((raw or "").strip()) > 2:
                stats.ocr_nonempty += 1

            fp = parse_kill_fingerprint(raw)
            valid = is_valid_kill_fingerprint(fp)
            y0, y1 = ev.get("rect", (0, 0))
            dup, dup_reason = feed_tracker.is_duplicate(t_bar, fp, y0, y1)
            if dup:
                stats.feed_persist_skipped += 1
                debug.log(
                    t_bar,
                    crop,
                    raw,
                    fp,
                    True,
                    "rejected",
                    f"feed_persist:{dup_reason}",
                )
                continue
            feed_tracker.record(t_bar, fp, y0, y1)

            highlight_only = not valid
            if valid:
                stats.ocr_parsed_as_kill_entry += 1
                if is_partial_fingerprint(fp):
                    stats.ocr_partial_reads += 1
                key = fingerprint_key(fp)
                seen_before_dedup.add(key)
            else:
                fp = {
                    "killer": "",
                    "assist": "",
                    "victim": "",
                    "partial": True,
                    "highlight_only": True,
                    "highlight_score": ev["highlight_score"],
                    "frame_edge": ev.get("frame_edge", 0.0),
                    "raw": raw or "",
                }
                key = f"hl|{t_bar:.1f}"
                seen_before_dedup.add(key)

            conf = round(
                min(0.99, 0.5 + float(ev["highlight_score"]) * 0.35),
                3,
            )
            debug.log(
                t_bar,
                crop,
                raw,
                fp,
                True,
                "accepted" if valid else "highlight_event",
                "ok" if valid else "highlight_only",
            )
            upsert_registry_entry(
                registry,
                fp,
                t_bar,
                conf,
                cfg.fuzzy_match_threshold,
                stats,
                bar_detection_s=t_bar,
                highlight_score=float(ev["highlight_score"]),
                highlight_only=highlight_only,
                frame_edge=float(ev.get("frame_edge", 0.0)),
                dedup_window_sec=cfg.dedup_time_window_sec,
                debug_dedup=cfg.debug_ocr,
            )

        stats.unique_fingerprints_before_dedup = len(seen_before_dedup)
        stats.unique_fingerprints_after_dedup = len(registry)

        pov_cluster, all_clusters, coverage = select_pov_cluster(registry, cfg)
        _kf_log(f"POV cluster members: {pov_cluster.get('members', []) if pov_cluster else 'NONE'}")
        seeded_pov = seed_pov_from_first_kill(registry, cfg)
        if pov_player_override:
            pov_rep = resolve_pov_rep(pov_cluster, pov_player_override)
        elif seeded_pov:
            pov_rep = seeded_pov
            _kf_log(
                f"POV seeded from first kill: '{seeded_pov}' "
                f"(cluster would have been: {pov_cluster.get('representative') if pov_cluster else 'NONE'})"
            )
        else:
            pov_rep = resolve_pov_rep(pov_cluster, pov_player_override)
            _kf_log(f"POV seed unavailable, falling back to cluster: '{pov_rep}'")
        pov_cluster = expand_pov_cluster_members(registry, pov_cluster, pov_rep)
        trusted_killers = build_trusted_pov_killers(registry, pov_rep, pov_cluster)
        if pov_player_override:
            cluster_rep_dbg = (
                normalize_name(pov_cluster["representative"]) if pov_cluster else "?"
            )
            _kf_log(
                f"POV override hint='{pov_player_override}' cluster_rep='{cluster_rep_dbg}' "
                f"-> using='{pov_rep}'"
            )
        stats.pov_cluster_coverage = round(coverage, 3) if pov_cluster else 0.0
        partial_mode = bool(pov_rep) and (
            not pov_cluster or coverage < cfg.pov_coverage_min
        )
        stats.pov_fallback_mode = partial_mode

        _kf_log(
            f"POV player={pov_rep or '?'} coverage={stats.pov_cluster_coverage:.2f} "
            f"cluster_members={len(pov_cluster.get('members', [])) if pov_cluster else 0} "
            f"partial_mode={'yes' if partial_mode else 'no'}"
        )

        kills: list[dict[str, Any]] = []
        skip_reasons: dict[str, int] = {}
        for entry in sorted(registry, key=lambda e: e["anchor_s"]):
            kind, reason = classify_registry_entry(
                entry,
                pov_rep,
                pov_cluster,
                all_clusters,
                cfg,
                trusted_killers,
            )
            if kind == "death":
                stats.pov_deaths_excluded += 1
                continue
            if kind != "kill":
                skip_reasons[reason] = skip_reasons.get(reason, 0) + 1
                continue
            kills.append(
                {
                    "anchor_s": kill_output_anchor(entry, cfg),
                    "killer": entry["killer"],
                    "assist": entry.get("assist", ""),
                    "victim": entry["victim"],
                    "confidence": entry["confidence"],
                    "pov_reason": reason,
                }
            )

        kills = collapse_kill_events(kills, cfg.kill_dedupe_gap_sec, pov_rep or "")
        kills = dedupe_output_kills(kills, cfg.output_dedupe_gap_sec, pov_rep or "")

        if pov_rep:
            card_times = scan_killstreak_cards(reader, cfg, stats, duration)
            existing_anchors = [k["anchor_s"] for k in kills]
            added = 0
            for ct in card_times:
                if all(abs(ct - a) > cfg.card_dedupe_vs_existing_sec for a in existing_anchors):
                    kills.append(
                        {
                            "anchor_s": ct,
                            "killer": pov_rep,
                            "assist": "",
                            "victim": "",
                            "confidence": 0.8,
                            "pov_reason": "killstreak_card",
                        }
                    )
                    existing_anchors.append(ct)
                    added += 1
            if added:
                kills.sort(key=lambda k: k["anchor_s"])
                _kf_log(f"killstreak card: added {added} kills not covered by name-OCR")

        stats.kills_found = len(kills)
        skipped = len(registry) - len(kills) - stats.pov_deaths_excluded
        _kf_log(
            f"POV filter: {len(kills)} kills, {stats.pov_deaths_excluded} deaths, "
            f"{skipped} foreign/skip"
        )
        if skip_reasons:
            _kf_log(f"POV skip reasons: {skip_reasons}")
        anchors = [k["anchor_s"] for k in kills]
        clips = merge_clips(anchors, cfg, duration)
        stats.clips_produced = len(clips)

        _kf_log(
            f"pipeline done: kills={stats.kills_found} clips={stats.clips_produced} "
            f"ocr={stats.ocr_calls} parsed={stats.ocr_parsed_as_kill_entry} "
            f"fp={stats.unique_fingerprints_after_dedup}/{stats.unique_fingerprints_before_dedup}"
            + (
                f" dedup_window_rejected={stats.registry_dedup_window_rejected}"
                if cfg.debug_ocr
                else ""
            )
        )

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
        reader.close()


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
    """Convert kill entries to legacy event format.
    
    Note: Only marks as red_highlight if the kill was confirmed via red-border detection.
    Most kills are detected through OCR text matching, not necessarily red border.
    """
    events: list[dict[str, Any]] = []
    for k in kills:
        anchor = k["anchor_s"]
        pov_reason = k.get("pov_reason", "")
        
        # Determine if this was a red-border kill vs text-only detection
        # red_highlight should only be True for kills confirmed via red border visual
        is_red_highlight = pov_reason in ("pov_killer_match", "pov_partial_killer")
        
        events.append(
            {
                "time": anchor,
                "raw_time": anchor,
                "kill_anchor_time": anchor,
                "confidence": k.get("confidence", 0.8),
                "roi": "top_right",
                "player_kill": True,
                "red_highlight": is_red_highlight,  # Only true for visual red border kills
                "killer": k.get("killer", ""),
                "assist": k.get("assist", ""),
                "victim": k.get("victim", ""),
                "highlight_score": k.get("confidence", 0.8),
                "highlight_color": "red" if is_red_highlight else "white",
                "method": "two-pass-ocr",
                "pov_player": pov_player,
                "pov_reason": pov_reason,
            }
        )
    return events
