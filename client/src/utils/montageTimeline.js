/** Output-timeline layout for montage jump-cut segments (concatenated, not VOD positions). */

export function montageKillSegments(segments = []) {
  return segments.filter((s) => s.segment_type !== 'payoff');
}

export function sumSegmentDuration(segments = []) {
  return montageKillSegments(segments).reduce((s, seg) => s + (Number(seg.duration) || 0), 0);
}

export function buildOutputLayout(segments = []) {
  const kills = montageKillSegments(segments);
  let cursor = 0;
  return kills.map((seg, index) => {
    const duration = Math.max(0.5, Number(seg.duration) || 1);
    const row = {
      index,
      seg,
      outStart: cursor,
      outEnd: cursor + duration,
      duration,
      sourceStart: Number(seg.start) || 0,
      peakTime: Number(seg.peak_time ?? seg.raw_time ?? seg.start) || 0,
    };
    cursor += duration;
    return row;
  });
}

export function outputTimeToSegmentIndex(layout, t) {
  if (!layout.length) return -1;
  for (let i = 0; i < layout.length; i++) {
    const isLast = i === layout.length - 1;
    if (t >= layout[i].outStart && (isLast ? t <= layout[i].outEnd : t < layout[i].outEnd)) {
      return i;
    }
  }
  return -1;
}

function roundSec(n) {
  return Math.round(n * 10) / 10;
}

function cloneSegments(segments) {
  return segments.map((s) => ({ ...s }));
}

function trimOverlaps(segments, { minDur = 1.15, gapSec = 0.15 } = {}) {
  const next = cloneSegments(segments);
  for (let i = 0; i < next.length - 1; i++) {
    if (next[i].segment_type === 'payoff' || next[i + 1].segment_type === 'payoff') continue;
    const maxEnd = next[i + 1].start - gapSec;
    const maxDur = maxEnd - next[i].start;
    if (maxDur < next[i].duration) {
      next[i].duration = Math.max(minDur, roundSec(maxDur));
    }
  }
  return next.filter((s) => s.segment_type === 'payoff' || (s.duration ?? 0) >= minDur);
}

export function segmentIndexForKill(segments = [], killIndex = 0) {
  let ki = -1;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].segment_type === 'payoff') continue;
    ki++;
    if (ki === killIndex) return i;
  }
  return -1;
}

function maxDurationForSegment(seg, nextKill, { sourceDuration = 0, gapSec = 0.15, maxPostRoll = 20 } = {}) {
  if (nextKill) {
    return Math.max(1.15, nextKill.start - seg.start - gapSec);
  }
  if (sourceDuration > 0) {
    return Math.max(1.15, sourceDuration - seg.start);
  }
  return Math.max(1.15, seg.duration + maxPostRoll);
}

/** Drag right edge — extend or shorten post-roll (source out-point moves). */
export function resizeSegmentEnd(
  segments,
  killIndex,
  newDuration,
  { sourceDuration = 0, gapSec = 0.15, minDur = 1.15, maxPostRoll = 20 } = {},
) {
  const index = segmentIndexForKill(segments, killIndex);
  if (index < 0) return cloneSegments(segments);

  const next = cloneSegments(segments);
  const seg = next[index];
  if (!seg || seg.segment_type === 'payoff') return cloneSegments(segments);

  const nextKill = next.slice(index + 1).find((s) => s.segment_type !== 'payoff');
  const maxDur = maxDurationForSegment(seg, nextKill, { sourceDuration, gapSec, maxPostRoll });
  const duration = Math.max(minDur, Math.min(maxDur, newDuration));
  if (Math.abs(duration - seg.duration) < 0.03) return cloneSegments(segments);

  next[index] = { ...seg, duration: roundSec(duration) };
  return trimOverlaps(next, { minDur, gapSec });
}

/** Drag left edge — extend/shorten pre-roll (source in-point moves, out-point fixed). */
export function resizeSegmentStart(
  segments,
  killIndex,
  deltaStart,
  { minDur = 1.15, minBeforePeak = 0.3, maxPreRoll = 20, sourceDuration = 0 } = {},
) {
  const index = segmentIndexForKill(segments, killIndex);
  if (index < 0) return cloneSegments(segments);

  const next = cloneSegments(segments);
  const seg = next[index];
  if (!seg || seg.segment_type === 'payoff') return cloneSegments(segments);

  const peak = Number(seg.peak_time ?? seg.raw_time ?? seg.start) || 0;
  const sourceEnd = seg.start + seg.duration;
  const earliestStart = Math.max(0, peak - maxPreRoll);
  const latestStart = Math.max(earliestStart, peak - minBeforePeak);

  let newStart = seg.start + deltaStart;
  newStart = Math.max(earliestStart, Math.min(latestStart, newStart));
  if (sourceDuration > 0) {
    newStart = Math.min(newStart, Math.max(0, sourceDuration - minDur));
  }

  const newDur = sourceEnd - newStart;
  if (newDur < minDur) return cloneSegments(segments);
  if (Math.abs(newStart - seg.start) < 0.03) return cloneSegments(segments);

  next[index] = {
    ...seg,
    start: roundSec(newStart),
    duration: roundSec(newDur),
  };
  return trimOverlaps(next, { minDur });
}
