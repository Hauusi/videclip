import { resolveIntelligentHook } from './intelligentHook.js';
import { scoreLine, highlightFromCandidate } from './highlightCandidates.js';
import { isShooterContent } from './gameCategory.js';

const MIN_QUALITY_SCORE = 8;
const LONG_VIDEO_SEC = 600;
const MIN_SPREAD_SEC = 90;
const MIN_CLIPS = 3;
const MAX_CLIPS = 5;
const STRONG_CONFIDENCE = 62;
const MIN_CONFIDENCE = 42;

function segStart(seg) {
  return Number(seg.offset ?? seg.start ?? 0);
}

function scoreHighlightWindow(segments, start, end) {
  if (!segments?.length) return 0;

  let total = 0;
  let count = 0;
  let peak = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const t = segStart(seg);
    if (t < start || t > end) continue;
    const prev = segments[i - 1];
    const gap =
      prev && segStart(prev) < start
        ? 0
        : prev
          ? Math.max(0, t - (segStart(prev) + Number(prev.duration || 0.5)))
          : 0;
    const segDur = Number(seg.duration || 0.5);
    const s = scoreLine(String(seg.text || ''), gap, segDur);
    total += s;
    peak = Math.max(peak, s);
    count += 1;
  }

  if (!count) return 0;
  return peak * 2 + total / Math.max(count, 1);
}

function overlapRatio(a, b) {
  const start = Math.max(a.start_time, b.start_time);
  const end = Math.min(a.end_time, b.end_time);
  if (end <= start) return 0;
  const overlap = end - start;
  const minLen = Math.min(a.end_time - a.start_time, b.end_time - b.start_time) || 1;
  return overlap / minLen;
}

function tooClose(a, b, minGap) {
  if (overlapRatio(a, b) > 0.35) return true;
  return Math.abs(a.start_time - b.start_time) < minGap;
}

function candidateToHighlight(c, index, segments) {
  const base = highlightFromCandidate(c, {}, index);
  if (!base) return null;

  if (segments?.length) {
    const resolved = { ...base, ...resolveIntelligentHook(segments, base) };
    return {
      ...resolved,
      zoom_moments: [resolved.hook_peak_time],
      local_score: c.local_score,
    };
  }

  return base;
}

function attachConfidence(h, candidates) {
  const match = candidates.find(
    (c) =>
      c.list_index === h.candidate_id ||
      overlapRatio(c, h) > 0.5 ||
      Math.abs(c.start_time - h.start_time) < 4,
  );
  const confidence = h.confidence ?? match?.confidence ?? 50;
  const viral_score =
    h.viral_score ??
    Math.min(10, 6 + Math.floor(((match?.local_score || 0) / Math.max(candidates[0]?.local_score || 1, 1)) * 4));

  return {
    ...h,
    confidence,
    viral_score,
    local_score: undefined,
  };
}

function isStrongPick(h, quality, candidates) {
  const conf = h.confidence ?? 0;
  const match = candidates.find((c) => c.list_index === h.candidate_id);
  const localScore = match?.local_score || 0;
  const topScore = candidates[0]?.local_score || 1;
  const relative = localScore / topScore;

  // Loud genuine moments pass even when caption text is sparse (low text quality)
  const montageStrong =
    match?.montage_type === 'shooter_multikill' ||
    match?.flags?.includes('multikill-montage') ||
    match?.flags?.includes('kill-chain') ||
    match?.flags?.includes('hud-kills') ||
    match?.flags?.includes('kill-feed');
  const audioStrong =
    montageStrong ||
    (match?.audio_boost || 0) >= 60 ||
    match?.flags?.includes('hype-moment');

  return (
    (quality >= MIN_QUALITY_SCORE || audioStrong) &&
    (conf >= STRONG_CONFIDENCE || relative >= 0.72 || audioStrong)
  );
}

/**
 * Drop weak picks, enforce spread, return 3–5 strong clips (quality floor for SaaS trust).
 */
export function finalizeHighlights(
  claudeHighlights,
  candidates,
  segments,
  duration,
  urlFocusSec,
  { contentCategory, categoryProfile } = {},
) {
  const minGap = duration > LONG_VIDEO_SEC ? MIN_SPREAD_SEC : 22;
  const focusRadius = 420;
  const isShooter = isShooterContent({ category: contentCategory, profile: categoryProfile });

  const scorePick = (h) => {
    let score = scoreHighlightWindow(segments, h.start_time, h.end_time);
    const match = candidates.find(
      (c) =>
        c.list_index === h.candidate_id ||
        overlapRatio(c, h) > 0.25 ||
        Math.abs(c.start_time - h.start_time) < 8,
    );
    if (match) {
      score += match.local_score * 0.15;
      score += (match.audio_boost || 0) * 0.5;
      if (match.flags?.includes('hype-moment')) score += 30;
      if (match.flags?.includes('multikill-montage')) score += 45;
      if (match.flags?.includes('kill-chain')) score += 25;
      if (match.flags?.includes('hud-kills')) score += 40;
      if (match.flags?.includes('kill-feed')) score += 30;
    }
    if (urlFocusSec != null && Math.abs(h.start_time - urlFocusSec) < focusRadius) {
      score += 25;
    }
    return score;
  };

  const ranked = [...claudeHighlights]
    .map((h) => ({ h: attachConfidence(h, candidates), quality: scorePick(h) }))
    .sort((a, b) => b.quality - a.quality || (b.h.confidence || 0) - (a.h.confidence || 0));

  const kept = [];

  if (isShooter) {
    const montages = [...candidates]
      .filter((c) => c.montage_type === 'shooter_multikill' && c.montage_segments?.length >= 2)
      .sort((a, b) => b.local_score - a.local_score);

    for (const c of montages) {
      if (kept.length >= MAX_CLIPS) break;
      const proposal = candidateToHighlight(c, kept.length, segments);
      if (!proposal || kept.some((k) => tooClose(k, proposal, minGap))) continue;
      kept.push(proposal);
    }
  }

  for (const { h, quality } of ranked) {
    if (kept.length >= MAX_CLIPS) break;
    if (isShooter) {
      const match = candidates.find((c) => c.list_index === h.candidate_id);
      const isMontage = match?.montage_type === 'shooter_multikill';
      const hasKills =
        isMontage ||
        match?.flags?.includes('hud-kills') ||
        match?.flags?.includes('kill-feed') ||
        match?.flags?.includes('multikill-montage');
      if (!hasKills) continue;
    }
    if (!isStrongPick(h, quality, candidates)) continue;
    if (kept.some((k) => tooClose(k, h, minGap))) continue;
    if (kept.some((k) => k.candidate_id === h.candidate_id)) continue;
    kept.push(h);
  }

  if (kept.length < MIN_CLIPS && !isShooter) {
    for (const { h, quality } of ranked) {
      if (kept.length >= MIN_CLIPS) break;
      if (quality < MIN_QUALITY_SCORE) continue;
      if ((h.confidence || 0) < MIN_CONFIDENCE) continue;
      if (kept.some((k) => tooClose(k, h, minGap))) continue;
      if (kept.some((k) => k.candidate_id === h.candidate_id)) continue;
      kept.push(h);
    }
  }

  const usedStarts = new Set(kept.map((h) => Math.floor(h.start_time / 30)));
  const unusedCandidates = [...candidates].sort((a, b) => b.local_score - a.local_score);

  for (const c of unusedCandidates) {
    if (kept.length >= MAX_CLIPS) break;
    if (isShooter && c.montage_type !== 'shooter_multikill') continue;
    const bucket = Math.floor(c.start_time / 30);
    const hasBucket = [...usedStarts].some((b) => Math.abs(b - bucket) < 3);
    if (duration > LONG_VIDEO_SEC && kept.length >= MIN_CLIPS && hasBucket) continue;

    const proposal = candidateToHighlight(c, kept.length, segments);
    if (!proposal || kept.some((k) => tooClose(k, proposal, minGap))) continue;
    if (
      !isShooter &&
      scoreHighlightWindow(segments, proposal.start_time, proposal.end_time) < MIN_QUALITY_SCORE
    ) {
      continue;
    }
    if ((proposal.confidence || 0) < MIN_CONFIDENCE && kept.length >= MIN_CLIPS) continue;

    kept.push(proposal);
    usedStarts.add(bucket);
  }

  if (kept.length < MIN_CLIPS && !isShooter) {
    for (const c of unusedCandidates) {
      if (kept.length >= MIN_CLIPS) break;
      const proposal = candidateToHighlight(c, kept.length, segments);
      if (!proposal || kept.some((k) => tooClose(k, proposal, minGap))) continue;
      kept.push(proposal);
    }
  }

  return kept.slice(0, MAX_CLIPS).map((h, i) => ({
    ...attachConfidence(h, candidates),
    id: `hl-${i}-${Math.random().toString(36).slice(2, 8)}`,
  }));
}
