import { findCliffhangerHint } from './intelligentHook.js';
import {
  computeDynamicEnd,
  computeDynamicWindow,
  logDynamicWindow,
} from './dynamicClipLength.js';
import {
  scoreLine,
  NEGATIVE_PATTERNS,
  scoreWindowStructure,
  transcriptStructureDelta,
} from './multiSignalScore.js';
import { findAudioPeaks, windowAudioStats, windowAudioScore } from './audioEnergyScan.js';
import {
  detectShooterHighlightWindows,
  filterQualityHudKills,
  isConfirmedHudKill,
  isShooterBoringWindow,
  KILL_KEYWORDS,
} from './shooterClusters.js';
import { hudWindowBoost } from './hudKillFeed.js';
import {
  buildKillMontagePacks,
  finalizeMontageHighlight,
  isCoherentKillMontage,
  isMontageHighlight,
  sortCandidatesByMontageKillCount,
  sumMontageDuration,
} from './montageClip.js';

export { scoreLine, NEGATIVE_PATTERNS };

const MIN_CLIP_SEC = 12;
const MAX_CLIP_SEC = 45;
const TARGET_CLIP_SEC = 28;
const MAX_RAW_CANDIDATES = 28;
const CLAUDE_POOL_SIZE = 12;
const MIN_CANDIDATES = 8;
const PER_THIRD_MAX = 6;
const WINDOW_SHIFT_STEP = 2;
const WINDOW_SHIFT_MAX = 8;

const SETUP_PATTERNS = [/\?/, /\b(warum|why|how|wieso|wait|warte)\b/i];

function segStart(seg) {
  return Number(seg.offset ?? seg.start ?? 0);
}

function segEnd(seg) {
  return segStart(seg) + Number(seg.duration || 0.5);
}

/** Parse chapter-like timestamps from video description. */
export function extractChapterAnchors(description, videoDuration) {
  if (!description) return [];

  const anchors = [];
  const lineRe = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*[-–—:]\s*([^\n]+)/gi;
  let match;

  while ((match = lineRe.exec(description)) !== null) {
    const h = match[3] ? parseInt(match[1], 10) : 0;
    const m = match[3] ? parseInt(match[2], 10) : parseInt(match[1], 10);
    const s = match[3] ? parseInt(match[3], 10) : parseInt(match[2], 10);
    const seconds = h * 3600 + m * 60 + s;
    if (seconds >= 0 && seconds < videoDuration) {
      anchors.push({ time: seconds, label: match[4].trim().slice(0, 80) });
    }
  }

  return anchors;
}

function resolveScoringOpts(options = {}) {
  const profile = options.categoryProfile || null;
  return {
    profile,
    audioScan: options.audioScan || null,
    killFeedEvents: options.killFeedEvents || [],
    channel: options.channel || '',
    title: options.title || '',
    minClipSec: profile?.minClipSec ?? MIN_CLIP_SEC,
    maxClipSec: profile?.maxClipSec ?? MAX_CLIP_SEC,
  };
}

function buildScoredTimeline(segments, scoringOpts = {}) {
  const profile = scoringOpts.profile || null;
  const timeline = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const text = String(seg.text || '').trim();
    if (!text) continue;

    const start = segStart(seg);
    const prevEnd = i > 0 ? segEnd(segments[i - 1]) : start;
    const gap = Math.max(0, start - prevEnd);
    const segDur = Math.max(0.3, segEnd(seg) - start);
    const score = scoreLine(text, gap, segDur, profile);

    timeline.push({
      start,
      end: segEnd(seg),
      text,
      score,
      duration: segDur,
    });
  }

  return timeline;
}

function itemsInWindow(timeline, windowStart, windowEnd) {
  return timeline.filter((item) => item.end >= windowStart && item.start <= windowEnd);
}

function windowScore(timeline, windowStart, windowEnd) {
  let total = 0;
  let peak = 0;
  const textParts = [];

  for (const item of timeline) {
    if (item.end < windowStart || item.start > windowEnd) continue;
    total += item.score;
    peak = Math.max(peak, item.score);
    if (item.score > 2) textParts.push(item.text);
  }

  const duration = windowEnd - windowStart;
  const density = total / Math.max(duration / 10, 1);

  return {
    total,
    peak,
    density,
    excerpt: textParts.slice(0, 6).join(' ').slice(0, 220),
  };
}

/** Setup in first half + payoff in second half (clip body quality, not scroll-stop). */
function scoreArcQuality(timeline, windowStart, windowEnd) {
  const mid = windowStart + (windowEnd - windowStart) * 0.5;
  const items = itemsInWindow(timeline, windowStart, windowEnd);
  if (!items.length) return { arcScore: 0, arcLabel: 'none' };

  let firstTotal = 0;
  let firstCount = 0;
  let secondTotal = 0;
  let secondPeak = 0;
  let hasSetup = false;

  for (const item of items) {
    if (item.start < mid) {
      firstTotal += item.score;
      firstCount += 1;
      if (SETUP_PATTERNS.some((re) => re.test(item.text))) hasSetup = true;
    } else {
      secondTotal += item.score;
      secondPeak = Math.max(secondPeak, item.score);
    }
  }

  const firstAvg = firstCount ? firstTotal / firstCount : 0;
  let arcScore = 0;
  let arcLabel = 'flat';

  if (secondPeak >= 8 && secondPeak >= firstAvg * 0.7) {
    arcScore += 12;
    arcLabel = hasSetup ? 'setup→payoff' : 'payoff';
  }
  if (hasSetup && secondPeak >= 6) {
    arcScore += 6;
    arcLabel = 'setup→payoff';
  }
  if (firstAvg > 4 && secondTotal < firstTotal * 0.4) {
    arcScore -= 10;
    arcLabel = 'weak-tail';
  }

  return { arcScore, arcLabel };
}

/** Penalize long dead gaps in the middle of the clip (not at start — hook handles that). */
function scoreMidClipDeadZone(timeline, windowStart, windowEnd) {
  const innerStart = windowStart + (windowEnd - windowStart) * 0.25;
  const innerEnd = windowStart + (windowEnd - windowStart) * 0.75;
  const inner = itemsInWindow(timeline, innerStart, innerEnd).sort((a, b) => a.start - b.start);

  let penalty = 0;
  for (let i = 1; i < inner.length; i++) {
    const gap = inner[i].start - inner[i - 1].end;
    if (gap > 4) penalty += Math.min(15, (gap - 4) * 3);
  }
  return penalty;
}

function findPeakInRange(timeline, center, radiusSec) {
  let best = null;
  let bestScore = -Infinity;

  for (const item of timeline) {
    if (item.start < center - radiusSec || item.start > center + radiusSec) continue;
    if (item.score > bestScore) {
      bestScore = item.score;
      best = item;
    }
  }

  return best;
}

function extractDossierLines(timeline, start, end, peakTime) {
  const items = itemsInWindow(timeline, start, end).sort((a, b) => a.start - b.start);
  if (!items.length) {
    return { setup_line: '', peak_line: '', tail_line: '' };
  }

  const peakItem =
    items.find((it) => Math.abs(it.start - peakTime) < 1.5) ||
    items.reduce((a, b) => (a.score >= b.score ? a : b));

  const beforePeak = items.filter((it) => it.start < peakItem.start - 0.3);
  const afterPeak = items.filter((it) => it.start > peakItem.start + 0.3);

  const setup_line = (beforePeak.slice(-2).map((i) => i.text).join(' ') || items[0]?.text || '').slice(
    0,
    72,
  );
  const peak_line = (peakItem?.text || '').slice(0, 72);
  const tail_line = (afterPeak.slice(0, 2).map((i) => i.text).join(' ') || '').slice(0, 72);

  return { setup_line, peak_line, tail_line };
}

function scoreFullWindow(timeline, start, end, scoringOpts = {}) {
  const profile = scoringOpts.profile || null;
  const base = windowScore(timeline, start, end);
  const { arcScore, arcLabel: legacyArc } = scoreArcQuality(timeline, start, end);
  const structure = scoreWindowStructure(timeline, start, end, profile);
  const transcriptDelta = transcriptStructureDelta(structure, profile);
  const deadPenalty = scoreMidClipDeadZone(timeline, start, end);

  let negativeHits = 0;
  for (const item of itemsInWindow(timeline, start, end)) {
    for (const pattern of NEGATIVE_PATTERNS) {
      if (pattern.test(item.text)) negativeHits += 1;
    }
  }

  const arcLabel =
    structure.arcLabel && structure.arcLabel !== 'flat' ? structure.arcLabel : legacyArc;

  // Audio energy is the strongest "real moment" signal — weighted to outrank
  // calm talk windows even when their transcript scores look good.
  let audioDelta = 0;
  let audioPeakTime = null;
  let audioMaxDelta = 0;
  let hypeMoment = false;

  if (scoringOpts.audioScan) {
    const stats = windowAudioStats(scoringOpts.audioScan, start, end);
    audioMaxDelta = stats.maxDelta;
    audioDelta = windowAudioScore(stats, profile?.audioWeight ?? 1);
    audioPeakTime = stats.peakTime;

    if (stats.maxDelta >= 5) {
      const nearReaction = itemsInWindow(
        timeline,
        stats.peakTime - 6,
        stats.peakTime + 6,
      ).some((it) => it.score >= 8 || /!|\?/.test(it.text));
      if (nearReaction) {
        audioDelta += 50;
        hypeMoment = true;
      }
    }
    // Flat-audio windows (calm talking) lose ground vs. spike windows
    if (stats.maxDelta < 2 && stats.avgDelta < 0.5) {
      audioDelta -= 25;
    }
  }

  let hudDelta = 0;
  let hudKills = 0;
  if (scoringOpts.killFeedEvents?.length) {
    const hud = hudWindowBoost(scoringOpts.killFeedEvents, start, end);
    hudDelta = hud.boost;
    hudKills = hud.kills;
    if (hud.kills === 0 && scoringOpts.profile?.id === 'shooter' && audioDelta > 40) {
      audioDelta -= 35;
    }
  }

  let boringPenalty = 0;
  if (scoringOpts.profile?.id === 'shooter') {
    if (isShooterBoringWindow(timeline, start, end)) {
      boringPenalty = 120;
    } else if (hudKills === 0 && !windowHasKillSignals(timeline, start, end, audioMaxDelta)) {
      boringPenalty = 80;
    }
  }

  const composite =
    base.total +
    base.peak * 3 +
    base.density * 4 +
    arcScore * 0.6 +
    transcriptDelta +
    audioDelta +
    hudDelta -
    deadPenalty -
    boringPenalty -
    negativeHits * 20;

  return {
    ...base,
    arcScore,
    arcLabel,
    deadPenalty,
    structure,
    transcript_delta: transcriptDelta,
    audioDelta,
    hudDelta,
    hudKills,
    audioPeakTime,
    audioMaxDelta,
    hypeMoment: hypeMoment || hudKills >= 2,
    composite,
  };
}

function baseWindowAroundPeak(peakTime, videoDuration, timeline = null, scoringOpts = {}) {
  const { minClipSec, maxClipSec } = scoringOpts;
  if (timeline?.length) {
    const window = computeDynamicWindow(timeline, peakTime, videoDuration, {
      minSec: minClipSec ?? MIN_CLIP_SEC,
      maxSec: maxClipSec ?? MAX_CLIP_SEC,
    });
    logDynamicWindow(peakTime, window);
    return { start: window.start, end: window.end };
  }

  let end = Math.min(videoDuration, peakTime + 8);
  let start = Math.max(0, end - TARGET_CLIP_SEC);

  const minClip = minClipSec ?? MIN_CLIP_SEC;
  const maxClip = maxClipSec ?? MAX_CLIP_SEC;

  if (end - start < minClip) {
    start = Math.max(0, peakTime - 6);
    end = Math.min(videoDuration, start + TARGET_CLIP_SEC);
  }
  if (end - start > maxClip) {
    start = end - maxClip;
  }

  return { start, end };
}

/** Slide window ±8s to maximize arc + payoff score. */
function optimizeWindowAroundPeak(peakTime, videoDuration, timeline, scoringOpts = {}) {
  const minClip = scoringOpts.minClipSec ?? MIN_CLIP_SEC;
  const maxClip = scoringOpts.maxClipSec ?? MAX_CLIP_SEC;
  const base = baseWindowAroundPeak(peakTime, videoDuration, timeline, scoringOpts);
  let best = {
    start: base.start,
    end: base.end,
    metrics: scoreFullWindow(timeline, base.start, base.end, scoringOpts),
  };

  for (let shift = -WINDOW_SHIFT_MAX; shift <= WINDOW_SHIFT_MAX; shift += WINDOW_SHIFT_STEP) {
    if (shift === 0) continue;

    let start = base.start + shift;
    if (start < 0) start = 0;

    let end = timeline?.length
      ? computeDynamicEnd(timeline, peakTime, start, videoDuration, {
          minSec: minClip,
          maxSec: maxClip,
        })
      : base.end + shift;

    if (end > videoDuration) {
      end = videoDuration;
      start = Math.max(0, end - minClip);
    }
    if (end - start < minClip) continue;
    if (end - start > maxClip) {
      start = end - maxClip;
    }

    const metrics = scoreFullWindow(timeline, start, end, scoringOpts);
    if (metrics.composite > best.metrics.composite) {
      best = { start, end, metrics };
    }
  }

  const peakInWindow = findPeakInRange(timeline, (best.start + best.end) / 2, (best.end - best.start) / 2);
  let hookPeak = peakInWindow?.start ?? peakTime;
  // Loud audio spike beats text peak as the hook moment (scream > sentence)
  if (
    best.metrics.audioPeakTime != null &&
    best.metrics.audioMaxDelta >= 6 &&
    best.metrics.audioPeakTime >= best.start &&
    best.metrics.audioPeakTime <= best.end
  ) {
    hookPeak = best.metrics.audioPeakTime;
  }
  const cliffLine = findCliffhangerHint(timeline, best.start, best.end, hookPeak);
  const dossier = extractDossierLines(timeline, best.start, best.end, hookPeak);

  return {
    start: best.start,
    end: best.end,
    ...best.metrics,
    suggested_hook_peak: hookPeak,
    peak_line: dossier.peak_line || peakInWindow?.text || '',
    setup_line: dossier.setup_line,
    tail_line: dossier.tail_line,
    cliff_line: cliffLine,
  };
}

function pickWindowAroundAnchor(anchorTime, videoDuration, timeline, scoringOpts = {}) {
  const peak =
    findPeakInRange(timeline, anchorTime, 18) || findPeakInRange(timeline, anchorTime, 45);
  const peakTime = peak?.start ?? anchorTime;
  return optimizeWindowAroundPeak(peakTime, videoDuration, timeline, scoringOpts);
}

function windowHasKillSignals(timeline, start, end, audioMaxDelta = 0) {
  let killHits = 0;
  for (const item of itemsInWindow(timeline, start, end)) {
    if (KILL_KEYWORDS.test(item.text)) killHits += 1;
  }
  return killHits >= 1 || audioMaxDelta >= 7;
}

function isShooterWorthyCandidate(candidate, timeline, scoringOpts) {
  if (scoringOpts.profile?.id !== 'shooter') return true;
  if (candidate.montage_type === 'shooter_multikill') return true;
  if (candidate.flags?.includes('multikill-montage')) return true;
  if (candidate.flags?.includes('hud-kills') || candidate.flags?.includes('kill-feed')) return true;
  if (candidate.flags?.includes('hud-confirmed')) return true;
  if (isShooterBoringWindow(timeline, candidate.start_time, candidate.end_time)) return false;
  return windowHasKillSignals(timeline, candidate.start_time, candidate.end_time, 0);
}

function windowsOverlap(a, b, minGap = 20) {
  const overlapStart = Math.max(a.start_time ?? a.start, b.start_time ?? b.start);
  const overlapEnd = Math.min(a.end_time ?? a.end, b.end_time ?? b.end);
  if (overlapEnd > overlapStart) {
    const overlapLen = overlapEnd - overlapStart;
    const minLen =
      Math.min(
        (a.end_time ?? a.end) - (a.start_time ?? a.start),
        (b.end_time ?? b.end) - (b.start_time ?? b.start),
      ) || 1;
    if (overlapLen / minLen > 0.35) return true;
  }
  return Math.abs((a.start_time ?? a.start) - (b.start_time ?? b.start)) < minGap;
}

function buildCandidate(window, anchor, index, scoringOpts = {}) {
  const local_score = Math.round(
    window.local_score ?? window.composite ?? window.total + window.peak * 3,
  );
  const flags = [];
  if (scoringOpts.profile?.id && scoringOpts.profile.id !== 'generic') {
    flags.push(`cat:${scoringOpts.profile.id}`);
  }
  if (window.arcLabel && window.arcLabel !== 'none' && window.arcLabel !== 'flat') {
    flags.push(window.arcLabel);
  }
  if (window.peak >= 12) flags.push('high-peak');
  if ((window.deadPenalty || 0) < 3) flags.push('tight-mid');
  if (window.structure?.arcLabel === 'peak+context+reaction') flags.push('multi-signal');
  if ((window.structure?.monologuePenalty || 0) >= 12) flags.push('lore-risk');
  if ((window.transcript_delta || 0) >= 12) flags.push('reaction-arc');
  if (window.hypeMoment) flags.push('hype-moment');
  else if ((window.audioMaxDelta || 0) >= 6) flags.push('audio-peak');
  if (window.montage_type === 'shooter_multikill') flags.push('multikill-montage');
  else if (window.arcLabel === 'kill-chain') flags.push('kill-chain');
  else if (window.arcLabel === 'hud-kill-chain') flags.push('hud-confirmed');
  if ((window.hudKills || 0) >= 2) flags.push('hud-kills');
  if ((window.hudKills || 0) >= 1 && (window.hudBoost || window.hudDelta || 0) >= 25) {
    flags.push('kill-feed');
  }
  for (const f of window.flags || []) {
    if (!flags.includes(f)) flags.push(f);
  }

  const isMontage = window.montage_type === 'shooter_multikill' && window.montage_segments?.length >= 2;
  const montageMeta = isMontage
    ? finalizeMontageHighlight({
        montage_segments: window.montage_segments,
        montage_type: window.montage_type,
        clip_type: window.montage_type,
        output_duration: window.output_duration ?? sumMontageDuration(window.montage_segments),
        source_span_start: window.source_span_start ?? window.start,
        source_span_end: window.source_span_end ?? window.end,
        montage_kill_count: window.montage_kill_count ?? window.montage_segments.length,
      })
    : null;

  return {
    id: `cand-${index}`,
    start_time: montageMeta?.start_time ?? Math.round(window.start * 10) / 10,
    end_time: montageMeta?.end_time ?? Math.round(window.end * 10) / 10,
    local_score,
    output_duration: montageMeta?.output_duration,
    source_span_start: montageMeta?.source_span_start,
    source_span_end: montageMeta?.source_span_end,
    montage_kill_count: montageMeta?.montage_kill_count,
    montage_segments: window.montage_segments || null,
    montage_type: window.montage_type || null,
    audio_boost: Math.max(0, Math.round(window.audioDelta || 0)),
    excerpt: window.excerpt || '',
    chapter_hint: anchor?.chapter || null,
    suggested_hook_peak: Math.round((window.suggested_hook_peak || window.start) * 10) / 10,
    peak_line: window.peak_line || '',
    setup_line: window.setup_line || '',
    tail_line: window.tail_line || '',
    cliff_line: window.cliff_line || '',
    arc_label: window.arcLabel || 'flat',
    transcript_delta: window.transcript_delta || 0,
    flags,
    confidence: window.confidence,
  };
}

/**
 * Turn raw HUD kill events into montage candidates and merge into the pool.
 * HUD clusters win over weaker overlapping audio-only montages.
 */
function injectHudMontageCandidates(candidates, videoDuration, scoringOpts = {}) {
  const raw = scoringOpts.killFeedEvents;
  if (scoringOpts.profile?.id !== 'shooter' || !raw?.length) {
    return candidates;
  }

  const events = filterQualityHudKills(raw, videoDuration, scoringOpts.audioScan, {
    channel: scoringOpts.channel,
    title: scoringOpts.title,
  });
  const hudWindows = buildKillMontagePacks(events, videoDuration, {
    audioScan: scoringOpts.audioScan,
  });

  if (!hudWindows.length) {
    console.log(
      `[candidates] HUD→montage: 0 chains from ${events.length} confirmed events (${raw.length} raw)`,
    );
    return candidates;
  }

  const totalSegs = hudWindows.reduce((n, w) => n + (w.montage_kill_count || 0), 0);
  console.log(
    `[candidates] HUD→montage: ${hudWindows.length} chains, ${totalSegs} kill segments ` +
      `from ${events.length} confirmed HUD events (${raw.length} raw)`,
  );
  for (const w of hudWindows.slice(0, 4)) {
    const segs = (w.montage_segments || []).filter((s) => s.segment_type !== 'payoff');
    if (segs.length < 2) continue;
    const gaps = segs
      .slice(1)
      .map((s, i) => ((s.peak_time ?? s.start) - (segs[i].peak_time ?? segs[i].start)).toFixed(1));
    console.log(
      `[candidates] HUD montage preview: ${segs.length} kills, peak gaps ${gaps.join('s | ')}s`,
    );
  }

  const hudCandidates = hudWindows.map((window, i) => {
    const c = buildCandidate(window, { time: window.start, audioPeak: true }, `hud-${i}`, scoringOpts);
    if (Number.isFinite(window.confidence)) {
      c.confidence = window.confidence;
    }
    c.local_score = Math.max(c.local_score || 0, window.local_score || 0) + 120;
    return c;
  });

  const merged = [...hudCandidates];
  if (hudCandidates.length < 5) {
    for (const c of candidates) {
      if (c.montage_type !== 'shooter_multikill') continue;
      if (!isCoherentKillMontage(c)) continue;
      if (hudCandidates.some((h) => windowsOverlap(h, c))) continue;
      merged.push(c);
    }
  }

  return sortCandidatesByMontageKillCount(merged);
}

function finalizeShooterCandidatePool(candidates, videoDuration, scoringOpts) {
  const pool = injectHudMontageCandidates(candidates, videoDuration, scoringOpts);
  const montageOnly = pool.filter((c) => c.montage_type === 'shooter_multikill');
  const ranked = montageOnly.length
    ? montageOnly
    : pool.filter((c) => c.flags?.includes('hud-kills'));
  const top = sortCandidatesByMontageKillCount(ranked).slice(0, CLAUDE_POOL_SIZE);
  const maxScore = top[0]?.local_score || 1;

  return top.map((c, i) => ({
    ...c,
    id: `cand-${i}`,
    list_index: i + 1,
    confidence:
      c.confidence ?? Math.min(99, Math.round(((c.local_score || 0) / maxScore) * 100)),
  }));
}

/** Shooter montages from audio/HUD only — when YouTube transcript is unavailable. */
function findShooterSignalCandidates(videoDuration, options = {}) {
  const scoringOpts = resolveScoringOpts(options);
  const duration = Math.max(scoringOpts.minClipSec ?? MIN_CLIP_SEC, Number(videoDuration) || 300);
  if (scoringOpts.profile?.id !== 'shooter' || !scoringOpts.audioScan) return [];

  const shooterWindows = detectShooterHighlightWindows(
    scoringOpts.audioScan,
    [],
    duration,
    scoringOpts,
  );
  console.log(
    `[candidates] Shooter signal-only: ${shooterWindows.length} montage windows (no transcript)`,
  );

  const rawPool = shooterWindows.map((sw, i) => {
    const candidate = buildCandidate(sw, { time: sw.start, audioPeak: true }, i, scoringOpts);
    if (candidate.montage_type === 'shooter_multikill') {
      candidate.local_score = (candidate.local_score || 0) + 280;
    }
    return candidate;
  });

  return finalizeShooterCandidatePool(rawPool, duration, scoringOpts);
}

/**
 * Find engaging clip windows from transcript segments (no API tokens).
 * Returns up to CLAUDE_POOL_SIZE candidates for Claude ID-only ranking.
 */
export function findHighlightCandidates(segments, videoDuration, options = {}) {
  const scoringOpts = resolveScoringOpts(options);
  const minClip = scoringOpts.minClipSec;
  const duration = Math.max(minClip, Number(videoDuration) || 300);
  const chapters = options.chapterAnchors || [];

  if (!segments?.length) {
    return findShooterSignalCandidates(duration, options);
  }

  const timeline = buildScoredTimeline(segments, scoringOpts);
  if (!timeline.length) return [];

  const anchorScores = new Map();

  for (const item of timeline) {
    const key = Math.floor(item.start / 4) * 4;
    const prev = anchorScores.get(key) || { time: key, score: 0 };
    prev.score += item.score;
    anchorScores.set(key, prev);
  }

  for (const ch of chapters) {
    const key = Math.floor(ch.time / 4) * 4;
    const prev = anchorScores.get(key) || { time: ch.time, score: 0 };
    prev.score += 18;
    prev.chapter = ch.label;
    anchorScores.set(key, prev);
  }

  // Audio spikes become first-class anchors: real moments (screams, hype)
  // get candidate windows even where captions are sparse or missed.
  if (scoringOpts.audioScan) {
    const audioPeaks = findAudioPeaks(scoringOpts.audioScan, {
      minDeltaDb: 5,
      minSpacingSec: Math.max(20, minClip),
      maxPeaks: 40,
    });
    console.log(`[candidates] Audio anchors: ${audioPeaks.length} loudness peaks`);
    for (const p of audioPeaks) {
      if (p.time >= duration) continue;
      const key = Math.floor(p.time / 4) * 4;
      const prev = anchorScores.get(key) || { time: p.time, score: 0 };
      prev.score += 30 + p.strength * 6;
      prev.audioPeak = true;
      anchorScores.set(key, prev);
    }
  }

  const rankedAnchors = [...anchorScores.values()].sort((a, b) => b.score - a.score);
  const thirdLen = duration / 3;
  const buckets = [[], [], []];
  const rawPool = [];

  // Shooter: multi-kill chains → montage candidates (jump-cut kills)
  const shooterWindows = detectShooterHighlightWindows(
    scoringOpts.audioScan,
    timeline,
    duration,
    scoringOpts,
  );
  const isShooter = scoringOpts.profile?.id === 'shooter';

  for (const sw of shooterWindows) {
    const candidate = buildCandidate(sw, { time: sw.start, audioPeak: true }, rawPool.length, scoringOpts);
    if (candidate.montage_type === 'shooter_multikill') {
      candidate.local_score = (candidate.local_score || 0) + 280;
    }
    const third = Math.min(2, Math.floor(sw.start / thirdLen));
    if (buckets[third].length < PER_THIRD_MAX) buckets[third].push(candidate);
    rawPool.push(candidate);
  }

  for (const anchor of rankedAnchors) {
    if (isShooter && shooterWindows.some((sw) => sw.montage_type === 'shooter_multikill')) continue;
    // Audio anchors window directly on the loudness peak — don't snap to distant text
    const window = anchor.audioPeak
      ? optimizeWindowAroundPeak(anchor.time, duration, timeline, scoringOpts)
      : pickWindowAroundAnchor(anchor.time, duration, timeline, scoringOpts);
    if (window.end - window.start < minClip) continue;

    const candidate = buildCandidate(window, anchor, rawPool.length, scoringOpts);
    if (!isShooterWorthyCandidate(candidate, timeline, scoringOpts)) continue;
    const third = Math.min(2, Math.floor(window.start / thirdLen));
    if (buckets[third].length < PER_THIRD_MAX) {
      buckets[third].push(candidate);
    }
    rawPool.push(candidate);
    if (rawPool.length >= MAX_RAW_CANDIDATES) break;
  }

  const merged = [];
  const addCandidate = (c) => {
    if (merged.some((x) => windowsOverlap(x, c))) return;
    merged.push({ ...c, id: `cand-${merged.length}` });
  };

  for (const bucket of buckets) {
    bucket.sort((a, b) => b.local_score - a.local_score);
    for (const c of bucket) addCandidate(c);
  }

  for (const c of rawPool) {
    if (merged.length >= MAX_RAW_CANDIDATES) break;
    if (!isShooterWorthyCandidate(c, timeline, scoringOpts)) continue;
    addCandidate(c);
  }

  merged.sort((a, b) => {
    const killsA = a.montage_kill_count ?? 0;
    const killsB = b.montage_kill_count ?? 0;
    if (killsB !== killsA) return killsB - killsA;
    const montageA = a.montage_type === 'shooter_multikill' ? 1 : 0;
    const montageB = b.montage_type === 'shooter_multikill' ? 1 : 0;
    if (montageB !== montageA) return montageB - montageA;
    return b.local_score - a.local_score;
  });

  if (isShooter) {
    const montageOnly = merged.filter((c) => c.montage_type === 'shooter_multikill');
    console.log(
      `[candidates] Shooter pool: ${montageOnly.length} montages (dropped ${merged.length - montageOnly.length} non-action windows)`,
    );
    return finalizeShooterCandidatePool(merged, duration, scoringOpts);
  }

  if (merged.length < MIN_CANDIDATES) {
    const step = Math.max(30, duration / (MIN_CANDIDATES + 1));
    for (let t = step; t < duration - minClip && merged.length < MIN_CANDIDATES; t += step) {
      const window = pickWindowAroundAnchor(t, duration, timeline, scoringOpts);
      if (merged.some((c) => windowsOverlap(c, { start_time: window.start, end_time: window.end }))) {
        continue;
      }
      addCandidate(buildCandidate(window, null, merged.length, scoringOpts));
    }
  }

  const top = merged.slice(0, CLAUDE_POOL_SIZE);
  const maxScore = top[0]?.local_score || 1;

  return top.map((c, i) => ({
    ...c,
    list_index: i + 1,
    confidence: Math.min(99, Math.round((c.local_score / maxScore) * 100)),
  }));
}

/** Compact candidate dossiers for Claude (ID-only ranking). */
export function formatCandidatesForClaude(candidates) {
  return candidates
    .map((c) => {
      const flags = (c.flags || []).join(',') || 'none';
      const audio = c.audio_boost ? ` aud:+${c.audio_boost}` : '';
      const visual = c.visual_boost ? ` vis:+${c.visual_boost}` : '';
      const montage =
        c.montage_segments?.length >= 2
          ? ` MONTAGE:${c.montage_segments.length}cuts OUT:${c.output_duration ?? sumMontageDuration(c.montage_segments)}s`
          : '';
      const span =
        c.source_span_start != null
          ? ` src:${c.source_span_start}-${c.source_span_end}s`
          : '';
      const lines = [
        `#${c.list_index} ${montage ? `out:${c.output_duration ?? '?'}s` : `${c.start_time}-${c.end_time}s`}${span} L:${c.local_score} conf:${c.confidence}% arc:${c.arc_label || 'flat'}${audio}${visual}${montage}`,
        `  setup: "${(c.setup_line || c.excerpt || '').slice(0, 65)}"`,
        `  peak: "${(c.peak_line || '').slice(0, 65)}"`,
        c.tail_line ? `  tail: "${c.tail_line.slice(0, 55)}"` : null,
        `  flags: ${flags}${c.chapter_hint ? ` [${c.chapter_hint.slice(0, 28)}]` : ''}`,
      ];
      return lines.filter(Boolean).join('\n');
    })
    .join('\n');
}

/** Always return a user-visible reason (Claude sometimes omits it). */
export function ensureHighlightReason(highlight, outputLanguage = 'de') {
  const existing = String(highlight.reason || '').trim();
  if (existing.length >= 10) return existing.slice(0, 280);

  const line =
    [
      highlight.setup_line,
      highlight.peak_line,
      highlight.cliff_line,
      highlight.excerpt,
      highlight.hook,
      highlight.chapter_hint,
    ]
      .map((s) => String(s || '').trim())
      .find((s) => s.length >= 6) || '';

  if (line) {
    return line.length > 260 ? `${line.slice(0, 257)}…` : line;
  }

  const title = String(highlight.title || '').trim();
  if (title && title !== 'Top moment') {
    return outputLanguage === 'de'
      ? `Starker Moment: „${title}“ — gut geeignet für Shorts und Reels.`
      : `Strong moment: “${title}” — works well as a short.`;
  }

  const start = Number(highlight.start_time) || 0;
  const m = Math.floor(start / 60);
  const s = Math.floor(start % 60);
  const stamp = `${m}:${String(s).padStart(2, '0')}`;
  return outputLanguage === 'de'
    ? `Spannender Ausschnitt ab ${stamp} — hohe Aufmerksamkeit und klare Story erwartet.`
    : `Engaging segment from ${stamp} with clear payoff.`;
}

/** Map a numbered candidate to highlight fields (immutable timestamps). */
export function highlightFromCandidate(candidate, pick = {}, index = 0, outputLanguage = 'en') {
  if (!candidate) return null;

  const title = String(pick.title || candidate.chapter_hint || 'Top moment').slice(0, 60);
  const base = {
    start_time: candidate.start_time,
    end_time: candidate.end_time,
    title,
    hook: candidate.cliff_line || candidate.peak_line || '',
    hook_peak_time: candidate.suggested_hook_peak,
    platform_fit: Array.isArray(pick.platform_fit) ? pick.platform_fit : ['shorts', 'tiktok', 'reels'],
    viral_score: Math.min(10, Math.max(6, Number(pick.viral_score) || 7)),
    setup_line: candidate.setup_line || '',
    peak_line: candidate.peak_line || '',
    cliff_line: candidate.cliff_line || '',
    excerpt: candidate.excerpt || '',
    chapter_hint: candidate.chapter_hint || '',
  };

  const highlight = {
    id: `hl-${index}-${Math.random().toString(36).slice(2, 8)}`,
    ...base,
    reason: ensureHighlightReason(
      {
        ...base,
        reason: String(pick.reason || '').trim(),
      },
      outputLanguage,
    ),
    zoom_moments: [candidate.suggested_hook_peak],
    caption_style: ['bold', 'minimal', 'fire'].includes(pick.caption_style)
      ? pick.caption_style
      : 'bold',
    candidate_id: candidate.list_index,
    confidence: candidate.confidence,
    local_score: candidate.local_score,
    montage_segments: candidate.montage_segments || null,
    montage_type: candidate.montage_type || null,
    clip_type: candidate.montage_type || undefined,
    output_duration: candidate.output_duration,
    source_span_start: candidate.source_span_start,
    source_span_end: candidate.source_span_end,
    montage_kill_count: candidate.montage_kill_count,
    flags: candidate.flags || [],
    arc_label: candidate.arc_label,
  };

  if (isMontageHighlight(highlight)) {
    return finalizeMontageHighlight(highlight);
  }

  return highlight;
}

/**
 * Re-optimize trim window locally for a weak highlight (no API tokens).
 */
export function refineHighlightWindow(segments, highlight, videoDuration) {
  if (!segments?.length) return null;

  const timeline = buildScoredTimeline(segments);
  if (!timeline.length) return null;

  const start = Number(highlight.start_time) || 0;
  const end = Number(highlight.end_time) || start + 28;
  const peak = Number(highlight.hook_peak_time) || start + (end - start) * 0.65;
  const duration = Math.max(MIN_CLIP_SEC, Number(videoDuration) || end);

  const before = scoreFullWindow(timeline, start, end);
  const refined = optimizeWindowAroundPeak(peak, duration, timeline);

  return {
    start: refined.start,
    end: refined.end,
    hook_peak: refined.suggested_hook_peak,
    beforeScore: before.composite,
    afterScore: refined.composite,
    improved: refined.composite > before.composite + 2,
    arc_label: refined.arcLabel,
    peak_line: refined.peak_line,
  };
}
