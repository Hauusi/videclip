import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { ffmpegPath } from '../lib/ffmpeg.js';
import { runCommand } from './exec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'game_detect.py');

/** Max wait for HUD sampling (10 frames × 6 ROIs OCR). */
const VISUAL_DETECT_TIMEOUT_MS = 180_000;

function forwardPyLog(prefix, chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) console.log(`${prefix} ${trimmed}`);
  }
}

/**
 * Sample gameplay frames and detect game/category from HUD (OCR + layout).
 *
 * @returns {Promise<{ category: string, game: string|null, confidence: number, source: string, detail?: object }|null>}
 */
export async function detectGameFromVideo(sourceVideo, duration) {
  if (!sourceVideo) return null;

  const payload = JSON.stringify({
    video: path.resolve(sourceVideo),
    duration: Number(duration) || 0,
    sample_count: 10,
  });

  const t0 = Date.now();
  console.log(
    `[game-visual] starting HUD sample (${Math.round(Number(duration) || 0)}s VOD, timeout=${VISUAL_DETECT_TIMEOUT_MS / 1000}s)`,
  );

  try {
    const env = { ...process.env };
    if (ffmpegPath) env.FFMPEG_PATH = ffmpegPath;

    const { stdout, stderr } = await runCommand(config.pythonPath, [SCRIPT], {
      input: payload,
      env,
      timeout: VISUAL_DETECT_TIMEOUT_MS,
      onStderr: (chunk) => forwardPyLog('[game-visual-py]', chunk),
    });

    if (stderr?.trim()) {
      console.log(`[game-visual] stderr tail: ${stderr.trim().slice(-240)}`);
    }

    const data = JSON.parse(stdout.trim());
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (!data.ok || data.category === 'generic' || !data.confidence) {
      if (data.ok && data.frames_used > 0) {
        console.log(
          `[game-visual] No confident match (${data.frames_used} frames, OCR=${data.ocr_available}) in ${elapsed}s`,
        );
      }
      return data.ok
        ? {
            category: 'generic',
            game: null,
            confidence: 40,
            source: 'visual',
            detail: data,
          }
        : null;
    }

    console.log(
      `[game-visual] ${data.game || data.category} (${data.confidence}%, ${data.frames_used} frames) in ${elapsed}s`,
    );
    return {
      category: data.category,
      game: data.game,
      confidence: data.confidence,
      source: 'visual',
      detail: data,
    };
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const timedOut = /timed out/i.test(err.message || '');
    console.warn(
      `[game-visual] Detection failed after ${elapsed}s` +
        (timedOut ? ' (TIMEOUT — pipeline continues without visual signal)' : '') +
        `: ${err.message}`,
    );
    return null;
  }
}
