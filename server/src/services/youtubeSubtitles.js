import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { buildYtdlpBaseArgs } from '../utils/ytdlp.js';
import { AppError } from '../utils/errors.js';
import {
  cookiesExpiredMessage,
  isSignInError,
  refreshYoutubeCookies,
} from './cookieRefresh.js';

function isSubtitleRateLimitError(message) {
  return /429|too many requests/i.test(String(message || ''));
}

/** Subtitle-specific sign-in detection — 429 is rate-limit, not auth failure. */
function isSubtitleAuthError(message) {
  const msg = String(message || '');
  if (isSubtitleRateLimitError(msg)) return false;
  return isSignInError(msg);
}

const ytdlpPath = config.ytdlpPath;
const cookiesPath = config.cookiesPath;

const LANG_PRIORITY = ['de', 'en', 'de-DE', 'en-US', 'en-GB'];

function stripTags(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseVttTimestamp(ts) {
  const parts = String(ts).trim().split(':');
  if (parts.length === 3) {
    return (
      Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2].replace(',', '.'))
    );
  }
  if (parts.length === 2) {
    return Number(parts[0]) * 60 + Number(parts[1].replace(',', '.'));
  }
  return Number(ts) || 0;
}

/** Parse WebVTT / YouTube VTT into { text, offset, duration }. */
export function parseVttContent(raw) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n');
  const segments = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || line === 'WEBVTT' || line.startsWith('NOTE') || line.startsWith('STYLE')) {
      i += 1;
      continue;
    }

    if (line.includes('-->')) {
      const [startRaw, endRaw] = line.split('-->').map((s) => s.trim().split(' ')[0]);
      const start = parseVttTimestamp(startRaw);
      const end = parseVttTimestamp(endRaw);
      i += 1;
      const textLines = [];
      while (i < lines.length && lines[i].trim() && !lines[i].includes('-->')) {
        const t = stripTags(lines[i]);
        if (t) textLines.push(t);
        i += 1;
      }
      const text = textLines.join(' ').trim();
      if (text && end > start) {
        segments.push({
          text,
          offset: Math.round(start * 100) / 100,
          duration: Math.max(0.05, Math.round((end - start) * 100) / 100),
        });
      }
      continue;
    }
    i += 1;
  }

  return mergeAdjacentSegments(segments);
}

/** Parse YouTube json3 timedtext. */
export function parseJson3Content(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }

  const segments = [];
  for (const ev of data.events || []) {
    if (!ev.segs?.length) continue;
    const text = ev.segs.map((s) => stripTags(s.utf8 || '')).join('').trim();
    if (!text || text === '\n') continue;
    const start = (ev.tStartMs || 0) / 1000;
    const dur = Math.max(50, ev.dDurationMs || 1500) / 1000;
    segments.push({
      text,
      offset: Math.round(start * 100) / 100,
      duration: Math.round(dur * 100) / 100,
    });
  }
  return mergeAdjacentSegments(segments);
}

function mergeAdjacentSegments(segments) {
  if (!segments.length) return [];
  const out = [{ ...segments[0] }];
  for (let i = 1; i < segments.length; i++) {
    const prev = out[out.length - 1];
    const cur = segments[i];
    const gap = cur.offset - (prev.offset + prev.duration);
    if (gap < 0.4 && prev.text.length + cur.text.length < 220) {
      prev.text = `${prev.text} ${cur.text}`.trim();
      prev.duration = Math.round((cur.offset + cur.duration - prev.offset) * 100) / 100;
    } else {
      out.push({ ...cur });
    }
  }
  return out.filter((s) => s.text);
}

function pickSubtitleFile(files) {
  const scored = files.map((file) => {
    const base = path.basename(file).toLowerCase();
    let score = 0;
    for (let i = 0; i < LANG_PRIORITY.length; i++) {
      if (base.includes(`.${LANG_PRIORITY[i].toLowerCase()}.`)) {
        score = 100 - i;
        break;
      }
    }
    if (base.includes('.auto')) score -= 2;
    if (base.endsWith('.vtt')) score += 5;
    if (base.endsWith('.json3')) score += 3;
    return { file, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.file || files[0];
}

async function parseSubtitleFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json3' || ext === '.json') return parseJson3Content(raw);
  return parseVttContent(raw);
}

function runYtdlpSubs(url, outputBase, { retried = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = buildYtdlpBaseArgs([
      '--cookies',
      cookiesPath,
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      'de,en',
      '--sub-format',
      'vtt/json3/best',
      '--skip-download',
      '--no-warnings',
      '-o',
      outputBase,
      url,
    ]);

    let stderr = '';
    const proc = spawn(ytdlpPath, args);
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', async (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || `yt-dlp subs exited ${code}`;
        if (isSubtitleRateLimitError(detail)) {
          reject(new Error(`YouTube subtitle rate limit (429): ${detail.slice(0, 180)}`));
          return;
        }
        if (isSubtitleAuthError(detail) && !retried) {
          try {
            await refreshYoutubeCookies({ force: true, cookiesPath });
            resolve(await runYtdlpSubs(url, outputBase, { retried: true }));
          } catch (refreshErr) {
            reject(refreshErr);
          }
          return;
        }
        if (isSubtitleAuthError(detail)) {
          reject(
            new AppError(cookiesExpiredMessage(cookiesPath, detail), 401, 'COOKIES_EXPIRED'),
          );
          return;
        }
        reject(new Error(detail));
        return;
      }
      resolve();
    });

    proc.on('error', reject);
  });
}

/**
 * Download YouTube captions via yt-dlp (same cookies as video download — avoids transcript API captcha).
 */
export async function fetchSubtitlesViaYtdlp(url, workDir) {
  if (!url?.trim() || !workDir) return null;

  const subsDir = path.join(workDir, 'subs');
  await fs.mkdir(subsDir, { recursive: true });
  const outputBase = path.join(subsDir, 'caption');

  console.log('[youtube-subs] Downloading captions via yt-dlp…');
  try {
    await runYtdlpSubs(url, outputBase);
  } catch (err) {
    console.warn(
      '[youtube-subs] yt-dlp subs failed (checking partial files):',
      err.message?.slice(0, 180),
    );
  }

  let entries = [];
  try {
    entries = await fs.readdir(subsDir);
  } catch {
    return null;
  }

  const subFiles = entries
    .filter((f) => /\.(vtt|json3|srt)$/i.test(f))
    .map((f) => path.join(subsDir, f));

  if (!subFiles.length) {
    console.warn('[youtube-subs] No subtitle files — will try STT fallback');
    return null;
  }

  const picked = pickSubtitleFile(subFiles);
  const segments = await parseSubtitleFile(picked);
  if (!segments.length) {
    console.warn('[youtube-subs] Subtitle file empty:', path.basename(picked));
    return null;
  }

  console.log(
    `[youtube-subs] Loaded ${segments.length} lines from ${path.basename(picked)}`,
  );
  return segments;
}
