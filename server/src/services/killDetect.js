/**
 * CS2 POV kills from two-pass kill-feed (red border + OCR anchor).
 * Clip window = -4s / +2s around anchor (see RED_HIGHLIGHT_KILL_TIMING).
 */

import { findAudioPeaks } from './audioEnergyScan.js';
import { getHudEventTime } from './montageClip.js';

const MIN_HIGHLIGHT_SCORE = 0.055;
const SPAWN_CUTOFF_SEC = 32;
const MIN_KILL_GAP_SEC = 2.2;

function isPlayerKillFeed(event) {
  const roi = event?.roi || '';
  if (!roi.startsWith('top_right')) return false;
  if (!(event.player_kill || event.red_highlight)) return false;
  if ((event.highlight_score ?? 0) < MIN_HIGHLIGHT_SCORE) return false;
  const method = event.method || '';
  return (
    method.includes('red-highlight') ||
    method.includes('two-pass') ||
    event.player_kill === true
  );
}

function nearKill(time, kills, gapSec = MIN_KILL_GAP_SEC) {
  return kills.some((k) => Math.abs((k.kill_anchor_time ?? getHudEventTime(k)) - time) < gapSec);
}

function pickStronger(a, b) {
  const score = (e) =>
    (e.highlight_score ?? 0) * 100 + (e.confidence ?? 0) * 10 + (e.activity ?? 0) * 5;
  return score(a) >= score(b) ? a : b;
}

/**
 * Red-highlight detections → one timestamp per kill (highlight frame time).
 */
export function buildAudioValidatedKills(hudEvents, _audioScan = null, videoDuration = 0) {
  const feedEvents = (hudEvents || [])
    .filter(isPlayerKillFeed)
    .sort((a, b) => getHudEventTime(a) - getHudEventTime(b));

  const kills = [];
  let skippedSpawn = 0;
  let skippedDedupe = 0;

  for (const hud of feedEvents) {
    const anchor = Math.round(getHudEventTime(hud) * 10) / 10;
    if (anchor < SPAWN_CUTOFF_SEC) {
      skippedSpawn += 1;
      continue;
    }
    if (videoDuration > 0 && anchor > videoDuration - 1) continue;

    const existingIdx = kills.findIndex(
      (k) => Math.abs((k.kill_anchor_time ?? 0) - anchor) < MIN_KILL_GAP_SEC,
    );
    if (existingIdx >= 0) {
      kills[existingIdx] = pickStronger(kills[existingIdx], {
        ...hud,
        kill_anchor_time: anchor,
        validated_by: 'red-highlight',
        player_kill: true,
        red_highlight: true,
      });
      skippedDedupe += 1;
      continue;
    }

    kills.push({
      ...hud,
      kill_anchor_time: anchor,
      validated_by: 'red-highlight',
      player_kill: true,
      red_highlight: true,
      kill_quality_score: Math.round(60 + (hud.highlight_score ?? 0) * 80),
    });
  }

  console.log(
    `[kill-detect] ${kills.length} POV kills (two-pass anchor, -4s/+2s clip) from ` +
      `${feedEvents.length} highlights (spawn=${skippedSpawn} dedupe=${skippedDedupe}) → ` +
      kills
        .map((k) => {
          const a = k.kill_anchor_time;
          const c = k.highlight_color || 'red';
          return `${formatTs(a)}[${c}]`;
        })
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
  return kill.kill_quality_score ?? 60;
}

function formatTs(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
