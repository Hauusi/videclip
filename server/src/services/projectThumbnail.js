import path from 'path';
import fs from 'fs/promises';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { runCommand } from './exec.js';
import { extractThumbnail } from './ffmpeg.js';
import { ffmpegPath } from '../lib/ffmpeg.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREP_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'thumbnail_prep.py');

const OUT_W = 1280;
const OUT_H = 720;

const MOOD_STYLES = {
  hype: {
    accent: '#ff4d4d',
    accent2: '#ffb347',
    overlay: 'rgba(255,60,40,0.18)',
  },
  chill: {
    accent: '#4ecdc4',
    accent2: '#556ee6',
    overlay: 'rgba(40,120,200,0.2)',
  },
  emotional: {
    accent: '#b388ff',
    accent2: '#ff6b9d',
    overlay: 'rgba(120,60,180,0.22)',
  },
};

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapTitle(text, maxLen = 42) {
  const t = String(text || 'Video').trim();
  if (t.length <= maxLen) return [t];
  const words = t.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > maxLen && line) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 2);
}

function pickBestHighlight(highlights = []) {
  if (!highlights.length) return null;
  return [...highlights].sort(
    (a, b) => (Number(b.viral_score) || 0) - (Number(a.viral_score) || 0),
  )[0];
}

function sampleWindow(highlight) {
  const start = Math.max(0, Number(highlight.start_time) || 0);
  const end = Math.max(start + 1, Number(highlight.end_time) || start + 8);
  const peak = Number(highlight.hook_peak_time);
  const center = Number.isFinite(peak)
    ? peak
    : start + (end - start) * 0.35;
  const winStart = Math.max(start, center - 2);
  const winEnd = Math.min(end, center + 4);
  return { start: winStart, end: Math.max(winStart + 0.5, winEnd) };
}

async function runThumbnailPrep(sourceVideo, start, end, workDir) {
  try {
    await fs.access(PREP_SCRIPT);
    const { stdout } = await runCommand(
      config.pythonPath,
      [PREP_SCRIPT, sourceVideo, String(start), String(end), workDir],
      { env: { ...process.env, FFMPEG_PATH: ffmpegPath } },
    );
    const data = JSON.parse(stdout.trim());
    if (data?.ok && data.bg_path && data.subject_path) {
      await fs.access(data.bg_path);
      await fs.access(data.subject_path);
      return data;
    }
  } catch (err) {
    console.warn('[Thumbnail] prep script failed:', err.message?.slice(0, 200));
  }
  return null;
}

async function fallbackAssets(sourceVideo, start, workDir) {
  const framePath = path.join(workDir, 'fallback_frame.jpg');
  const bgPath = path.join(workDir, 'bg.jpg');
  await extractThumbnail(sourceVideo, start, framePath);
  await sharp(framePath)
    .resize(OUT_W, OUT_H, { fit: 'cover' })
    .modulate({ brightness: 0.75 })
    .blur(4)
    .jpeg({ quality: 88 })
    .toFile(bgPath);
  return { bg_path: bgPath, subject_path: null, gameplay_side: 'left', webcam_corner: 'bottom-right' };
}

function buildOverlaySvg({ title, episode, mood, lines }) {
  const style = MOOD_STYLES[mood] || MOOD_STYLES.hype;
  const ep = String(episode).padStart(2, '0');
  const titleLines = lines
    .map(
      (ln, i) =>
        `<tspan x="72" dy="${i === 0 ? 0 : 52}">${escapeXml(ln)}</tspan>`,
    )
    .join('');

  return Buffer.from(`<svg width="${OUT_W}" height="${OUT_H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${style.accent}" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="${style.accent2}" stop-opacity="0.75"/>
    </linearGradient>
  </defs>
  <rect width="${OUT_W}" height="${OUT_H}" fill="${style.overlay}"/>
  <rect x="0" y="0" width="10" height="${OUT_H}" fill="url(#grad)"/>
  <text x="72" y="580" font-family="Arial Black, Arial, sans-serif" font-size="88" font-weight="900" fill="white" stroke="#111" stroke-width="6" paint-order="stroke">${ep}</text>
  <text x="200" y="560" font-family="Arial Black, Arial, sans-serif" font-size="46" font-weight="900" fill="white" stroke="#111" stroke-width="5" paint-order="stroke">${titleLines}</text>
  <rect x="72" y="620" width="320" height="8" rx="4" fill="url(#grad)"/>
</svg>`);
}

async function composeThumbnail({
  bgPath,
  subjectPath,
  gameplaySide,
  title,
  episode,
  mood,
  outPath,
}) {
  const lines = wrapTitle(title);
  const bg = await sharp(bgPath).resize(OUT_W, OUT_H, { fit: 'cover' }).toBuffer();

  const layers = [{ input: bg, top: 0, left: 0 }];

  if (subjectPath) {
    const meta = await sharp(subjectPath).metadata();
    const targetH = Math.round(OUT_H * 0.92);
    const resized = await sharp(subjectPath)
      .resize({
        height: targetH,
        fit: 'inside',
        withoutEnlargement: false,
      })
      .toBuffer();
    const subMeta = await sharp(resized).metadata();
    const left =
      gameplaySide === 'left'
        ? OUT_W - (subMeta.width || 0) + 20
        : -20;
    const top = OUT_H - (subMeta.height || 0);
    layers.push({ input: resized, top: Math.max(0, top), left: Math.max(-40, left) });
  }

  layers.push({ input: buildOverlaySvg({ title, episode, mood, lines }), top: 0, left: 0 });

  await sharp({
    create: {
      width: OUT_W,
      height: OUT_H,
      channels: 3,
      background: { r: 12, g: 12, b: 18 },
    },
  })
    .composite(layers)
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(outPath);
}

/**
 * Generate a YouTube-style 16:9 project thumbnail after analysis.
 * @returns {{ path: string, url: string } | null}
 */
export async function generateProjectThumbnail({
  jobId,
  workDir,
  sourceVideo,
  highlights,
  mood = 'hype',
  videoTitle = '',
  sourceName = '',
}) {
  const best = pickBestHighlight(highlights);
  if (!best) return null;

  const thumbDir = path.join(workDir, 'thumbs');
  const prepDir = path.join(thumbDir, 'project_prep');
  await fs.mkdir(prepDir, { recursive: true });

  const { start, end } = sampleWindow(best);
  const episode =
    highlights.findIndex((h) => h.id === best.id) + 1 || 1;
  const title =
    videoTitle ||
    best.title ||
    sourceName ||
    'PeakClip';

  console.log('[Thumbnail] Generating project thumb', {
    jobId,
    highlight: best.id,
    window: `${start.toFixed(1)}–${end.toFixed(1)}s`,
  });

  let prep = await runThumbnailPrep(sourceVideo, start, end, prepDir);
  if (!prep) {
    prep = await fallbackAssets(sourceVideo, start, prepDir);
  }

  const outPath = path.join(thumbDir, 'project.jpg');
  await composeThumbnail({
    bgPath: prep.bg_path,
    subjectPath: prep.subject_path,
    gameplaySide: prep.gameplay_side || 'left',
    title,
    episode,
    mood: mood || 'hype',
    outPath,
  });

  const url = `/api/files/${jobId}/thumbs/project.jpg`;
  console.log('[Thumbnail] Saved', outPath);
  return { path: outPath, url };
}
