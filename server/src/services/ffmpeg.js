import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { ffmpeg, ffmpegPath, ffprobePath } from '../lib/ffmpeg.js';
import { runCommand } from './exec.js';
import {
  buildAssSubtitles,
  buildHookAssSubtitles,
  logCaptionSyncDiagnostics,
  resolveCaptionTimings,
} from './preprocess.js';
import { normalizeCaptionStyle } from './captionKeywords.js';
import {
  burnAssSubtitlesOntoVideo,
  clampCaptionWordsToDuration,
  countAssDialogueLines,
  isViableTranscript,
  mixMusicOntoVideo,
} from './captionPipeline.js';
import { detectFaceCrop, buildCropFilter, getCroppedDimensions } from './smartCrop.js';
import { isWebcamPipEnabled } from './webcamPip.js';
import {
  applyWideTimeRange,
  buildVideoCompositeGraph,
  isWideOverlayActive,
  resolveWideMoment,
} from './wideContentOverlay.js';
import { AppError } from '../utils/errors.js';
import { getHookTeaserDuration, getHookTeaserRequested, getClipDuration, shouldUseColdOpen } from './hookClip.js';
import { isMontageHighlight } from './montageClip.js';
import { clampColdOpenPeakTime, getMinColdOpenPeakOffset } from './coldOpenTiming.js';
import { normalizeMusicVolume } from './music.js';

const cutLockChains = new Map();

/** Serialize cuts that target the same output (preview + export often overlap). */
function withCutLock(lockKey, fn) {
  const key = path.resolve(lockKey);
  const prev = cutLockChains.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => fn());
  cutLockChains.set(
    key,
    run.finally(() => {
      if (cutLockChains.get(key) === run) cutLockChains.delete(key);
    }),
  );
  return run;
}

function makePartPath(outputPath) {
  const base = outputPath.replace(/\.mp4$/i, '');
  return `${base}.${process.pid}.${Date.now()}.part.mp4`;
}

/** Windows: ffmpeg may still hold the file — retry rename, then copy fallback. */
async function finalizePartFile(partPath, outputPath) {
  const part = path.resolve(partPath);
  const output = path.resolve(outputPath);
  const attempts = 10;

  for (let i = 0; i < attempts; i++) {
    try {
      await fs.unlink(output).catch(() => {});
      await fs.rename(part, output);
      return;
    } catch (err) {
      const retryable = ['EPERM', 'EBUSY', 'EACCES', 'EXDEV'].includes(err?.code);
      if (!retryable || i === attempts - 1) {
        if (!retryable) throw err;
        await fs.copyFile(part, output);
        await fs.unlink(part).catch(() => {});
        return;
      }
      await sleep(60 * (i + 1));
    }
  }
}

/** Words for captions; clip-local segments are already 0-based (no offset subtract). */
function prepareClipCaptionWords(
  transcriptSegments,
  highlight,
  clipStart,
  clipEnd,
  clipLocalTimestamps = false,
) {
  const clipWords = clipLocalTimestamps
    ? transcriptSegments
    : transcriptSegments.filter((seg) => {
        const start = Number(seg.offset ?? seg.start);
        return start >= clipStart && start <= clipEnd;
      });

  console.log(
    `[captions] Clip ${highlight.id}: ${clipWords.length} words (own transcript, ${clipStart}s–${clipEnd}s)`,
  );

  const words = [];

  for (const seg of clipWords) {
    const text = String(seg.text || '').trim();
    if (!text) continue;

    const start = Number(seg.offset ?? seg.start);
    const end = start + Number(seg.duration || 0.05);
    const adjustedStart = clipLocalTimestamps
      ? Math.max(0, start)
      : Math.max(0, start - clipStart);
    const adjustedEnd = clipLocalTimestamps
      ? Math.max(0.1, end)
      : Math.max(0.1, end - clipStart);
    if (adjustedEnd <= adjustedStart) continue;

    words.push({
      text,
      start: adjustedStart,
      end: adjustedEnd,
      speaker: seg.speaker,
      speakerId: seg.speakerId,
    });
  }

  return words.sort((a, b) => a.start - b.start);
}

export function probeVideoSource(videoPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, data) => {
      if (err) {
        resolve({ width: 1920, height: 1080 });
        return;
      }
      const stream = data.streams?.find((s) => s.codec_type === 'video');
      resolve({
        width: stream?.width || 1920,
        height: stream?.height || 1080,
      });
    });
  });
}

/** Source duration in seconds via ffprobe. */
export async function getVideoDuration(videoPath) {
  const resolved = path.resolve(videoPath);
  const { stdout } = await runCommand(ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    resolved,
  ]);
  const duration = parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AppError(`Could not read video duration: ${resolved}`, 502);
  }
  return duration;
}

function enableBetween(start, end) {
  return `enable='between(t\\,${start}\\,${end})'`;
}

function escapeDrawtextLine(t) {
  return String(t)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

function escapeDrawtext(t) {
  return escapeDrawtextLine(t).slice(0, 80);
}

/** Word-wrap hook overlay so it stays inside the frame. */
function wrapHookTextLines(text, maxCharsPerLine = 26) {
  const words = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (!words.length) return ['Watch this'];

  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxCharsPerLine && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

function hookLineYPosition(lineIndex, lineCount) {
  if (lineCount <= 1) return 'h*0.30';
  const top = 0.17;
  const step = 0.085;
  return `h*${(top + lineIndex * step).toFixed(3)}`;
}

function buildHookDrawtextFilters(rawText, { preview, playResX, hookEnd }) {
  const resX = Math.max(360, playResX || 1080);
  const maxChars = Math.max(16, Math.min(32, Math.floor(resX / (preview ? 20 : 26))));
  const lines = wrapHookTextLines(rawText, maxChars);
  const fontSize = preview
    ? Math.max(22, Math.min(28, Math.floor(resX / 38)))
    : Math.max(28, Math.min(38, Math.floor(resX / 30)));
  const lineCount = lines.length;

  return lines.map((line, i) => {
    const escaped = escapeDrawtextLine(line);
    const y = hookLineYPosition(i, lineCount);
    return (
      `drawtext=text='${escaped}':fontsize=${fontSize}:fontcolor=white:borderw=3:bordercolor=black` +
      `:box=1:boxcolor=black@0.5:boxborderw=14:x=(w-text_w)/2:y=${y}` +
      `:${enableBetween(0, hookEnd)}`
    );
  });
}

/** Only scale down tall sources; never upscale low-res. */
function buildScaleFilter(croppedHeight, preview) {
  if (preview) return 'scale=-2:480';
  if (croppedHeight > 1080) return 'scale=-2:1920';
  return null;
}

function buildColorGradeFilter(enabled, aiStrength, { boosted = false } = {}) {
  if (!enabled) return null;
  const t = Math.max(0.35, Math.min(1, (Number(aiStrength) || 75) / 100));
  if (boosted) {
    return `eq=contrast=${(1.12 + 0.08 * t).toFixed(3)}:saturation=${(1.18 + 0.12 * t).toFixed(3)}:brightness=${(0.012 * t).toFixed(4)}`;
  }
  return `eq=contrast=${(1.04 + 0.14 * t).toFixed(3)}:saturation=${(1.05 + 0.22 * t).toFixed(3)}:brightness=${(0.008 * t).toFixed(4)}`;
}

function buildVideoEncodeArgs(preview) {
  if (preview) {
    return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p'];
}

const CLIP_TIMEOUT_DEFAULT = 900_000; // hard cap 15 minutes (long sources / late seeks)
const CLIP_TIMEOUT_MIN = 90_000;
const CLIP_PROBE_ATTEMPTS = 20;
const CLIP_PROBE_DELAY_MS = 250;
const MAX_DURATION_TRIM_DRIFT_SEC = 3;

function cutTimeoutMs(startSec, durationSec, { hybridSeek = false, montagePart = false } = {}) {
  const start = Math.max(0, Number(startSec) || 0);
  const dur = Math.max(1, Number(durationSec) || 30);
  if (hybridSeek) {
    const floor = montagePart ? 120_000 : 90_000;
    return Math.min(CLIP_TIMEOUT_DEFAULT, Math.max(floor, 40_000 + dur * 5000));
  }
  return Math.min(
    CLIP_TIMEOUT_DEFAULT,
    Math.max(CLIP_TIMEOUT_MIN, 45_000 + dur * 3000 + start * 8),
  );
}

/** Fast keyframe jump + short fine seek — accurate without decoding from t=0 (AV1). */
function buildMontageEncodeArgs(input, start, clipDuration, forceEncode) {
  const encodeTail = [
    '-t',
    String(clipDuration),
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    '-preset',
    'ultrafast',
    '-crf',
    forceEncode ? '23' : '28',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
  ];

  if (start > 4) {
    const coarse = Math.max(0, start - 3);
    const fine = start - coarse;
    return ['-y', '-ss', String(coarse), '-i', input, '-ss', String(fine), ...encodeTail];
  }
  if (start > 0.05) {
    return ['-y', '-i', input, '-ss', String(start), ...encodeTail];
  }
  return ['-y', '-i', input, ...encodeTail];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function probeMediaFile(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(path.resolve(filePath), (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function parseMediaInfo(probeData) {
  const formatDuration = Number(probeData.format?.duration);
  const video = probeData.streams?.find((s) => s.codec_type === 'video');
  const audio = probeData.streams?.find((s) => s.codec_type === 'audio');
  const streamDuration = Number(video?.duration || audio?.duration || 0);
  const duration =
    Number.isFinite(formatDuration) && formatDuration > 0
      ? formatDuration
      : streamDuration;

  return {
    duration,
    hasVideo: !!video,
    hasAudio: !!audio,
  };
}

function hookBuildTimeoutMs(mainDur, teaserDur) {
  const total = Math.max(1, Number(mainDur) || 30) + Math.max(0.5, Number(teaserDur) || 2);
  return Math.min(300_000, Math.max(75_000, 25_000 + total * 1800));
}

/** Prefer stream-copy probe; fall back to nominal when ffprobe returns a bogus short read. */
function resolveReliableMainDuration(nominalSec, probedSec) {
  const nominal = Math.max(0.5, Number(nominalSec) || 0);
  const probed = Number(probedSec);
  if (!Number.isFinite(probed) || probed < 0.25) {
    return nominal;
  }
  if (nominal > 3 && probed < nominal * 0.55) {
    console.warn(
      `[cut] main duration probe ${probed.toFixed(2)}s << nominal ${nominal.toFixed(2)}s — using nominal`,
    );
    return nominal;
  }
  if (Math.abs(probed - nominal) <= 0.45) {
    return probed;
  }
  return probed > nominal * 0.55 ? probed : nominal;
}

/** Stream-copy main clip; cached per trim for hook preview/export. */
export async function ensureMainCopyForHook(sourceVideo, highlight, workDir) {
  const rawClipsDir = path.join(workDir, 'raw-clips');
  await fs.mkdir(rawClipsDir, { recursive: true });
  const mainCopyPath = path.join(rawClipsDir, `raw_${highlight.id}.main.mp4`);
  const start = parseFloat(highlight.start_time) || 0;
  const end = parseFloat(highlight.end_time) || start + 30;
  const mainDur = end - start;

  let needMainCut = true;
  try {
    const cachedMain = await probeClipQuick(mainCopyPath);
    if (isClipProbeValid(cachedMain) && Math.abs(cachedMain.duration - mainDur) <= 0.45) {
      needMainCut = false;
    }
  } catch {
    /* rebuild */
  }

  if (needMainCut) {
    const plainRawPath = path.join(rawClipsDir, `raw_${highlight.id}.mp4`);
    try {
      const plainRaw = await probeClipQuick(plainRawPath);
      if (isClipProbeValid(plainRaw) && Math.abs(plainRaw.duration - mainDur) <= 0.45) {
        await fs.copyFile(plainRawPath, mainCopyPath);
        needMainCut = false;
      }
    } catch {
      /* no plain raw */
    }
  }

  if (needMainCut) {
    await fs.unlink(mainCopyPath).catch(() => {});
    await cutHighlightClip(sourceVideo, start, mainDur, mainCopyPath);
  }

  const mainInfo = await probeClipQuick(mainCopyPath);
  return {
    mainPath: mainCopyPath,
    mainDur: resolveReliableMainDuration(mainDur, mainInfo.duration || mainDur),
  };
}

const TEASER_ENCODE_ARGS = [
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-crf',
  '28',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-b:a',
  '128k',
  '-movflags',
  '+faststart',
  '-f',
  'mp4',
];

async function probeClipStreams(clipPath) {
  const probe = await probeMediaFile(clipPath);
  const info = parseMediaInfo(probe);
  return {
    ...info,
    hasVideo: probe.streams?.some((s) => s.codec_type === 'video') ?? false,
    hasAudio: probe.streams?.some((s) => s.codec_type === 'audio') ?? false,
  };
}

/** AV1 stream-copy mains cannot be sub-cut reliably — cache an h264 main once per trim. */
async function ensureH264MainForHook(mainCopyPath, mainDurNominal) {
  const rawClipsDir = path.dirname(mainCopyPath);
  const base = path.basename(mainCopyPath).replace(/\.main\.mp4$/i, '');
  const h264Path = path.join(rawClipsDir, `${base}.main.hook.mp4`);
  const mainCopyProbe = await probeClipQuick(mainCopyPath);
  const reliableNominal = resolveReliableMainDuration(
    mainDurNominal,
    mainCopyProbe.duration || mainDurNominal,
  );

  try {
    const cached = await probeClipStreams(h264Path);
    const probe = await probeMediaFile(h264Path);
    const video = probe.streams?.find((s) => s.codec_type === 'video');
    const cachedDurProbed = Number(cached.duration) || 0;
    if (cachedDurProbed < reliableNominal * 0.55) {
      console.warn(
        `[cut] stale h264 hook cache ${cachedDurProbed.toFixed(2)}s — rebuilding (nominal ${reliableNominal.toFixed(2)}s)`,
      );
      await fs.unlink(h264Path).catch(() => {});
    } else if (
      cached.hasVideo &&
      cached.hasAudio &&
      isClipProbeValid(cached, reliableNominal) &&
      video?.codec_name === 'h264' &&
      video?.pix_fmt === 'yuv420p'
    ) {
      const mainDurActual = resolveReliableMainDuration(reliableNominal, cachedDurProbed);
      console.log(`[cut] reuse h264 main for hook (${mainDurActual.toFixed(1)}s)`);
      return { h264Path, mainDurActual };
    }
  } catch {
    /* rebuild below */
  }

  const partPath = makePartPath(h264Path);
  await fs.unlink(partPath).catch(() => {});
  await fs.unlink(h264Path).catch(() => {});
  const timeoutMs = hookBuildTimeoutMs(reliableNominal, 0);
  console.log(`[cut] transcoding main to h264 for hook (${reliableNominal.toFixed(1)}s)`);

  await runFfmpegCut(
    path.resolve(ffmpegPath),
    [
      '-y',
      '-i',
      path.resolve(mainCopyPath),
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      ...TEASER_ENCODE_ARGS,
      partPath,
    ],
    { timeoutMs },
  );
  await finalizePartFile(partPath, h264Path);
  await assertValidClip(h264Path, 'h264 main for hook');
  const builtProbe = await probeClipQuick(h264Path);
  const mainDurActual = resolveReliableMainDuration(reliableNominal, builtProbe.duration);
  return { h264Path, mainDurActual };
}

/**
 * Teaser window anchored on the payoff moment; extends backward so the full requested
 * hook length fits even when the peak is late in the (probed) main clip.
 */
function resolveHookTeaserWindow(highlight, mainDurActual) {
  const start = parseFloat(highlight.start_time) || 0;
  const end = parseFloat(highlight.end_time) || start + 30;
  const nominalMain = Math.max(0.5, end - start);
  const mainDur = resolveReliableMainDuration(nominalMain, mainDurActual ?? nominalMain);
  const teaserRequested = getHookTeaserRequested(highlight);

  const offsetInClip = Number(highlight.hook_offset_in_clip);
  const peakAbs = Number(highlight.hook_peak_time);
  let peakRaw;
  if (Number.isFinite(offsetInClip) && offsetInClip > 0) {
    peakRaw = offsetInClip;
  } else if (Number.isFinite(peakAbs)) {
    peakRaw = peakAbs - start;
  } else {
    peakRaw = mainDur * 0.72;
  }

  const minPeak = getMinColdOpenPeakOffset(mainDur);
  const peakInClip = Math.max(minPeak, Math.min(mainDur - 0.35, peakRaw));

  let ss;
  let te;
  let actualTeaserDur;

  // Peak near clip end: take the last N seconds so the full slider length is honored.
  const tailAnchorStart = mainDur - teaserRequested - 0.2;
  if (peakInClip >= tailAnchorStart) {
    ss = Math.max(0, mainDur - teaserRequested);
    te = Math.min(mainDur, ss + teaserRequested);
    actualTeaserDur = te - ss;
  } else {
    te = Math.min(mainDur, peakInClip + 0.15);
    ss = Math.max(0, te - teaserRequested);
    actualTeaserDur = te - ss;
    if (actualTeaserDur < teaserRequested - 0.05) {
      ss = Math.max(0, mainDur - teaserRequested);
      te = Math.min(mainDur, ss + teaserRequested);
      actualTeaserDur = te - ss;
    }
  }

  if (actualTeaserDur < 0.25) {
    console.warn(
      `[cut] hook teaser clamped to ${actualTeaserDur.toFixed(2)}s ` +
        `(requested ${teaserRequested.toFixed(2)}s, peak@${peakInClip.toFixed(2)}s, main=${mainDur.toFixed(2)}s)`,
    );
  } else if (actualTeaserDur < teaserRequested - 0.12) {
    console.warn(
      `[cut] hook teaser shortened ${teaserRequested.toFixed(2)}s → ${actualTeaserDur.toFixed(2)}s ` +
        `(peak@${peakInClip.toFixed(2)}s, main=${mainDur.toFixed(2)}s)`,
    );
  }

  console.log(
    `[cut] hook window peak@${peakInClip.toFixed(2)}s ss=${ss.toFixed(2)} te=${te.toFixed(2)} ` +
      `len=${actualTeaserDur.toFixed(2)}s (requested ${teaserRequested.toFixed(2)}s)`,
  );

  return {
    teaserStartInClip: ss,
    teaserDur: teaserRequested,
    mainDur,
    peakInClip,
  };
}

/** Trim teaser + main from one h264 input and concat — no -ss (avoids 0-frame seeks). */
async function buildHookConcatFromH264Main(
  h264MainPath,
  outputPath,
  highlight,
  { teaserStartInClip, teaserDur, mainDur, mainDurActual },
) {
  const nominalMain = Math.max(0.5, Number(mainDur) || 30);
  const probedMain = await probeClipQuick(h264MainPath);
  const effectiveMainDur = resolveReliableMainDuration(
    mainDurActual ?? nominalMain,
    probedMain.duration || mainDurActual || nominalMain,
  );

  const requestedTeaser = Math.max(0.5, getHookTeaserRequested(highlight) || Number(teaserDur) || 1.5);
  let ss = Math.max(
    0,
    Math.min(Number(teaserStartInClip) || 0, Math.max(0, effectiveMainDur - requestedTeaser)),
  );
  let te = Math.min(effectiveMainDur, ss + requestedTeaser);
  let actualTeaserDur = te - ss;

  if (actualTeaserDur < requestedTeaser - 0.05) {
    ss = Math.max(0, effectiveMainDur - requestedTeaser);
    te = Math.min(effectiveMainDur, ss + requestedTeaser);
    actualTeaserDur = te - ss;
  }

  if (actualTeaserDur < 0.25) {
    throw new Error(
      `Hook teaser window empty (ss=${ss.toFixed(2)}s, main=${effectiveMainDur.toFixed(2)}s). ` +
        'Spannungs-Moment weiter nach vorne setzen.',
    );
  }

  const partPath = makePartPath(outputPath);
  const timeoutMs = hookBuildTimeoutMs(effectiveMainDur, actualTeaserDur);

  await fs.unlink(partPath).catch(() => {});
  await fs.unlink(outputPath).catch(() => {});

  console.log(
    `[cut] hook-trim concat teaser@${ss.toFixed(2)}–${te.toFixed(2)}s (${actualTeaserDur.toFixed(2)}s) ` +
      `+ main=${effectiveMainDur.toFixed(2)}s (nominal ${Number(mainDur).toFixed(2)}s)`,
  );

  const filter =
    `[0:v]trim=start=${ss}:end=${te},setpts=PTS-STARTPTS[vh];` +
    `[0:v]trim=start=0:end=${effectiveMainDur},setpts=PTS-STARTPTS[vm];` +
    `[vh][vm]concat=n=2:v=1:a=0[vout];` +
    `[0:a]asplit=2[ahs][ams];` +
    `[ahs]atrim=start=${ss}:end=${te},asetpts=PTS-STARTPTS[ha];` +
    `[ams]atrim=start=0:end=${effectiveMainDur},asetpts=PTS-STARTPTS[ma];` +
    `[ha][ma]concat=n=2:v=0:a=1[aout]`;

  await runFfmpegCut(
    path.resolve(ffmpegPath),
    [
      '-y',
      '-i',
      path.resolve(h264MainPath),
      '-filter_complex',
      filter,
      '-map',
      '[vout]',
      '-map',
      '[aout]',
      ...TEASER_ENCODE_ARGS,
      partPath,
    ],
    { timeoutMs },
  );

  await finalizePartFile(partPath, outputPath);
  const clipInfo = await probeClipQuick(outputPath);
  const expectedMin = effectiveMainDur + actualTeaserDur * 0.45;
  if ((clipInfo.duration || 0) < expectedMin) {
    throw new Error(
      `Hook concat too short: ${(clipInfo.duration || 0).toFixed(2)}s (expected >= ${expectedMin.toFixed(2)}s, ` +
        `teaser@${ss.toFixed(2)}–${te.toFixed(2)}s)`,
    );
  }

  const measuredTotal = clipInfo.duration || effectiveMainDur + actualTeaserDur;
  const probedTeaser = Math.max(0, measuredTotal - effectiveMainDur);
  const hookTeaserMeasuredSec =
    probedTeaser >= actualTeaserDur * 0.7 ? probedTeaser : actualTeaserDur;

  return {
    clipDurationMeasured: measuredTotal,
    hookTeaserMeasuredSec,
    mainDurActual: effectiveMainDur,
  };
}

/** Teaser (re-encode) + main (any codec) → hook raw mp4. */
export async function buildHookRawFromMain(mainCopyPath, outputPath, highlight) {
  const mainDurNominal = Math.max(
    1,
    (parseFloat(highlight.end_time) || 0) - (parseFloat(highlight.start_time) || 0),
  );

  await fs.unlink(outputPath).catch(() => {});

  const t0 = Date.now();
  const { h264Path: h264MainPath, mainDurActual } = await ensureH264MainForHook(
    mainCopyPath,
    mainDurNominal,
  );
  const hookWindow = resolveHookTeaserWindow(highlight, mainDurActual);
  const result = await buildHookConcatFromH264Main(h264MainPath, outputPath, highlight, {
    ...hookWindow,
    mainDurActual,
  });
  await assertValidClip(outputPath, 'hook raw');

  console.log(
    `[cut] hook-raw done ${Date.now() - t0}ms teaser=${result.hookTeaserMeasuredSec.toFixed(2)}s ` +
      `total=${result.clipDurationMeasured.toFixed(2)}s`,
  );
  return result;
}

/** Preview styling on pre-built hook raw (single input — reliable on AV1 sources). */
async function renderStyledHookPreview(hookRawPath, outputPath, highlight, options = {}) {
  const {
    aspectRatio = '9:16',
    showHook = false,
    hook,
    colorGrade = false,
    aiStrength = 75,
    clipBoosted = false,
  } = options;

  const mainDurNominal = Math.max(1, highlight.end_time - highlight.start_time);
  const teaserSec = options.knownHookTeaserSec ?? getHookTeaserRequested(highlight);
  const source = await probeVideoSource(hookRawPath);
  const cropped = getCroppedDimensions(source.width, source.height, aspectRatio);
  const vfParts = [
    buildCropFilter(aspectRatio, source.width, source.height, null),
    buildScaleFilter(cropped.height, true),
    buildColorGradeFilter(colorGrade, aiStrength, { boosted: clipBoosted }),
  ].filter(Boolean);

  const mainOutW = Math.max(2, Math.round(480 * (cropped.width / cropped.height)));
  const evenW = mainOutW - (mainOutW % 2);
  if (showHook) {
    vfParts.push(
      ...buildHookDrawtextFilters(hook || highlight.hook || highlight.title || '', {
        preview: true,
        playResX: evenW,
        hookEnd: teaserSec,
      }),
    );
  }

  const partPath = makePartPath(outputPath);
  const timeoutMs = hookBuildTimeoutMs(mainDurNominal, teaserSec);
  const t0 = Date.now();
  await fs.unlink(partPath).catch(() => {});
  console.log(`[preview] hook-style encode (timeout ${Math.round(timeoutMs / 1000)}s)`);

  await runFfmpegCut(
    path.resolve(ffmpegPath),
    [
      '-y',
      '-i',
      path.resolve(hookRawPath),
      '-vf',
      vfParts.join(','),
      ...buildVideoEncodeArgs(true),
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      partPath,
    ],
    { timeoutMs },
  );

  await finalizePartFile(partPath, outputPath);
  const clipInfo = await probeClipQuick(outputPath);
  console.log(`[preview] hook-style done ${Date.now() - t0}ms total=${(clipInfo.duration || 0).toFixed(2)}s`);

  return {
    clipDurationMeasured: clipInfo.duration || getClipDuration(highlight),
    hookTeaserMeasuredSec: teaserSec,
    mainDurNominal,
  };
}

/** Style an already-concatenated hook+main raw clip (preview fast path). */
export async function renderHookPreviewFromRaw(hookRawPath, outputPath, highlight, options = {}) {
  const knownHookTeaserSec = options.knownHookTeaserSec ?? getHookTeaserRequested(highlight);
  return renderStyledHookPreview(hookRawPath, outputPath, highlight, {
    ...options,
    knownHookTeaserSec,
  });
}

/** Preview: build hook raw, then single-pass 9:16 styling. */
export async function renderHookPreviewFast(sourceMainClip, outputPath, highlight, options = {}) {
  const hookRawPath = `${outputPath}.hookraw.mp4`;
  const t0 = Date.now();
  const built = await buildHookRawFromMain(sourceMainClip, hookRawPath, highlight);
  const styled = await renderStyledHookPreview(hookRawPath, outputPath, highlight, {
    ...options,
    knownHookTeaserSec: built.hookTeaserMeasuredSec,
  });
  await fs.unlink(hookRawPath).catch(() => {});
  console.log(`[preview] hook-fast total ${Date.now() - t0}ms`);
  return {
    clipDurationMeasured: styled.clipDurationMeasured || built.clipDurationMeasured,
    hookTeaserMeasuredSec: built.hookTeaserMeasuredSec,
  };
}

/** Wait until ffprobe reports a readable clip (handles Windows flush delay). */
export async function assertValidClip(clipPath, label = 'clip') {
  const resolved = path.resolve(clipPath);
  let lastError = 'unknown';

  for (let attempt = 1; attempt <= CLIP_PROBE_ATTEMPTS; attempt++) {
    try {
      const stat = await fs.stat(resolved);
      if (!stat.size) {
        throw new Error('file is empty');
      }

      const probe = await probeMediaFile(resolved);
      const info = parseMediaInfo(probe);
      if (!info.hasVideo || info.duration < 0.25) {
        throw new Error(
          `invalid media (duration=${info.duration}, video=${info.hasVideo}, audio=${info.hasAudio})`,
        );
      }

      console.log(
        `[ffmpeg] ${label} verified: ${info.duration.toFixed(2)}s, audio=${info.hasAudio}, size=${stat.size}`,
      );
      return info;
    } catch (err) {
      lastError = err?.message || String(err);
      if (attempt < CLIP_PROBE_ATTEMPTS) {
        await sleep(CLIP_PROBE_DELAY_MS);
      }
    }
  }

  throw new Error(`Clip not valid after cut (${resolved}): ${lastError}`);
}

function runFfmpegCut(bin, args, { timeoutMs = CLIP_TIMEOUT_DEFAULT } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let settled = false;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };

    const timeout = setTimeout(() => {
      finish(() => {
        proc.kill('SIGKILL');
        reject(new Error(`FFmpeg clip cut timed out after ${Math.round(timeoutMs / 1000)}s`));
      });
    }, timeoutMs);

    proc.stderr?.on('data', (d) => console.log('[ffmpeg cut]', d.toString()));

    proc.on('close', (code) => {
      finish(() => {
        if (code === 0) {
          console.log('[ffmpeg cut] process closed with code 0');
          resolve();
        } else {
          reject(new Error(`FFmpeg clip cut failed with code ${code}`));
        }
      });
    });

    proc.on('error', (err) => {
      finish(() => reject(err));
    });
  });
}

function isClipProbeValid(info, expectedDurationSec = null) {
  if (!info.hasVideo || info.duration < 0.25) return false;
  const expected = Number(expectedDurationSec);
  if (!Number.isFinite(expected) || expected <= 0) return true;
  return Math.abs(info.duration - expected) <= 0.35;
}

export async function probeClipQuick(clipPath) {
  try {
    const stat = await fs.stat(clipPath);
    if (!stat.size) {
      return { duration: 0, hasVideo: false, hasAudio: false };
    }
    const probe = await probeMediaFile(clipPath);
    return parseMediaInfo(probe);
  } catch {
    return { duration: 0, hasVideo: false, hasAudio: false };
  }
}

/** Step 1: fast stream copy (input seek). Step 2: re-encode fallback for AV1/broken cuts. */
export async function cutHighlightClip(sourceVideo, startTime, duration, outPath, opts = {}) {
  return withCutLock(outPath, () =>
    cutHighlightClipUnlocked(sourceVideo, startTime, duration, outPath, opts),
  );
}

async function cutHighlightClipUnlocked(sourceVideo, startTime, duration, outPath, opts = {}) {
  const forceEncode = Boolean(opts.forceEncode);
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const input = path.resolve(sourceVideo);
  const output = path.resolve(outPath);
  const partPath = makePartPath(output);
  const bin = path.resolve(ffmpegPath);

  const start = Math.max(0, parseFloat(startTime) || 0);
  let clipDuration = parseFloat(duration);
  if (!Number.isFinite(clipDuration) || clipDuration <= 0) {
    throw new Error(`Invalid clip duration: ${duration}`);
  }

  try {
    const sourceProbe = await probeMediaFile(input);
    const sourceDuration = parseMediaInfo(sourceProbe).duration;
    console.log(`[cut] source duration=${sourceDuration.toFixed(2)}s`);
    if (sourceDuration > 0 && start >= sourceDuration) {
      throw new Error(`start ${start}s is past source duration ${sourceDuration}s`);
    }
    if (sourceDuration > 0 && start + clipDuration > sourceDuration) {
      clipDuration = sourceDuration - start;
      console.log(`[cut] clamped duration to ${clipDuration.toFixed(3)}s (source end)`);
    }
  } catch (err) {
    if (String(err.message).includes('past source duration')) throw err;
    console.warn('[cut] could not probe source duration:', err.message);
  }

  const accurateSeek = Boolean(opts.accurateSeek || forceEncode);
  const useExactSeek = Boolean(opts.exactSeek) && start < 90;
  const cutTimeout = cutTimeoutMs(start, clipDuration, {
    hybridSeek: accurateSeek && !useExactSeek,
    montagePart: Boolean(opts.montagePart),
  });
  console.log(
    `[cut] ffmpeg -ss ${start.toFixed(3)} -t ${clipDuration.toFixed(3)} -> ${output} ` +
      `(timeout ${Math.round(cutTimeout / 1000)}s${accurateSeek ? ', hybrid seek' : ''})`,
  );

  await fs.unlink(partPath).catch(() => {});

  const copyArgs = [
    '-y',
    '-ss',
    String(start),
    '-i',
    input,
    '-t',
    String(clipDuration),
    '-c',
    'copy',
    '-avoid_negative_ts',
    'make_zero',
    '-f',
    'mp4',
    partPath,
  ];

  let copyOk = false;
  if (forceEncode) {
    console.log('[cut] step 1: skip stream copy (forceEncode)');
  }
  try {
    if (!forceEncode) {
      console.log('[cut] step 1: stream copy');
      await runFfmpegCut(bin, copyArgs, { timeoutMs: cutTimeout });
    }
    if (!forceEncode) {
      const copyInfo = await probeClipQuick(partPath);
      if (isClipProbeValid(copyInfo, clipDuration)) {
        copyOk = true;
        console.log(
          `[cut] stream copy ok: ${copyInfo.duration.toFixed(2)}s, audio=${copyInfo.hasAudio}`,
        );
      } else {
      const drift = Math.abs((copyInfo.duration || 0) - clipDuration);
      if (copyInfo.duration > 0.5 && drift <= MAX_DURATION_TRIM_DRIFT_SEC) {
        console.log(
          `[cut] stream copy drift ${drift.toFixed(2)}s — trimming to ${clipDuration.toFixed(2)}s (copy)`,
        );
        await trimClipToExactDuration(partPath, clipDuration);
        const trimmed = await probeClipQuick(partPath);
        if (isClipProbeValid(trimmed, clipDuration)) {
          copyOk = true;
          console.log(`[cut] trim ok: ${trimmed.duration.toFixed(2)}s`);
        } else {
          await fs.unlink(partPath).catch(() => {});
        }
      } else {
        console.log(
          `[cut] stream copy invalid (got ${copyInfo.duration?.toFixed?.(2) ?? copyInfo.duration}s, ` +
            `want ${clipDuration.toFixed(2)}s), falling back to re-encode`,
        );
        await fs.unlink(partPath).catch(() => {});
      }
      }
    }
  } catch (err) {
    if (!forceEncode) {
      console.log(`[cut] stream copy failed: ${err.message} — re-encoding`);
      await fs.unlink(partPath).catch(() => {});
    }
  }

  if (!copyOk) {
    const encodeTail = [
      '-t',
      String(clipDuration),
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-preset',
      'ultrafast',
      '-crf',
      forceEncode ? '23' : '28',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
    ];
    const encodeArgs = useExactSeek
      ? ['-y', '-i', input, '-ss', String(start), ...encodeTail, partPath]
      : accurateSeek
      ? [...buildMontageEncodeArgs(input, start, clipDuration, forceEncode), partPath]
      : [
          '-y',
          '-ss',
          String(start),
          '-i',
          input,
          '-t',
          String(clipDuration),
          '-c:v',
          'libx264',
          '-c:a',
          'aac',
          '-preset',
          'ultrafast',
          '-crf',
          forceEncode ? '23' : '28',
          '-pix_fmt',
          'yuv420p',
          '-g',
          '30',
          '-keyint_min',
          '30',
          '-force_key_frames',
          '0',
          '-movflags',
          '+faststart',
          '-f',
          'mp4',
          partPath,
        ];
    console.log(
      `[cut] step 2: re-encode (libx264/aac${forceEncode ? ', montage part' : ''}` +
        `${useExactSeek ? ', exact seek' : accurateSeek ? ', hybrid seek' : ''})`,
    );
    await runFfmpegCut(bin, encodeArgs, { timeoutMs: cutTimeout });
  }

  try {
    await finalizePartFile(partPath, output);
    await assertValidClip(output, 'raw clip');
    const finalInfo = await probeClipQuick(output);
    if (!isClipProbeValid(finalInfo, clipDuration)) {
      console.log(
        `[cut] duration trim ${finalInfo.duration?.toFixed?.(2) ?? '?'}s -> ${clipDuration.toFixed(2)}s`,
      );
      await trimClipToExactDuration(output, clipDuration);
    }
  } catch (err) {
    await fs.unlink(partPath).catch(() => {});
    throw err;
  }

  return output;
}

/** Trim an already-cut short clip to exact length (copy first, encode only if needed). */
async function trimClipToExactDuration(clipPath, durationSec) {
  const bin = path.resolve(ffmpegPath);
  const input = path.resolve(clipPath);
  const partPath = makePartPath(input);
  const dur = Math.max(0.25, parseFloat(durationSec) || 0);
  const trimTimeout = Math.min(120_000, cutTimeoutMs(0, dur));

  await fs.unlink(partPath).catch(() => {});

  let trimmed = false;
  try {
    await runFfmpegCut(
      bin,
      [
        '-y',
        '-i',
        input,
        '-t',
        String(dur),
        '-c',
        'copy',
        '-avoid_negative_ts',
        'make_zero',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        partPath,
      ],
      { timeoutMs: trimTimeout },
    );
    const info = await probeClipQuick(partPath);
    trimmed = isClipProbeValid(info, dur);
  } catch (err) {
    console.log(`[cut] duration copy-trim failed: ${err.message}`);
    await fs.unlink(partPath).catch(() => {});
  }

  if (!trimmed) {
    await fs.unlink(partPath).catch(() => {});
    await runFfmpegCut(
      bin,
      [
        '-y',
        '-i',
        input,
        '-t',
        String(dur),
        ...buildVideoEncodeArgs(true),
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        partPath,
      ],
      { timeoutMs: trimTimeout },
    );
  }

  await finalizePartFile(partPath, input);
}

/**
 * Cold-open hook (fast path):
 * 1. Stream-copy main clip from source (~seconds even on long videos)
 * 2. Extract ~2s teaser from the short clip file
 * 3. Concat teaser + main (~30s total, not the full source)
 */
export async function cutRawClipWithHook(sourceVideo, highlight, workDir) {
  const lockKey = path.join(workDir, 'raw-clips', highlight.id);
  return withCutLock(lockKey, () => cutRawClipWithHookUnlocked(sourceVideo, highlight, workDir));
}

async function cutRawClipWithHookUnlocked(sourceVideo, highlight, workDir) {
  if (!shouldUseColdOpen(highlight)) {
    if (isMontageHighlight(highlight) && (highlight.montage_segments?.length || 0) < 2) {
      throw new Error(
        `Montage highlight ${highlight.id} has no segments — refusing linear VOD span cut`,
      );
    }
    const clipPath =
      highlight.montage_segments?.length >= 2
        ? await cutMontageClip(sourceVideo, highlight, workDir)
        : await cutRawClip(sourceVideo, highlight, workDir);
    const info = await probeClipQuick(clipPath);
    return {
      clipPath,
      hookTeaserMeasuredSec: 0,
      clipDurationMeasured: info.duration || 0,
    };
  }

  const rawClipsDir = path.join(workDir, 'raw-clips');
  await fs.mkdir(rawClipsDir, { recursive: true });
  const clipPath = path.join(rawClipsDir, `raw_${highlight.id}.mp4`);
  const mainCopyPath = path.join(rawClipsDir, `raw_${highlight.id}.main.mp4`);

  const start = parseFloat(highlight.start_time) || 0;
  const end = parseFloat(highlight.end_time) || start + 30;
  const mainDurNominal = end - start;

  console.log(
    `[cut] cold-open highlight=${highlight.id} main=${start.toFixed(1)}s (nominal ${mainDurNominal.toFixed(1)}s)`,
  );

  await fs.unlink(clipPath).catch(() => {});

  let needMainCut = true;
  try {
    const cachedMain = await probeClipQuick(mainCopyPath);
    if (isClipProbeValid(cachedMain) && Math.abs(cachedMain.duration - mainDurNominal) <= 0.45) {
      needMainCut = false;
    }
  } catch {
    /* no cached main */
  }

  if (needMainCut) {
    const plainRawPath = path.join(rawClipsDir, `raw_${highlight.id}.mp4`);
    try {
      const plainRaw = await probeClipQuick(plainRawPath);
      if (isClipProbeValid(plainRaw) && Math.abs(plainRaw.duration - mainDurNominal) <= 0.45) {
        await fs.copyFile(plainRawPath, mainCopyPath);
        needMainCut = false;
        console.log(`[cut] cold-open reuse plain raw as main for ${highlight.id}`);
      }
    } catch {
      /* plain raw missing or invalid */
    }
  }

  if (needMainCut) {
    await fs.unlink(mainCopyPath).catch(() => {});
    await cutHighlightClip(sourceVideo, start, mainDurNominal, mainCopyPath);
  } else {
    console.log(
      `[cut] cold-open reuse cached main for ${highlight.id} (${mainDurNominal.toFixed(1)}s nominal)`,
    );
  }

  const { h264Path: h264MainPath, mainDurActual } = await ensureH264MainForHook(
    mainCopyPath,
    mainDurNominal,
  );
  const hookWindow = resolveHookTeaserWindow(highlight, mainDurActual);
  console.log(
    `[cut] cold-open teaser@${hookWindow.teaserStartInClip.toFixed(2)}s ` +
      `len=${hookWindow.teaserDur.toFixed(2)}s main=${hookWindow.mainDur.toFixed(2)}s`,
  );
  const hookResult = await buildHookConcatFromH264Main(h264MainPath, clipPath, highlight, {
    ...hookWindow,
    mainDurActual,
  });

  await assertValidClip(clipPath, 'raw clip with hook');

  return {
    clipPath,
    hookTeaserMeasuredSec: hookResult.hookTeaserMeasuredSec,
    clipDurationMeasured: hookResult.clipDurationMeasured,
  };
}

/**
 * Jump-cut montage: 2–4 kill segments concatenated into one raw clip.
 * highlight.montage_segments: [{ start, duration }, ...]
 */
export async function cutMontageClip(sourceVideo, highlight, workDir) {
  const segments = highlight.montage_segments;
  if (!segments?.length || segments.length < 2) {
    throw new Error(
      `cutMontageClip: highlight ${highlight.id} needs ≥2 segments (got ${segments?.length || 0})`,
    );
  }

  const rawClipsDir = path.join(workDir, 'raw-clips');
  await fs.mkdir(rawClipsDir, { recursive: true });
  const clipPath = path.join(rawClipsDir, `raw_${highlight.id}.mp4`);
  const partPaths = [];

  console.log(
    `[cut] montage highlight=${highlight.id} segments=${segments.length} ` +
      segments.map((s) => `${s.start.toFixed(1)}+${s.duration.toFixed(1)}s`).join(' | '),
  );

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const partPath = path.join(rawClipsDir, `raw_${highlight.id}_m${i}.mp4`);
    await cutHighlightClip(sourceVideo, seg.start, seg.duration, partPath, {
      forceEncode: true,
      accurateSeek: true,
      montagePart: true,
    });
    partPaths.push(partPath);
  }

  const bin = path.resolve(ffmpegPath);
  await fs.unlink(clipPath).catch(() => {});

  const filterParts = [];
  const inputs = [];
  for (let i = 0; i < partPaths.length; i++) {
    inputs.push('-i', partPaths[i]);
    filterParts.push(`[${i}:v:0][${i}:a:0]`);
  }
  const filter = `${filterParts.join('')}concat=n=${partPaths.length}:v=1:a=1[v][a]`;
  console.log('[cut] montage concat: re-encode (avoids browser freeze at segment joins)');
  await runFfmpegCut(
    bin,
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
      clipPath,
    ],
    { timeoutMs: 240_000 },
  );

  const info = await probeClipQuick(clipPath);
  if (!info.hasVideo || info.duration < 2) {
    throw new Error(`Montage concat failed for ${highlight.id}: ${info.duration}s`);
  }

  console.log(
    `[cut] montage done: ${info.duration.toFixed(2)}s output (${segments.length} cuts, ` +
      `nominal ${segments.reduce((s, seg) => s + seg.duration, 0).toFixed(1)}s)`,
  );
  return clipPath;
}

/** Cut raw highlight clip; resolves only after FFmpeg exits successfully. */
export async function cutRawClip(sourceVideo, highlight, workDir) {
  const rawClipsDir = path.join(workDir, 'raw-clips');
  await fs.mkdir(rawClipsDir, { recursive: true });
  const clipPath = path.join(rawClipsDir, `raw_${highlight.id}.mp4`);

  console.log('[cut] start_time:', highlight.start_time, typeof highlight.start_time);
  console.log('[cut] end_time:', highlight.end_time, typeof highlight.end_time);
  console.log('[cut] duration:', highlight.end_time - highlight.start_time);

  const startTime = parseFloat(highlight.start_time) || 0;
  const duration = parseFloat(highlight.end_time) - parseFloat(highlight.start_time);

  if (duration <= 0) {
    throw new Error(`Invalid duration: ${duration}`);
  }

  console.log(
    `[cut] highlight=${highlight.id} startTime=${startTime} duration=${duration} source=${sourceVideo}`,
  );

  return cutHighlightClip(sourceVideo, startTime, duration, clipPath);
}

export async function extractThumbnail(videoPath, timeSec, outPath) {
  await runCommand(ffmpegPath, [
    '-y',
    '-ss',
    String(timeSec),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    outPath,
  ]);
}

export async function processClip({
  sourceVideo,
  workDir,
  highlight,
  transcriptSegments,
  options,
}) {
  const {
    start_time,
    end_time,
    hook,
  } = highlight;

  const {
    aspectRatio = '9:16',
    smartCrop = true,
    captions = true,
    music = true,
    colorGrade = true,
    aiStrength = 75,
    musicPath,
    ctaText = '',
    showHook = false,
    webcam = null,
    preview = false,
    outputName,
    clipLocalTimestamps = false,
    wideOverlay = true,
    wideOverlayRegion = null,
    clipBoosted = false,
    captionStyle,
    musicVolume = 15,
    musicOffsetSec = 0,
    startFromPass = 1,
    stopAfterPass = 3,
    cachePaths = null,
  } = options;

  await fs.mkdir(workDir, { recursive: true });

  const clipStart = clipLocalTimestamps ? 0 : start_time;
  let duration = clipLocalTimestamps
    ? getClipDuration(highlight)
    : Math.max(1, end_time - start_time);
  if (clipLocalTimestamps) {
    try {
      const probed = await getVideoDuration(sourceVideo);
      if (probed > 0.5) duration = probed;
    } catch {
      /* use calculated */
    }
  }
  const effectiveEnd = clipLocalTimestamps ? duration : end_time;
  const source = await probeVideoSource(sourceVideo);

  let faceCrop = null;
  if (smartCrop && !preview) {
    faceCrop = await detectFaceCrop(sourceVideo, start_time, Math.min(duration, 30));
  }

  let wideMoment = null;
  if (
    startFromPass <= 1 &&
    wideOverlay === true &&
    aspectRatio === '9:16' &&
    source.width / source.height > 1.25
  ) {
    wideMoment = await resolveWideMoment(
      sourceVideo,
      clipStart,
      duration,
      clipLocalTimestamps ? transcriptSegments : null,
      {
        wideOverlay: true,
        manual:
          wideOverlayRegion?.selection?.width
            ? wideOverlayRegion
            : null,
        fast: preview,
      },
    );
    if (wideMoment && wideOverlayRegion) {
      wideMoment = applyWideTimeRange(wideMoment, wideOverlayRegion, duration);
    }
  }

  const cropped = getCroppedDimensions(source.width, source.height, aspectRatio);
  const vfParts = [buildCropFilter(aspectRatio, source.width, source.height, faceCrop)];

  const colorF = buildColorGradeFilter(colorGrade, aiStrength, { boosted: clipBoosted });
  if (colorF) vfParts.push(colorF);

  const scaleF = buildScaleFilter(cropped.height, preview);

  const teaserSec = highlight.cold_open ? getHookTeaserDuration(highlight) : 0;

  let mainOutW = cropped.width;
  let mainOutH = cropped.height;
  if (scaleF) {
    if (preview) {
      mainOutH = 480;
      mainOutW = Math.round(480 * (cropped.width / cropped.height));
    } else {
      mainOutH = 1920;
      mainOutW = Math.round(1920 * (cropped.width / cropped.height));
    }
  }
  mainOutW = Math.max(2, mainOutW - (mainOutW % 2));
  mainOutH = Math.max(2, mainOutH - (mainOutH % 2));

  const safeClipId = String(highlight.id).replace(/[^a-zA-Z0-9_-]/g, '_');
  const useCache = Boolean(cachePaths?.pass1);
  const pass1Path = useCache
    ? cachePaths.pass1
    : path.join(workDir, `_pass1_${safeClipId}.mp4`);
  const pass2Path = useCache
    ? cachePaths.pass2
    : path.join(workDir, `_pass2_${safeClipId}.mp4`);
  const preMusicPath = cachePaths?.preMusic || null;

  const assFileName = `subs_${safeClipId}.ass`;
  const assFiles = [];

  if (captions && transcriptSegments?.length) {
    const outW = mainOutW;
    const outH = mainOutH;

    const clipTranscript = [...transcriptSegments];
    const previewWords = clipTranscript
      .slice(0, 5)
      .map((s) => `"${String(s.text).trim()}"`)
      .join(', ');
    console.log(
      `[captions] Clip ${highlight.id}: building captions from ${clipTranscript.length} clip-local words → ${assFileName}`,
      previewWords ? `(first words: ${previewWords})` : '',
    );

    let captionWords = prepareClipCaptionWords(
      clipTranscript,
      highlight,
      clipStart,
      effectiveEnd,
      clipLocalTimestamps,
    );
    captionWords = resolveCaptionTimings(captionWords);
    captionWords = clampCaptionWordsToDuration(captionWords, duration);
    logCaptionSyncDiagnostics(highlight.id, captionWords);

    if (!captionWords.length) {
      const msg =
        `[captions] Clip ${highlight.id}: NO caption words after timing ` +
        `(${clipTranscript.length} raw segments, duration=${duration.toFixed(1)}s)`;
      if (isMontageHighlight(highlight)) {
        console.warn(`${msg} — montage clip, continuing without subtitles`);
      } else {
        console.error(msg);
        if (captions && isViableTranscript(clipTranscript)) {
          throw new AppError(`${msg} — aborting render`, 500);
        }
      }
    } else {
      const assContent = buildAssSubtitles(captionWords, outW, outH, {
        style: normalizeCaptionStyle(captionStyle ?? highlight.caption_style),
        highlightKeywords: true,
      });
      const dialogueLines = countAssDialogueLines(assContent);
      if (dialogueLines === 0 && !isMontageHighlight(highlight)) {
        throw new AppError(
          `[captions] Clip ${highlight.id}: ASS file has zero dialogue lines`,
          500,
        );
      }
      await fs.writeFile(path.join(workDir, assFileName), assContent, 'utf8');
      assFiles.push(assFileName);
      console.log(
        `[captions] Clip ${highlight.id}: ASS ready (${dialogueLines} lines, style=${normalizeCaptionStyle(captionStyle ?? highlight.caption_style)})`,
      );
    }
  } else if (captions) {
    console.warn(
      `[captions] Clip ${highlight.id}: captions skipped — transcript empty or too sparse`,
    );
  }

  if (showHook) {
    const hookRaw = hook || highlight.hook || highlight.title || 'Watch this';
    const hookEnd = Math.min(duration, teaserSec > 0 ? teaserSec : 1.8);
    const hookAssName = `hook_${safeClipId}.ass`;
    const hookAss = buildHookAssSubtitles(hookRaw, mainOutW, mainOutH, hookEnd);
    await fs.writeFile(path.join(workDir, hookAssName), hookAss, 'utf8');
    assFiles.push(hookAssName);
  }

  const trimmedCta = String(ctaText ?? '').trim();
  const ctaFilter = trimmedCta
    ? `drawtext=text='${escapeDrawtext(trimmedCta)}':fontsize=${preview ? 28 : 42}:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h*0.4:${enableBetween(Math.max(0, duration - 1.5), duration)}`
    : null;

  const baseName = outputName || `clip_${highlight.id}.mp4`;
  const outFile = path.join(workDir, baseName);

  const usePip = isWebcamPipEnabled(webcam);
  const useWide = isWideOverlayActive(wideMoment);

  if (wideMoment && wideOverlayRegion?.pip) {
    wideMoment = { ...wideMoment, pip: wideOverlayRegion.pip };
  }

  const hasMusic = music && musicPath;
  const hookMusicSkip = highlight.cold_open ? teaserSec : 0;
  const useFilterComplex = useWide || usePip;
  const baseVideoChain = vfParts.join(',');

  const needsAssPass = assFiles.length > 0 || Boolean(ctaFilter);
  let videoBeforeMusic = pass1Path;

  if (startFromPass <= 1) {
    const args = ['-y'];
    if (!clipLocalTimestamps) {
      args.push('-ss', String(start_time));
    }
    args.push('-i', sourceVideo);
    if (!clipLocalTimestamps) {
      args.push('-t', String(duration));
    }

    const preserveAudioSync = clipLocalTimestamps;

    if (useFilterComplex) {
      const composite = buildVideoCompositeGraph(baseVideoChain, {
        wideMoment,
        webcam: usePip ? webcam : null,
        mainOutW,
        mainOutH,
      });
      args.push('-filter_complex', composite.graph, '-map', `[${composite.videoOutputLabel}]`, '-map', '0:a');
    } else {
      let vf = baseVideoChain;
      if (scaleF) vf += `,${scaleF}`;
      args.push('-vf', vf);
    }

    args.push(...buildVideoEncodeArgs(preview));
    if (preserveAudioSync) {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-b:a', preview ? '96k' : '192k');
    }
    args.push('-movflags', '+faststart', pass1Path);

    try {
      await runCommand(ffmpegPath, args, { cwd: workDir });
    } catch (err) {
      throw new AppError(`FFmpeg pass 1 failed: ${err.message}`, 500);
    }

    if (stopAfterPass <= 1) {
      return pass1Path;
    }
  } else {
    try {
      await fs.access(pass1Path);
    } catch {
      throw new AppError(`Cached pass1 missing: ${pass1Path}`, 500);
    }
  }

  if (startFromPass <= 2) {
    const assInput = pass1Path;
    if (needsAssPass) {
      try {
        await burnAssSubtitlesOntoVideo(assInput, pass2Path, workDir, assFiles, {
          ctaFilter,
          preview,
        });
      } catch (err) {
        throw new AppError(`FFmpeg caption burn failed: ${err.message}`, 500);
      }
      if (!useCache) {
        await fs.unlink(pass1Path).catch(() => {});
      }
      videoBeforeMusic = pass2Path;
    }

    if (stopAfterPass <= 2) {
      if (preMusicPath) {
        await fs.copyFile(videoBeforeMusic, preMusicPath);
      }
      return videoBeforeMusic;
    }
  } else {
    try {
      await fs.access(pass2Path);
      videoBeforeMusic = pass2Path;
    } catch {
      try {
        await fs.access(pass1Path);
        videoBeforeMusic = pass1Path;
      } catch {
        throw new AppError(`Cached pass2/pass1 missing for ${highlight.id}`, 500);
      }
    }
  }

  if (preMusicPath) {
    await fs.copyFile(videoBeforeMusic, preMusicPath);
  }

  if (hasMusic) {
    try {
      await mixMusicOntoVideo(
        preMusicPath || videoBeforeMusic,
        outFile,
        musicPath,
        duration,
        {
          preview,
          musicStartSec: hookMusicSkip,
          musicVolume: normalizeMusicVolume(musicVolume),
          musicOffsetSec,
        },
      );
    } catch (err) {
      throw new AppError(`FFmpeg music mix failed: ${err.message}`, 500);
    }
    if (!useCache) {
      await fs.unlink(videoBeforeMusic).catch(() => {});
    }
  } else {
    await fs.copyFile(preMusicPath || videoBeforeMusic, outFile);
    if (!useCache && preMusicPath && preMusicPath !== videoBeforeMusic) {
      await fs.unlink(videoBeforeMusic).catch(() => {});
    }
  }

  return outFile;
}

export function buildFilename(highlight, platform = 'shorts') {
  const sanitize = (name) =>
    String(name)
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .slice(0, 40);
  return `${sanitize(highlight.title)}_${platform}_${highlight.viral_score}.mp4`;
}
