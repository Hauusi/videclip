import path from 'path';
import fs from 'fs/promises';
import { ffmpegPath } from '../lib/ffmpeg.js';
import { runCommand } from './exec.js';
import { AppError } from '../utils/errors.js';

/** Relative ASS filename for subtitles filter (Pass 2 runs with cwd=workDir). */
export function assFilterArg(_workDir, fileName) {
  return String(fileName).replace(/\\/g, '/');
}

/**
 * Drop orphan timings and clamp words to clip duration.
 */
export function clampCaptionWordsToDuration(words, durationSec, { padSec = 0.2 } = {}) {
  const maxT = Math.max(0.5, Number(durationSec) || 0) + padSec;
  return words
    .filter((w) => Number(w.start) < maxT)
    .map((w) => {
      const start = Math.max(0, Number(w.start) || 0);
      const end = Math.min(maxT, Math.max(start + 0.05, Number(w.end) || start + 0.05));
      return { ...w, start, end };
    })
    .filter((w) => w.end > w.start && String(w.text || '').trim());
}

export const MIN_VIABLE_CAPTION_WORDS = 5;

export function isViableTranscript(segments) {
  return Array.isArray(segments) && segments.length >= MIN_VIABLE_CAPTION_WORDS;
}

export function countAssDialogueLines(assContent) {
  return String(assContent || '')
    .split('\n')
    .filter((line) => line.startsWith('Dialogue:')).length;
}

function buildVideoEncodeArgs(preview) {
  if (preview) {
    return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p'];
}

/**
 * Pass 2: burn ASS (+ optional drawtext CTA) onto an already-rendered video.
 * Uses simple -vf (not filter_complex) for reliable Windows libass paths.
 */
export async function burnAssSubtitlesOntoVideo(
  inputVideo,
  outputVideo,
  workDir,
  assFiles,
  { ctaFilter = null, preview = false } = {},
) {
  if (!assFiles.length && !ctaFilter) {
    await fs.copyFile(inputVideo, outputVideo);
    return;
  }

  const vfParts = assFiles.map((f) => {
    const rel = assFilterArg(workDir, f);
    return `subtitles=${rel}`;
  });
  if (ctaFilter) vfParts.push(ctaFilter);

  await runCommand(
    ffmpegPath,
    [
      '-y',
      '-i',
      path.resolve(inputVideo),
      '-vf',
      vfParts.join(','),
      '-c:a',
      'copy',
      ...buildVideoEncodeArgs(preview),
      '-movflags',
      '+faststart',
      path.resolve(outputVideo),
    ],
    { cwd: workDir },
  );
}

/**
 * Pass 3: mix royalty-free background music (voice unchanged).
 * Music starts after hook via adelay — hook stays voice-only.
 */
export async function mixMusicOntoVideo(
  inputVideo,
  outputVideo,
  musicPath,
  durationSec,
  {
    preview = false,
    musicStartSec = 0,
    musicVolume = 0.15,
    musicOffsetSec = 0,
  } = {},
) {
  const duration = Math.max(0.5, Number(durationSec) || 1);
  const hookSkip = Math.max(0, Number(musicStartSec) || 0);
  const vol = Math.min(0.45, Math.max(0, Number(musicVolume) || 0.15));
  const mainDur = Math.max(0.5, duration - hookSkip);
  const delayMs = Math.round(hookSkip * 1000);
  const musicSs = Math.max(0, Number(musicOffsetSec) || 0);
  const fadeOutAt = Math.max(0.2, mainDur - 0.5);

  // Output label [music] must be suffixed to the last filter (no leading comma).
  const musicChain = [
    `[1:a]atrim=start=${musicSs.toFixed(3)}:duration=${mainDur.toFixed(3)}`,
    'asetpts=PTS-STARTPTS',
    `volume=${vol.toFixed(4)}`,
    delayMs > 0 ? `adelay=${delayMs}|${delayMs}` : null,
    'afade=t=in:st=0:d=0.6',
    `afade=t=out:st=${fadeOutAt.toFixed(3)}:d=0.5[music]`,
  ]
    .filter(Boolean)
    .join(',');

  await runCommand(ffmpegPath, [
    '-y',
    '-i',
    path.resolve(inputVideo),
    '-stream_loop',
    '-1',
    '-i',
    path.resolve(musicPath),
    '-filter_complex',
    [
      '[0:a]aresample=44100,aformat=channel_layouts=stereo,anull[voice]',
      musicChain,
      '[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]',
    ].join(';'),
    '-map',
    '0:v',
    '-map',
    '[aout]',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    preview ? '64k' : '192k',
    ...(preview ? [] : ['-movflags', '+faststart']),
    path.resolve(outputVideo),
  ]);
}
