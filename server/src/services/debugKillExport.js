/**
 * TEMPORARY DEBUG — HUD kill inspection (JSON + MP4 reel).
 * Remove this entire file when testing is done. See DEBUG_KILL_EXPORT_REMOVAL.md
 */

import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { config } from '../config.js';
import { ffmpegPath } from '../lib/ffmpeg.js';
import { cutHighlightClip } from './ffmpeg.js';
import {
  filterQualityHudKills,
  hasCombatAudioNear,
  isConfirmedHudKill,
  isQualityHudKill,
} from './shooterClusters.js';
import { scoreKillMoment } from './killDetect.js';
import { getHudEventTime, resolveHudKillAnchor } from './montageClip.js';

export const DEBUG_KILL_EXPORT_MAX_REEL = 60;
const SEG_BEFORE_SEC = 1.0;
const SEG_DURATION_SEC = 3.5;

export function isDebugKillExportEnabled() {
  return config.debugKillExport === true;
}

function eventKey(event) {
  const t = getHudEventTime(event);
  return `${Math.round(t * 10)}_${event.roi || 'unknown'}`;
}

function collectMontageKillTimes(highlights) {
  const times = [];
  for (const h of highlights || []) {
    for (const seg of h.montage_segments || []) {
      if (seg.segment_type === 'payoff') continue;
      const t = seg.raw_time ?? seg.peak_time ?? seg.start;
      if (Number.isFinite(t)) times.push(t);
    }
  }
  return times;
}

function isInFinalMontage(event, montageTimes, toleranceSec = 1.8) {
  const t = getHudEventTime(event);
  return montageTimes.some((mt) => Math.abs(mt - t) <= toleranceSec);
}

function rejectReasons(event, { confirmed, quality, combatAudio, inPool }) {
  const reasons = [];
  if (!confirmed) reasons.push('not_confirmed');
  if (confirmed && !quality) reasons.push('quality_filter');
  if (quality && !combatAudio) reasons.push('no_combat_audio');
  if (quality && combatAudio && !inPool) reasons.push('excluded_from_montage_pool');
  return reasons;
}

/** Annotate every raw HUD event with filter pipeline status. */
export function annotateHudKillEvents(
  events,
  videoDuration,
  audioScan,
  finalHighlights = [],
  options = {},
) {
  const raw = [...(events || [])].sort((a, b) => getHudEventTime(a) - getHudEventTime(b));
  const confirmed = raw.filter(isConfirmedHudKill);
  const pool = filterQualityHudKills(raw, videoDuration, audioScan, options);
  const poolKeys = new Set(pool.map(eventKey));
  const montageTimes = collectMontageKillTimes(finalHighlights);

  return raw.map((event, index) => {
    const hudTime = getHudEventTime(event);
    const confirmedOk = isConfirmedHudKill(event);
    const qualityOk =
      confirmedOk && isQualityHudKill(event, { allEvents: confirmed, videoDuration });
    const combatOk = !audioScan || !qualityOk || hasCombatAudioNear(event, audioScan);
    const inPool = poolKeys.has(eventKey(event));
    const inFinalMontage = isInFinalMontage(event, montageTimes);

    const qualityScore = event.player_kill ? scoreKillMoment(event) : null;

    return {
      index: index + 1,
      hud_time: Math.round(hudTime * 10) / 10,
      kill_quality_score: qualityScore,
      passes_quality_threshold: qualityScore == null || qualityScore >= 64,
      raw_time: event.raw_time != null ? Math.round(event.raw_time * 10) / 10 : null,
      shot_time: event.shot_time != null ? Math.round(event.shot_time * 10) / 10 : null,
      anchor_time: Math.round(resolveHudKillAnchor(event) * 10) / 10,
      roi: event.roi || null,
      confidence: event.confidence ?? null,
      activity: event.activity ?? null,
      text: event.text || null,
      method: event.method || null,
      confirmed: confirmedOk,
      passes_quality: qualityOk,
      passes_combat_audio: combatOk,
      in_montage_pool: inPool,
      in_final_montage: inFinalMontage,
      reject_reasons: rejectReasons(event, {
        confirmed: confirmedOk,
        quality: qualityOk,
        combatAudio: combatOk,
        inPool,
      }),
      preview_start: Math.max(0, Math.round((hudTime - SEG_BEFORE_SEC) * 10) / 10),
      preview_duration: SEG_DURATION_SEC,
    };
  });
}

function runFfmpeg(args, timeoutMs = 180_000) {
  const bin = path.resolve(ffmpegPath);
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        proc.kill('SIGKILL');
        reject(new Error(`FFmpeg timed out after ${Math.round(timeoutMs / 1000)}s`));
      });
    }, timeoutMs);
    proc.stderr?.on('data', (d) => console.log('[debug-kill-export ffmpeg]', d.toString().trim()));
    proc.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exited ${code}`));
      });
    });
  });
}

async function concatParts(partPaths, outPath) {
  if (!partPaths.length) return false;
  if (partPaths.length === 1) {
    await fs.copyFile(partPaths[0], outPath);
    return true;
  }

  const filterParts = [];
  const inputs = [];
  for (let i = 0; i < partPaths.length; i++) {
    inputs.push('-i', partPaths[i]);
    filterParts.push(`[${i}:v:0][${i}:a:0]`);
  }
  const filter = `${filterParts.join('')}concat=n=${partPaths.length}:v=1:a=1[v][a]`;

  await runFfmpeg(
    [
      '-y',
      ...inputs,
      '-filter_complex',
      filter,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      outPath,
    ],
    300_000,
  );
  return true;
}

function killPartFileName(index) {
  return `kill_${String(index).padStart(3, '0')}.mp4`;
}

/** Cut one MP4 per HUD event (flat in debug/). */
async function buildIndividualKillParts(sourceVideo, annotated, debugDir) {
  const reelEvents = annotated.slice(0, DEBUG_KILL_EXPORT_MAX_REEL);
  await fs.mkdir(debugDir, { recursive: true });
  const partPaths = [];

  for (const item of reelEvents) {
    const partPath = path.join(debugDir, killPartFileName(item.index));
    await cutHighlightClip(sourceVideo, item.preview_start, item.preview_duration, partPath, {
      forceEncode: true,
      accurateSeek: true,
      montagePart: true,
    });
    partPaths.push({ item, partPath });
  }
  return partPaths;
}

async function buildKillReelFromParts(partEntries, debugDir, reelName, filterFn) {
  const selected = partEntries.filter(({ item }) => filterFn(item));
  if (!selected.length) return null;
  const outPath = path.join(debugDir, reelName);
  await concatParts(
    selected.map(({ partPath }) => partPath),
    outPath,
  );
  return path.basename(outPath);
}

/**
 * Copy montage jump-cut parts (raw_*_mN.mp4) into debug/ for per-kill download.
 * DEBUG_KILL_EXPORT — call after cutRawClipWithHook in analyzePipeline.
 */
export async function attachMontageSegmentDownloads(workDir, jobId, highlight) {
  if (!isDebugKillExportEnabled() || !highlight?.montage_segments?.length) {
    return highlight;
  }

  const srcDir = path.join(workDir, 'raw-clips');
  const debugDir = path.join(workDir, 'debug');
  await fs.mkdir(debugDir, { recursive: true });

  let killIdx = 0;
  const segments = await Promise.all(
    highlight.montage_segments.map(async (seg, i) => {
      if (seg.segment_type === 'payoff') return seg;
      killIdx += 1;
      const src = path.join(srcDir, `raw_${highlight.id}_m${i}.mp4`);
      const fileName = `${highlight.id}_seg_${killIdx}.mp4`;
      const dest = path.join(debugDir, fileName);
      try {
        await fs.access(src);
        await fs.copyFile(src, dest);
        return {
          ...seg,
          debug_download_url: `/api/files/${jobId}/debug/${fileName}`,
        };
      } catch {
        return seg;
      }
    }),
  );

  return { ...highlight, montage_segments: segments };
}

/**
 * Write kills.json + MP4 reels into workDir/debug/.
 * @returns {Promise<object|null>} URLs for job result (null if nothing to export)
 */
export async function exportDebugKills({
  sourceVideo,
  workDir,
  jobId,
  videoDuration,
  killFeedEvents,
  audioScan,
  finalHighlights = [],
  channel = '',
  title = '',
}) {
  if (!isDebugKillExportEnabled()) return null;
  if (!killFeedEvents?.length) {
    console.log('[debug-kill-export] skipped — no HUD kill events');
    return null;
  }

  const debugDir = path.join(workDir, 'debug');
  await fs.mkdir(debugDir, { recursive: true });

  const annotated = annotateHudKillEvents(
    killFeedEvents,
    videoDuration,
    audioScan,
    finalHighlights,
    { channel, title },
  );

  const summary = {
    total_detected: annotated.length,
    confirmed: annotated.filter((e) => e.confirmed).length,
    passes_quality: annotated.filter((e) => e.passes_quality).length,
    in_montage_pool: annotated.filter((e) => e.in_montage_pool).length,
    in_final_montage: annotated.filter((e) => e.in_final_montage).length,
    reel_max: DEBUG_KILL_EXPORT_MAX_REEL,
    segment_window: `${SEG_BEFORE_SEC}s before HUD time, ${SEG_DURATION_SEC}s total`,
  };

  const payload = {
    generated_at: new Date().toISOString(),
    temporary_debug: true,
    summary,
    kills: annotated,
  };

  await fs.writeFile(path.join(debugDir, 'kills.json'), JSON.stringify(payload, null, 2), 'utf8');
  console.log(
    `[debug-kill-export] JSON: ${summary.total_detected} HUD events ` +
      `(${summary.in_montage_pool} in pool, ${summary.in_final_montage} in final clips)`,
  );

  const partEntries = await buildIndividualKillParts(sourceVideo, annotated, debugDir);
  const allReel = await buildKillReelFromParts(partEntries, debugDir, 'kills-reel-all.mp4', () => true);
  const passReel = await buildKillReelFromParts(
    partEntries,
    debugDir,
    'kills-reel-pool.mp4',
    (e) => e.in_montage_pool,
  );
  const failReel = await buildKillReelFromParts(
    partEntries,
    debugDir,
    'kills-reel-rejected.mp4',
    (e) => e.confirmed && !e.in_montage_pool,
  );

  const fileUrl = (file) => `/api/files/${jobId}/debug/${file}`;
  const individualKills = partEntries.map(({ item }) => ({
    index: item.index,
    hud_time: item.hud_time,
    roi: item.roi,
    in_montage_pool: item.in_montage_pool,
    url: fileUrl(killPartFileName(item.index)),
  }));

  return {
    temporary: true,
    summary,
    jsonUrl: fileUrl('kills.json'),
    reelAllUrl: allReel ? fileUrl(allReel) : null,
    reelPoolUrl: passReel ? fileUrl(passReel) : null,
    reelRejectedUrl: failReel ? fileUrl(failReel) : null,
    individualKills,
  };
}
