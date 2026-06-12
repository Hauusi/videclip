# Cursor Prompt: Fix Kill-Feed OCR Quality & POV Detection

Copy everything below into Cursor:

---

## Context

Last run on a ~49min CS2 YouTube VOD: `pass1=976, ocr=689, kills=2, pov=ene`. Two things are clearly broken:

1. **OCR output is garbage most of the time.** 689 OCR calls produced only 2 valid kill fingerprints. "ene" is not a player name — it is an OCR fragment of a longer name. The kill feed font is small, stylized, and YouTube-compressed; raw OCR on the crop is failing.
2. **POV inference counts raw OCR strings.** The "most frequent killer" logic counts exact strings, so one real player produces dozens of different fragments ("ene", "en3", "ane", ...) that never aggregate. The winner is whichever fragment happens to repeat.

Do NOT remove the killer-name filter entirely (a red border also appears when the POV player DIES — clipping all red entries would produce death clips). Fix the root causes instead, in this order:

## Step 1 — Debug instrumentation FIRST (do this before changing any logic)

Add a debug mode (env var or config flag) that, during Pass 2, saves to a debug directory:
- The cropped kill-feed ROI image for every OCR call (PNG, filename = video timestamp)
- A JSONL log per OCR call: timestamp, raw OCR text, parsed killer/assist/victim, red-border-detected yes/no, accepted/rejected and rejection reason

Also extend the end-of-run stats with: `ocr_calls`, `ocr_nonempty`, `ocr_parsed_as_kill_entry`, `unique_fingerprints_before_dedup`, `unique_fingerprints_after_dedup`. We need to see WHERE the funnel collapses (689 → 2).

## Step 2 — OCR preprocessing (the likely main fix)

Before passing the ROI crop to OCR, apply a preprocessing chain:
- Upscale the crop 3–4x (INTER_CUBIC or INTER_LANCZOS4) — kill feed text at 720p is far too small for reliable OCR
- Convert to grayscale, then threshold: the feed text is bright (white/yellow/blue names) on a dark semi-transparent bar. Use the dark bar as the segmentation anchor: detect the dark horizontal bar regions first, then OCR each bar individually instead of the whole ROI at once
- Try both binary and inverted binary thresholds; keep the result with higher OCR confidence
- If using Tesseract: set PSM 7 (single text line) per bar, and restrict the character whitelist to alphanumerics plus `_-. ` (CS2 nicknames)

Per-bar OCR also fixes entry separation: one bar = one kill entry = one fingerprint.

## Step 3 — Name normalization & fuzzy clustering for POV detection

- Normalize all OCR'd names: lowercase, strip non-alphanumeric except `_-`, collapse whitespace
- Cluster killer names from red-bordered entries using fuzzy matching (Levenshtein ratio ≥ 0.75 joins a cluster; representative = longest/most frequent member)
- POV player = the dominant cluster across all red-bordered entries, NOT the most frequent raw string
- Keep the existing rule of never using channel/title-derived names as POV; title tokens may only be used as a tie-breaker hint between clusters
- A kill entry counts as a POV kill if its killer name fuzzy-matches the POV cluster (ratio ≥ 0.75). Entries where the POV cluster matches the VICTIM position are POV deaths — exclude them from kill clips (but log them)

## Step 4 — Confidence fallback

If after clustering the dominant cluster covers < 40% of red-bordered entries (low confidence that we found the real POV name), fall back to: accept ALL red-bordered entries as highlights EXCEPT those where the dominant cluster (even weakly) matches the victim position. Log clearly that fallback mode was used.

## Step 5 — Validate

Re-run on the same VOD. Expected outcome: tens of kills (the video is a full POV gameplay VOD), a plausible POV gamertag, and a sane funnel in the new stats. If `ocr_parsed_as_kill_entry` is still low relative to `ocr_calls`, inspect the saved debug crops and iterate on Step 2 — do not tweak the clustering thresholds first.

Do not change the clip cutting, merging, transcription, or rendering stages — they work. Only touch detection.
