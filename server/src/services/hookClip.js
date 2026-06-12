import { scoreLine } from './highlightCandidates.js';
import { analyzeClipHook, resolveIntelligentHook } from './intelligentHook.js';
import { finalizeMontageHighlight, isMontageHighlight, sumMontageDuration } from './montageClip.js';
import {
  clampColdOpenPeakTime,
  isPeakLateEnoughForColdOpen,
  getMinColdOpenPeakOffset,
} from './coldOpenTiming.js';

const DEFAULT_TEASER_SEC = 2.2;

function segStart(seg) {
  return Number(seg.offset ?? seg.start ?? 0);
}

/** @deprecated Use resolveIntelligentHook — kept for highlightQuality fallback */
export function findHookPeakTime(segments, startTime, endTime, hookText = '') {
  const analyzed = analyzeClipHook(segments, startTime, endTime);
  if (hookText) {
    const hookWords = String(hookText)
      .toLowerCase()
      .replace(/[^\wäöüß\s]/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3);
    if (hookWords.length) {
      const start = Number(startTime);
      const end = Number(endTime);
      for (const seg of segments || []) {
        const t = segStart(seg);
        if (t < start || t > end) continue;
        const text = String(seg.text || '').toLowerCase();
        let matches = 0;
        for (const word of hookWords) {
          if (text.includes(word)) matches += 1;
        }
        if (matches >= Math.min(2, hookWords.length)) return t;
      }
    }
  }
  return analyzed.teaser_peak_time;
}

export function findHookPeakTimeForClip(segments, startTime, endTime, hookText = '') {
  return findHookPeakTime(segments, startTime, endTime, hookText);
}

/** Hook only when the user explicitly enabled cold-open (never auto during export/preview). */
export function shouldUseColdOpen(highlight) {
  if (highlight.user_cold_open !== true) return false;

  const start = Number(highlight.start_time);
  const end = Number(highlight.end_time);
  const peak = Number(highlight.hook_peak_time);
  const duration = end - start;

  return (
    Number.isFinite(peak) &&
    peak >= start &&
    peak <= end &&
    duration >= 8 &&
    (Number(highlight.hook_teaser_duration) || DEFAULT_TEASER_SEC) >= 0.5 &&
    isPeakLateEnoughForColdOpen(start, end, peak)
  );
}

export function isHookPeakInsideTrim(highlight, start, end) {
  const peak = Number(highlight.hook_peak_time);
  const s = Number(start);
  const e = Number(end);
  if (!Number.isFinite(peak) || !Number.isFinite(s) || !Number.isFinite(e)) return false;
  return peak >= s && peak <= e;
}

export function getHookTeaserRequested(highlight) {
  const requested = Number(highlight.hook_teaser_duration);
  if (Number.isFinite(requested) && requested > 0) {
    return requested;
  }
  return DEFAULT_TEASER_SEC;
}

/** User-facing / render target — always the requested slider value, never stale probe data. */
export function getHookTeaserDuration(highlight) {
  return getHookTeaserRequested(highlight);
}

/** Last probed teaser length from FFmpeg (for UI feedback only). */
export function getHookTeaserMeasured(highlight) {
  const measured = Number(highlight.hook_teaser_measured_sec);
  const requested = getHookTeaserRequested(highlight);
  if (Number.isFinite(measured) && measured >= 0.3) {
    return measured;
  }
  return requested;
}

/** Total clip duration (teaser + main) preferring ffprobe on the rendered file. */
export function getClipDuration(highlight) {
  if (isMontageHighlight(highlight)) {
    const measured = Number(highlight.clip_duration_measured);
    if (Number.isFinite(measured) && measured > 0.5) return measured;
    if (Number(highlight.output_duration) > 0.5) return Number(highlight.output_duration);
    return sumMontageDuration(highlight.montage_segments);
  }

  const start = parseFloat(highlight.start_time) || 0;
  const end = parseFloat(highlight.end_time) || start + 30;
  const mainDuration = Math.max(1, end - start);
  const teaserSec = highlight.cold_open ? getHookTeaserDuration(highlight) : 0;

  if (!highlight.cold_open) {
    const measured = Number(highlight.clip_duration_measured);
    if (
      Number.isFinite(measured) &&
      measured > 0.5 &&
      Math.abs(measured - mainDuration) <= 0.35
    ) {
      return measured;
    }
    return mainDuration;
  }

  const measured = Number(highlight.clip_duration_measured);
  if (Number.isFinite(measured) && measured > 0.5) {
    return measured;
  }
  return mainDuration + teaserSec;
}

/** Hook teaser window — must stay aligned with ffmpeg resolveHookTeaserWindow. */
export function resolveHookCaptionWindow(highlight) {
  const start = parseFloat(highlight.start_time) || 0;
  const end = parseFloat(highlight.end_time) || start + 30;
  const mainDuration = Math.max(1, end - start);
  const measured = Number(highlight.hook_teaser_measured_sec);
  const teaserSec =
    Number.isFinite(measured) && measured >= 0.5 ? measured : getHookTeaserRequested(highlight);

  const offsetInClip = Number(highlight.hook_offset_in_clip);
  const peakAbs = Number(highlight.hook_peak_time);
  let peakRaw;
  if (Number.isFinite(offsetInClip) && offsetInClip > 0) {
    peakRaw = offsetInClip;
  } else if (Number.isFinite(peakAbs)) {
    peakRaw = peakAbs - start;
  } else {
    peakRaw = mainDuration * 0.72;
  }

  const minPeak = getMinColdOpenPeakOffset(mainDuration);
  const peakInClip = Math.max(minPeak, Math.min(mainDuration - 0.35, peakRaw));

  let teaserStartInClip;
  const tailAnchorStart = mainDuration - teaserSec - 0.2;
  if (peakInClip >= tailAnchorStart) {
    teaserStartInClip = Math.max(0, mainDuration - teaserSec);
  } else {
    const te = Math.min(mainDuration, peakInClip + 0.15);
    teaserStartInClip = Math.max(0, te - teaserSec);
    if (te - teaserStartInClip < teaserSec - 0.05) {
      teaserStartInClip = Math.max(0, mainDuration - teaserSec);
    }
  }

  const clampedPeak = clampColdOpenPeakTime(start, end, peakAbs);

  return { teaserSec, teaserStartInClip, mainDuration, hookPeakTime: clampedPeak, peakInClip };
}

/** Params for main-only STT + cold-open caption timeline mapping. */
export function getColdOpenCaptionParams(highlight) {
  if (!shouldUseColdOpen(highlight)) return null;
  return resolveHookCaptionWindow(highlight);
}

/**
 * Intelligent hook: best scene in teaser + cliffhanger text overlay (local, no tokens).
 */
export function enrichHighlightsWithHook(highlights, segments) {
  return highlights.map((h) => {
    if (isMontageHighlight(h)) {
      return finalizeMontageHighlight({
        ...h,
        cold_open: false,
        user_cold_open: false,
        hook: h.hook || h.excerpt || h.title || '',
      });
    }

    if (!segments?.length) {
      return {
        ...h,
        hook: h.hook || 'Wait for this…',
        hook_teaser_duration: getHookTeaserDuration(h),
        cold_open: shouldUseColdOpen(h),
      };
    }

    const intel = resolveIntelligentHook(segments, h);
    const analyzed = analyzeClipHook(segments, h.start_time, h.end_time);

    const enriched = {
      ...h,
      ...intel,
      _hook_teaser_score: analyzed.teaser_score,
      hook_teaser_duration: intel.hook_teaser_duration || getHookTeaserDuration(h),
    };

    enriched.cold_open = shouldUseColdOpen(enriched);

    if (enriched.cold_open) {
      const replayIn = (enriched.hook_peak_time - h.start_time).toFixed(1);
      console.log(
        `[intelligent-hook] ${h.id || h.title}: teaser@${enriched.hook_peak_time?.toFixed(1)}s ` +
          `(main replay +${replayIn}s) ` +
          `"${(enriched.hook_teaser_line || '').slice(0, 50)}" → cliff "${(enriched.hook || '').slice(0, 50)}"`,
      );
    }

    return enriched;
  });
}

/** Zoom pulse times for a clip that starts with a cold-open teaser. */
export function clipZoomMomentsWithHook(highlight, teaserSec) {
  const start = Number(highlight.start_time);
  const teaser = Number(teaserSec) || 0;
  const moments = [];

  if (teaser > 0) {
    moments.push(Math.min(0.8, teaser * 0.5));
  }

  for (const z of highlight.zoom_moments || []) {
    const rel = Number(z) - start;
    if (!Number.isFinite(rel)) continue;
    moments.push(rel + teaser);
  }

  return moments.filter((z) => z >= 0);
}
