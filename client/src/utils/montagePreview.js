import {
  buildOutputLayout,
  montageKillSegments,
  outputTimeToSegmentIndex,
  sumSegmentDuration,
} from './montageTimeline';

/** Map output-timeline position → source VOD time for jump-cut montage. */
export function sourceTimeFromOutput(segments, outputT) {
  const layout = buildOutputLayout(segments);
  if (!layout.length) return 0;
  const idx = outputTimeToSegmentIndex(layout, outputT);
  const safeIdx = idx >= 0 ? idx : 0;
  const row = layout[safeIdx];
  const offset = Math.max(0, Math.min(row.duration, outputT - row.outStart));
  return row.seg.start + offset;
}

/** Map source VOD time → output montage timeline position (prefers active kill when ranges overlap). */
export function outputTimeFromSource(segments, sourceT, activeKillIndex = -1) {
  const layout = buildOutputLayout(segments);
  const kills = montageKillSegments(segments);
  if (!kills.length) return 0;

  const inRange = (i) => {
    const s = kills[i];
    const end = s.start + s.duration;
    return sourceT >= s.start - 0.02 && sourceT < end - 0.01;
  };

  if (activeKillIndex >= 0 && activeKillIndex < kills.length && inRange(activeKillIndex)) {
    const s = kills[activeKillIndex];
    return layout[activeKillIndex].outStart + (sourceT - s.start);
  }

  for (let i = kills.length - 1; i >= 0; i--) {
    if (inRange(i)) {
      return layout[i].outStart + (sourceT - kills[i].start);
    }
  }

  if (layout.length) {
    const last = layout[layout.length - 1];
    const lastEnd = last.seg.start + last.seg.duration;
    if (sourceT >= lastEnd - 0.05) return last.outEnd;
  }
  return 0;
}

export function montageTotalSec(segments, fallback = 0) {
  const sum = sumSegmentDuration(segments);
  return sum > 0.5 ? sum : fallback;
}

function sourceInKillRange(seg, st) {
  const srcEnd = seg.start + seg.duration;
  return st >= seg.start - 0.02 && st < srcEnd - 0.04;
}

/**
 * Keep playback inside montage segment windows; jump to next kill or stop at montage end.
 * activeIndexRef tracks which kill is playing — required when source ranges overlap.
 * Returns current output timeline position.
 */
export function advanceMontagePlayback(video, segments, activeIndexRef) {
  const kills = montageKillSegments(segments);
  const layout = buildOutputLayout(segments);
  const total = sumSegmentDuration(segments);
  if (!video || !kills.length) return 0;

  const st = video.currentTime;
  let active = Math.max(0, Math.min(kills.length - 1, activeIndexRef?.current ?? 0));

  const seekVideo = (t) => {
    try {
      video.currentTime = t;
    } catch {
      /* ignore */
    }
  };

  const setActive = (i) => {
    active = i;
    if (activeIndexRef) activeIndexRef.current = i;
  };

  if (st < kills[0].start - 0.05) {
    setActive(0);
    seekVideo(kills[0].start);
    return 0;
  }

  const activeSeg = kills[active];
  const activeEnd = activeSeg.start + activeSeg.duration;

  if (st >= activeEnd - 0.04) {
    if (active + 1 < kills.length) {
      setActive(active + 1);
      seekVideo(kills[active].start);
      return layout[active].outStart;
    }
    try {
      video.pause();
      seekVideo(Math.max(activeSeg.start, activeEnd - 0.03));
    } catch {
      /* ignore */
    }
    return total;
  }

  if (!sourceInKillRange(activeSeg, st)) {
    let resolved = -1;
    for (let i = active; i < kills.length; i++) {
      if (sourceInKillRange(kills[i], st)) {
        resolved = i;
        break;
      }
    }
    if (resolved < 0) {
      for (let i = active - 1; i >= 0; i--) {
        if (sourceInKillRange(kills[i], st)) {
          resolved = i;
          break;
        }
      }
    }
    if (resolved >= 0) setActive(resolved);
  }

  setActive(active);
  return layout[active].outStart + (st - kills[active].start);
}
