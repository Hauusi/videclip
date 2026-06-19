import path from 'path';
import fs from 'fs/promises';
import { cutRawClipWithHook, probeClipQuick } from './ffmpeg.js';
import {
  transcribeClipAudio,
  guessTranscriptLanguage,
  normalizeWhisperLanguage,
  applyColdOpenCaptionShift,
  buildClipCaptionTimings,
  transcriptIsMainTimelineOnly,
} from './transcript.js';
import {
  getColdOpenCaptionParams,
  getClipDuration,
  getHookTeaserDuration,
  getHookTeaserRequested,
  isHookPeakInsideTrim,
  shouldUseColdOpen,
} from './hookClip.js';
import { clampColdOpenPeakTime } from './coldOpenTiming.js';
import { isViableTranscript } from './captionPipeline.js';

const MIN_MAIN_SEC = 8;
const MAX_MAIN_SEC = 60;
const MIN_HOOK_SEC = 0.5;
const MAX_HOOK_SEC = 4;

export function clampMainDuration(start, end, sourceDuration) {
  let s = Math.max(0, Number(start) || 0);
  let e = Math.max(s + MIN_MAIN_SEC, Number(end) || s + 28);
  if (sourceDuration > 0) {
    e = Math.min(sourceDuration, e);
    s = Math.min(s, Math.max(0, e - MIN_MAIN_SEC));
  }
  if (e - s > MAX_MAIN_SEC) e = s + MAX_MAIN_SEC;
  if (e - s < MIN_MAIN_SEC) e = s + MIN_MAIN_SEC;
  return { start: s, end: e };
}

/**
 * Merge UI settings into a highlight for cutting / rendering.
 */
export function buildExportHighlight(hl, settings = {}, sourceDuration = 0) {
  const { start, end } = clampMainDuration(
    settings.start_time ?? hl.start_time,
    settings.end_time ?? hl.end_time,
    sourceDuration,
  );

  const userColdOpen = settings.cold_open === true;
  const hookTeaser = userColdOpen
    ? Math.min(
        MAX_HOOK_SEC,
        Math.max(MIN_HOOK_SEC, Number(settings.hook_teaser_duration ?? hl.hook_teaser_duration ?? 2.2)),
      )
    : 0;

  const mainDur = end - start;
  let hookOffsetInClip = Number(settings.hook_offset_in_clip);
  let hookPeak;
  if (Number.isFinite(hookOffsetInClip)) {
    hookPeak = start + hookOffsetInClip;
  } else if (Number.isFinite(Number(settings.hook_peak_time))) {
    hookPeak = Number(settings.hook_peak_time);
    hookOffsetInClip = hookPeak - start;
  } else if (Number.isFinite(Number(hl.hook_peak_time))) {
    hookPeak = Number(hl.hook_peak_time);
    hookOffsetInClip = hookPeak - start;
  } else {
    hookOffsetInClip = mainDur * 0.72;
    hookPeak = start + hookOffsetInClip;
  }
  hookPeak = Math.max(start + 0.3, Math.min(end - 0.3, hookPeak));
  hookOffsetInClip = Math.max(0, Math.min(mainDur, hookPeak - start));

  if (userColdOpen && hookTeaser >= MIN_HOOK_SEC) {
    hookPeak = clampColdOpenPeakTime(start, end, hookPeak);
  }

  const highlight = {
    ...hl,
    start_time: start,
    end_time: end,
    hook_teaser_duration: hookTeaser,
    hook_peak_time: hookPeak,
    hook_offset_in_clip: hookOffsetInClip,
    hook: settings.hook ?? hl.hook,
    user_cold_open: userColdOpen,
    cold_open: false,
  };

  if (
    userColdOpen &&
    hookTeaser >= MIN_HOOK_SEC &&
    isHookPeakInsideTrim(highlight, start, end) &&
    shouldUseColdOpen(highlight)
  ) {
    highlight.cold_open = true;
  }

  if (
    hl.montage_segments?.length &&
    Array.isArray(settings.montage_segments) &&
    settings.montage_segments.length
  ) {
    highlight.montage_segments = settings.montage_segments;
    highlight.output_duration = settings.montage_segments.reduce(
      (s, seg) => s + (Number(seg.duration) || 0),
      0,
    );
    highlight.montage_kill_count = settings.montage_segments.filter(
      (s) => s.segment_type !== 'payoff',
    ).length;
  }

  return highlight;
}

function trimChanged(hl, exportHl) {
  return (
    Math.abs(exportHl.start_time - hl.start_time) > 0.35 ||
    Math.abs(exportHl.end_time - hl.end_time) > 0.35
  );
}

function hookCutChanged(hl, exportHl) {
  return (
    Math.abs((exportHl.hook_teaser_duration || 0) - (hl.hook_teaser_duration || 2.2)) > 0.15 ||
    exportHl.cold_open !== Boolean(hl.cold_open) ||
    Math.abs((exportHl.hook_peak_time || 0) - (hl.hook_peak_time || 0)) > 0.35 ||
    Math.abs((exportHl.hook_offset_in_clip || 0) - (hl.hook_offset_in_clip || 0)) > 0.35
  );
}

function montageSegmentsChanged(hl, exportHl) {
  const base = hl.montage_segments || [];
  const next = exportHl.montage_segments || [];
  if (!base.length || !next.length) return false;
  if (base.length !== next.length) return true;
  return next.some(
    (s, i) =>
      Math.abs((s.start ?? 0) - (base[i].start ?? 0)) > 0.12 ||
      Math.abs((s.duration ?? 0) - (base[i].duration ?? 0)) > 0.12,
  );
}

function segmentStart(seg) {
  return Number(seg.offset ?? seg.start ?? 0);
}

function segmentEnd(seg) {
  return segmentStart(seg) + Number(seg.duration || 0.05);
}

/** New trim stays inside the analyze window — existing STT words still cover the speech. */
function trimWithinAnalyzeWindow(baselineHl, exportHl) {
  const oldStart = Number(baselineHl.start_time) || 0;
  const oldEnd = Number(baselineHl.end_time) || oldStart + 30;
  return (
    exportHl.start_time >= oldStart - 0.35 && exportHl.end_time <= oldEnd + 0.35
  );
}

/**
 * Reuse analyze transcript: map clip-local words via source time into the new trim window.
 * Avoids Whisper on every slider move when only length/position changes.
 */
export function remapTranscriptForTrim(baselineHl, exportHl, segments) {
  const oldStart = Number(baselineHl.start_time) || 0;
  const newStart = Number(exportHl.start_time) || 0;
  const newEnd = Number(exportHl.end_time) || newStart + 30;
  const mainDur = Math.max(1, newEnd - newStart);

  const mainSegments = [];
  for (const seg of segments || []) {
    const text = String(seg.text || '').trim();
    if (!text) continue;

    const relStart = segmentStart(seg);
    const relEnd = segmentEnd(seg);
    const sourceStart = oldStart + relStart;
    const sourceEnd = oldStart + relEnd;
    if (sourceEnd < newStart - 0.1 || sourceStart > newEnd + 0.1) continue;

    const clipStart = Math.max(0, sourceStart - newStart);
    const clipEnd = Math.min(mainDur, sourceEnd - newStart);
    if (clipEnd <= clipStart) continue;

    mainSegments.push({
      ...seg,
      text,
      offset: clipStart,
      start: clipStart,
      duration: Math.max(0.05, clipEnd - clipStart),
    });
  }

  let remapped = buildClipCaptionTimings(mainSegments);
  if (exportHl.cold_open) {
    const coldOpen = getColdOpenCaptionParams(exportHl);
    if (coldOpen) {
      remapped = applyColdOpenCaptionShift(remapped, coldOpen, { highlightId: exportHl.id });
    }
  }
  return remapped;
}

function needsTranscriptForSettings(settings) {
  return settings.captions === true || settings.wideOverlay === true;
}

/**
 * Re-cut raw clip from full source using trim + hook settings; re-transcribe if needed.
 */
export async function prepareExportRawClip(meta, hl, settings, jobWorkDir, { preview = false } = {}) {
  const sourceDuration = Number(meta.sourceDuration) || 0;
  const exportHl = buildExportHighlight(hl, settings, sourceDuration);
  const sourceVideo =
    meta.sourceVideoPath || path.join(jobWorkDir, meta.sourceVideo || 'source.mp4');

  const st = Number(settings.start_time ?? hl.start_time);
  const en = Number(settings.end_time ?? hl.end_time);
  const trimFromSettings =
    Math.abs(st - Number(hl.start_time)) > 0.35 ||
    Math.abs(en - Number(hl.end_time)) > 0.35;

  let needsRecut =
    trimFromSettings ||
    trimChanged(hl, exportHl) ||
    hookCutChanged(hl, exportHl) ||
    montageSegmentsChanged(hl, exportHl) ||
    !hl.rawClipPath;
  const rawClipsDir = path.join(jobWorkDir, 'raw-clips');
  await fs.mkdir(rawClipsDir, { recursive: true });

  let rawPath = hl.rawClipPath
    ? path.join(jobWorkDir, hl.rawClipPath)
    : path.join(rawClipsDir, `raw_${hl.id}.mp4`);

  if (!needsRecut && preview && exportHl.cold_open) {
    const nominalMain = Math.max(0.5, exportHl.end_time - exportHl.start_time);
    const requestedHook = getHookTeaserRequested(exportHl);
    try {
      const info = await probeClipQuick(rawPath);
      const probedDur = info.duration || 0;
      const minTotalWithHook = nominalMain + requestedHook * 0.35;
      const inferredHook = Math.max(0, probedDur - nominalMain);
      const storedHook = Number(exportHl.hook_teaser_measured_sec);
      if (probedDur < minTotalWithHook || inferredHook < requestedHook * 0.5) {
        console.log(
          `[export] Preview hook ${hl.id}: raw ${probedDur.toFixed(2)}s lacks hook ` +
            `(need ≥${minTotalWithHook.toFixed(2)}s, inferred hook ${inferredHook.toFixed(2)}s) — re-cutting`,
        );
        needsRecut = true;
      } else if (Number.isFinite(storedHook) && storedHook < requestedHook * 0.5) {
        console.log(
          `[export] Preview hook ${hl.id}: stored hook ${storedHook.toFixed(2)}s ` +
            `< requested ${requestedHook.toFixed(1)}s — re-cutting`,
        );
        needsRecut = true;
      }
    } catch {
      needsRecut = true;
    }
  }

  if (needsRecut) {
    console.log(
      `[export] Re-cutting ${hl.id}: main ${exportHl.start_time.toFixed(1)}–${exportHl.end_time.toFixed(1)}s` +
        (exportHl.cold_open ? ` hook ${exportHl.hook_teaser_duration}s` : ''),
    );
    const cutResult = await cutRawClipWithHook(sourceVideo, exportHl, jobWorkDir);
    rawPath = cutResult.clipPath;
    exportHl.hook_teaser_measured_sec = cutResult.hookTeaserMeasuredSec;
    exportHl.clip_duration_measured = cutResult.clipDurationMeasured;
  }

  let transcriptSegments = hl.transcriptSegments || [];
  const hookChanged = hookCutChanged(hl, exportHl);
  const transcriptNeeded = needsTranscriptForSettings(settings);
  const mainDurForCaptions = Math.max(0.5, exportHl.end_time - exportHl.start_time);
  const transcriptOnMainTimelineOnly =
    isViableTranscript(transcriptSegments) &&
    transcriptIsMainTimelineOnly(transcriptSegments, mainDurForCaptions);
  let trimOnlyInsideAnalyze =
    needsRecut &&
    !hookChanged &&
    trimWithinAnalyzeWindow(hl, exportHl) &&
    isViableTranscript(transcriptSegments);

  if (trimOnlyInsideAnalyze) {
    const remapped = remapTranscriptForTrim(hl, exportHl, transcriptSegments);
    if (isViableTranscript(remapped)) {
      transcriptSegments = remapped;
      console.log(
        `[export] Trim-only: remapped transcript for ${hl.id} (${transcriptSegments.length} words, no STT)`,
      );
    } else {
      trimOnlyInsideAnalyze = false;
      console.log(`[export] Trim remap too sparse for ${hl.id} — running STT`);
    }
  }

  let needsRetranscribe =
    transcriptNeeded &&
    !trimOnlyInsideAnalyze &&
    (needsRecut ||
      hookChanged ||
      !isViableTranscript(transcriptSegments) ||
      (exportHl.cold_open && transcriptOnMainTimelineOnly));

  if (!needsRetranscribe && transcriptSegments.length) {
    console.log(`[export] Reusing transcript for ${hl.id} (${transcriptSegments.length} words)`);
  }

  if (needsRetranscribe) {
    const trDir = path.join(
      jobWorkDir,
      'transcripts',
      preview ? `${hl.id}-preview` : `${hl.id}-export`,
    );
    const coldOpen = getColdOpenCaptionParams(exportHl);
    const tr = await transcribeClipAudio(rawPath, trDir, {
      language:
        normalizeWhisperLanguage(meta.detectedLanguage) ||
        guessTranscriptLanguage(meta.title, meta.description),
      videoTitle: hl.title || meta.title,
      coldOpen,
      skipCache: true,
    });
    transcriptSegments = tr.segments;
    if (tr.quality && !tr.quality.pass) {
      console.warn(
        `[export] Caption quality warning for ${hl.id}: ${tr.quality.wordCount} words, ` +
          `${(tr.quality.coverage * 100).toFixed(0)}% coverage`,
      );
    }
    if (!isViableTranscript(transcriptSegments)) {
      console.error(
        `[export] Caption transcript still sparse for ${hl.id}: ${transcriptSegments.length} words`,
      );
    }
  }

  if (transcriptNeeded && exportHl.cold_open && isViableTranscript(transcriptSegments)) {
    const coldOpen = getColdOpenCaptionParams(exportHl);
    transcriptSegments = applyColdOpenCaptionShift(transcriptSegments, coldOpen, {
      highlightId: hl.id,
    });
  }

  const teaserSec = exportHl.cold_open ? getHookTeaserDuration(exportHl) : 0;
  const clipDuration = getClipDuration(exportHl);
  const mainDur = exportHl.end_time - exportHl.start_time;

  const processHighlight = {
    ...exportHl,
    start_time: 0,
    end_time: clipDuration,
    clipDuration,
    zoom_moments: [],
  };

  return {
    exportHl,
    rawPath,
    processHighlight,
    transcriptSegments,
    clipDuration,
    teaserSec,
    hookTeaserMeasuredSec: exportHl.hook_teaser_measured_sec,
    clipDurationMeasured: exportHl.clip_duration_measured,
  };
}
