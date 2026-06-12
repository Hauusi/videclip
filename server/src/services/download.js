import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { extractVideoId } from '../utils/youtube.js';
import { AppError } from '../utils/errors.js';
import {
  ensureFreshCookies,
  isSignInError,
  refreshYoutubeCookies,
  throwCookiesExpired,
} from './cookieRefresh.js';
import { buildYtdlpBaseArgs, hasPotBypass } from '../utils/ytdlp.js';

const ytdlpPath = config.ytdlpPath;
const cookiesPath = config.cookiesPath;
const DOWNLOAD_TIMEOUT_MIN_MS = 10 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MAX_MS = 3 * 60 * 60 * 1000;

/** Scale yt-dlp timeout with video length (7h streams need far more than 5 minutes). */
export function computeDownloadTimeoutMs(durationSec) {
  const dur = Math.max(0, Number(durationSec) || 0);
  const scaled = DOWNLOAD_TIMEOUT_MIN_MS + dur * 900 + 5 * 60 * 1000;
  return Math.min(DOWNLOAD_TIMEOUT_MAX_MS, Math.max(DOWNLOAD_TIMEOUT_MIN_MS, scaled));
}

function formatDurationHint(durationSec) {
  const d = Math.max(0, Number(durationSec) || 0);
  if (d < 60) return `${Math.round(d)}s`;
  const h = Math.floor(d / 3600);
  const m = Math.floor((d % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

/** Lower resolution for very long sources — faster download, enough for highlight cuts. */
function buildYtdlpFormat(durationSec) {
  const dur = Number(durationSec) || 0;
  if (dur >= 4 * 3600) {
    return 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]';
  }
  if (dur >= 2 * 3600) {
    return 'bestvideo[height<=540][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]';
  }
  return 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]';
}
const BROWSER_COOKIE_SOURCES = (config.cookiesBrowsers || 'chrome,edge,chromium,brave,firefox')
  .split(',')
  .map((b) => b.trim())
  .filter(Boolean);

function buildYtdlpArgs(url, outputPath, cookieSource = 'file', { format, timeoutMs } = {}) {
  const cookieArgs =
    cookieSource === 'file'
      ? ['--cookies', cookiesPath]
      : ['--cookies-from-browser', cookieSource];
  const args = buildYtdlpBaseArgs([
    ...cookieArgs,
    '-f',
    format || 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]',
    '--merge-output-format',
    'mp4',
    '-o',
    outputPath,
    url,
  ]);
  if (timeoutMs) {
    const socketTimeoutSec = Math.ceil(timeoutMs / 1000);
    args.push('--socket-timeout', String(Math.min(socketTimeoutSec, 3600)));
  }
  return args;
}

function runYtdlp(url, outputPath, cookieSource = 'file', options = {}) {
  const timeoutMs = options.timeoutMs || DOWNLOAD_TIMEOUT_MIN_MS;
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let stderr = '';

    const proc = spawn(
      ytdlpPath,
      buildYtdlpArgs(url, outputPath, cookieSource, options),
    );
    proc.stdout.on('data', (data) => console.log('[yt-dlp]', data.toString()));
    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      console.log('[yt-dlp error]', chunk);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
      const limitMin = Math.round(timeoutMs / 60_000);
      reject(
        new AppError(
          `Video download timed out after ${limitMin} minutes — very long videos may need another try`,
          502,
        ),
      );
    }, timeoutMs);

    const clearTimer = () => clearTimeout(timeout);

    proc.on('close', (code) => {
      clearTimer();
      if (timedOut) return;
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || 'Download failed'));
    });

    proc.on('error', (err) => {
      clearTimer();
      if (timedOut) return;
      reject(err);
    });
  });
}

async function downloadWithBrowserCookies(url, outputPath) {
  for (const browser of BROWSER_COOKIE_SOURCES) {
    try {
      console.log(`[cookies] Download retry with browser cookies (${browser})…`);
      await runYtdlp(url, outputPath, browser);
      try {
        await refreshYoutubeCookies({ force: true, cookiesPath });
      } catch {
        /* cookies.txt sync optional */
      }
      return;
    } catch (err) {
      const detail = err?.message || String(err);
      console.warn(`[cookies] ${browser} download failed:`, detail.slice(0, 100));
      if (!isSignInError(detail)) {
        throw new AppError(`Video download failed: ${detail}`, 502);
      }
    }
  }
}

async function downloadWithYtdlp(
  url,
  outputPath,
  { retried = false, usedBrowsers = false, timeoutMs, format } = {},
) {
  try {
    await runYtdlp(url, outputPath, 'file', { timeoutMs, format });
  } catch (err) {
    const detail = err?.message || String(err);
    const canUseBrowserCookies =
      !config.cookiesSkipBrowserExport && process.platform !== 'linux';

    if (isSignInError(detail) && !retried) {
      if (hasPotBypass()) {
        console.log('[cookies] Sign-in error during download — retrying once (PO token path)…');
        return downloadWithYtdlp(url, outputPath, {
          retried: true,
          usedBrowsers: true,
          timeoutMs,
          format,
        });
      }
      console.log('[cookies] Sign-in error during download — refreshing cookies and retrying…');
      try {
        await refreshYoutubeCookies({ force: true, cookiesPath });
        return downloadWithYtdlp(url, outputPath, {
          retried: true,
          usedBrowsers,
          timeoutMs,
          format,
        });
      } catch (refreshErr) {
        if (canUseBrowserCookies && !usedBrowsers) {
          try {
            await downloadWithBrowserCookies(url, outputPath);
            return;
          } catch (browserErr) {
            throwCookiesExpired(
              cookiesPath,
              browserErr?.message || refreshErr?.message || detail,
            );
          }
        }
        throwCookiesExpired(cookiesPath, refreshErr?.message || detail);
      }
    }
    if (isSignInError(detail) && canUseBrowserCookies && !usedBrowsers) {
      try {
        await downloadWithBrowserCookies(url, outputPath);
        return;
      } catch (browserErr) {
        throwCookiesExpired(cookiesPath, browserErr?.message || detail);
      }
    }
    if (isSignInError(detail)) {
      throwCookiesExpired(cookiesPath, detail);
    }
    throw new AppError(`Video download failed: ${detail}`, 502);
  }
}

function fetchVideoMetadataOnce(url) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(
      ytdlpPath,
      buildYtdlpBaseArgs([
        '--cookies',
        cookiesPath,
        '--skip-download',
        '--dump-single-json',
        '--no-warnings',
        url,
      ]),
    );

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `yt-dlp exited ${code}`;
        if (isSignInError(detail)) {
          reject(new Error(detail));
          return;
        }
        reject(new Error(detail));
        return;
      }

      try {
        const data = JSON.parse(stdout);
        resolve({
          title: String(data.title || 'Unknown video').trim(),
          description: String(data.description || '').trim().slice(0, 3000),
          duration: Number(data.duration) || null,
          tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
          channel: String(data.channel || data.uploader || '').trim(),
          categories: Array.isArray(data.categories) ? data.categories.map(String) : [],
        });
      } catch (err) {
        reject(new Error(`Failed to parse video metadata: ${err.message}`));
      }
    });

    proc.on('error', reject);
  });
}

/** Title + description via yt-dlp (for highlight detection when captions are missing). */
export async function fetchVideoMetadata(url, { retried = false } = {}) {
  await ensureFreshCookies(cookiesPath);

  try {
    return await fetchVideoMetadataOnce(url);
  } catch (err) {
    const detail = err?.message || String(err);
    if (isSignInError(detail) && !retried) {
      console.log('[cookies] Sign-in error during metadata — refreshing cookies and retrying…');
      await refreshYoutubeCookies({ force: true, cookiesPath });
      return fetchVideoMetadata(url, { retried: true });
    }
    if (isSignInError(detail)) {
      throwCookiesExpired(cookiesPath, detail);
    }
    throw err;
  }
}

export async function downloadVideo(url, outDir, { onProgress } = {}) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new AppError('Invalid YouTube URL', 400);

  await fs.mkdir(outDir, { recursive: true });
  const outputPath = path.join(outDir, 'source.mp4');
  const exists = await fs.access(outputPath).then(() => true).catch(() => false);
  if (exists) return outputPath;

  await ensureFreshCookies(cookiesPath);

  let durationSec = null;
  try {
    const meta = await fetchVideoMetadata(url);
    durationSec = meta.duration;
  } catch (err) {
    console.warn('[download] Metadata prefetch failed, using default timeout:', err.message);
  }

  const timeoutMs = computeDownloadTimeoutMs(durationSec);
  const format = buildYtdlpFormat(durationSec);
  const durationHint = durationSec ? formatDurationHint(durationSec) : 'unknown length';
  const timeoutMin = Math.round(timeoutMs / 60_000);

  console.log(
    `[download] Starting (${durationHint}), format=${format.split('/')[0]}, timeout=${timeoutMin}min`,
  );
  onProgress?.({
    message: `Video wird heruntergeladen (${durationHint}, bis ${timeoutMin} min)…`,
    durationSec,
    timeoutMs,
  });

  await downloadWithYtdlp(url, outputPath, { timeoutMs, format });

  const resolved = await resolveDownloadedSource(outDir, outputPath);
  return resolved;
}

/** yt-dlp may leave separate streams if merge failed — normalize to source.mp4 */
async function resolveDownloadedSource(outDir, outputPath) {
  try {
    await fs.access(outputPath);
    return outputPath;
  } catch {
    /* merge may have failed */
  }

  const entries = await fs.readdir(outDir);
  const videoPart = entries.find((f) => /^source\.f\d+\.mp4$/i.test(f));
  const audioPart = entries.find((f) => /^source\.f\d+\.(m4a|webm|opus)$/i.test(f));

  if (videoPart && audioPart) {
    const { ffmpegPath } = await import('../lib/ffmpeg.js');
    const { runCommand } = await import('./exec.js');
    await runCommand(ffmpegPath, [
      '-y',
      '-i',
      path.join(outDir, videoPart),
      '-i',
      path.join(outDir, audioPart),
      '-c',
      'copy',
      outputPath,
    ]);
    return outputPath;
  }

  if (videoPart) {
    await fs.rename(path.join(outDir, videoPart), outputPath);
    return outputPath;
  }

  throw new AppError(`Video download finished but ${outputPath} was not created`, 502);
}
