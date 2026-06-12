import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { ffmpegPath } from '../lib/ffmpeg.js';
import { runCommand } from './exec.js';
import { streamerNameTokens } from './streamerNames.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'kill_feed_detect.py');

/**
 * Two-pass CS2 kill-feed scan: coarse red-border (3s) → fine OCR backward anchors.
 */
function jobIdFromVideoPath(videoPath) {
  const m = String(videoPath).match(/videclip[/\\]([a-f0-9-]{36})[/\\]/i);
  return m ? m[1] : null;
}

export async function scanShooterKillFeed(
  sourceVideo,
  { audioScan, duration, categoryProfile, channel, title } = {},
) {
  if (!sourceVideo || categoryProfile?.id !== 'shooter') {
    return [];
  }

  const dur = Number(duration) || audioScan?.durationSec || 0;
  if (!dur) return [];

  try {
    const t0 = Date.now();
    const resolvedVideo = path.resolve(sourceVideo);
    const jobId = jobIdFromVideoPath(resolvedVideo);
    const debugDir = jobId
      ? path.join('/tmp/videclip', jobId, 'debug', 'killfeed')
      : path.join(path.dirname(resolvedVideo), 'debug', 'killfeed');

    const payload = JSON.stringify({
      video: resolvedVideo,
      duration: dur,
      cs2_kill_feed: true,
      full_vod_scan: true,
      title_hint_tokens: streamerNameTokens(channel, title),
      kill_feed_debug: true,
      debug_dir: debugDir,
    });

    const env = { ...process.env, FFMPEG_PATH: path.resolve(ffmpegPath) };

    console.log(
      `[hud-killfeed] two-pass scan: ${Math.round(dur)}s VOD ` +
        `(coarse 3s → OCR anchor, ROI kill-feed strip)`,
    );

    const { stdout } = await runCommand(config.pythonPath, [SCRIPT], {
      env,
      input: payload,
    });

    const data = JSON.parse(stdout.trim() || '{}');
    if (!data.ok) {
      console.warn('[hud-killfeed] scan failed:', data.reason || 'unknown');
      return [];
    }

    const pk = data.player_kill_count ?? data.events?.length ?? 0;
    const st = data.stats || {};
    console.log(
      `[hud-killfeed] ${pk} POV kills (pov=${data.pov_player || '?'}, ` +
        `pass1=${st.frames_sampled_pass1 ?? '?'}, ocr=${st.ocr_calls ?? '?'}, ` +
        `parsed=${st.ocr_parsed_as_kill_entry ?? '?'}, ` +
        `fp=${st.unique_fingerprints_after_dedup ?? '?'}/${st.unique_fingerprints_before_dedup ?? '?'}, ` +
        `fallback=${st.pov_fallback_mode ? 'yes' : 'no'}, ` +
        `deaths=${st.pov_deaths_excluded ?? 0}, clips=${st.clips_produced ?? '?'}) ` +
        `in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    if (data.debug_dir) {
      console.log(`[hud-killfeed] OCR debug: ${data.debug_dir}`);
    }
    return data.events || [];
  } catch (err) {
    console.warn('[hud-killfeed] scan error:', err.message?.slice(0, 120));
    return [];
  }
}

/** HUD kill events in [start, end]. */
export function countHudKillsInRange(events, start, end, minConfidence = 0.5) {
  if (!events?.length) return 0;
  return events.filter(
    (e) => e.time >= start - 0.5 && e.time <= end + 0.5 && e.confidence >= minConfidence,
  ).length;
}

export function nearestHudEvent(events, time, maxDist = 2.5) {
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

export function hudConfirmedPeaks(peaks, hudEvents, maxDist = 2.8) {
  if (!peaks?.length || !hudEvents?.length) return 0;
  return peaks.filter((p) => nearestHudEvent(hudEvents, p.time, maxDist)).length;
}

export function hudWindowBoost(events, start, end) {
  const kills = countHudKillsInRange(events, start, end, 0.5);
  if (!kills) return { boost: 0, kills: 0 };
  const highConf = events.filter(
    (e) =>
      e.time >= start - 0.5 &&
      e.time <= end + 0.5 &&
      e.confidence >= 0.65,
  ).length;
  const boost = Math.min(120, kills * 28 + highConf * 12);
  return { boost, kills, highConf };
}
