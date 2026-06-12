import { refineHighlightWindow } from './highlightCandidates.js';
import { resolveIntelligentHook } from './intelligentHook.js';
import { shouldUseColdOpen } from './hookClip.js';

/** Clips below this get local trim + render boost (no filtering). */
export const WEAK_CONFIDENCE_THRESHOLD = 75;

function trimLeadingDeadAir(segments, start, end) {
  let firstSpeech = null;

  for (const seg of segments || []) {
    const t = Number(seg.offset ?? seg.start ?? 0);
    if (t < start || t > end) continue;
    const text = String(seg.text || '').trim();
    if (text.length >= 3) {
      firstSpeech = t;
      break;
    }
  }

  if (firstSpeech == null) return start;
  const trimmed = Math.max(start, firstSpeech - 0.6);
  return trimmed > start + 1.2 ? trimmed : start;
}

function mergeZoomMoments(highlight, peakTime) {
  const start = Number(highlight.start_time) || 0;
  const end = Number(highlight.end_time) || start + 28;
  const moments = new Set((highlight.zoom_moments || []).map(Number).filter(Number.isFinite));

  if (Number.isFinite(peakTime)) moments.add(peakTime);
  moments.add(start + Math.min(2.5, (end - start) * 0.12));

  return [...moments].filter((z) => z >= start && z <= end).sort((a, b) => a - b);
}

/**
 * Locally upgrade a sub-75% clip: tighter trim, better hook, extra zoom pulses.
 */
export function boostWeakHighlight(highlight, segments, videoDuration) {
  if (highlight.montage_segments?.length >= 2 || highlight.montage_type === 'shooter_multikill') {
    return highlight;
  }

  const confidence = Number(highlight.confidence);
  if (!Number.isFinite(confidence) || confidence >= WEAK_CONFIDENCE_THRESHOLD) {
    return highlight;
  }

  let boosted = { ...highlight, clip_boosted: true };
  const refined = refineHighlightWindow(segments, highlight, videoDuration);
  const veryWeak = confidence < 62;

  if (refined) {
    const shouldApplyTrim =
      refined.improved || veryWeak || refined.afterScore >= refined.beforeScore - 1;

    if (shouldApplyTrim) {
      boosted.start_time = refined.start;
      boosted.end_time = refined.end;
      boosted.hook_peak_time = refined.hook_peak;
      boosted.boost_trim = refined.improved;
    }

    const trimmedStart = trimLeadingDeadAir(segments, boosted.start_time, boosted.end_time);
    if (trimmedStart > boosted.start_time) {
      boosted.start_time = trimmedStart;
      boosted.boost_dead_air = true;
    }
  }

  if (segments?.length) {
    const intel = resolveIntelligentHook(segments, boosted);
    boosted = {
      ...boosted,
      ...intel,
      clip_boosted: true,
    };
    boosted.cold_open = shouldUseColdOpen(boosted);
  }

  boosted.zoom_moments = mergeZoomMoments(boosted, boosted.hook_peak_time);

  if (!boosted.cold_open && boosted.hook && confidence < 68) {
    boosted.show_hook_suggest = true;
  }

  const scoreGain = refined ? Math.max(0, refined.afterScore - refined.beforeScore) : 0;
  boosted.confidence = Math.min(
    84,
    Math.max(confidence, confidence + Math.round(scoreGain * 1.5) + (boosted.boost_trim ? 4 : 0)),
  );
  boosted.viral_score = Math.min(10, Math.max(Number(boosted.viral_score) || 7, 7));

  console.log(
    `[clip-boost] ${highlight.id || highlight.title}: ${confidence}%→${boosted.confidence}% ` +
      `trim=${Boolean(boosted.boost_trim)} dead_air=${Boolean(boosted.boost_dead_air)} ` +
      `cold_open=${Boolean(boosted.cold_open)} window=${boosted.start_time?.toFixed(1)}–${boosted.end_time?.toFixed(1)}s`,
  );

  return boosted;
}

export function boostWeakHighlights(highlights, segments, videoDuration) {
  return highlights.map((h) => boostWeakHighlight(h, segments, videoDuration));
}

export function getClipBoostRenderOptions(highlight) {
  if (!highlight?.clip_boosted) return {};
  return {
    clipBoosted: true,
    showHook:
      Boolean(highlight.cold_open && highlight.hook) || Boolean(highlight.show_hook_suggest),
  };
}
