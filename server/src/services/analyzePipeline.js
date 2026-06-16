import path from 'path';
import fs from 'fs/promises';
import { resolveYoutubeTranscript } from './youtubeTranscript.js';
import { getClipBoostRenderOptions, boostWeakHighlights } from './clipBoost.js';
import {
  transcribeClipAudio,
  transcribeSourceForHighlightDetection,
  guessTranscriptLanguage,
  normalizeWhisperLanguage,
} from './transcript.js';
import { formatTranscriptForAi } from './preprocess.js';
import { analyzeHighlights } from './claude.js';
import { ensureHighlightReason, extractChapterAnchors } from './highlightCandidates.js';
import {
  enrichHighlightsWithHook,
  getColdOpenCaptionParams,
  getClipDuration,
  getHookTeaserDuration,
  isHookPeakInsideTrim,
  shouldUseColdOpen,
} from './hookClip.js';
import { downloadVideo, fetchVideoMetadata } from './download.js';
import {
  assertValidClip,
  cutRawClip,
  cutRawClipWithHook,
  extractThumbnail,
  getVideoDuration,
  processClip,
  probeVideoSource,
} from './ffmpeg.js';
import { createJobWorkspace } from './tempFiles.js';
import { setJobStep, completeJob, failJob } from './jobs.js';
import { extractUrlStartSeconds, extractVideoId } from '../utils/youtube.js';
import { AppError, friendlyError } from '../utils/errors.js';
import { resolveMusicForClip } from '../services/music.js';
import {
  normalizeRenderSettings,
  resolveWideOverlayEnabled,
} from '../services/renderSettings.js';
import { isViableTranscript } from './captionPipeline.js';
import { registerProject } from './projectStore.js';
import { generateProjectThumbnail } from './projectThumbnail.js';
import {
  getCategoryLabel,
  getCategoryProfile,
  isShooterContent,
  resolveContentClassification,
} from './gameCategory.js';
import {
  finalizeMontageHighlight,
  getMontageThumbnailTime,
  isMontageHighlight,
  sumMontageDuration,
} from './montageClip.js';
import { detectGameFromVideo } from './gameVisualDetect.js';
// DEBUG_KILL_EXPORT START
import {
  attachMontageSegmentDownloads,
  exportDebugKills,
  isDebugKillExportEnabled,
} from './debugKillExport.js';
// DEBUG_KILL_EXPORT END

async function processWithConcurrency(items, fn, concurrency = 2) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function transcribeClipWithRetry(clipPath, clipWorkDir, options, clipId) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await transcribeClipAudio(clipPath, clipWorkDir, options);
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      const retryable =
        err?.status === 429 ||
        err?.statusCode === 429 ||
        /429|rate limit/i.test(msg);
      if (!retryable || attempt >= 2) throw err;
      const waitSec = 5 + attempt * 8;
      console.warn(
        `[Pipeline] STT rate limit clip ${clipId}, retry ${attempt + 1}/2 in ${waitSec}s`,
      );
      await sleep(waitSec * 1000);
    }
  }
  throw lastErr;
}

/**
 * Context for Claude highlight detection only (not used for burned-in captions).
 * Captions always come from per-clip Groq transcription later in the pipeline.
 */
async function buildHighlightDetectionContext(
  videoId,
  url,
  sourceDuration,
  { sourceVideo, workDir, jobId } = {},
) {
  let title = 'Unknown video';
  let description = '';
  let duration = sourceDuration;
  let tags = [];
  let channel = '';

  try {
    const meta = await fetchVideoMetadata(url);
    title = meta.title || title;
    description = meta.description || '';
    tags = meta.tags || [];
    channel = meta.channel || '';
    if (meta.duration) duration = meta.duration;
  } catch (err) {
    console.warn('[Pipeline] Video metadata fetch failed:', err.message);
  }

  const chapterAnchors = extractChapterAnchors(description, duration);
  if (chapterAnchors.length) {
    console.log(`[Pipeline] Chapter hints from description: ${chapterAnchors.length}`);
  }

  setJobStep(jobId, 'analyzing', 'Lade Untertitel / Transkript…', 24);
  let resolved = null;
  try {
    resolved = await resolveYoutubeTranscript({
      videoId,
      url,
      workDir,
      sourceVideo,
      sourceDuration: duration,
      title,
      description,
      onProgress: (message) => setJobStep(jobId, 'analyzing', message, 25),
    });
  } catch (err) {
    console.warn('[Pipeline] Transcript resolution threw (continuing with fallbacks):', err.message);
  }

  if (resolved?.segments?.length) {
    console.log(
      `[Pipeline] Transcript via ${resolved.source}: ${resolved.segments.length} segments`,
    );
    return {
      hasTranscript: true,
      segments: resolved.segments,
      formattedText: formatTranscriptForAi(resolved.segments),
      title,
      description,
      tags,
      channel,
      duration,
      chapterAnchors,
      transcriptSource: resolved.source,
    };
  }

  console.warn('[Pipeline] No transcript from any source — metadata + audio/HUD fallback');
  return {
    hasTranscript: false,
    segments: null,
    formattedText: null,
    title,
    description,
    tags,
    channel,
    duration,
    chapterAnchors,
  };
}

async function buildLocalHighlightDetectionContext(sourceVideo, sourceDuration, title, jobId) {
  const displayTitle = title || 'Hochgeladenes Video';
  const isLongSource = sourceDuration >= 2 * 3600;

  const workDir = path.dirname(sourceVideo);

  console.log(
    `[Pipeline] Transcribing upload for highlight detection (${(sourceDuration / 60).toFixed(0)} min)…`,
  );
  setJobStep(jobId, 'analyzing', 'Transkribiere Video für KI-Analyse…', 22);

  try {
    const transcription = await transcribeSourceForHighlightDetection(sourceVideo, workDir, {
      videoTitle: displayTitle,
      sourceDuration,
      onProgress: (message) => setJobStep(jobId, 'analyzing', message, 24),
    });
    const segments = transcription.segments || [];
    if (segments.length) {
      console.log(`[Pipeline] Local STT: ${segments.length} segments for highlight detection`);
      return {
        hasTranscript: true,
        segments,
        formattedText: formatTranscriptForAi(segments),
        title: displayTitle,
        description: '',
        duration: sourceDuration,
        chapterAnchors: [],
        transcriptSource: 'groq-stt',
      };
    }
  } catch (err) {
    console.warn('[Pipeline] Upload STT failed:', err.message);
  }

  console.log('[Pipeline] Local upload — metadata-only highlight detection');
  return {
    hasTranscript: false,
    segments: null,
    formattedText: null,
    title: displayTitle,
    description: '',
    duration: sourceDuration,
    chapterAnchors: [],
  };
}

/** 9:16 overview preview: crop/scale only — no captions, music, zoom, or color. */
async function renderPlainOverviewClip(clipPath, highlight, clipsDir, { aspectRatio = '9:16' }) {
  const clipDuration = getClipDuration({ ...highlight, cold_open: false });
  const clipHighlight = {
    ...highlight,
    cold_open: false,
    start_time: 0,
    end_time: clipDuration,
    clipDuration,
  };

  await processClip({
    sourceVideo: clipPath,
    workDir: clipsDir,
    highlight: clipHighlight,
    transcriptSegments: [],
    options: {
      aspectRatio,
      smartCrop: true,
      wideOverlay: false,
      captions: false,
      music: false,
      colorGrade: false,
      showHook: false,
      clipBoosted: false,
      clipLocalTimestamps: true,
      outputName: `plain_${highlight.id}.mp4`,
      preview: true,
    },
  });
}

async function processClipWithCaptions(
  clipPath,
  highlight,
  transcription,
  clipsDir,
  {
    renderSettings,
    sourceWidth,
    sourceHeight,
    mood = 'hype',
    analyzeDownload = false,
    skipCaptions = false,
  } = {},
) {
  const { segments, language } = transcription;
  const teaserSec = highlight.cold_open ? getHookTeaserDuration(highlight) : 0;
  const clipDuration = getClipDuration(highlight);
  const clipTranscript = [...segments];

  const rs = renderSettings || normalizeRenderSettings({}, 'hype');
  const aspectRatio = rs.aspectRatio || '9:16';
  const wideOverlay = resolveWideOverlayEnabled(rs, sourceWidth, sourceHeight);
  const captionStyle = rs.captionStyle || 'fire';
  const montageClip = isMontageHighlight(highlight);
  const burnCaptions =
    !montageClip && !skipCaptions && rs.captions !== false && isViableTranscript(segments);
  if (montageClip) {
    console.log(`[Pipeline] Montage clip ${highlight.id}: captions off (kill jump-cuts)`);
  }

  const clipHighlight = {
    ...highlight,
    caption_style: captionStyle,
    start_time: 0,
    end_time: clipDuration,
    clipDuration,
    hook_teaser_measured_sec: highlight.hook_teaser_measured_sec,
    clip_duration_measured: highlight.clip_duration_measured,
    zoom_moments: [],
  };

  const musicResolved =
    rs.music !== false
      ? await resolveMusicForClip({ mood, highlight, renderSettings: rs })
      : null;

  await processClip({
    sourceVideo: clipPath,
    workDir: clipsDir,
    highlight: clipHighlight,
    transcriptSegments: clipTranscript,
      options: {
      aspectRatio,
      smartCrop: true,
      wideOverlay,
      gameplayFraming: rs.gameplayFraming || 'wide',
      captions: burnCaptions,
      music: Boolean(musicResolved),
      musicPath: musicResolved?.path || null,
      musicVolume: rs.musicVolume,
      musicOffsetSec: musicResolved?.offsetSec ?? 0,
      colorGrade: rs.colorGrade !== false,
      clipLocalTimestamps: true,
      showHook: analyzeDownload
        ? false
        : getClipBoostRenderOptions(highlight).showHook ??
          Boolean(highlight.cold_open && highlight.hook),
      clipBoosted: Boolean(highlight.clip_boosted),
      captionStyle,
      outputName: `${highlight.id}.mp4`,
    },
  });

  return {
    clipDuration,
    transcriptSegments: clipTranscript,
    language,
  };
}

export async function runAnalyzeJob(
  jobId,
  { url, localSourcePath, sourceTitle, mood, renderSettings: rawRenderSettings },
) {
  try {
    const renderSettings = normalizeRenderSettings(rawRenderSettings, mood);
    const isLocal = Boolean(localSourcePath);

    console.log('[Pipeline] Starting job', jobId, {
      source: isLocal ? 'local' : 'youtube',
      aspectRatio: renderSettings.aspectRatio,
      music: renderSettings.music !== false,
      musicAuto: renderSettings.musicAuto !== false,
      musicVolume: renderSettings.musicVolume,
      wideOverlay: renderSettings.wideOverlay,
    });

    const workDir = await createJobWorkspace(jobId);
    let sourceVideo;
    let videoId;
    let displayUrl;

    if (isLocal) {
      sourceVideo = localSourcePath;
      videoId = `local-${jobId.slice(0, 8)}`;
      displayUrl = `local://${sourceTitle || 'upload'}`;
      console.log('[Pipeline] 1/6 Using uploaded video:', sourceVideo);
      setJobStep(jobId, 'fetching', 'Video wird vorbereitet…', 10);
    } else {
      videoId = extractVideoId(url);
      displayUrl = url;
      console.log('[Pipeline] 1/6 Downloading video...');
      setJobStep(jobId, 'fetching', 'Video wird heruntergeladen…', 10);
      sourceVideo = await downloadVideo(url, workDir, {
        onProgress: ({ message }) => setJobStep(jobId, 'fetching', message, 12),
      });
      console.log('[Pipeline] Download complete:', sourceVideo);
    }

    const { width: sourceWidth, height: sourceHeight } = await probeVideoSource(sourceVideo);
    console.log('[Pipeline] Source dimensions:', sourceWidth, 'x', sourceHeight);

    const sourceDuration = await getVideoDuration(sourceVideo);
    console.log('[Pipeline] Source duration:', sourceDuration.toFixed(2), 's');

    console.log('[Pipeline] 2/6 Claude highlight detection...');
    setJobStep(jobId, 'analyzing', 'Finding highlights with AI...', 30);
    const detectionContext = isLocal
      ? await buildLocalHighlightDetectionContext(
          sourceVideo,
          sourceDuration,
          sourceTitle,
          jobId,
        )
      : await buildHighlightDetectionContext(videoId, url, sourceDuration, {
          sourceVideo,
          workDir,
          jobId,
        });
    const videoTitle = detectionContext.title || '';
    const videoLanguage = guessTranscriptLanguage(videoTitle, detectionContext.description);
    const urlFocusSec = isLocal ? null : extractUrlStartSeconds(url);
    if (urlFocusSec != null) {
      console.log(`[Pipeline] URL time focus: ~${urlFocusSec}s`);
    }

    const outputLanguage =
      videoLanguage === 'de' ||
      guessTranscriptLanguage(videoTitle, detectionContext.description) === 'de'
        ? 'de'
        : 'en';

    setJobStep(jobId, 'analyzing', 'Erkenne Spiel & Kategorie…', 27);
    const classT0 = Date.now();
    const contentClass = await resolveContentClassification({
      title: videoTitle,
      description: detectionContext.description || '',
      tags: detectionContext.tags || [],
      channel: detectionContext.channel || '',
      segments: detectionContext.segments,
      sourceVideo,
      duration: sourceDuration,
      detectVisual: detectGameFromVideo,
    });
    console.log(
      `[Pipeline] Classification done in ${((Date.now() - classT0) / 1000).toFixed(1)}s`,
    );
    console.log(
      `[Pipeline] Content category: ${contentClass.category}` +
        `${contentClass.game ? ` (${contentClass.game})` : ''}` +
        ` — confidence ${contentClass.confidence}%` +
        `${contentClass.sources?.length ? ` [${contentClass.sources.join(', ')}]` : ''}`,
    );
    let pipelineCategory = contentClass.category;
    let pipelineProfile = contentClass.profile;
    if (isShooterContent(contentClass)) {
      pipelineCategory = 'shooter';
      pipelineProfile = getCategoryProfile('shooter');
      console.log(
        `[Pipeline] Shooter montage pipeline forced` +
          `${contentClass.game ? ` (${contentClass.game})` : ''}`,
      );
    }

    if (pipelineCategory !== 'generic') {
      setJobStep(
        jobId,
        'analyzing',
        `KI-Analyse (${getCategoryLabel(pipelineCategory)})…`,
        28,
      );
    }

    const highlightContext = {
      ...detectionContext,
      mood: mood || 'hype',
      urlFocusSec,
      sourceVideo,
      outputLanguage,
      hasTranscript: Boolean(detectionContext.hasTranscript && detectionContext.segments?.length),
      contentCategory: pipelineCategory,
      contentGame: contentClass.game,
      categoryProfile: pipelineProfile,
    };
    const rawHighlights = await analyzeHighlights(highlightContext);
    const highlights = boostWeakHighlights(
      enrichHighlightsWithHook(rawHighlights, detectionContext.segments),
      detectionContext.segments,
      sourceDuration,
    )
      .map((h) => (isMontageHighlight(h) ? finalizeMontageHighlight(h) : h))
      .map((h) => ({
        ...h,
        reason: ensureHighlightReason(h, outputLanguage),
      }));
    const coldOpenCount = highlights.filter((h) => h.cold_open).length;
    console.log(
      `[Pipeline] Highlights from Claude: ${highlights.length} (${coldOpenCount} with cold-open hook)`,
    );

    const shooterPipeline = isShooterContent({
      category: pipelineCategory,
      game: contentClass.game,
      profile: pipelineProfile,
    });

    const validHighlights = highlights
      .map((h) => ({
        ...h,
        start_time: Math.max(0, parseFloat(h.start_time)),
        end_time: Math.min(sourceDuration, parseFloat(h.end_time)),
      }))
      .filter((h) => {
        if (shooterPipeline) {
          if (!isMontageHighlight(h) || (h.montage_segments?.length || 0) < 1) {
            console.warn(
              `[Pipeline] Dropped non-montage shooter highlight: ${h.id || h.title}`,
            );
            return false;
          }
          return sumMontageDuration(h.montage_segments) >= 3;
        }
        return (
          h.start_time < sourceDuration &&
          h.end_time > h.start_time &&
          h.end_time - h.start_time >= 5
        );
      });

    console.log(
      `[Pipeline] Valid highlights: ${validHighlights.length}/${highlights.length}`,
    );

    if (!validHighlights.length) {
      const shooterFail = isShooterContent({
        category: pipelineCategory,
        game: contentClass.game,
        profile: pipelineProfile,
      });
      throw new AppError(
        shooterFail
          ? 'Keine Kill-Montagen gefunden — bei fehlendem YouTube-Transcript nutzen wir Audio/HUD; ggf. anderes Video oder Upload versuchen.'
          : 'No valid highlights after timestamp validation. Try analyzing again.',
        502,
      );
    }

    // DEBUG_KILL_EXPORT START — remove with debugKillExport.js (see DEBUG_KILL_EXPORT_REMOVAL.md)
    let debugKillExport = null;
    if (
      isDebugKillExportEnabled() &&
      shooterPipeline &&
      highlightContext.killFeedEvents?.length
    ) {
      try {
        setJobStep(jobId, 'editing', 'Debug: exportiere Kill-Vorschau…', 47);
        debugKillExport = await exportDebugKills({
          sourceVideo,
          workDir,
          jobId,
          videoDuration: sourceDuration,
          killFeedEvents: highlightContext.killFeedEvents,
          audioScan: highlightContext.audioScan,
          finalHighlights: validHighlights,
          channel: detectionContext.channel || '',
          title: videoTitle,
        });
      } catch (debugErr) {
        console.warn('[debug-kill-export] failed (job continues):', debugErr.message);
      }
    }
    // DEBUG_KILL_EXPORT END

    const clipsDir = path.join(workDir, 'clips');
    const thumbsDir = path.join(workDir, 'thumbs');
    await fs.mkdir(clipsDir, { recursive: true });
    await fs.mkdir(thumbsDir, { recursive: true });

    // Phase 1 — cut all clips in parallel
    console.log('[Pipeline] Phase 1: cutting all clips...');
    setJobStep(jobId, 'editing', 'Clips werden geschnitten…', 50);

    const montageCut =
      shooterPipeline || validHighlights.some((h) => isMontageHighlight(h));
    const cutConcurrency = montageCut ? 1 : 3;
    if (montageCut && validHighlights.length > 1) {
      console.log('[Pipeline] Montage cuts: serial (AV1 hybrid seek)');
    }

    let cutIdx = 0;
    const rawClips = await processWithConcurrency(
      validHighlights,
      async (h) => {
        cutIdx += 1;
        setJobStep(
          jobId,
          'editing',
          `Schneide Clip ${cutIdx}/${validHighlights.length}…`,
          50 + Math.floor((cutIdx / validHighlights.length) * 12),
        );
        const coldOpenRecommended =
          Number.isFinite(Number(h.hook_peak_time)) &&
          isHookPeakInsideTrim(h, h.start_time, h.end_time) &&
          shouldUseColdOpen({ ...h, user_cold_open: true });
        if (isMontageHighlight(h)) {
          console.log(
            `[Pipeline] Cutting montage ${h.id}: ${h.montage_segments.length} kills, ` +
              `~${h.output_duration ?? sumMontageDuration(h.montage_segments)}s output`,
          );
        } else if (shooterPipeline) {
          throw new Error(`Shooter highlight ${h.id} missing montage_segments`);
        }

        const cutResult = await cutRawClipWithHook(
          sourceVideo,
          { ...h, cold_open: false, user_cold_open: false },
          workDir,
        );
        const clipPath = cutResult.clipPath;
        let highlightWithMeasure = {
          ...h,
          cold_open: false,
          cold_open_recommended: coldOpenRecommended,
          hook_teaser_measured_sec: cutResult.hookTeaserMeasuredSec,
          clip_duration_measured: cutResult.clipDurationMeasured,
        };
        if (isMontageHighlight(highlightWithMeasure)) {
          highlightWithMeasure = finalizeMontageHighlight(highlightWithMeasure);
        }
        const clipInfo = await assertValidClip(clipPath, `clip ${h.id}`);
        if (!clipInfo.hasAudio) {
          throw new Error(`Clip has no audio stream: ${clipPath}`);
        }
        return { highlight: highlightWithMeasure, clipPath, clipInfo };
      },
      cutConcurrency,
    );
    console.log('[Pipeline] All clips cut');

    await Promise.all(
      validHighlights.map((h) =>
        extractThumbnail(
          sourceVideo,
          getMontageThumbnailTime(h),
          path.join(thumbsDir, `${h.id}.jpg`),
        ).catch(() => {}),
      ),
    );

    // Phase 2 — transcribe all clips in parallel
    console.log('[Pipeline] Phase 2: transcribing all clips...');
    setJobStep(
      jobId,
      'editing',
      `Untertitel für ${rawClips.length} Clip${rawClips.length === 1 ? '' : 's'}…`,
      65,
    );

    let clipTranscribeIdx = 0;
    const transcriptions = await processWithConcurrency(
      rawClips,
      async ({ clipPath, highlight }) => {
        clipTranscribeIdx += 1;
        setJobStep(
          jobId,
          'editing',
          `Untertitel Clip ${clipTranscribeIdx}/${rawClips.length}…`,
          65 + Math.floor((clipTranscribeIdx / rawClips.length) * 15),
        );
        const clipWorkDir = path.join(workDir, 'transcripts', String(highlight.id));
        const coldOpen = getColdOpenCaptionParams(highlight);
        const transcription = await transcribeClipWithRetry(
          clipPath,
          clipWorkDir,
          {
            language: videoLanguage,
            videoTitle: highlight.title || videoTitle,
            preview: false,
            coldOpen,
            allowSparseCaptions: isMontageHighlight(highlight),
          },
          highlight.id,
        );
        if (!isViableTranscript(transcription.segments)) {
          console.error(
            `[Pipeline] Sparse transcript clip ${highlight.id}: ${transcription.segments?.length || 0} words`,
          );
        }
        if (transcription.quality && !transcription.quality.pass) {
          console.warn(
            `[Pipeline] Caption quality warning clip ${highlight.id}: ` +
              `${transcription.quality.wordCount} words, ` +
              `${(transcription.quality.coverage * 100).toFixed(0)}% coverage`,
          );
        }
        const preview = transcription.segments
          .slice(0, 5)
          .map((s) => `"${String(s.text).trim()}"`)
          .join(', ');
        console.log(
          `[Pipeline] Transcribed clip ${highlight.id} (${transcription.segments.length} words): ${preview}`,
        );
        return { highlightId: highlight.id, transcription };
      },
      1,
    );
    console.log('[Pipeline] All clips transcribed');

    const transcriptionMap = new Map(
      transcriptions.map(({ highlightId, transcription }) => [highlightId, transcription]),
    );

    // Phase 3 — render clips sequentially (2-pass caption burn is CPU-heavy)
    console.log('[Pipeline] Phase 3: rendering all clips...');
    setJobStep(jobId, 'editing', 'Clips werden gerendert…', 85);

    const processedResults = [];
    for (const { clipPath, highlight } of rawClips) {
      let transcription = transcriptionMap.get(highlight.id);
      if (!transcription) {
        throw new Error(`No transcription for clip ${highlight.id}`);
      }

      const plainAspect = renderSettings.aspectRatio || '9:16';
      try {
        await renderPlainOverviewClip(clipPath, highlight, clipsDir, {
          aspectRatio: plainAspect,
        });
      } catch (plainErr) {
        console.warn(`[Pipeline] Plain overview failed for ${highlight.id}: ${plainErr.message}`);
      }

      let processed;
      try {
        processed = await processClipWithCaptions(
          clipPath,
          highlight,
          transcription,
          clipsDir,
          {
            renderSettings,
            sourceWidth,
            sourceHeight,
            mood: mood || 'hype',
            analyzeDownload: true,
          },
        );
      } catch (renderErr) {
        const msg = renderErr?.message || String(renderErr);
        const captionFail = /captions|transcript empty|ASS file|caption words/i.test(msg);
        if (!captionFail) throw renderErr;

        if (isMontageHighlight(highlight)) {
          console.warn(
            `[Pipeline] Montage ${highlight.id}: caption skip after render error — retry without subs`,
          );
          processed = await processClipWithCaptions(
            clipPath,
            highlight,
            transcription,
            clipsDir,
            {
              renderSettings: { ...renderSettings, captions: false },
              sourceWidth,
              sourceHeight,
              mood: mood || 'hype',
              analyzeDownload: true,
              skipCaptions: true,
            },
          );
          processedResults.push({ highlightId: highlight.id, ...processed });
          continue;
        }

        console.warn(
          `[Pipeline] Caption render failed for ${highlight.id}, re-transcribing: ${msg.slice(0, 120)}`,
        );
        const clipWorkDir = path.join(workDir, 'transcripts', `${highlight.id}-retry`);
        const coldOpen = getColdOpenCaptionParams(highlight);
        transcription = await transcribeClipWithRetry(
          clipPath,
          clipWorkDir,
          {
            language: videoLanguage,
            videoTitle: highlight.title || videoTitle,
            preview: false,
            coldOpen,
            skipCache: true,
            allowSparseCaptions: isMontageHighlight(highlight),
          },
          highlight.id,
        );
        transcriptionMap.set(highlight.id, transcription);
        processed = await processClipWithCaptions(
          clipPath,
          highlight,
          transcription,
          clipsDir,
          {
            renderSettings,
            sourceWidth,
            sourceHeight,
            mood: mood || 'hype',
            analyzeDownload: true,
          },
        );
      }

      processedResults.push({ highlightId: highlight.id, ...processed });
    }
    console.log('[Pipeline] All clips rendered');

    const processedMap = new Map(
      processedResults.map((result) => [result.highlightId, result]),
    );

    const detectedLanguage =
      normalizeWhisperLanguage(
        [...transcriptionMap.values()].find((t) => t.language && t.language !== 'unknown')
          ?.language,
      ) || 'unknown';

    let enriched = rawClips.map(({ highlight, clipPath }) => {
      const processed = processedMap.get(highlight.id);
      if (!processed) {
        throw new Error(`No processed output for clip ${highlight.id}`);
      }
      const { clipDuration, transcriptSegments, language } = processed;
      return {
        ...highlight,
        reason: ensureHighlightReason(highlight, outputLanguage),
        cold_open: false,
        cold_open_recommended: Boolean(highlight.cold_open_recommended),
        caption_style: renderSettings.captionStyle || 'fire',
        hook_teaser_duration: highlight.hook_teaser_duration,
        hook_teaser_measured_sec: 0,
        clip_duration_measured: highlight.clip_duration_measured,
        clipDuration,
        rawClipPath: path.relative(workDir, clipPath).replace(/\\/g, '/'),
        rawClipUrl: `/api/files/${jobId}/${path.relative(workDir, clipPath).replace(/\\/g, '/')}`,
        thumbnailUrl: `/api/files/${jobId}/thumbs/${highlight.id}.jpg`,
        transcriptSegments,
        detectedLanguage: language,
        outputFile: `${highlight.id}.mp4`,
        downloadUrl: `/api/files/${jobId}/clips/${highlight.id}.mp4`,
        overviewUrl: `/api/files/${jobId}/clips/plain_${highlight.id}.mp4`,
      };
    });

    // DEBUG_KILL_EXPORT — per-montage-segment MP4s in debug/
    if (isDebugKillExportEnabled()) {
      enriched = await Promise.all(
        enriched.map((h) => attachMontageSegmentDownloads(workDir, jobId, h)),
      );
    }

    let projectThumbnailUrl = null;
    try {
      const thumb = await generateProjectThumbnail({
        jobId,
        workDir,
        sourceVideo,
        highlights: enriched,
        mood: mood || 'hype',
        videoTitle,
        sourceName: isLocal ? sourceTitle || path.basename(sourceVideo) : undefined,
      });
      projectThumbnailUrl = thumb?.url || null;
    } catch (thumbErr) {
      console.warn('[Pipeline] Project thumbnail failed:', thumbErr.message);
    }

    const result = {
      jobId,
      videoId,
      url: displayUrl,
      sourceType: isLocal ? 'local' : 'youtube',
      sourceName: isLocal ? sourceTitle || path.basename(sourceVideo) : undefined,
      mood: mood || 'hype',
      renderSettings,
      musicTrackId: renderSettings.musicTrackId,
      sourceVideo: path.basename(sourceVideo),
      sourceDuration,
      sourceWidth,
      sourceHeight,
      highlights: enriched,
      detectedLanguage,
      projectThumbnailUrl,
      contentCategory: contentClass.category,
      contentGame: contentClass.game,
      contentCategoryLabel: getCategoryLabel(contentClass.category),
      contentCategoryConfidence: contentClass.confidence,
      contentCategorySources: contentClass.sources || [],
      // DEBUG_KILL_EXPORT — remove field when feature is removed
      debugKillExport,
    };

    await fs.writeFile(
      path.join(workDir, 'meta.json'),
      JSON.stringify({ ...result, sourceVideoPath: sourceVideo }),
      'utf8',
    );

    console.log('[Pipeline] Job complete:', jobId);
    completeJob(jobId, result);
    registerProject(jobId, result).catch((err) => {
      console.warn('[Pipeline] Project register failed:', err.message);
    });
    return result;
  } catch (err) {
    console.error('[runAnalyzeJob] Job failed:', jobId);
    console.error('[runAnalyzeJob] Error:', err);
    if (err?.stack) console.error('[runAnalyzeJob] Stack:', err.stack);

    try {
      failJob(jobId, err?.code ? err : friendlyError(err));
    } catch (failErr) {
      console.error('[runAnalyzeJob] failJob error:', failErr);
    }

    throw err;
  }
}
