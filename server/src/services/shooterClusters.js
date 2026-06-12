import { findAudioPeaks, windowAudioStats, windowAudioScore } from './audioEnergyScan.js';
import { scoreLine } from './multiSignalScore.js';
import {
  countHudKillsInRange,
  hudConfirmedPeaks,
  hudWindowBoost,
  nearestHudEvent,
} from './hudKillFeed.js';
import {
  appendPayoffSegment,
  buildKillMontagePacks,
  buildMontageSegmentsFromPeaks,
  dedupeHudKillEvents,
  dedupeKillPeaks,
  finalizeMontageHighlight,
  HUD_KILL_TIMING,
  RED_HIGHLIGHT_KILL_TIMING,
  isCoherentKillMontage,
  KILL_ONLY_TIMING,
  MAX_KILL_SEG_BEFORE_SEC,
  MAX_MONTAGE_KILL_SEGMENTS,
  buildHudKillMontageSegments,
  getHudEventTime,
  MIN_SHOOTER_MONTAGE_SEC,
  PAYOFF_TIMING,
  resolveHudKillAnchor,
} from './montageClip.js';
import { buildAudioValidatedKills } from './killDetect.js';

const MAX_KILL_GAP_SEC = 22;

export const KILL_KEYWORDS =
  /\b(ace|clutch|1v\d|headshot|frag|double|triple|quad|pick|trade|nade|one tap|last|got him|nice|killed|eliminated)\b/i;

/** Plant/hold/rotate talk without action — NOT highlights. */
export const SHOOTER_BORING_PATTERNS =
  /\b(plant|planted|defus|holding|hold the|hold this|save|saving|eco|rotate|default|waiting|wait here|lädt|pflanzt|hält|post plant)\b/i;

const PAYOFF_KEYWORDS = /\b(defus|defuse|defusing|plant|planted|bombe|bomb|clutch)\b/i;

/** First N seconds of VOD — freeze/spawn HUD noise is common. */
export const SPAWN_WINDOW_SEC = 90;
export const EARLY_VOD_SEC = 150;

/** HUD flash without kill OCR (defuse UI, scoreboard) — reject as kill peak. */
export function isConfirmedHudKill(event) {
  if (!event || event.confidence < 0.4) return false;
  const roi = event.roi || '';
  const text = (event.text || '').trim();
  if (text && PAYOFF_KEYWORDS.test(text) && !KILL_KEYWORDS.test(text)) return false;
  if (text && SHOOTER_BORING_PATTERNS.test(text) && !KILL_KEYWORDS.test(text)) return false;
  if (roi === 'bottom_kills') return false;
  if (roi.startsWith('top_right')) {
    if (event.player_kill || event.red_highlight) return true;
    if ((event.method || '').includes('red-highlight')) return true;
    return (event.highlight_score ?? 0) >= 0.03;
  }
  if (text && KILL_KEYWORDS.test(text)) return true;
  if (text) return false;
  return event.confidence >= 0.72 && (event.activity || 0) >= 0.1;
}

/**
 * Stricter gate for montage clips — rejects spawn/round-start HUD noise.
 * Kill-feed top-right only (bottom_kills icons are unreliable on this layout).
 */
export function isQualityHudKill(event, context = {}) {
  if (!event || !isConfirmedHudKill(event)) return false;

  const t = Number(event.time) || 0;
  const text = (event.text || '').trim();
  const roi = event.roi || '';
  const all = context.allEvents || [];

  if (roi === 'bottom_kills') return false;

  if (roi.startsWith('top_right')) {
    if (event.player_kill || event.red_highlight || event.validated_by) return true;
    if ((event.method || '').includes('red-highlight')) return true;
    return (event.highlight_score ?? 0) >= 0.035;
  }

  if ((roi === 'center_banner' || roi === 'top_left') && !text) return false;
  if (text && !KILL_KEYWORDS.test(text)) return false;

  if (t < SPAWN_WINDOW_SEC && roi !== 'bottom_kills') {
    if (!text || (event.confidence ?? 0) < 0.72) return false;
  }

  if (t < EARLY_VOD_SEC && roi !== 'bottom_kills' && !text) {
    const near = all.filter((o) => o !== event && Math.abs(o.time - t) <= 6);
    const spawnPair =
      near.length >= 1 &&
      near.every((o) => o.roi !== 'bottom_kills' && !(o.text && KILL_KEYWORDS.test(o.text)));
    if (spawnPair) return false;
  }

  return (event.confidence ?? 0) >= 0.55;
}

/** Gunshot spike must land near HUD flash — rejects UI-only false positives. */
export function hasCombatAudioNear(event, audioScan, { beforeSec = 2.2, afterSec = 0.6, minDelta = 4.2 } = {}) {
  if (!audioScan?.delta?.length) return true;
  const t = getHudEventTime(event);
  const bucketSec = audioScan.bucketSec || 0.5;
  const lo = Math.max(0, Math.floor((t - beforeSec) / bucketSec));
  const hi = Math.min(audioScan.delta.length - 1, Math.ceil((t + afterSec) / bucketSec));
  for (let i = lo; i <= hi; i++) {
    if ((audioScan.delta[i] ?? 0) >= minDelta) return true;
  }
  return false;
}

export function filterQualityHudKills(events, videoDuration = 0, audioScan = null, options = {}) {
  const raw = events || [];
  const confirmed = raw.filter(isConfirmedHudKill);

  const validated = buildAudioValidatedKills(raw, audioScan, videoDuration);
  if (validated.length >= 1) {
    return validated;
  }
  if (audioScan) {
    console.warn('[hud-quality] 0 validated kills — skip legacy pool');
    return [];
  }

  let quality = confirmed.filter((e) =>
    isQualityHudKill(e, { allEvents: confirmed, videoDuration }),
  );

  if (audioScan) {
    const withAudio = quality.filter((e) => hasCombatAudioNear(e, audioScan));
    console.log(
      `[hud-quality] ${withAudio.length}/${quality.length} pass combat-audio near HUD flash`,
    );
    quality = withAudio;
  }

  if (quality.length < confirmed.length) {
    console.log(
      `[hud-quality] ${quality.length}/${confirmed.length} HUD events pass quality filter` +
        (videoDuration ? ` (${Math.round(videoDuration)}s VOD)` : ''),
    );
  }
  return quality;
}

function hudEventToPeak(event) {
  return {
    time: event.time,
    strength: event.confidence * 12,
    source: 'hud',
    roi: event.roi,
  };
}

function findTranscriptKillPeaks(timeline, start, end) {
  const peaks = [];
  for (const item of timeline || []) {
    if (item.start < start - 2 || item.start > end + 8) continue;
    const text = item.text || '';
    if (!KILL_KEYWORDS.test(text)) continue;
    if (SHOOTER_BORING_PATTERNS.test(text) && !/\b(kill|frag|headshot|ace|clutch)\b/i.test(text)) {
      continue;
    }
    if (PAYOFF_KEYWORDS.test(text) && !/\b(kill|frag|headshot|ace)\b/i.test(text)) continue;
    peaks.push({ time: item.start, strength: 11, source: 'transcript' });
  }
  return peaks.sort((a, b) => a.time - b.time);
}

function findPayoffPeak(timeline, audioScan, afterTime, videoDuration) {
  const windowEnd = Math.min(videoDuration, afterTime + PAYOFF_TIMING.maxAheadSec);
  let best = null;

  for (const item of timeline || []) {
    if (item.start < afterTime + 1.5 || item.start > windowEnd) continue;
    if (!PAYOFF_KEYWORDS.test(item.text || '')) continue;
    if (!best || item.start < best.time) {
      best = { time: item.start, strength: 9, segment_type: 'payoff' };
    }
  }

  if (!best && audioScan) {
    const peaks = findAudioPeaks(audioScan, { minDeltaDb: 3.5, minSpacingSec: 2, maxPeaks: 40 })
      .filter((p) => p.time > afterTime + 2 && p.time < windowEnd)
      .sort((a, b) => b.strength - a.strength);
    if (peaks[0]) {
      best = { time: peaks[0].time, strength: peaks[0].strength, segment_type: 'payoff' };
    }
  }

  return best;
}

function maybeAppendPayoff(built, timeline, audioScan, videoDuration, { hudConfirmed = 0 } = {}) {
  if (!built?.montage_segments?.length) return built;
  if (hudConfirmed < 2) return built;
  const killSegs = built.montage_segments.filter((s) => s.segment_type !== 'payoff');
  if (killSegs.length < 3) return built;
  const lastKill = killSegs[killSegs.length - 1];
  const anchor = lastKill?.peak_time ?? lastKill?.start ?? 0;
  const payoff = findPayoffPeak(timeline, audioScan, anchor, videoDuration);
  if (!payoff) return built;
  return appendPayoffSegment(built, payoff, videoDuration) || built;
}

/** Tight-spaced peaks for kill chains (vs. sparse anchors). */
export function findKillChainPeaks(scan) {
  return findAudioPeaks(scan, {
    minDeltaDb: 3.5,
    minSpacingSec: 3,
    maxPeaks: 100,
  });
}

/**
 * Group nearby audio spikes into multi-kill chains.
 * @returns {Array<{ peaks: Array, start: number, end: number, peakCount: number, maxStrength: number }>}
 */
export function clusterKillPeaks(peaks, { maxGapSec = 18, minPeaks = 2, maxSpanSec = 105 } = {}) {
  if (!peaks?.length) return [];

  const sorted = [...peaks].sort((a, b) => a.time - b.time);
  const clusters = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = current[current.length - 1];
    const gap = sorted[i].time - prev.time;
    const span = sorted[i].time - current[0].time;

    if (gap <= maxGapSec && span <= maxSpanSec) {
      current.push(sorted[i]);
    } else {
      if (current.length >= minPeaks) clusters.push(finalizeCluster(current));
      current = [sorted[i]];
    }
  }
  if (current.length >= minPeaks) clusters.push(finalizeCluster(current));

  return clusters.sort((a, b) => b.score - a.score);
}

function finalizeCluster(peaks) {
  const start = peaks[0].time;
  const end = peaks[peaks.length - 1].time;
  const maxStrength = Math.max(...peaks.map((p) => p.strength));
  const score = peaks.length * 22 + maxStrength * 4 + peaks.reduce((s, p) => s + p.strength, 0);
  return { peaks, start, end, peakCount: peaks.length, maxStrength, score };
}

/** Count kill-keyword lines in a time range. */
function killKeywordHits(timeline, start, end) {
  let hits = 0;
  for (const item of timeline || []) {
    if (item.start < start - 2 || item.start > end + 4) continue;
    if (KILL_KEYWORDS.test(item.text)) hits += 1;
  }
  return hits;
}

/**
 * Build jump-cut montage segments (2–4 kills) for shooter highlights.
 * @returns {object|null} window-shaped object for buildCandidate
 */
function peaksWithinMaxGap(peaks, maxGap = MAX_KILL_GAP_SEC) {
  if (!peaks?.length) return [];
  const sorted = [...peaks].sort((a, b) => a.time - b.time);
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].time - out[out.length - 1].time > maxGap) break;
    out.push(sorted[i]);
  }
  return out;
}

function pickMontagePeaksAudio(cluster, hudEvents) {
  const peaks = [...cluster.peaks];
  if (!hudEvents?.length) {
    return peaksWithinMaxGap(
      peaks.sort((a, b) => b.strength - a.strength).slice(0, 4).sort((a, b) => a.time - b.time),
    );
  }

  const scored = peaks.map((p) => {
    const hud = nearestHudEvent(hudEvents, p.time, 2.5);
    const hudBonus = hud ? hud.confidence * 40 : 0;
    return { peak: p, score: p.strength + hudBonus, hud };
  });
  scored.sort((a, b) => b.score - a.score);

  const withHud = scored.filter((s) => s.hud).map((s) => s.peak);
  if (withHud.length >= 2) {
    const tight = peaksWithinMaxGap(withHud.slice(0, 5).sort((a, b) => a.time - b.time));
    if (tight.length >= 2) return tight;
    return withHud.slice(0, 4).sort((a, b) => a.time - b.time);
  }

  const confirmedHud = (hudEvents || []).filter(isConfirmedHudKill);
  if (confirmedHud.length >= 2) {
    const nearCluster = confirmedHud
      .filter((e) => e.time >= cluster.start - 6 && e.time <= cluster.end + 14)
      .sort((a, b) => a.time - b.time);
    if (nearCluster.length >= 2) {
      return dedupeKillPeaks(nearCluster.map(hudEventToPeak));
    }
  }

  const withoutHud = scored.filter((s) => !s.hud).map((s) => s.peak);
  return peaksWithinMaxGap([...withHud, ...withoutHud].slice(0, 4).sort((a, b) => a.time - b.time));
}

/** Prefer HUD-confirmed kills — audio/defuse spikes must not replace real frags. */
function pickMontagePeaks(cluster, hudEvents, timeline) {
  const confirmed = (hudEvents || []).filter(isConfirmedHudKill);
  if (confirmed.length >= 2) {
    const inRange = confirmed
      .filter((e) => e.time >= cluster.start - 3 && e.time <= cluster.end + 8)
      .sort((a, b) => a.time - b.time);
    if (inRange.length >= 2) {
      const peaks = dedupeKillPeaks(
        dedupeHudKillEvents(inRange).map(hudEventToPeak),
      );
      const tight = peaksWithinMaxGap(peaks);
      if (tight.length >= 2) return dedupeKillPeaks(tight);
    }

    const inWide = confirmed
      .filter((e) => e.time >= cluster.start - 5 && e.time <= cluster.end + 18)
      .sort((a, b) => a.time - b.time);
    if (inWide.length >= 2) {
      const peaks = dedupeKillPeaks(
        dedupeHudKillEvents(inWide).map(hudEventToPeak),
      );
      const tight = peaksWithinMaxGap(peaks);
      if (tight.length >= 2) return dedupeKillPeaks(tight);
    }
  }

  const transcriptPeaks = findTranscriptKillPeaks(
    timeline,
    cluster.start - 4,
    cluster.end + 10,
  );
  if (transcriptPeaks.length >= 2) {
    const tight = peaksWithinMaxGap(transcriptPeaks);
    if (tight.length >= 2) return tight.slice(0, 4);
    return transcriptPeaks.slice(0, 4);
  }

  return pickMontagePeaksAudio(cluster, confirmed.length ? confirmed : hudEvents);
}

export function buildShooterMontageWindow(cluster, videoDuration, timeline, scoringOpts = {}) {
  const profile = scoringOpts.profile;
  const audioScan = scoringOpts.audioScan;
  const hudEvents = scoringOpts.killFeedEvents || [];
  if (!cluster?.peaks?.length || cluster.peaks.length < 2) return null;

  let selected = dedupeKillPeaks(
    pickMontagePeaks(cluster, hudEvents, timeline),
    undefined,
    MAX_MONTAGE_KILL_SEGMENTS,
  );
  selected = selected.map((p) => {
    if (p.source !== 'hud' && p.roi !== 'bottom_kills') return p;
    const hudTime = resolveHudKillAnchor(p.time, p.roi);
    return { ...p, time: hudTime, hudKillTime: hudTime, snappedGunshot: true };
  });

  const hudConfirmed = hudConfirmedPeaks(selected, hudEvents, 3.5);

  const hudPeaks = selected.filter((p) => p.source === 'hud' || p.roi === 'bottom_kills');
  const timingProfile =
    selected.length === 1
      ? { ...KILL_ONLY_TIMING, segAfter: 8, clipAfter: 8, maxSegDur: 10, minSegDur: 8 }
      : hudPeaks.length >= 2
        ? HUD_KILL_TIMING
        : KILL_ONLY_TIMING;

  let built =
    hudPeaks.length >= 2
      ? buildHudKillMontageSegments(
          hudPeaks.map((p) => ({
            time: p.hudKillTime ?? p.time,
            confidence: p.confidence ?? 0.6,
            roi: p.roi,
          })),
          videoDuration,
          timingProfile,
        )
      : buildMontageSegmentsFromPeaks(selected, videoDuration, timingProfile);
  if (!built) return null;

  const hudCount = hudEvents.filter(isConfirmedHudKill).length;
  if (hudCount >= 3 && hudConfirmed < 2) return null;

  const proposal = {
    montage_segments: built.montage_segments,
    montage_kill_count: built.montage_kill_count,
  };
  if (!isCoherentKillMontage(proposal)) return null;

  built = maybeAppendPayoff(built, timeline, audioScan, videoDuration, { hudConfirmed });

  const { montage_segments, output_duration, source_span_start, source_span_end } = built;
  const spanStart = source_span_start;
  const spanEnd = source_span_end;
  const hookPeak = selected[selected.length - 1].time;

  const keywordHits = killKeywordHits(timeline, spanStart, spanEnd);
  const audioStats = audioScan ? windowAudioStats(audioScan, spanStart, spanEnd) : null;
  const audioDelta = audioStats
    ? windowAudioScore(audioStats, profile?.audioWeight ?? 1.35) + 60
    : 50;
  const hud = hudWindowBoost(hudEvents, spanStart, spanEnd);

  const peakLine =
    findPeakLineNear(timeline, hookPeak) ||
    hudEvents.find((e) => e.text && e.time >= spanStart && e.time <= spanEnd)?.text?.slice(0, 72) ||
    `${cluster.peakCount}-kill chain`;
  const setupLine = findPeakLineNear(timeline, selected[0].time) || '';

  const composite =
    280 +
    cluster.peakCount * 45 +
    keywordHits * 15 +
    audioDelta +
    hud.boost +
    hudConfirmed * 30 +
    montage_segments.length * 25 +
    (cluster.maxStrength >= 8 ? 50 : 25);

  return finalizeMontageHighlight({
    start: spanStart,
    end: spanEnd,
    composite,
    peak: 18 + cluster.peakCount * 4 + hud.kills * 3,
    total: composite * 0.4,
    density: cluster.peakCount * 3,
    arcLabel: 'multikill-montage',
    audioDelta,
    hudBoost: hud.boost,
    hudKills: hud.kills,
    audioPeakTime: hookPeak,
    audioMaxDelta: audioStats?.maxDelta ?? cluster.maxStrength,
    hypeMoment: hud.kills >= 2 || hudConfirmed >= 2 || cluster.peakCount >= 3,
    montage_segments,
    montage_type: 'shooter_multikill',
    clip_type: 'shooter_multikill',
    output_duration,
    source_span_start: spanStart,
    source_span_end: spanEnd,
    montage_kill_count: built.montage_kill_count ?? montage_segments.length,
    peak_line: peakLine,
    setup_line: setupLine,
    tail_line: '',
    suggested_hook_peak: hookPeak,
    excerpt: `${montage_segments.length} kills · ${output_duration}s montage`,
    transcript_delta: keywordHits * 8,
    structure: { arcLabel: 'multikill-montage', monologuePenalty: 0 },
  });
}

/**
 * Single extended window covering a full kill chain (fallback / simpler clip).
 */
export function buildShooterClusterWindow(cluster, videoDuration, timeline, scoringOpts = {}) {
  const profile = scoringOpts.profile;
  const audioScan = scoringOpts.audioScan;
  const hudEvents = scoringOpts.killFeedEvents || [];
  const minClip = scoringOpts.minClipSec ?? MIN_SHOOTER_MONTAGE_SEC;
  const maxClip = Math.min(45, (profile?.maxClipSec ?? 35) + 10);

  const isSingleKill = cluster.peakCount === 1;
  const padBefore = Math.min(MAX_KILL_SEG_BEFORE_SEC, 2);
  const padAfter = isSingleKill ? 8 : KILL_ONLY_TIMING.segAfter;
  const firstKill = cluster.peaks[0]?.time ?? cluster.start;
  const lastKill = cluster.peaks[cluster.peaks.length - 1]?.time ?? cluster.end;
  let start = Math.max(0, firstKill - padBefore);
  let end = Math.min(videoDuration, lastKill + padAfter);

  if (end - start < minClip && !isSingleKill) {
    end = Math.min(videoDuration, start + minClip);
  }
  if (end - start > maxClip) {
    start = Math.max(0, end - maxClip);
  }

  const audioStats = audioScan ? windowAudioStats(audioScan, start, end) : null;
  const audioDelta = audioStats
    ? windowAudioScore(audioStats, profile?.audioWeight ?? 1.35) + 35
    : 30;
  const keywordHits = killKeywordHits(timeline, start, end);
  const hud = hudWindowBoost(hudEvents, start, end);
  const hookPeak = cluster.peaks.reduce((a, b) => (a.strength >= b.strength ? a : b)).time;

  const composite =
    80 +
    cluster.peakCount * 28 +
    keywordHits * 12 +
    audioDelta +
    hud.boost +
    cluster.maxStrength * 3;

  return {
    start,
    end,
    composite,
    peak: 14 + cluster.peakCount * 3 + hud.kills * 2,
    total: composite * 0.35,
    density: cluster.peakCount * 2.5,
    arcLabel: 'kill-chain',
    audioDelta,
    hudBoost: hud.boost,
    hudKills: hud.kills,
    audioPeakTime: hookPeak,
    audioMaxDelta: audioStats?.maxDelta ?? cluster.maxStrength,
    hypeMoment: hud.kills >= 2 || cluster.peakCount >= 3,
    peak_line: findPeakLineNear(timeline, hookPeak) || `${cluster.peakCount}-kill chain`,
    setup_line: findPeakLineNear(timeline, cluster.peaks[0].time) || '',
    tail_line: '',
    suggested_hook_peak: hookPeak,
    excerpt: `${cluster.peakCount} audio peaks in ${Math.round(end - start)}s`,
    transcript_delta: keywordHits * 6,
    structure: { arcLabel: 'kill-chain', monologuePenalty: 0 },
  };
}

function findPeakLineNear(timeline, time) {
  let best = null;
  let bestDist = Infinity;
  for (const item of timeline || []) {
    const dist = Math.abs(item.start - time);
    if (dist < bestDist && item.text) {
      bestDist = dist;
      best = item;
    }
  }
  return best && bestDist < 8 ? best.text.slice(0, 72) : '';
}

/**
 * Detect shooter kill chains and return montage + cluster window candidates.
 */
function resolveProfile(scoringOpts) {
  return scoringOpts.profile || scoringOpts.categoryProfile || null;
}

/** HUD kill-feed chains → tight jump-cut montages (primary source for CS2). */
export function buildHudKillMontages(hudEvents, videoDuration, timeline, scoringOpts = {}) {
  const quality = filterQualityHudKills(hudEvents, videoDuration, scoringOpts.audioScan, {
    channel: scoringOpts.channel,
    title: scoringOpts.title,
  });
  if (quality.length < 2) return [];

  return buildKillMontagePacks(quality, videoDuration, {
    audioScan: scoringOpts.audioScan,
  })
    .map((window) => {
      let built = {
        montage_segments: window.montage_segments,
        output_duration: window.output_duration,
        source_span_start: window.source_span_start,
        source_span_end: window.source_span_end,
        montage_kill_count: window.montage_kill_count,
        timing_profile: RED_HIGHLIGHT_KILL_TIMING,
      };
      built = maybeAppendPayoff(built, timeline, scoringOpts.audioScan, videoDuration, {
        hudConfirmed: window.montage_kill_count,
      });

      const killCount = built.montage_kill_count ?? window.montage_kill_count;
      const hookPeak =
        window.montage_segments?.[window.montage_segments.length - 1]?.peak_time ?? window.end;
      const composite = 320 + killCount * 55 + (window.confidence || 70) * 2;

      return finalizeMontageHighlight({
        start: built.source_span_start,
        end: built.source_span_end,
        composite,
        peak: 18 + killCount * 3,
        arcLabel: window.arcLabel || 'hud-kill-pack',
        hypeMoment: true,
        hudKills: killCount,
        hudBoost: killCount * 35,
        audioPeakTime: hookPeak,
        suggested_hook_peak: hookPeak,
        peak_line: window.excerpt || `${killCount} HUD kills`,
        setup_line: findPeakLineNear(timeline, window.source_span_start) || '',
        excerpt: window.excerpt || `${killCount} kills · ${built.output_duration}s montage (HUD)`,
        montage_type: 'shooter_multikill',
        montage_segments: built.montage_segments,
        output_duration: built.output_duration,
        source_span_start: built.source_span_start,
        source_span_end: built.source_span_end,
        montage_kill_count: killCount,
        has_payoff: built.has_payoff || false,
        confidence: window.confidence,
        flags: window.flags || ['hud-kills', 'hud-pack'],
      });
    })
    .filter(
      (w) =>
        (w.flags || []).some((f) => f === 'hud-chain' || f === 'hud-pack') ||
        isCoherentKillMontage(w),
    )
    .sort((a, b) => b.composite - a.composite);
}

/** @deprecated Use buildHudKillMontages */
export function buildHudKillWindows(hudEvents, videoDuration, timeline, scoringOpts = {}) {
  return buildHudKillMontages(hudEvents, videoDuration, timeline, scoringOpts);
}

export function detectShooterHighlightWindows(audioScan, timeline, videoDuration, scoringOpts = {}) {
  const profile = resolveProfile(scoringOpts);
  if (!audioScan || profile?.id !== 'shooter') return [];

  scoringOpts = { ...scoringOpts, profile };

  const hudCount = scoringOpts.killFeedEvents?.length || 0;
  const out = [];
  const seen = new Set();

  const hudMontages = buildHudKillMontages(
    scoringOpts.killFeedEvents,
    videoDuration,
    timeline,
    scoringOpts,
  );
  for (const hw of hudMontages) {
    const key = `h-${Math.floor(hw.source_span_start ?? hw.start)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(hw);
    }
  }

  const tightPeaks = findKillChainPeaks(audioScan);
  const clusters = clusterKillPeaks(tightPeaks);
  const confirmedHud = (scoringOpts.killFeedEvents || []).filter(isConfirmedHudKill).length;
  console.log(
    `[shooter] ${hudMontages.length} HUD montages, ${tightPeaks.length} audio peaks → ${clusters.length} chains` +
      (hudCount ? ` (${hudCount} HUD events, ${confirmedHud} confirmed)` : ''),
  );

  if (confirmedHud >= 4 && hudMontages.length >= 3) {
    return out.sort((a, b) => b.composite - a.composite);
  }

  for (const cluster of clusters) {
    const montage = buildShooterMontageWindow(cluster, videoDuration, timeline, scoringOpts);
    if (!montage) continue;
    if (!isCoherentKillMontage(montage)) continue;
    if (confirmedHud >= 3 && (montage.hudKills || 0) < 2) continue;
    const key = `m-${Math.floor(montage.source_span_start ?? montage.start)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(montage);
    }
  }

  if (out.length < 4 && tightPeaks.length >= 2 && hudCount < 3) {
    const sparse = buildMontageFromSparsePeaks(tightPeaks, videoDuration, timeline, scoringOpts);
    if (sparse) {
      const key = `s-${Math.floor(sparse.source_span_start ?? sparse.start)}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(sparse);
      }
    }
  }

  return out.sort((a, b) => b.composite - a.composite);
}

/** Score a transcript line for shooter kill relevance (used in timeline boost). */
export function scoreShooterKillLine(text, profile) {
  if (!KILL_KEYWORDS.test(text)) return 0;
  return scoreLine(text, 0, 1, profile) + 12;
}

/** True when window is plant/hold talk without kills. */
export function isShooterBoringWindow(timeline, start, end) {
  let boring = 0;
  let kills = 0;
  for (const item of timeline || []) {
    if (item.end < start || item.start > end) continue;
    if (SHOOTER_BORING_PATTERNS.test(item.text)) boring += 1;
    if (KILL_KEYWORDS.test(item.text)) kills += 1;
  }
  return boring >= 1 && kills === 0;
}

/**
 * Infer shooter/FPS from audio kill chains + transcript (title often wrong).
 */
/** Build montage when peaks exist but clustering failed (sparse caster audio). */
export function buildMontageFromSparsePeaks(peaks, videoDuration, timeline, scoringOpts = {}) {
  if (!peaks?.length || peaks.length < 2) return null;

  const sorted = [...peaks].sort((a, b) => b.strength - a.strength);
  const selected = [sorted[0]];

  for (let i = 1; i < sorted.length && selected.length < 5; i++) {
    const p = sorted[i];
    const span = Math.abs(p.time - selected[0].time);
    const gap = Math.abs(p.time - selected[selected.length - 1].time);
    if (span <= 75 && gap <= MAX_KILL_GAP_SEC) selected.push(p);
  }

  if (selected.length < 2) return null;
  selected.sort((a, b) => a.time - b.time);

  const cluster = {
    peaks: selected,
    peakCount: selected.length,
    start: selected[0].time,
    end: selected[selected.length - 1].time,
    maxStrength: Math.max(...selected.map((p) => p.strength)),
    score: selected.length * 35,
  };

  const montage = buildShooterMontageWindow(cluster, videoDuration, timeline, scoringOpts);
  return montage;
}

export function inferShooterFromSignals(audioScan, segments) {
  if (!audioScan) return null;

  const peaks = findKillChainPeaks(audioScan);
  const clusters = clusterKillPeaks(peaks);
  const multikillClusters = clusters.filter((c) => c.peakCount >= 2);

  let reason = '';
  if (multikillClusters.length >= 1) {
    reason = `${multikillClusters.length} kill chain(s)`;
  } else if (peaks.length >= 5) {
    reason = `${peaks.length} combat audio spikes`;
  } else {
    const text = (segments || []).map((s) => s.text || '').join(' ');
    const killHits = (text.match(new RegExp(KILL_KEYWORDS.source, 'gi')) || []).length;
    const boringHits = (text.match(new RegExp(SHOOTER_BORING_PATTERNS.source, 'gi')) || []).length;
    if (killHits >= 4 && killHits > boringHits) {
      reason = `${killHits} kill terms in transcript`;
    } else {
      return null;
    }
  }

  const text = (segments || []).map((s) => s.text || '').join(' ');
  let game = 'FPS';
  if (/\b(cs2|csgo|counter.?strike)\b/i.test(text)) game = 'Counter-Strike 2';
  else if (/\bvalorant\b/i.test(text)) game = 'Valorant';

  return { category: 'shooter', game, confidence: 82, reason };
}
