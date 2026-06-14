"""
CS2 kill-feed detection: two-pass pipeline (coarse color scan → fine OCR anchor).
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


@dataclass
class KillFeedConfig:
    """All tunables — defaults from product spec."""

    roi_x: float = 0.825
    roi_y: float = 0.03
    roi_w: float = 0.175
    roi_h: float = 0.15

    coarse_sample_sec: float = 3.0
    # Spawn/warmup filter — owned here only (Node killDetect.js must not duplicate).
    spawn_cutoff_sec: float = 32.0

    fine_step_sec: float = 0.5
    fine_max_back_sec: float = 12.0
    fine_miss_budget: int = 2

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
    pov_cluster_threshold: float = 0.62
    pov_match_threshold: float = 0.62
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
    n = (name or "").lower()
    return re.sub(r"[^a-z0-9_\-\u0430-\u044f\u0451]", "", n)


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


def name_matches_pov(
    name: str,
    pov_rep: str,
    pov_cluster: dict[str, Any] | None,
    cfg: KillFeedConfig,
) -> bool:
    """Name ≈ POV player from OCR cluster (fuzzy, aliases, shared stem)."""
    k = normalize_name(name)
    if len(k) < 3 or not pov_rep:
        return False
    threshold = cfg.pov_match_threshold
    if name_matches_cluster(name, pov_rep, threshold):
        return True
    pn = normalize_name(pov_rep)
    for stem_len in (7, 6, 5):
        if len(pn) >= stem_len:
            stem = pn[-stem_len:]
            if stem in k or k in pn:
                return True
    if len(k) >= 3 and pn.endswith(k):
        return True
    if pov_cluster:
        for member in pov_cluster.get("members", []):
            if fuzzy_ratio(k, member) >= max(0.58, threshold - 0.05):
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
        if oc["count"] < 3:
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


def _ocr_score_text(text: str, data: dict[str, Any]) -> float:
    text = " ".join((text or "").split())
    confs = [int(c) for c in data.get("conf", []) if str(c).isdigit() and int(c) >= 0]
    avg_conf = sum(confs) / len(confs) if confs else 0.0
    names = _NAME_RE.findall(text)
    return len(names) * 12.0 + avg_conf + min(len(text), 40) * 0.15


def _ocr_threshold_passes(gray: np.ndarray, tess_cfg: str, lang: str | None = None) -> tuple[str, float]:
    import pytesseract
    from pytesseract import Output

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
    tess_whitelist = (
        f"--psm {cfg.ocr_psm} "
        "-c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-. "
    )
    best_text, best_score = _ocr_threshold_passes(gray, tess_whitelist)

    if len(_NAME_RE.findall(best_text)) < 2:
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
    names = [normalize_name(n) for n in _NAME_RE.findall(ocr_text or "")]
    names = [n for n in names if len(n) >= 3]
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
    fp: dict[str, Any], registry: list[dict[str, Any]], threshold: float
) -> dict[str, Any] | None:
    for entry in registry:
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
) -> dict[str, Any]:
    existing = find_registry_match(fp, registry, threshold)
    if existing is None:
        entry = {
            "anchor_s": round(anchor, 2),
            "killer": fp.get("killer", ""),
            "assist": fp.get("assist", ""),
            "victim": fp.get("victim", ""),
            "fingerprint": fp,
            "confidence": round(confidence, 3),
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
    existing["anchor_s"] = round(min(existing["anchor_s"], anchor), 2)
    existing["confidence"] = round(max(existing["confidence"], confidence), 3)
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


def coarse_scan(
    duration: float,
    cfg: KillFeedConfig,
    reader: FrameReader,
    stats: PipelineStats,
) -> list[float]:
    # spawn_cutoff_sec: skip buy/spawn period (only enforced in Python).
    hits: list[float] = []
    t = cfg.spawn_cutoff_sec
    expected = max(1, int((duration - t) / cfg.coarse_sample_sec))
    _kf_log(f"pass1 coarse scan start: ~{expected} samples (step={cfg.coarse_sample_sec}s)")
    t0 = time.monotonic()
    while t < duration:
        stats.frames_sampled_pass1 += 1
        if stats.frames_sampled_pass1 % 50 == 0 or stats.frames_sampled_pass1 == 1:
            _kf_log(
                f"pass1 progress: frame={stats.frames_sampled_pass1}/{expected} "
                f"t={t:.0f}s hits={len(hits)} elapsed={time.monotonic() - t0:.0f}s"
            )
        frame = get_frame(reader, t)
        if frame is not None:
            patch = crop_roi(frame, cfg)
            if patch is not None and detect_red_bordered_entries(patch, cfg):
                hits.append(t)
        t += cfg.coarse_sample_sec
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
) -> tuple[float, dict[str, Any], float]:
    anchor = coarse_t
    best_conf = 0.5
    t = coarse_t
    misses = 0
    limit = max(cfg.spawn_cutoff_sec, coarse_t - cfg.fine_max_back_sec)
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
            if misses > cfg.fine_miss_budget:
                break
        t -= cfg.fine_step_sec
    return anchor, seed_fp, best_conf


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

    k_clusters = cluster_names(killers, cfg.pov_cluster_threshold)
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
    """Canonical POV name from OCR cluster or explicit override only."""
    if pov_player_override and is_plausible_gamertag(pov_player_override):
        return normalize_name(pov_player_override)
    if pov_cluster:
        return normalize_name(pov_cluster["representative"])
    return ""


def classify_registry_entry(
    entry: dict[str, Any],
    pov_rep: str,
    pov_cluster: dict[str, Any] | None,
    all_clusters: list[dict[str, Any]],
    cfg: KillFeedConfig,
) -> tuple[str, str]:
    """Red-border line + POV name in OCR → kill. Foreign killer cluster → skip."""
    if not pov_rep:
        return "skip", "no_pov"

    fp = entry.get("fingerprint", {})
    killer = entry.get("killer", "") or fp.get("killer", "")
    victim = entry.get("victim", "") or fp.get("victim", "")
    assist = entry.get("assist", "") or fp.get("assist", "")

    if victim and name_matches_pov(victim, pov_rep, pov_cluster, cfg):
        return "death", "pov_death"

    if killer and name_matches_pov(killer, pov_rep, pov_cluster, cfg):
        reason = "pov_partial_killer" if is_partial_fingerprint(fp) else "pov_killer_match"
        return "kill", reason

    if assist and name_matches_pov(assist, pov_rep, pov_cluster, cfg):
        return "kill", "pov_assist_swap"

    if is_partial_fingerprint(fp):
        for name in entry_names(entry, fp):
            if name_matches_pov(name, pov_rep, pov_cluster, cfg):
                return "kill", "pov_partial_any"
        return "skip", "partial_not_pov"

    if killer and killer_is_foreign(killer, pov_cluster, all_clusters, cfg):
        return "skip", "foreign_killer"

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
    fp_cache = FingerprintCache()
    duration = float(duration or 0)

    if duration <= cfg.spawn_cutoff_sec:
        return _empty_result(video_path, cfg, stats)

    reader = open_frame_reader(video_path, ffmpeg_bin, cfg.spawn_cutoff_sec)
    seen_before_dedup: set[str] = set()

    try:
        preload_coarse_frame_cache(reader, duration, cfg)
        coarse = coarse_scan(duration, cfg, reader, stats)
        registry: list[dict[str, Any]] = []

        _kf_log(f"pass2 fine OCR: {len(coarse)} coarse seeds")
        for seed_i, coarse_t in enumerate(coarse, start=1):
            if seed_i == 1 or seed_i % 10 == 0 or seed_i == len(coarse):
                _kf_log(
                    f"pass2 progress: seed {seed_i}/{len(coarse)} t={coarse_t:.1f}s "
                    f"ocr_calls={stats.ocr_calls} registry={len(registry)}"
                )
            seed_items = fingerprints_at_time(
                coarse_t, cfg, reader, stats, debug, fp_cache
            )
            for item in seed_items:
                seen_before_dedup.add(item["key"])
                if find_registry_match(item["fingerprint"], registry, cfg.fuzzy_match_threshold):
                    continue
                anchor, fp, conf = backward_anchor(
                    coarse_t,
                    item["fingerprint"],
                    cfg,
                    reader,
                    stats,
                    debug,
                    fp_cache,
                )
                seen_before_dedup.add(fingerprint_key(fp))
                if find_registry_match(fp, registry, cfg.fuzzy_match_threshold):
                    upsert_registry_entry(
                        registry, fp, anchor, conf, cfg.fuzzy_match_threshold, stats
                    )
                    continue
                upsert_registry_entry(
                    registry, fp, anchor, conf, cfg.fuzzy_match_threshold, stats
                )

        stats.unique_fingerprints_before_dedup = len(seen_before_dedup)
        stats.unique_fingerprints_after_dedup = len(registry)

        pov_cluster, all_clusters, coverage = select_pov_cluster(registry, cfg)
        pov_rep = resolve_pov_rep(pov_cluster, pov_player_override)
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
            )
            if kind == "death":
                stats.pov_deaths_excluded += 1
                continue
            if kind != "kill":
                skip_reasons[reason] = skip_reasons.get(reason, 0) + 1
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
