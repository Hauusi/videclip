
/**
 * Shooter jump-cut montages use a different duration model than linear clips:
 * - source_span_*  = where kills live in the original VOD
 * - output_duration = sum(montage_segments[].duration) = actual rendered clip length
 */

export function isMontageHighlight(highlight) {
  return (
    highlight?.montage_type === 'shooter_multikill' ||
    (highlight?.montage_segments?.length >= 1 && highlight?.clip_type === 'shooter_multikill')
  );
}

export function sumMontageDuration(segments) {
  if (!segments?.length) return 0;
  return (
    Math.round(
      segments.reduce((sum, seg) => sum + (Number(seg.duration) || 0), 0) * 10,
    ) / 10
  );
}

/**
 * One HUD engagement = one kill. Frame-diff fires many times per frag (4:18, 4:21, 4:27…)
 * — collapse to a single timestamp before building montages.
 */
export const HUD_ENGAGEMENT_GAP_SEC = 4.5;
/** Min seconds between distinct kills in one montage. */
export const MIN_KILL_PEAK_GAP_SEC = 3.5;
export const MAX_MONTAGE_KILL_SEGMENTS = 4;
export const SHOOTER_CLIP_COUNT = 99;
export const KILLS_PER_CLIP_TARGET = 5;
/** Max gap between consecutive kills in one burst montage (real multikill round). */
export const MONTAGE_BURST_MAX_GAP_SEC = 22;
export const MONTAGE_BURST_MAX_SPAN_SEC = 55;
/** Max gap between consecutive kills in one jump-cut montage (e.g. 4:25 → 5:32). */
export const HUD_CLUSTER_MAX_GAP_SEC = 95;
export const HUD_CLUSTER_MAX_SPAN_SEC = 600;
/** Min source-time gap between kills IN one montage (real jump-cut). */
export const MIN_MONTAGE_SOURCE_GAP_SEC = 30;
/** Min VOD span for a montage chain (kills far apart in source). */
export const MIN_MONTAGE_CHAIN_SPAN_SEC = 75;
/** Reject montages that jump across unrelated VOD sections. */
export const MAX_KILL_GAP_IN_MONTAGE_SEC = 22;
export const PREFERRED_CHAIN_KILLS = 4;
export const MIN_CHAIN_KILLS = 2;

/** Per-kill window: short pre-roll, enough post-roll to show the frag + reaction. */
export const KILL_ONLY_TIMING = {
  clipBefore: 2,
  clipAfter: 4,
  segBefore: 2,
  segAfter: 4,
  maxSegDur: 6,
  minSegDur: 4,
  maxTotal: 26,
  audioPeakOffsetSec: -0.2,
  transcriptPeakOffsetSec: -0.15,
};

/**
 * HUD kills: segment anchored on HUD timeline (Python adjust_kill_time).
 * Tiny pre-roll + post-roll so the frag + kill-feed icon are visible.
 */
export const HUD_KILL_TIMING = {
  ...KILL_ONLY_TIMING,
  clipBefore: 1.2,
  clipAfter: 6.0,
  segBefore: 1.2,
  segAfter: 6.0,
  maxSegDur: 7.4,
  minSegDur: 4.5,
  maxTotal: 42,
  hudPeakOffsetSec: 0,
};

/** Red kill-feed: anchor BEFORE flash (frag first), long post-roll for body drop. */
export const RED_HIGHLIGHT_KILL_TIMING = {
  clipBefore: 2.0,
  clipAfter: 6.0,
  segBefore: 2.0,
  segAfter: 6.0,
  maxSegDur: 8,
  minSegDur: 5.5,
  maxTotal: 32,
  hudPeakOffsetSec: -1.8,
  fixedKillWindow: false,
};

/** POV kills safe for montage chains (identity confirmed, not victim-only OCR). */
export const TRUSTED_POV_REASONS = new Set([
  'pov_killer_match',
  'pov_partial_killer',
  'pov_partial_any',
  'pov_partial_victim_foreign',
  'pov_foreign_killer_ocr',
  'pov_enemy_killer_field',
  'pov_assist_swap',
  'pov_name_in_line',
]);

export function isTrustedHudKill(event) {
  if (!event) return false;
  if (!(event.player_kill || event.red_highlight || event.validated_by === 'red-highlight')) {
    return false;
  }
  const reason = event.pov_reason || '';
  if (!reason || !TRUSTED_POV_REASONS.has(reason)) return false;
  if ((event.confidence ?? 0) < 0.55) return false;
  return true;
}

/** One kill in a window — longer post-roll for caster reaction, never pad pre-kill. */
export const SINGLE_KILL_TIMING = {
  ...KILL_ONLY_TIMING,
  clipBefore: 2,
  clipAfter: 8,
  segBefore: 2,
  segAfter: 8,
  maxSegDur: 10,
  minSegDur: 8,
  maxTotal: 11,
};

export const MAX_KILL_SEG_BEFORE_SEC = 3;
/** Met via multiple tight kill cuts, not pre-kill walking padding. */
export const MIN_SHOOTER_MONTAGE_SEC = 12;

/**
 * Anchor on kill moment: CS2 feed flashes AFTER the frag.
 * Negative hudPeakOffsetSec shifts cut before raw_time; gunshot snap when available.
 */
export function resolveHudKillAnchor(killEventOrTime, roi = '', timing = null) {
  const event =
    typeof killEventOrTime === 'object' && killEventOrTime !== null ? killEventOrTime : null;
  if (event?.kill_anchor_time != null && !event?.red_highlight && event?.validated_by !== 'red-highlight') {
    return event.kill_anchor_time;
  }
  const raw = event?.raw_time ?? event?.time ?? Number(killEventOrTime);
  if (event?.player_kill || event?.red_highlight || event?.validated_by === 'red-highlight') {
    const lag = timing?.hudPeakOffsetSec ?? RED_HIGHLIGHT_KILL_TIMING.hudPeakOffsetSec ?? 0;
    return Number.isFinite(raw) ? Math.max(0, raw + lag) : 0;
  }
  if (event?.audio_peak_time != null) return Math.max(0, event.audio_peak_time - 0.2);
  const r = event?.roi ?? roi;
  if (!Number.isFinite(raw)) return 0;
  const lead = r === 'bottom_kills' ? 0.65 : r === 'top_right' ? 0.85 : 0.75;
  return Math.max(0, raw - lead);
}

export function getHudEventTime(event) {
  if (!event) return 0;
  return Number(event.raw_time ?? event.time) || 0;
}

export function hudEventToKillPeak(event) {
  const time = resolveHudKillAnchor(event);
  return {
    time,
    hudKillTime: time,
    raw_time: getHudEventTime(event),
    snappedGunshot: true,
    strength: (event.confidence ?? 0.5) * 12,
    source: 'hud',
    roi: event.roi,
    confidence: event.confidence,
    text: event.text,
  };
}

function resolveSegmentPeakTime(peak, timing) {
  if (peak.segment_type === 'payoff') return peak.time;
  if (peak.hudKillTime != null) return resolveHudKillAnchor(peak.hudKillTime);
  if (peak.snappedGunshot) return Math.max(0, peak.time);
  let t = peak.time;
  if (peak.source === 'hud' || peak.roi === 'bottom_kills') {
    t += timing.hudPeakOffsetSec ?? -0.65;
  } else if (peak.source === 'transcript') {
    t += timing.transcriptPeakOffsetSec ?? -0.55;
  } else {
    t += timing.audioPeakOffsetSec ?? -1.35;
  }
  return Math.max(0, t);
}

/** Optional clutch ending (defuse/plant) after kill jump-cuts. */
export const PAYOFF_TIMING = {
  clipBefore: 0.5,
  clipAfter: 6,
  segBefore: 0.5,
  segAfter: 6,
  maxSegDur: 6.5,
  minSegDur: 5,
  maxAheadSec: 20,
};

export function countKillSegments(segments) {
  if (!segments?.length) return 0;
  const kills = segments.filter((s) => s.segment_type !== 'payoff');
  return kills.length || segments.length;
}

/** Kill-count-based segment timing (more kills → longer montage toward MIN_SHOOTER_MONTAGE_SEC). */
export function getMontageTimingProfile(killCount) {
  const n = Math.min(5, Math.max(2, Number(killCount) || 2));
  const segLen = KILL_ONLY_TIMING.segBefore + KILL_ONLY_TIMING.segAfter;
  const profiles = {
    2: { ...KILL_ONLY_TIMING, maxTotal: segLen * 2 },
    3: { ...KILL_ONLY_TIMING, maxTotal: segLen * 3 },
    4: { ...KILL_ONLY_TIMING, maxTotal: Math.max(MIN_SHOOTER_MONTAGE_SEC, segLen * 4) },
    5: { ...KILL_ONLY_TIMING, maxTotal: segLen * 5 },
  };
  return profiles[n] || profiles[5];
}

function effectiveSegBefore(timing) {
  const before = timing.segBefore ?? timing.clipBefore ?? 2;
  return Math.min(before, MAX_KILL_SEG_BEFORE_SEC);
}

function segmentDuration(timing) {
  const before = effectiveSegBefore(timing);
  const after = timing.segAfter ?? timing.clipAfter ?? 4;
  return Math.min(timing.maxSegDur ?? before + after, before + after);
}

/** Jump-cuts must not overlap in source time — prevents replay after each cut. */
export function trimJumpCutOverlaps(segments, { minDur = 1.15, gapSec = 0.15 } = {}) {
  if (!segments?.length) return [];
  const out = segments.map((s) => ({ ...s }));
  for (let i = 0; i < out.length - 1; i++) {
    const maxEnd = out[i + 1].start - gapSec;
    const maxDur = maxEnd - out[i].start;
    if (maxDur < out[i].duration) {
      out[i].duration = Math.max(minDur, Math.round(maxDur * 10) / 10);
    }
  }
  return out.filter((s) => s.duration >= minDur);
}

/** One FFmpeg cut window centered on a HUD kill timestamp. */
export function buildKillSegmentAtAnchor(
  killEvent,
  videoDuration,
  timing = HUD_KILL_TIMING,
  nextKillEvent = null,
  audioScan = null,
) {
  const event = typeof killEvent === 'object' && killEvent !== null ? killEvent : { time: killEvent };
  let anchor = resolveHudKillAnchor(event, event?.roi ?? '', timing);
  const rawHud = getHudEventTime(event);
  if (
    audioScan &&
    (event.player_kill || event.red_highlight || event.validated_by === 'red-highlight')
  ) {
    const snapped = snapPeakToGunshot(rawHud, audioScan);
    if (snapped > 0 && Math.abs(snapped - rawHud) <= 2.8) {
      anchor = snapped;
    }
  }
  const segBefore = timing.segBefore ?? timing.clipBefore ?? effectiveSegBefore(timing);
  let segAfter = timing.segAfter ?? timing.clipAfter ?? 4.5;
  if (!timing.fixedKillWindow && nextKillEvent) {
    const nextAnchor = resolveHudKillAnchor(nextKillEvent, nextKillEvent?.roi ?? '', timing);
    const maxAfter = nextAnchor - anchor - 0.25;
    segAfter = Math.min(segAfter, Math.max(0.9, maxAfter));
  }
  const nominalDur = timing.fixedKillWindow
    ? timing.maxSegDur ?? segBefore + segAfter
    : Math.min(timing.maxSegDur ?? segBefore + segAfter, segBefore + segAfter);
  let start = Math.max(0, anchor - segBefore);
  if (start + nominalDur > videoDuration) {
    start = Math.max(0, videoDuration - nominalDur);
  }
  const dur = Math.min(nominalDur, videoDuration - start);
  if (dur < (timing.minSegDur ?? 2)) return null;

  const displayTime =
    event.audio_peak_time != null
      ? event.audio_peak_time
      : getHudEventTime(event);

  return {
    start: Math.round(start * 10) / 10,
    duration: Math.round(dur * 10) / 10,
    peak_time: Math.round(anchor * 10) / 10,
    raw_time: Math.round(displayTime * 10) / 10,
    hud_flash_time: Math.round(getHudEventTime(event) * 10) / 10,
    segment_type: 'kill',
    hud_roi: event.roi,
  };
}

/**
 * Build jump-cut segments directly from HUD kill-feed timeline (primary CS2 path).
 * start/duration always derived from peak_time — no audio back-snap.
 */
export function buildHudKillMontageSegments(
  killEvents,
  videoDuration,
  timing = HUD_KILL_TIMING,
  audioScan = null,
) {
  const kills = dedupeHudKillEvents(killEvents, MIN_KILL_PEAK_GAP_SEC, MAX_MONTAGE_KILL_SEGMENTS);
  if (kills.length < 2) return null;

  const montage_segments = [];
  for (let i = 0; i < kills.length; i++) {
    const seg = buildKillSegmentAtAnchor(kills[i], videoDuration, timing, kills[i + 1], audioScan);
    if (!seg) continue;
    seg.confidence = kills[i].confidence;
    seg.hud_roi = kills[i].roi;
    montage_segments.push(seg);
  }

  const trimmed = trimJumpCutOverlaps(montage_segments);
  if (trimmed.length < 2) return null;

  const output_duration = sumMontageDuration(trimmed);
  const minOutput =
    trimmed.length >= 4
      ? MIN_SHOOTER_MONTAGE_SEC
      : trimmed.length >= 3
        ? 7
        : 4;
  if (output_duration < minOutput) return null;

  const last = trimmed[trimmed.length - 1];
  return {
    montage_segments: trimmed,
    output_duration,
    source_span_start: trimmed[0].start,
    source_span_end: Math.round((last.start + last.duration) * 10) / 10,
    montage_kill_count: trimmed.length,
    timing_profile: timing,
  };
}

/**
 * Build jump-cut segments from kill peaks.
 * @param {Array<{ time: number, strength?: number }>} peaks
 */
/** Collapse HUD/audio peaks that are too close — keeps strongest per window. */
export function dedupeKillPeaks(
  peaks,
  minGap = MIN_KILL_PEAK_GAP_SEC,
  maxPeaks = MAX_MONTAGE_KILL_SEGMENTS,
) {
  if (!peaks?.length) return [];
  const scored = [...peaks].sort((a, b) => {
    const scoreA =
      ((a.roi || '').startsWith('top_right') ? 45 : 0) +
      (a.strength ?? 0) +
      (a.confidence ?? 0) * 8;
    const scoreB =
      ((b.roi || '').startsWith('top_right') ? 45 : 0) +
      (b.strength ?? 0) +
      (b.confidence ?? 0) * 8;
    return scoreB - scoreA;
  });

  const picked = [];
  for (const peak of scored) {
    if (picked.some((p) => Math.abs(p.time - peak.time) < minGap)) continue;
    picked.push(peak);
    if (picked.length >= maxPeaks) break;
  }
  return picked.sort((a, b) => a.time - b.time);
}

export function buildMontageSegmentsFromPeaks(peaks, videoDuration, profile = null) {
  if (!peaks?.length) return null;

  const hudPeaks = peaks.every((p) => p.source === 'hud' || p.roi === 'bottom_kills');
  const timing =
    profile ||
    (peaks.length === 1
      ? SINGLE_KILL_TIMING
      : hudPeaks
        ? HUD_KILL_TIMING
        : getMontageTimingProfile(peaks.length));

  const montage_segments = [];
  let totalDur = 0;
  let lastSegEnd = -Infinity;
  const segBefore = effectiveSegBefore(timing);
  const segDur = segmentDuration(timing);
  const needMinMontage = peaks.length >= 2;
  const maxTotal = Math.max(
    timing.maxTotal ?? segDur * peaks.length,
    needMinMontage ? MIN_SHOOTER_MONTAGE_SEC : segDur,
  );

  for (const peak of peaks) {
    const anchor = resolveSegmentPeakTime(peak, timing);
    let start = Math.max(0, anchor - segBefore);
    let dur = segDur;
    if (start + dur > videoDuration) {
      start = Math.max(0, videoDuration - dur);
      dur = videoDuration - start;
    }
    if (dur < timing.minSegDur) continue;
    if (start < lastSegEnd - 0.2) continue;
    if (totalDur + dur > maxTotal && totalDur >= MIN_SHOOTER_MONTAGE_SEC) break;
    if (totalDur + dur > maxTotal + segDur) break;

    montage_segments.push({
      start: Math.round(start * 10) / 10,
      duration: Math.round(dur * 10) / 10,
      peak_time: Math.round(anchor * 10) / 10,
      segment_type: peak.segment_type === 'payoff' ? 'payoff' : 'kill',
    });
    totalDur += dur;
    lastSegEnd = start + dur;
  }

  if (montage_segments.length < 1) return null;
  if (montage_segments.length < 2 && peaks.length >= 2) return null;
  if (needMinMontage && totalDur < MIN_SHOOTER_MONTAGE_SEC) return null;

  const source_span_start = montage_segments[0].start;
  const last = montage_segments[montage_segments.length - 1];
  const source_span_end = Math.round((last.start + last.duration) * 10) / 10;

  return {
    montage_segments,
    output_duration: sumMontageDuration(montage_segments),
    source_span_start,
    source_span_end,
    montage_kill_count: countKillSegments(montage_segments),
    timing_profile: timing,
  };
}

/** Append defuse/plant payoff after kill segments (does not count toward kill count). */
export function appendPayoffSegment(built, payoffPeak, videoDuration, timing = PAYOFF_TIMING) {
  if (!built?.montage_segments?.length || !payoffPeak?.time) return built;

  const killSegments = built.montage_segments.filter((s) => s.segment_type !== 'payoff');
  if (killSegments.length < 2) return built;

  const lastKill = killSegments[killSegments.length - 1];
  const lastKillEnd = (lastKill.peak_time ?? lastKill.start + lastKill.duration / 2) + 0.5;
  if (payoffPeak.time <= lastKillEnd + 1.5) return built;

  const profile = built.timing_profile || getMontageTimingProfile(killSegments.length);
  const maxTotal = profile.maxTotal + timing.maxSegDur + 0.5;
  const currentTotal = sumMontageDuration(built.montage_segments);
  if (currentTotal >= maxTotal) return built;

  const segBefore = effectiveSegBefore(timing);
  let start = Math.max(0, payoffPeak.time - segBefore);
  let dur = segmentDuration(timing);
  if (start + dur > videoDuration) {
    start = Math.max(0, videoDuration - dur);
    dur = videoDuration - start;
  }
  if (dur < timing.minSegDur || currentTotal + dur > maxTotal) return built;

  const payoffSeg = {
    start: Math.round(start * 10) / 10,
    duration: Math.round(dur * 10) / 10,
    peak_time: Math.round(payoffPeak.time * 10) / 10,
    segment_type: 'payoff',
  };

  const montage_segments = [...built.montage_segments, payoffSeg];
  const last = montage_segments[montage_segments.length - 1];

  return {
    ...built,
    montage_segments,
    output_duration: sumMontageDuration(montage_segments),
    source_span_end: Math.round((last.start + last.duration) * 10) / 10,
    montage_kill_count: killSegments.length,
    has_payoff: true,
  };
}

/** Normalize highlight/candidate metadata after montage is built or cut. */
export function finalizeMontageHighlight(highlight) {
  const segments = highlight?.montage_segments;
  if (!segments?.length) return highlight;

  const summed = sumMontageDuration(segments);
  const measured = Number(highlight.clip_duration_measured);
  const output_duration =
    Number.isFinite(measured) && measured > 0.5 ? Math.round(measured * 10) / 10 : summed;

  const source_span_start =
    Number(highlight.source_span_start) ||
    segments[0].start;
  const last = segments[segments.length - 1];
  const source_span_end =
    Number(highlight.source_span_end) ||
    Math.round((last.start + last.duration) * 10) / 10;

  return {
    ...highlight,
    clip_type: highlight.clip_type || 'shooter_multikill',
    montage_type: highlight.montage_type || 'shooter_multikill',
    montage_segments: segments,
    montage_kill_count: countKillSegments(segments),
    output_duration,
    source_span_start,
    source_span_end,
    /** VOD anchor for thumbnails — NOT clip length. */
    start_time: source_span_start,
    /** VOD end of action span — do NOT use (end - start) as clip duration. */
    end_time: source_span_end,
    cold_open: false,
    user_cold_open: false,
    hook_teaser_duration: 0,
  };
}

export function getMontageThumbnailTime(highlight) {
  if (highlight.montage_segments?.[0]?.start != null) {
    return highlight.montage_segments[0].start;
  }
  if (highlight.source_span_start != null) return highlight.source_span_start;
  return highlight.start_time || 0;
}

function peakCombatAudioInRange(audioScan, centerTime, beforeSec = 5, afterSec = 2) {
  if (!audioScan?.delta?.length) return { time: centerTime, delta: 0 };
  const bucketSec = audioScan.bucketSec || 0.5;
  let bestIdx = -1;
  let bestDelta = 0;
  const lo = Math.max(0, Math.floor((centerTime - beforeSec) / bucketSec));
  const hi = Math.min(
    audioScan.delta.length - 1,
    Math.ceil((centerTime + afterSec) / bucketSec),
  );
  for (let i = lo; i <= hi; i++) {
    if ((audioScan.delta[i] ?? 0) > bestDelta) {
      bestDelta = audioScan.delta[i];
      bestIdx = i;
    }
  }
  return { time: bestIdx >= 0 ? bestIdx * bucketSec : centerTime, delta: bestDelta };
}

/** Pick one kill timestamp from multiple HUD flashes in the same engagement. */
export function pickBestHudKillInCluster(cluster, audioScan = null) {
  if (!cluster?.length) return null;
  if (cluster.length === 1) return cluster[0];

  const topRight = cluster.filter((e) => (e.roi || '').startsWith('top_right'));
  const pool = topRight.length ? topRight : cluster;

  if (audioScan?.delta?.length) {
    const t0 = Math.min(...cluster.map(getHudEventTime));
    const t1 = Math.max(...cluster.map(getHudEventTime));
    const gun = peakCombatAudioInRange(audioScan, (t0 + t1) / 2, t1 - t0 + 5, 2);
    let best = pool[0];
    let bestDist = Infinity;
    for (const e of pool) {
      const dist = Math.abs(getHudEventTime(e) - gun.time);
      const conf = e.confidence ?? 0;
      if (
        dist < bestDist - 0.05 ||
        (Math.abs(dist - bestDist) < 0.05 && conf > (best.confidence ?? 0))
      ) {
        bestDist = dist;
        best = e;
      }
    }
    return best;
  }

  return [...pool].sort(
    (a, b) =>
      (b.confidence ?? 0) * 12 +
      (b.activity ?? 0) * 20 -
      ((a.confidence ?? 0) * 12 + (a.activity ?? 0) * 20),
  )[0];
}

/**
 * Merge HUD frame-diff bursts (4:18, 4:21, 4:27) into one kill per engagement.
 * Uses combat audio to anchor on the real frag when available.
 */
export function collapseHudEngagements(events, audioScan = null, gapSec = HUD_ENGAGEMENT_GAP_SEC) {
  const sorted = [...(events || [])]
    .filter((e) => e && Number.isFinite(getHudEventTime(e)))
    .sort((a, b) => getHudEventTime(a) - getHudEventTime(b));
  if (!sorted.length) return [];

  const out = [];
  let cluster = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = getHudEventTime(sorted[i]) - getHudEventTime(cluster[cluster.length - 1]);
    if (gap <= gapSec) {
      cluster.push(sorted[i]);
    } else {
      const pick = pickBestHudKillInCluster(cluster, audioScan);
      if (pick) out.push(pick);
      cluster = [sorted[i]];
    }
  }
  const last = pickBestHudKillInCluster(cluster, audioScan);
  if (last) out.push(last);
  return out;
}

/** Pick real kill moments from raw HUD events (kill-feed preferred). */
export function dedupeHudKillEvents(events, minGap = MIN_KILL_PEAK_GAP_SEC, maxKills = MAX_MONTAGE_KILL_SEGMENTS) {
  if (!events?.length) return [];
  const topRight = events.filter((e) => (e.roi || '').startsWith('top_right'));
  const pool = topRight.length >= 2 ? topRight : events;

  const scored = [...pool].sort((a, b) => {
    const scoreA =
      (a.player_kill || a.red_highlight ? 50 : 0) +
      (a.highlight_score ?? 0) * 30 +
      (a.kill_quality_score ?? 0) * 0.5 +
      (a.confidence ?? 0) * 12;
    const scoreB =
      (b.player_kill || b.red_highlight ? 50 : 0) +
      (b.highlight_score ?? 0) * 30 +
      (b.kill_quality_score ?? 0) * 0.5 +
      (b.confidence ?? 0) * 12;
    return scoreB - scoreA;
  });

  const picked = [];
  for (const event of scored) {
    const t = getHudEventTime(event);
    if (picked.some((p) => Math.abs(getHudEventTime(p) - t) < minGap)) continue;
    picked.push(event);
    if (picked.length >= maxKills) break;
  }
  return picked.sort((a, b) => getHudEventTime(a) - getHudEventTime(b));
}

/** Tight combat clusters — each becomes one jump-cut montage. */
export function clusterHudKillEvents(
  events,
  maxGapSec = HUD_CLUSTER_MAX_GAP_SEC,
  maxSpanSec = HUD_CLUSTER_MAX_SPAN_SEC,
) {
  const sorted = [...(events || [])]
    .filter((e) => e && Number.isFinite(e.time))
    .sort((a, b) => a.time - b.time);
  if (!sorted.length) return [];

  const clusters = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].time - current[current.length - 1].time;
    const span = sorted[i].time - current[0].time;
    if (gap <= maxGapSec && span <= maxSpanSec) {
      current.push(sorted[i]);
    } else {
      const kills = dedupeHudKillEvents(current, MIN_KILL_PEAK_GAP_SEC, MAX_MONTAGE_KILL_SEGMENTS);
      if (kills.length >= 2) clusters.push({ kills });
      current = [sorted[i]];
    }
  }
  const kills = dedupeHudKillEvents(current, MIN_KILL_PEAK_GAP_SEC, MAX_MONTAGE_KILL_SEGMENTS);
  if (kills.length >= 2) clusters.push({ kills });

  return clusters;
}

/** Find gunshot spike in the seconds BEFORE a HUD kill flash. */
export function snapPeakToGunshot(hudTime, audioScan) {
  if (hudTime == null) return 0;
  if (!audioScan?.delta?.length) return Math.max(0, hudTime - 0.68);

  const { delta, bucketSec } = audioScan;
  const lo = Math.max(1, Math.floor((hudTime - 2.4) / bucketSec));
  const hi = Math.min(delta.length - 2, Math.ceil((hudTime + 0.15) / bucketSec));

  let bestIdx = -1;
  let bestScore = 4.2;
  for (let i = lo; i <= hi; i++) {
    const d = delta[i];
    if (d < 4.2) continue;
    if (d < delta[i - 1] || d < delta[i + 1]) continue;
    const t = i * bucketSec;
    const beforeHud = hudTime - t;
    if (beforeHud < 0.08 || beforeHud > 2.4) continue;
    const score = d + beforeHud * 0.4;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx >= 0) return bestIdx * bucketSec;
  return Math.max(0, hudTime - 0.68);
}

/** @deprecated Use snapPeakToGunshot */
export function snapPeakToAudio(peakTime, audioScan) {
  return snapPeakToGunshot(peakTime, audioScan);
}

function scoreHudKillCluster(cluster) {
  const kills = cluster?.kills || [];
  if (kills.length < MIN_CHAIN_KILLS) return 0;
  const span = getHudEventTime(kills[kills.length - 1]) - getHudEventTime(kills[0]);
  const avgConf = kills.reduce((s, k) => s + (k.confidence ?? 0.5), 0) / kills.length;
  const feedKills = kills.filter(
    (k) => k.player_kill || k.red_highlight || (k.roi || '').startsWith('top_right'),
  ).length;
  const wideBonus = Math.min(120, span * 0.35);
  const countBonus =
    kills.length >= 4 ? 90 : kills.length === 3 ? 55 : kills.length === 2 ? 12 : 0;
  const firstT = getHudEventTime(kills[0]);
  const earlyPenalty = firstT < 90 ? 15 : 0;
  const tightPenalty = span < MIN_MONTAGE_CHAIN_SPAN_SEC ? 100 : span < 120 ? 50 : 0;
  return countBonus + kills.length * 35 + avgConf * 28 + feedKills * 18 + wideBonus - earlyPenalty - tightPenalty;
}

function chainsShareKill(a, b, gapSec = 3) {
  for (const ka of a.kills || []) {
    for (const kb of b.kills || []) {
      if (Math.abs(ka.time - kb.time) < gapSec) return true;
    }
  }
  return false;
}

/**
 * Find every local 2–4 kill window; each kill becomes one jump-cut segment.
 * Picks non-overlapping chains, preferring more kills in tighter spans.
 */
export function buildSlidingKillChains(
  events,
  {
    minKills = MIN_CHAIN_KILLS,
    maxKills = MAX_MONTAGE_KILL_SEGMENTS,
    maxGapSec = HUD_CLUSTER_MAX_GAP_SEC,
    maxSpanSec = HUD_CLUSTER_MAX_SPAN_SEC,
  } = {},
) {
  const sorted = [...(events || [])]
    .filter((e) => e && Number.isFinite(getHudEventTime(e)))
    .sort((a, b) => getHudEventTime(a) - getHudEventTime(b));
  if (sorted.length < minKills) return [];

  const raw = [];
  for (let i = 0; i < sorted.length; i++) {
    const chain = [sorted[i]];
    for (let j = i + 1; j < sorted.length && chain.length < maxKills; j++) {
      const gap = getHudEventTime(sorted[j]) - getHudEventTime(chain[chain.length - 1]);
      const span = getHudEventTime(sorted[j]) - getHudEventTime(chain[0]);
      if (gap <= maxGapSec && span <= maxSpanSec) {
        chain.push(sorted[j]);
      } else {
        break;
      }
    }
    const kills = dedupeHudKillEvents(chain, HUD_ENGAGEMENT_GAP_SEC, maxKills);
    if (kills.length >= minKills) {
      raw.push({
        kills,
        killCount: kills.length,
        span: getHudEventTime(kills[kills.length - 1]) - getHudEventTime(kills[0]),
      });
    }
  }

  raw.sort((a, b) => {
    if (b.killCount !== a.killCount) return b.killCount - a.killCount;
    if (a.span !== b.span) return a.span - b.span;
    const scoreA = scoreHudKillCluster(a);
    const scoreB = scoreHudKillCluster(b);
    return scoreB - scoreA;
  });

  const kept = [];
  for (const c of raw) {
    if (kept.some((k) => chainsShareKill(k, c))) continue;
    kept.push(c);
  }
  return kept;
}

/** True when two montages reuse the same HUD kill (±3s). */
export function montagesShareKill(a, b, gapSec = 3) {
  const peaksA = (a?.montage_segments || []).map((s) => s.peak_time ?? s.start);
  const peaksB = (b?.montage_segments || []).map((s) => s.peak_time ?? s.start);
  for (const ta of peaksA) {
    for (const tb of peaksB) {
      if (Math.abs(ta - tb) < gapSec) return true;
    }
  }
  return false;
}

/**
 * Score burst chains: tight multikill rounds win; wide stitched chains lose.
 */
function chainBurstScoreAdjust(chain) {
  const k = chain.killCount || 0;
  const span = chain.span || 0;
  if (span <= MONTAGE_BURST_MAX_GAP_SEC) return 70 + k * 22;
  if (span <= MONTAGE_BURST_MAX_SPAN_SEC) return 35 + k * 12;
  if (span > 90) return -120 - k * 8;
  if (span > 60) return -70 - k * 5;
  return 0;
}

/**
 * Jump-cut montages: each kill must be >= minGapSec apart in the source VOD.
 * Avoids "continuous" montages where 4 kills sit within 30s of gameplay.
 */
export function buildWideGapKillChains(
  events,
  {
    minKills = MIN_CHAIN_KILLS,
    maxKills = MAX_MONTAGE_KILL_SEGMENTS,
    minGapSec = MIN_MONTAGE_SOURCE_GAP_SEC,
    minChainSpanSec = MIN_MONTAGE_CHAIN_SPAN_SEC,
  } = {},
) {
  const sorted = [...(events || [])]
    .filter((e) => e && Number.isFinite(getHudEventTime(e)))
    .sort((a, b) => getHudEventTime(a) - getHudEventTime(b));
  if (sorted.length < minKills) return [];

  const raw = [];
  for (let i = 0; i < sorted.length; i++) {
    const chain = [sorted[i]];
    for (let j = i + 1; j < sorted.length && chain.length < maxKills; j++) {
      const gap = getHudEventTime(sorted[j]) - getHudEventTime(chain[chain.length - 1]);
      if (gap >= minGapSec) {
        chain.push(sorted[j]);
      }
    }
    const span = getHudEventTime(chain[chain.length - 1]) - getHudEventTime(chain[0]);
    if (chain.length >= minKills && span >= minChainSpanSec) {
      raw.push({
        kills: chain,
        killCount: chain.length,
        span,
        minGap: minGapSec,
      });
    }
  }

  raw.sort((a, b) => {
    if (b.span !== a.span) return b.span - a.span;
    if (b.killCount !== a.killCount) return b.killCount - a.killCount;
    return scoreHudKillCluster(b) - scoreHudKillCluster(a);
  });

  const kept = [];
  for (const c of raw) {
    if (kept.some((k) => chainsShareKill(k, c))) continue;
    kept.push(c);
  }
  return kept;
}

/** Greedy partition: every kill in exactly one pack (burst groups ≤4, rest solo). */
export function partitionKillsIntoBurstPacks(
  events,
  {
    maxGapSec = MONTAGE_BURST_MAX_GAP_SEC,
    maxKills = MAX_MONTAGE_KILL_SEGMENTS,
    maxSpanSec = MONTAGE_BURST_MAX_SPAN_SEC,
  } = {},
) {
  const sorted = [...(events || [])]
    .filter((e) => e && Number.isFinite(getHudEventTime(e)))
    .sort((a, b) => getHudEventTime(a) - getHudEventTime(b));
  if (!sorted.length) return [];

  const packs = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const gap = getHudEventTime(sorted[i]) - getHudEventTime(current[current.length - 1]);
    const span = getHudEventTime(sorted[i]) - getHudEventTime(current[0]);
    if (gap <= maxGapSec && current.length < maxKills && span <= maxSpanSec) {
      current.push(sorted[i]);
    } else {
      packs.push({ kills: current });
      current = [sorted[i]];
    }
  }
  packs.push({ kills: current });
  return packs;
}

/** One clip per pack: 1 kill = single segment, 2–4 kills = jump-cut montage. */
export function buildHudKillClipFromPack(kills, videoDuration, options = {}) {
  const list = dedupeHudKillEvents(kills, MIN_KILL_PEAK_GAP_SEC, MAX_MONTAGE_KILL_SEGMENTS);
  if (!list.length) return null;

  const audioScan = options.audioScan;
  const timing = list.some(
    (k) => k.player_kill || k.red_highlight || k.validated_by === 'red-highlight',
  )
    ? RED_HIGHLIGHT_KILL_TIMING
    : HUD_KILL_TIMING;

  if (list.length === 1) {
    const seg = buildKillSegmentAtAnchor(list[0], videoDuration, timing, null, audioScan);
    if (!seg || seg.duration < 3) return null;
    const montage_segments = [{ ...seg, segment_type: 'kill', confidence: list[0].confidence }];
    const output_duration = seg.duration;
    const span = 0;
    return {
      montage_type: 'shooter_multikill',
      clip_type: 'shooter_multikill',
      montage_kill_count: 1,
      start: seg.start,
      end: Math.round((seg.start + seg.duration) * 10) / 10,
      start_time: seg.start,
      end_time: Math.round((seg.start + seg.duration) * 10) / 10,
      local_score: 72,
      composite: 72,
      flags: ['hud-kills', 'single-kill', 'hud-chain'],
      montage_segments,
      output_duration,
      source_span_start: seg.start,
      source_span_end: Math.round((seg.start + seg.duration) * 10) / 10,
      confidence: Math.min(95, Math.round((list[0].confidence ?? 0.5) * 100)),
      arcLabel: 'hud-kill-chain',
      chain_span: span,
      hudKills: 1,
      hypeMoment: false,
      excerpt: `1 kill · ${output_duration}s clip`,
    };
  }

  const built = buildHudMontageCandidate({ kills: list }, videoDuration, options);
  if (!built) return null;
  const span =
    getHudEventTime(list[list.length - 1]) - getHudEventTime(list[0]);
  return { ...built, chain_span: Math.round(span * 10) / 10 };
}

/**
 * Full kill coverage: every detected POV kill → exactly one clip segment.
 * Bursts (≤22s apart) become 2–4 kill montages; isolated kills become solo clips.
 */
export function buildKillMontagePacks(events, videoDuration, options = {}) {
  let engagements = events;
  if (!events.some((e) => e.validated_by === 'red-highlight' || e.validated_by === 'audio+hud')) {
    engagements = collapseHudEngagements(events, options.audioScan);
    if (engagements.length !== events.length) {
      console.log(
        `[montage] HUD engagement collapse: ${events.length} raw flashes → ${engagements.length} kills`,
      );
    }
  }

  if (!engagements.length) return [];

  const packs = partitionKillsIntoBurstPacks(engagements);
  const selected = packs
    .map((pack) => buildHudKillClipFromPack(pack.kills, videoDuration, options))
    .filter((clip) => clip && isCoherentKillMontage(clip));

  const totalSegs = selected.reduce((n, c) => n + (c.montage_kill_count || 0), 0);
  const killHist = selected.map((c) => c.montage_kill_count).join('+');
  console.log(
    `[montage] full coverage: ${engagements.length} kills → ${selected.length} clips ` +
      `(${totalSegs} segments, packs=${killHist || 'none'})`,
  );
  const sample = selected[0]?.montage_segments?.[0];
  if (sample) {
    console.log(
      `[montage] sample cut: raw=${sample.raw_time}s peak=${sample.peak_time}s ` +
        `window=${sample.start}+${sample.duration}s roi=${sample.hud_roi || '?'}`,
    );
  }

  return selected;
}

/** One montage candidate per local HUD kill cluster (fallback). */
export function buildAllHudMontageCandidates(events, videoDuration, options = {}) {
  return clusterHudKillEvents(events)
    .map((cluster) => buildHudMontageCandidate(cluster, videoDuration, options))
    .filter(Boolean)
    .sort((a, b) => (b.montage_kill_count || 0) - (a.montage_kill_count || 0));
}

/** True when montage segments are jump-cuts with large source gaps (HUD wide-gap chains). */
export function montageUsesWideSourceGaps(candidate) {
  const segs = (candidate?.montage_segments || []).filter((s) => s.segment_type !== 'payoff');
  if (segs.length < 2) return false;
  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1].peak_time ?? segs[i - 1].start;
    const curr = segs[i].peak_time ?? segs[i].start;
    if (curr - prev > MAX_KILL_GAP_IN_MONTAGE_SEC) return true;
  }
  return false;
}

/** Reject montages that jump across the VOD (e.g. kill at 19s then 400s).
 * 
 * IMPORTANT: Never allow wide-gap montages that stitch kills from distant parts
 * of the VOD together. This creates incoherent clips with large dead time.
 * Each montage must represent a single local combat sequence.
 */
export function isCoherentKillMontage(candidate) {
  const segs = (candidate?.montage_segments || []).filter((s) => s.segment_type !== 'payoff');
  if (segs.length < 1) return false;
  if (segs.length === 1) return true;
  
  // STRICT: Always check for wide gaps - never allow wide-gap stitching
  // This enforces the rule: kills in a montage must be from a single local sequence
  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1].peak_time ?? segs[i - 1].start;
    const curr = segs[i].peak_time ?? segs[i].start;
    const gap = curr - prev;
    // Log wide gaps for debugging but always reject them
    if (gap > MAX_KILL_GAP_IN_MONTAGE_SEC) {
      console.log(`[montage-coherence] REJECTED: gap ${gap.toFixed(1)}s > ${MAX_KILL_GAP_IN_MONTAGE_SEC}s (kill ${i} to ${i+1})`);
      return false;
    }
  }
  
  const span =
    (segs[segs.length - 1].peak_time ?? segs[segs.length - 1].start) -
    (segs[0].peak_time ?? segs[0].start);
  
  // Reject if total span too long for a burst montage
  if (span > MONTAGE_BURST_MAX_SPAN_SEC) {
    console.log(`[montage-coherence] REJECTED: span ${span.toFixed(1)}s > ${MONTAGE_BURST_MAX_SPAN_SEC}s (burst limit)`);
    return false;
  }
  
  // Reject if span exceeds absolute maximum
  if (span > HUD_CLUSTER_MAX_SPAN_SEC) {
    console.log(`[montage-coherence] REJECTED: span ${span.toFixed(1)}s > ${HUD_CLUSTER_MAX_SPAN_SEC}s (absolute limit)`);
    return false;
  }
  
  return true;
}

/**
 * Build a shooter_multikill window from a HUD kill cluster.
 * Segments include start/duration for FFmpeg cuts plus peak_time/confidence metadata.
 */
export function buildHudMontageCandidate(cluster, videoDuration, options = {}) {
  let kills = dedupeHudKillEvents(cluster?.kills || []);
  const audioScan = options.audioScan;
  if (audioScan && kills.some((k) => k.kill_quality_score != null)) {
    kills = kills.filter((k) => (k.kill_quality_score ?? 0) >= 62);
  }
  if (kills.length < 2) return null;

  // Choose timing profile based on the majority of kills
  // Red-highlight timing is for kills confirmed via visual red border
  // HUD timing is for kills detected via OCR text matching
  const redHighlightKills = kills.filter((k) => 
    k.red_highlight || k.validated_by === 'red-highlight' || k.method?.includes('red-highlight')
  ).length;
  
  // Use red-highlight timing only if majority (>50%) are red-highlight kills
  // This prevents mixing timing profiles in a single montage
  const useRedHighlightTiming = redHighlightKills >= kills.length / 2;
  
  const timing = useRedHighlightTiming ? RED_HIGHLIGHT_KILL_TIMING : HUD_KILL_TIMING;
  const built = buildHudKillMontageSegments(kills, videoDuration, timing, audioScan);
  if (!built?.montage_segments?.length || built.montage_segments.length < 2) return null;

  const avgConf =
    kills.reduce((sum, k) => sum + (k.confidence ?? 0.5), 0) / Math.max(1, kills.length);
  const killCount = built.montage_segments.length;
  const localScore = 50 + killCount * 22;

  const montage_segments = built.montage_segments.map((seg) => ({
    ...seg,
    segment_type: 'kill',
  }));

  return {
    montage_type: 'shooter_multikill',
    clip_type: 'shooter_multikill',
    montage_kill_count: killCount,
    start: built.source_span_start,
    end: built.source_span_end,
    start_time: built.source_span_start,
    end_time: built.source_span_end,
    local_score: localScore,
    composite: localScore,
    flags: ['hud-kills', 'multikill-montage'],
    montage_segments,
    output_duration: built.output_duration,
    source_span_start: built.source_span_start,
    source_span_end: built.source_span_end,
    confidence: Math.min(95, Math.round(avgConf * 100)),
    arcLabel: 'hud-kill-chain',
    hudKills: killCount,
    hypeMoment: true,
    excerpt: `${killCount} HUD kills · ${built.output_duration}s montage`,
  };
}

export function sortCandidatesByMontageKillCount(candidates) {
  return [...(candidates || [])].sort((a, b) => {
    const killsA = a.montage_kill_count ?? countKillSegments(a.montage_segments) ?? 0;
    const killsB = b.montage_kill_count ?? countKillSegments(b.montage_segments) ?? 0;
    if (killsB !== killsA) return killsB - killsA;
    const montageA = a.montage_type === 'shooter_multikill' ? 1 : 0;
    const montageB = b.montage_type === 'shooter_multikill' ? 1 : 0;
    if (montageB !== montageA) return montageB - montageA;
    return (b.local_score || 0) - (a.local_score || 0);
  });
}
