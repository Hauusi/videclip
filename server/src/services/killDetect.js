/**
 * CS2 POV kills from two-pass kill-feed (red border + OCR anchor).
 * Clip window = -4s / +2s around anchor (see RED_HIGHLIGHT_KILL_TIMING).
 *
 * NOTE: the spawn/warmup filter lives exclusively in
 * kill_feed_pipeline.py (spawn_cutoff_sec). Do not re-add it here.
 */

import { findAudioPeaks } from './audioEnergyScan.js';
import { getHudEventTime } from './montageClip.js';

export const KILL_DETECT_TUNING = {
  minHighlightScore: 0.055,
  /**
   * Two detections of the SAME fingerprint within this window are duplicates.
   * NOTE: this is for dedupe of repeated detections of one kill, NOT for
   * merging nearby kills — multi-kills (2 kills < 1s apart) are real and
   * must be kept as separate events.
   */
  sameKillWindowSec: 7.0,
  qualityBase: 60,
  qualityScoreFactor: 80,
};

function isPlayerKillFeed(event) {
  const roi = event?.roi || '';
  if (!roi.startsWith('top_right')) return false;
  if (!(event.player_kill || event.red_highlight)) return false;
  if ((event.highlight_score ?? 0) < KILL_DETECT_TUNING.minHighlightScore) return false;
  return true;
}

/**
 * Dedupe key: prefer the OCR fingerprint (killer+victim identity) from the
 * Python scan; fall back to a coarse time bucket only if no fingerprint
 * exists. Identity-based dedupe keeps real multi-kills (separate victims)
 * as separate events even when they are <1s apart.
 */
function dedupeKey(event, anchor) {
  if (event.fingerprint) return `fp:${event.fingerprint}`;
  if (event.victim) return `kv:${event.killer || ''}>${event.victim}`;
  // Last resort: 2s time bucket. Loses sub-2s multi-kills, but only fires
  // when the Python scan provided no identity at all.
  return `t:${Math.round(anchor / 2)}`;
}

function pickStronger(a, b) {
  const score = (e) =>
    (e.highlight_score ?? 0) * 100 + (e.confidence ?? 0) * 10 + (e.activity ?? 0) * 5;
  return score(a) >= score(b) ? a : b;
}

/**
 * Red-highlight detections → one event per actual kill.
 */
export function buildAudioValidatedKills(hudEvents, _audioScan = null, videoDuration = 0) {
  const T = KILL_DETECT_TUNING;
  const feedEvents = (hudEvents || [])
    .filter(isPlayerKillFeed)
    .sort((a, b) => getHudEventTime(a) - getHudEventTime(b));

  /** @type {Map<string, object>} key → kill event */
  const byKey = new Map();
  let skippedDedupe = 0;

  for (const hud of feedEvents) {
    const anchor = Math.round(getHudEventTime(hud) * 10) / 10;

    if (videoDuration > 0 && anchor > videoDuration - 1) continue;

    const key = dedupeKey(hud, anchor);
    const enriched = {
      ...hud,
      kill_anchor_time: anchor,
      validated_by: 'red-highlight',
      player_kill: true,
      red_highlight: true,
      kill_quality_score: Math.round(
        T.qualityBase + (hud.highlight_score ?? 0) * T.qualityScoreFactor,
      ),
    };

    const existing = byKey.get(key);
    if (
      existing &&
      Math.abs(existing.kill_anchor_time - anchor) <= T.sameKillWindowSec
    ) {
      // Same kill detected again (feed persists ~6s) → keep stronger reading,
      // but always keep the EARLIEST anchor (closest to the real kill moment).
      const winner = pickStronger(existing, enriched);
      winner.kill_anchor_time = Math.min(existing.kill_anchor_time, anchor);
      byKey.set(key, winner);
      skippedDedupe += 1;
      continue;
    }

    // Same fingerprint but far apart in time = the same matchup happened
    // again later (killer killed the same victim in another round).
    // Store under a time-suffixed key so it is kept as a separate kill.
    byKey.set(existing ? `${key}@${anchor}` : key, enriched);
  }

  const kills = [...byKey.values()].sort(
    (a, b) => a.kill_anchor_time - b.kill_anchor_time,
  );

  console.log(
    `[kill-detect] ${kills.length} POV kills (two-pass anchor, -4s/+2s clip) from ` +
      `${feedEvents.length} highlights (dedupe=${skippedDedupe}) → ` +
      kills
        .map((k) => `${formatTs(k.kill_anchor_time)}[${k.highlight_color || 'red'}]`)
        .join(', '),
  );

  return kills;
}

/** Gunshot peaks — only used to place HUD scan windows in Python. */
export function findCombatGunshotPeaks(audioScan) {
  if (!audioScan) return [];
  return findAudioPeaks(audioScan, {
    minDeltaDb: 4.8,
    minSpacingSec: 1.4,
    maxPeaks: 200,
  });
}

export function scoreKillMoment(kill) {
  return kill.kill_quality_score ?? KILL_DETECT_TUNING.qualityBase;
}

function formatTs(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}