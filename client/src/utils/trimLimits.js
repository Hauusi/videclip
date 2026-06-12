/** Must match server clipExport.js limits. */
export const MIN_MAIN_SEC = 8;
export const MAX_MAIN_SEC = 60;

/** HTML5 media fragment — browser timeline starts at 0 for the clip segment. */
export function buildMediaFragmentSrc(url, startSec, endSec) {
  if (!url) return null;
  const base = url.split('#')[0];
  const start = Math.max(0, Number(startSec) || 0);
  const end = Math.max(start + 0.5, Number(endSec) || start + 1);
  return `${base}#t=${start.toFixed(2)},${end.toFixed(2)}`;
}

export function clampTrimTimes(start, end, sourceDuration = 0) {
  let s = Math.max(0, Number(start) || 0);
  let e = Math.max(s + MIN_MAIN_SEC, Number(end) || s + 28);
  if (sourceDuration > 0) {
    e = Math.min(sourceDuration, e);
    s = Math.min(s, Math.max(0, e - MIN_MAIN_SEC));
  }
  if (e - s > MAX_MAIN_SEC) e = s + MAX_MAIN_SEC;
  if (e - s < MIN_MAIN_SEC) e = s + MIN_MAIN_SEC;
  return { start: s, end: e, duration: e - s };
}

/** Drag trim handle; anchor = which handle moves, the other stays fixed until min/max forces it. */
export function dragTrimTimes({
  anchor,
  start,
  end,
  raw,
  min,
  max,
  sourceDuration = 0,
  minClipSec = MIN_MAIN_SEC,
  maxMainSec = MAX_MAIN_SEC,
}) {
  if (anchor === 'start') {
    let s = Math.max(min, Math.min(Number(raw), max - minClipSec));
    let e = end;
    if (e - s > maxMainSec) s = e - maxMainSec;
    if (e - s < minClipSec) e = Math.min(max, s + minClipSec);
    return clampTrimTimes(s, e, sourceDuration);
  }
  let e = Math.min(max, Math.max(Number(raw), min + minClipSec));
  let s = start;
  if (e - s > maxMainSec) e = s + maxMainSec;
  if (e - s < minClipSec) s = Math.max(min, e - minClipSec);
  return clampTrimTimes(s, e, sourceDuration);
}

export function isVideoMediaUrl(url) {
  return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(String(url || ''));
}
