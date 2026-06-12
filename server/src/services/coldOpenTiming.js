/** Minimum seconds before the cold-open payoff replays in the main clip. */
export const MIN_COLD_OPEN_PEAK_SEC = 10;

/** Minimum fraction through the clip before the payoff (builds setup/tension). */
export const MIN_COLD_OPEN_PEAK_RATIO = 0.38;

export function getMinColdOpenPeakOffset(durationSec) {
  const duration = Math.max(8, Number(durationSec) || 8);
  return Math.max(MIN_COLD_OPEN_PEAK_SEC, duration * MIN_COLD_OPEN_PEAK_RATIO);
}

export function clampColdOpenPeakTime(start, end, peak) {
  const s = Number(start) || 0;
  const e = Number(end) || s + 30;
  const p = Number(peak);
  if (!Number.isFinite(p)) return s + (e - s) * 0.72;
  const minOff = getMinColdOpenPeakOffset(e - s);
  return Math.max(s + minOff, Math.min(e - 0.5, p));
}

export function isPeakLateEnoughForColdOpen(start, end, peak) {
  const s = Number(start) || 0;
  const e = Number(end) || s + 30;
  const p = Number(peak);
  if (!Number.isFinite(p) || p < s || p > e) return false;
  return p - s >= getMinColdOpenPeakOffset(e - s);
}

/** Seconds from main-clip start until the teaser payoff replays (for logging/UI). */
export function coldOpenReplayDelaySec(highlight) {
  const start = Number(highlight.start_time) || 0;
  const end = Number(highlight.end_time) || start + 30;
  const peak = Number(highlight.hook_peak_time);
  if (!Number.isFinite(peak)) return null;
  return Math.max(0, peak - start);
}
