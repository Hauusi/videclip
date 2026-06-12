/** Must match server/src/services/coldOpenTiming.js */
export const MIN_COLD_OPEN_PEAK_SEC = 10;
export const MIN_COLD_OPEN_PEAK_RATIO = 0.38;

export function minColdOpenPeakOffset(durationSec) {
  const duration = Math.max(8, Number(durationSec) || 8);
  return Math.max(MIN_COLD_OPEN_PEAK_SEC, duration * MIN_COLD_OPEN_PEAK_RATIO);
}

export function clampHookOffsetInClip(mainDurationSec, offsetSec) {
  const main = Math.max(8, Number(mainDurationSec) || 8);
  const minOff = minColdOpenPeakOffset(main);
  const off = Number(offsetSec);
  if (!Number.isFinite(off)) return minOff;
  return Math.max(minOff, Math.min(main - 0.5, off));
}
