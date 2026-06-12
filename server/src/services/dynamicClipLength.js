/** Dynamic clip windows: tight tail after peak, enough setup before. */

const DEFAULTS = {
  minSec: 12,
  maxSec: 45,
  maxPrePeakSec: 18,
  postPeakSec: 3,
  tailScoreFloor: 4,
  tailGapBreakSec: 2.5,
};

/**
 * End time: peak + reaction, extend while tail segments score well.
 * @param {Array<{ start: number, end: number, score: number }>} timeline
 */
export function computeDynamicEnd(timeline, peakTime, start, videoDuration, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const peak = Number(peakTime) || 0;
  const videoEnd = Math.max(start + opts.minSec, Number(videoDuration) || opts.minSec);

  let end = Math.min(videoEnd, peak + opts.postPeakSec);

  const afterPeak = (timeline || [])
    .filter((item) => item.end > peak - 0.3 && item.start < videoEnd)
    .sort((a, b) => a.start - b.start);

  for (const item of afterPeak) {
    if (item.start > end + opts.tailGapBreakSec) break;
    if (item.score >= opts.tailScoreFloor) {
      end = Math.min(videoEnd, Math.max(end, item.end + 0.4));
    }
  }

  const peakItems = afterPeak.filter((i) => i.start >= peak - 0.25);
  if (peakItems.length) {
    const peakEnd = Math.max(...peakItems.map((i) => i.end));
    end = Math.min(videoEnd, Math.max(end, peakEnd + 0.35));
  }

  end = Math.min(videoEnd, Math.max(end, start + opts.minSec));
  if (end - start > opts.maxSec) {
    end = start + opts.maxSec;
  }

  return end;
}

/**
 * Clip window anchored on peak — shorter than fixed 28s when tail is weak.
 */
export function computeDynamicWindow(timeline, peakTime, videoDuration, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const peak = Number(peakTime) || 0;
  const videoEnd = Math.max(opts.minSec, Number(videoDuration) || opts.minSec);

  let start = Math.max(0, peak - opts.maxPrePeakSec);
  let end = computeDynamicEnd(timeline, peak, start, videoEnd, opts);

  if (end - start < opts.minSec) {
    start = Math.max(0, end - opts.minSec);
    end = computeDynamicEnd(timeline, peak, start, videoEnd, opts);
  }

  if (start > peak - 2) {
    start = Math.max(0, peak - 6);
    end = computeDynamicEnd(timeline, peak, start, videoEnd, opts);
  }

  if (end - start > opts.maxSec) {
    end = start + opts.maxSec;
  }

  start = Math.round(start * 10) / 10;
  end = Math.round(end * 10) / 10;

  return { start, end, durationSec: Math.round((end - start) * 10) / 10 };
}

export function logDynamicWindow(peakTime, window, label = 'dynamic-length') {
  console.log(
    `[${label}] peak@${Number(peakTime).toFixed(1)}s → ` +
      `${window.start.toFixed(1)}–${window.end.toFixed(1)}s (${window.durationSec.toFixed(1)}s)`,
  );
}
