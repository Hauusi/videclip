import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { ffmpegPath } from '../lib/ffmpeg.js';
import { runCommand } from './exec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'kill_feed_detect.py');

/**
 * Tunables for HUD kill-feed scoring. Centralized so the future
 * Brain/learning system has one place to adjust weights.
 */
export const HUD_TUNING = {
  /** Seconds of slack when matching events to a [start, end] window. */
  windowSlackSec: 0.5,
  /** Max distance (s) between an audio peak and a HUD event to count as confirmed. */
  peakMatchMaxDistSec: 2.8,
  /** Default max distance (s) for nearestHudEvent lookups. */
  nearestMaxDistSec: 2.5,
  /** Minimum confidence for an event to count as a kill. */
  minConfidence: 0.5,
  /** Confidence threshold for the high-confidence bonus. */
  highConfidence: 0.65,
  /** Score boost per kill in window. */
  boostPerKill: 28,
  /** Extra boost per high-confidence kill. */
  boostPerHighConf: 12,
  /** Cap for the total window boost. */
  boostCap: 120,
  /** Hard ceiling for the Python scan as a fraction of VOD duration (AV1/ffmpeg needs ~1× realtime). */
  scanTimeoutFactor: 1.2,
  /** Absolute minimum scan timeout (ms). */
  scanTimeoutMinMs: 600_000,
};

/**
 * Two-pass CS2 kill-feed scan: coarse red-border (3s) → fine OCR backward anchors.
 *
 * @param {string} sourceVideo absolute or relative path to the VOD
 * @param {object} opts
 * @param {string} [opts.jobId] preferred way to locate the debug dir; falls
 *   back to parsing the video path if absent.
 */
export async function scanShooterKillFeed(
  sourceVideo,
  { audioScan, duration, categoryProfile, channel, title, jobId } = {},
) {
  if (!sourceVideo || categoryProfile?.id !== 'shooter') {
    return [];
  }

  const dur = Number(duration) || audioScan?.durationSec || 0;
  if (!dur) return [];

  try {
    const t0 = Date.now();
    const resolvedVideo = path.resolve(sourceVideo);
    const resolvedJobId = jobId || jobIdFromVideoPath(resolvedVideo);
    const debugDir = resolvedJobId
      ? path.join('/tmp/videclip', resolvedJobId, 'debug', 'killfeed')
      : path.join(path.dirname(resolvedVideo), 'debug', 'killfeed');

    const payload = JSON.stringify({
      video: resolvedVideo,
      duration: dur,
      cs2_kill_feed: true,
      full_vod_scan: true,
      kill_feed_debug: true,
      debug_dir: debugDir,
      // POV identity hints: Python derives a gamertag override only when it
      // disagrees with the OCR cluster (protects against a wrong cluster rep,
      // never overrides the OCR spelling of a correct one).
      channel: channel || '',
      title: title || '',
    });

    const env = { ...process.env, FFMPEG_PATH: path.resolve(ffmpegPath) };

    console.log(
      `[hud-killfeed] two-pass scan: ${Math.round(dur)}s VOD ` +
        `(coarse 3s → OCR anchor, ROI kill-feed strip)`,
    );

    // Guard against a hung Python process: scale timeout with VOD length.
    const timeoutMs = Math.max(
      HUD_TUNING.scanTimeoutMinMs,
      dur * 1000 * HUD_TUNING.scanTimeoutFactor,
    );
    console.log(
      `[hud-killfeed] scan timeout: ${Math.round(timeoutMs / 1000)}s ` +
        `(factor=${HUD_TUNING.scanTimeoutFactor}, min=${HUD_TUNING.scanTimeoutMinMs / 1000}s)`,
    );

    const { stdout, stderr } = await runCommand(config.pythonPath, [SCRIPT], {
      env,
      input: payload,
      timeout: timeoutMs,
      onStderr: (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed.startsWith('[kill-feed]')) console.log(trimmed);
        }
      },
    });

    if (stderr?.trim()) {
      const tail = stderr.trim().slice(-300);
      if (!tail.includes('[kill-feed]')) {
        console.log(`[hud-killfeed] py stderr tail: ${tail}`);
      }
    }

    let data;
    try {
      data = JSON.parse(stdout.trim() || '{}');
    } catch {
      console.warn('[hud-killfeed] scan returned invalid JSON');
      return [];
    }

    if (!data.ok) {
      console.warn('[hud-killfeed] scan failed:', data.reason || 'unknown');
      warnKillFeedDecodeFailure(data.reason || '');
      return [];
    }

    logScanStats(data, t0);
    warnKillFeedDecodeFailure('', data);
    return data.events || [];
  } catch (err) {
    const timedOut = /timed out/i.test(err.message || '');
    console.warn('[hud-killfeed] scan error:', err.message?.slice(0, 200));
    if (timedOut) {
      console.warn(
        '[hud-killfeed] WARNING: kill-feed scan TIMEOUT — increase HUD_TUNING.scanTimeoutFactor ' +
          'or enable batch coarse extract for AV1. Falling back to audio peaks.',
      );
    }
    warnKillFeedDecodeFailure(err.message || '');
    return [];
  }
}

function jobIdFromVideoPath(videoPath) {
  const m = String(videoPath).match(/videclip[/\\]([a-f0-9-]{36})[/\\]/i);
  return m ? m[1] : null;
}

function isAv1DecodeError(text) {
  return /av1|failed to get pixel/i.test(String(text || ''));
}

/** Distinct WARNING when scan dies on decode — avoids silent audio-only fallback. */
function warnKillFeedDecodeFailure(errText, data = null) {
  if (isAv1DecodeError(errText)) {
    console.warn(
      '[hud-killfeed] WARNING: AV1 decode failure — kill-feed scan produced no kills. ' +
        'Pipeline will fall back to audio peaks (not real POV kills).',
    );
    return;
  }
  const st = data?.stats || {};
  const kills = data?.player_kill_count ?? data?.events?.length ?? 0;
  const pass1 = st.frames_sampled_pass1 ?? 0;
  if (errText) {
    console.warn(
      '[hud-killfeed] WARNING: kill-feed scan error — pipeline falling back to audio peaks.',
    );
    return;
  }
  if (kills === 0 && pass1 > 0 && pass1 < 50) {
    console.warn(
      '[hud-killfeed] WARNING: scan completed with 0 kills and few pass1 frames — likely decode failure.',
    );
  }
}

function logScanStats(data, t0) {
  const pk = data.player_kill_count ?? data.events?.length ?? 0;
  const st = data.stats || {};
  console.log(
    `[hud-killfeed] funnel: pass1=${st.frames_sampled_pass1 ?? '?'} ` +
      `ocr=${st.ocr_calls ?? '?'} nonempty=${st.ocr_nonempty ?? '?'} ` +
      `parsed=${st.ocr_parsed_as_kill_entry ?? '?'} ` +
      `fp_before=${st.unique_fingerprints_before_dedup ?? '?'} ` +
      `fp_after=${st.unique_fingerprints_after_dedup ?? '?'} ` +
      `kills=${st.kills_found ?? pk} ` +
      `(pov=${data.pov_player || '?'}, fallback=${st.pov_fallback_mode ? 'yes' : 'no'}, ` +
      `deaths=${st.pov_deaths_excluded ?? 0}, clips=${st.clips_produced ?? '?'}) ` +
      `in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  if (data.debug_dir) {
    console.log(`[hud-killfeed] OCR debug: ${data.debug_dir}`);
  }
}

/** HUD kill events in [start, end] (with window slack). */
export function countHudKillsInRange(
  events,
  start,
  end,
  minConfidence = HUD_TUNING.minConfidence,
) {
  if (!events?.length) return 0;
  const slack = HUD_TUNING.windowSlackSec;
  return events.filter(
    (e) => e.time >= start - slack && e.time <= end + slack && e.confidence >= minConfidence,
  ).length;
}

export function nearestHudEvent(events, time, maxDist = HUD_TUNING.nearestMaxDistSec) {
  if (!events?.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const e of events) {
    const d = Math.abs(e.time - time);
    if (d < bestDist && d <= maxDist) {
      bestDist = d;
      best = e;
    }
  }
  return best;
}

export function hudConfirmedPeaks(peaks, hudEvents, maxDist = HUD_TUNING.peakMatchMaxDistSec) {
  if (!peaks?.length || !hudEvents?.length) return 0;
  return peaks.filter((p) => nearestHudEvent(hudEvents, p.time, maxDist)).length;
}

export function hudWindowBoost(events, start, end) {
  const kills = countHudKillsInRange(events, start, end, HUD_TUNING.minConfidence);
  if (!kills) return { boost: 0, kills: 0 };
  const slack = HUD_TUNING.windowSlackSec;
  const highConf = events.filter(
    (e) =>
      e.time >= start - slack &&
      e.time <= end + slack &&
      e.confidence >= HUD_TUNING.highConfidence,
  ).length;
  const boost = Math.min(
    HUD_TUNING.boostCap,
    kills * HUD_TUNING.boostPerKill + highConf * HUD_TUNING.boostPerHighConf,
  );
  return { boost, kills, highConf };
}