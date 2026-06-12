import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { ffmpegPath } from '../lib/ffmpeg.js';
import { runCommand } from './exec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'game_detect.py');

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

  try {
    const env = { ...process.env };
    if (ffmpegPath) env.FFMPEG_PATH = ffmpegPath;

    const { stdout } = await runCommand(config.pythonPath, [SCRIPT], {
      input: payload,
      env,
    });

    const data = JSON.parse(stdout.trim());
    if (!data.ok || data.category === 'generic' || !data.confidence) {
      if (data.ok && data.frames_used > 0) {
        console.log(
          `[game-visual] No confident match (${data.frames_used} frames, OCR=${data.ocr_available})`,
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
      `[game-visual] ${data.game || data.category} (${data.confidence}%, ${data.frames_used} frames)`,
    );
    return {
      category: data.category,
      game: data.game,
      confidence: data.confidence,
      source: 'visual',
      detail: data,
    };
  } catch (err) {
    console.warn('[game-visual] Detection failed:', err.message);
    return null;
  }
}
