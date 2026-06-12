import { highlightFromCandidate } from './highlightCandidates.js';
import {
  finalizeMontageHighlight,
  isCoherentKillMontage,
  montagesShareKill,
} from './montageClip.js';

const MAX_CLIPS = 5;
const MIN_CLIPS = 1;
const LONG_VIDEO_SEC = 600;
const MIN_SPREAD_SEC = 90;

function overlapRatio(a, b) {
  const start = Math.max(a.start_time, b.start_time);
  const end = Math.min(a.end_time, b.end_time);
  if (end <= start) return 0;
  const overlap = end - start;
  const minLen = Math.min(a.end_time - a.start_time, b.end_time - b.start_time) || 1;
  return overlap / minLen;
}

function isHudChain(candidate) {
  return (
    (candidate.flags || []).includes('hud-chain') ||
    (candidate.flags || []).includes('hud-pack') ||
    candidate.arc_label === 'hud-kill-chain' ||
    candidate.arc_label === 'hud-kill-pack'
  );
}

function tooClose(a, b, minGap) {
  if (isHudChain(a) && isHudChain(b)) {
    return montagesShareKill(a, b);
  }
  if (overlapRatio(a, b) > 0.35) return true;
  return Math.abs(a.start_time - b.start_time) < minGap;
}

function buildShooterTitle(candidate, outputLanguage) {
  const cuts =
    candidate.montage_kill_count ||
    candidate.montage_segments?.filter((s) => s.segment_type !== 'payoff').length ||
    candidate.montage_segments?.length ||
    2;
  const hud = (candidate.flags || []).includes('hud-kills') || (candidate.flags || []).includes('kill-feed');
  if (outputLanguage === 'de') {
    return hud
      ? `${cuts} Kills — Montage`.slice(0, 60)
      : `${cuts}-Kill Action Montage`.slice(0, 60);
  }
  return hud ? `${cuts}-Kill HUD Montage`.slice(0, 60) : `${cuts}-Kill Montage`.slice(0, 60);
}

function montageViralScore(candidate) {
  const segs =
    candidate.montage_segments?.filter((s) => s.segment_type !== 'payoff') ||
    candidate.montage_segments ||
    [];
  const killCount = segs.length || candidate.montage_kill_count || 2;
  const avgConf =
    segs.reduce((sum, seg) => sum + (seg.confidence ?? candidate.confidence ?? 0.55), 0) /
    Math.max(1, killCount);
  const hudBacked = (candidate.flags || []).some(
    (f) => f === 'hud-kills' || f === 'hud-pack' || f === 'hud-chain',
  );
  const base = hudBacked ? 4.5 + avgConf * 2.5 : 4 + avgConf * 2;
  return Math.min(8, Math.max(4, Math.round(base + killCount * 0.2)));
}

function candidateToHighlight(c, index, segments, outputLanguage) {
  const title = buildShooterTitle(c, outputLanguage);
  const base = highlightFromCandidate(
    c,
    {
      title,
      viral_score: montageViralScore(c),
      reason: c.excerpt || title,
    },
    index,
    outputLanguage,
  );
  if (!base) return null;

  return finalizeMontageHighlight({
    ...base,
    montage_segments: c.montage_segments,
    montage_type: c.montage_type,
    clip_type: c.montage_type,
    output_duration: c.output_duration,
    source_span_start: c.source_span_start,
    source_span_end: c.source_span_end,
    montage_kill_count: c.montage_kill_count,
    has_payoff: c.has_payoff || false,
    cold_open: false,
    flags: c.flags,
    excerpt: c.excerpt,
    arc_label: c.arc_label,
    zoom_moments: c.montage_segments?.map((s) => s.peak_time).filter(Boolean) || [],
  });
}

/**
 * Shooter/FPS: pick ONLY jump-cut kill montages — never plant/hold/transcript windows.
 */
export function selectShooterHighlights(candidates, segments, duration, options = {}) {
  const { urlFocusSec, outputLanguage = 'de' } = options;
  const minGap = duration > LONG_VIDEO_SEC ? MIN_SPREAD_SEC : 22;
  const focusRadius = 420;

  const killCount = (c) =>
    c.montage_kill_count ||
    c.montage_segments?.filter((s) => s.segment_type !== 'payoff').length ||
    c.montage_segments?.length ||
    0;

  const montages = [...candidates]
    .filter((c) => {
      if (c.montage_type !== 'shooter_multikill' || c.montage_segments?.length < 2) return false;
      return isCoherentKillMontage(c);
    })
    .sort((a, b) => {
      const killsA = killCount(a);
      const killsB = killCount(b);
      if (killsB !== killsA) return killsB - killsA;

      const durA = a.output_duration || 0;
      const durB = b.output_duration || 0;
      if (durB !== durA) return durB - durA;

      const hudA = (a.flags || []).includes('hud-kills') || (a.flags || []).includes('kill-feed') ? 1 : 0;
      const hudB = (b.flags || []).includes('hud-kills') || (b.flags || []).includes('kill-feed') ? 1 : 0;
      if (hudB !== hudA) return hudB - hudA;

      let scoreA = a.local_score || 0;
      let scoreB = b.local_score || 0;
      if (urlFocusSec != null) {
        if (Math.abs(a.start_time - urlFocusSec) < focusRadius) scoreA += 40;
        if (Math.abs(b.start_time - urlFocusSec) < focusRadius) scoreB += 40;
      }
      return scoreB - scoreA;
    });

  const hudChains = montages.filter((c) => isHudChain(c));
  const pool = hudChains.length >= 2 ? hudChains : montages;

  const kept = [];
  for (const c of pool) {
    if (kept.length >= MAX_CLIPS) break;
    const proposal = candidateToHighlight(c, kept.length, segments, outputLanguage);
    if (!proposal) continue;
    if (kept.some((k) => tooClose(k, proposal, minGap))) {
      console.log(
        `[shooter-select] skip duplicate pack: ${c.excerpt || c.id} (overlaps kept clip)`,
      );
      continue;
    }
    kept.push({
      ...proposal,
      confidence: Math.min(99, c.confidence || 88),
      candidate_id: c.list_index,
    });
  }

  console.log(
    `[shooter-select] ${pool.length}/${montages.length} montage candidates → ${kept.length} clips` +
      (kept.length < MIN_CLIPS ? ' (no plant/hold fallback)' : ''),
  );

  return kept.slice(0, MAX_CLIPS).map((h, i) => ({
    ...h,
    id: `hl-${i}-${Math.random().toString(36).slice(2, 8)}`,
  }));
}
