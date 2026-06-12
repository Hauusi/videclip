import { clampTrimTimes, MAX_MAIN_SEC, MIN_MAIN_SEC } from './trimLimits';
import { clampHookOffsetInClip } from './coldOpenTiming';

/** Best known absolute hook peak from analyze metadata. */
export function resolveHookPeakTime(highlight) {
  const peak = Number(highlight?.hook_peak_time);
  if (Number.isFinite(peak) && peak > 0) return peak;

  const zoom = highlight?.zoom_moments?.[0];
  if (Number.isFinite(Number(zoom)) && Number(zoom) > 0) return Number(zoom);

  const start = Number(highlight?.start_time) || 0;
  const end = Number(highlight?.end_time) || start + 32;
  return start + Math.max(8, end - start) * 0.68;
}

export function isHookPeakInsideTrim(peak, start, end) {
  const p = Number(peak);
  const s = Number(start);
  const e = Number(end);
  if (!Number.isFinite(p) || !Number.isFinite(s) || !Number.isFinite(e)) return false;
  return p >= s - 0.2 && p <= e + 0.2;
}

/**
 * Build a trim window anchored on the hook peak (better clip than arbitrary trim).
 */
export function buildTrimAroundHook(highlight, sourceDuration = 0) {
  const peak = resolveHookPeakTime(highlight);
  const origStart = Number(highlight?.start_time) || 0;
  const origEnd = Number(highlight?.end_time) || origStart + 32;
  const targetDur = Math.max(
    MIN_MAIN_SEC,
    Math.min(MAX_MAIN_SEC, Math.max(origEnd - origStart, 24)),
  );

  const offset = clampHookOffsetInClip(targetDur, targetDur * 0.72);
  let start = peak - offset;
  let end = start + targetDur;

  let trimmed = clampTrimTimes(start, end, sourceDuration);

  if (!isHookPeakInsideTrim(peak, trimmed.start, trimmed.end)) {
    end = Math.min(sourceDuration > 0 ? sourceDuration : peak + 8, peak + 4);
    start = peak - (targetDur - 4);
    trimmed = clampTrimTimes(start, end, sourceDuration);
    if (!isHookPeakInsideTrim(peak, trimmed.start, trimmed.end)) {
      start = Math.max(0, peak - MIN_MAIN_SEC);
      end = start + targetDur;
      trimmed = clampTrimTimes(start, end, sourceDuration);
    }
  }

  const mainDur = trimmed.duration;
  const hookOffset = clampHookOffsetInClip(mainDur, peak - trimmed.start);

  return {
    start: trimmed.start,
    end: trimmed.end,
    duration: mainDur,
    peak,
    hook_offset_in_clip: hookOffset,
    hook_peak_time: trimmed.start + hookOffset,
  };
}
