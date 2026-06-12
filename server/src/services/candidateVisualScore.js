import path from 'path';
import { ffmpegPath } from '../lib/ffmpeg.js';
import { runCommand } from './exec.js';

const SCENE_LINE_RE = /pts_time[:=]([\d.]+)/gi;

/**
 * Count sudden scene/camera cuts in a window (proxy for gameplay events / UI changes).
 * Returns 0–12 boost points.
 */
export async function measureWindowVisualEvents(sourceVideo, startSec, durationSec) {
  if (!sourceVideo) return 0;

  const start = Math.max(0, Number(startSec) || 0);
  const dur = Math.min(45, Math.max(4, Number(durationSec) || 12));
  const bin = path.resolve(ffmpegPath);

  try {
    const { stderr } = await runCommand(bin, [
      '-hide_banner',
      '-ss',
      String(start),
      '-t',
      String(dur),
      '-i',
      sourceVideo,
      '-an',
      '-vf',
      "select='gt(scene,0.38)',metadata=print",
      '-f',
      'null',
      '-',
    ]);

    const matches = [...stderr.matchAll(SCENE_LINE_RE)];
    const sceneCount = matches.length;

    if (sceneCount >= 8) return 12;
    if (sceneCount >= 5) return 9;
    if (sceneCount >= 3) return 6;
    if (sceneCount >= 2) return 3;
    return 0;
  } catch (err) {
    console.warn('[visual-score] scene detect failed:', err.message?.slice(0, 80));
    return 0;
  }
}
