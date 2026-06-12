# Cursor Prompt: CS2 Kill-Feed Detection & Clip Extraction (Two-Pass System)

Copy everything below into Cursor:

---

## Context

This project (Videclip) processes **pre-recorded videos** (YouTube downloads via yt-dlp, or local files). There is NO access to game state (no GSI, no .dem files) — the only source of truth is the pixels in the video frames. We already have a Python-based CS2 kill-feed detection using OpenCV/OCR. Clips are cut with FFmpeg.

First, inspect the existing kill-feed detection code and decide yourself whether to refactor it or build a new module alongside it. Explain your decision briefly before implementing.

## Goal

Build a robust, compute-efficient pipeline that:
1. Finds all kills made by the POV player in a CS2 gameplay video
2. Anchors each clip on the **actual kill moment**, not the detection moment
3. Merges multi-kills into a single clip
4. Outputs precise cut timestamps for FFmpeg

## Domain knowledge (important — base the design on this)

- The CS2 kill feed appears in the top-right of the screen. Each entry persists for ~6 seconds by default (`hud_deathnotice_time 6`), but creators can change this — do NOT hardcode logic that breaks if entries persist longer.
- Kills involving the POV/spectated player have a **red border** around the entry. This is the signal for "this kill belongs to the player we're clipping."
- Entries stack: each kill starts its own timer. Old entries scroll out individually while new ones appear.
- YouTube footage is compressed and creators may slightly alter HUD colors/scale. Color matching for the red border must use HSV ranges with tolerance, not exact RGB values.

## Architecture: Two-Pass Detection

### Pass 1 — Coarse Scan (find candidate regions)
- Sample the video every **3.0 seconds** (configurable, default 3.0). With ~6s feed persistence, no kill can be missed.
- For each sampled frame: crop the kill-feed ROI (top-right region, configurable as relative coordinates, default roughly x: 55–100%, y: 0–30% of frame), then detect red-bordered entries (HSV mask + contour/edge detection on horizontal bar shapes).
- Output: list of timestamps where at least one red-bordered entry is visible.

### Pass 2 — Fine Backward Scan (find the kill anchor)
- For each coarse hit at time T: step **backwards** in 0.5s increments (configurable) and re-detect.
- For each detected entry, extract an **entry fingerprint** via OCR: killer name + assist name (if present) + victim name. Use this fingerprint for identity, not just "a red box exists."
- The **kill anchor** for an entry = the earliest timestamp at which that fingerprint first appears. Stop stepping back once the fingerprint is no longer found (the frame before it appeared).
- Deduplicate: the same fingerprint seen across multiple samples is ONE kill. Maintain a registry of fingerprints with their anchor timestamps. Use fuzzy string matching (e.g. Levenshtein ratio ≥ 0.85) for OCR noise tolerance — the same entry must not produce two kills because OCR read "DoTox_" once and "DoT0x_" another time.

### Multi-Kill Merging
- After all anchors are collected, sort by timestamp.
- Merge kills into one clip if the gap between consecutive anchors is ≤ **MERGE_GAP** seconds (configurable, default 5.0).
- Merged clip boundaries: `start = first_anchor - LEAD`, `end = last_anchor + TAIL`.
- Defaults: LEAD = 4.0s (the action/peek happens before the kill), TAIL = 2.0s. Both configurable.
- Clamp boundaries to video duration. If two merged clips still overlap after applying lead/tail, merge them too.

## Output contract

The detection module must return a JSON-serializable structure:

```json
{
  "video": "path/or/id",
  "pov_player": "DoTox_",
  "kills": [
    {"anchor_s": 123.5, "killer": "DoTox_", "assist": "donk666", "victim": "CEMEN_BAKIN", "confidence": 0.92}
  ],
  "clips": [
    {"start_s": 119.5, "end_s": 131.0, "kill_count": 2, "kill_anchors": [123.5, 126.8]}
  ]
}
```

FFmpeg cutting consumes `clips[]`. Keep detection and cutting decoupled.

## POV player identification
- Infer the POV player automatically: the name that appears as killer in red-bordered entries most frequently across the video. Expose it in the output and allow a manual override parameter.

## Efficiency requirements (hard constraints)
- Never OCR every frame. OCR only runs in Pass 2 and only on the cropped ROI, never the full frame.
- Use FFmpeg or OpenCV `VideoCapture.set(CAP_PROP_POS_MSEC)` seeking for sampling — do not decode the whole video sequentially in Pass 1.
- Pass 1 should use cheap color/shape detection only (no OCR).
- Log per-video stats: frames sampled, OCR calls made, kills found, clips produced — so we can verify cost stays low.

## Robustness requirements
- HSV red detection must handle both red hue ranges (0–10 and 170–180).
- Handle videos with no kills (empty clips list, no crash).
- Handle entries partially scrolled out / overlapping the ROI edge.
- Make ALL tunables (sample intervals, ROI, HSV ranges, LEAD, TAIL, MERGE_GAP, fuzzy threshold) a single config dataclass with the defaults above.

## Testing
- Add a small test harness that runs the pipeline on a local video path and prints the JSON output plus the per-video stats.
- Include unit tests for: fingerprint deduplication (fuzzy matching), multi-kill merging logic (gap edge cases: exactly at MERGE_GAP, overlapping lead/tail), and boundary clamping.

Do not invent additional features beyond this spec. If something in the existing codebase conflicts with this design, flag it and ask before changing behavior elsewhere.
