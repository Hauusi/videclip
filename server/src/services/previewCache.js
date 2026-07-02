import path from 'path';
import fs from 'fs/promises';
import { createHash } from 'crypto';
import {
  processClip,
  getVideoDuration,
  renderHookPreviewFromRaw,
  renderHookPreviewFast,
  ensureMainCopyForHook,
  probeClipQuick,
} from './ffmpeg.js';
import { mixMusicOntoVideo } from './captionPipeline.js';
import { normalizeMusicVolume } from './music.js';
import { getHookTeaserDuration, getHookTeaserRequested } from './hookClip.js';
import { getClipBoostRenderOptions } from './clipBoost.js';
import { normalizeRenderSettings } from './renderSettings.js';
import { resolveMusicForClip } from './music.js';
import { prepareExportRawClip } from './clipExport.js';
import { config } from '../config.js';

const inFlightPreviews = new Map();

function stableHash(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

async function fileFingerprint(filePath) {
  try {
    const st = await fs.stat(filePath);
    return `${st.size}-${Math.floor(st.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

function buildPreviewKeys({
  exportSettings,
  settings,
  previewRender,
  hl,
  rawPath,
  musicResolved,
  processHighlight,
  previewWide,
}) {
  const rawKey = stableHash({
    raw: exportSettings,
    rawFile: rawPath,
    previewNonce: exportSettings.previewNonce ?? null,
  });

  const pass1Key = stableHash({
    rawKey,
    aspectRatio: settings.aspectRatio || previewRender.aspectRatio,
    colorGrade: settings.colorGrade === true,
    aiStrength: settings.aiStrength ?? 75,
    wideOverlay: settings.wideOverlay === true,
    wideRegion: settings.wideOverlayRegion || null,
    webcam: settings.webcam || null,
    clipBoosted: Boolean(hl.clip_boosted),
  });

  const pass2Key = stableHash({
    pass1Key,
    captions: settings.captions === true,
    captionStyle: settings.caption_style ?? hl.caption_style ?? previewRender.captionStyle,
    showHook: settings.showHook,
    hook: exportSettings.hook ?? hl.hook,
    ctaText: String(settings.ctaText ?? '').trim(),
  });

  const musicKey = stableHash({
    pass2Key,
    music: settings.music === true && Boolean(musicResolved),
    musicVolume: previewRender.musicVolume,
    musicTrackId: previewRender.musicTrackId,
    customMusicPath: previewRender.customMusicPath,
    musicPath: musicResolved?.path || null,
    musicOffsetSec: musicResolved?.offsetSec ?? 0,
  });

  return { rawKey, pass1Key, pass2Key, musicKey };
}

async function loadCacheState(statePath) {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveCacheState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function resolveTier(state, keys) {
  if (!state || state.rawKey !== keys.rawKey) return 'full';
  if (state.pass1Key !== keys.pass1Key) return 'grade';
  if (state.pass2Key !== keys.pass2Key) return 'captions';
  if (state.musicKey !== keys.musicKey) return 'music';
  return 'noop';
}

function musicFileToAssetUrl(filePath) {
  if (!filePath) return null;
  const normalized = path.resolve(filePath);
  const assetsRoot = path.resolve(config.assetsRoot);
  if (!normalized.startsWith(assetsRoot)) return null;
  const rel = path.relative(assetsRoot, normalized).replace(/\\/g, '/');
  return rel ? `/assets/${rel}` : null;
}

async function publishStemCopy(preMusicPath, stemPath) {
  try {
    await fs.access(preMusicPath);
    await fs.copyFile(preMusicPath, stemPath);
  } catch {
    /* stem optional */
  }
}

function highlightFromExport(hl, exportSettings, state) {
  return {
    ...hl,
    ...exportSettings,
    hook_teaser_measured_sec:
      state?.hookTeaserMeasuredSec ?? hl.hook_teaser_measured_sec,
  };
}

async function buildStemExtras(jobId, previewsDir, hl, preMusicPath, musicResolved, highlight) {
  const stemPath = path.join(previewsDir, `stem_${hl.id}.mp4`);
  await publishStemCopy(preMusicPath, stemPath);
  const hookMusicSkip = highlight.cold_open ? getHookTeaserDuration(highlight) : 0;
  const bedUrl = musicFileToAssetUrl(musicResolved?.path);
  return {
    stemUrl: `/api/files/${jobId}/previews/stem_${hl.id}.mp4`,
    musicBedUrl: bedUrl,
    musicStartSec: hookMusicSkip,
    musicOffsetSec: musicResolved?.offsetSec ?? 0,
    musicTrackId: musicResolved?.trackId || null,
    clientMix: Boolean(bedUrl),
  };
}

function previewPayload({
  jobId,
  outputName,
  tier,
  hookTeaserMeasuredSec,
  clipDurationMeasured,
  previewStems,
  effectiveStartTime,
  effectiveEndTime,
  musicBaked,
}) {
  const mainSec =
    Number.isFinite(effectiveEndTime) && Number.isFinite(effectiveStartTime)
      ? Math.max(0, effectiveEndTime - effectiveStartTime)
      : null;
  return {
    previewUrl: `/api/files/${jobId}/previews/${outputName}`,
    hookTeaserMeasuredSec,
    clipDurationMeasured,
    effectiveStartTime: effectiveStartTime ?? null,
    effectiveEndTime: effectiveEndTime ?? null,
    exportMainDurationSec: mainSec,
    musicBaked: Boolean(musicBaked),
    tier,
    previewStems: previewStems || null,
  };
}

async function runFastMusicMix({
  preMusicPath,
  outFile,
  cacheDir,
  musicResolved,
  highlight,
  musicVolume,
}) {
  const vol = normalizeMusicVolume(musicVolume);
  const volTag = String(Math.round(vol * 1000)).padStart(4, '0');
  const volCache = path.join(cacheDir, `mixed_v${volTag}.mp4`);

  try {
    await fs.access(volCache);
    await fs.copyFile(volCache, outFile);
    return;
  } catch {
    /* render */
  }

  const duration = await getVideoDuration(preMusicPath);
  const hookMusicSkip = highlight.cold_open ? getHookTeaserDuration(highlight) : 0;
  const offsetSec = musicResolved?.offsetSec ?? 0;

  if (musicResolved) {
    await mixMusicOntoVideo(preMusicPath, volCache, musicResolved.path, duration, {
      preview: true,
      musicStartSec: hookMusicSkip,
      musicVolume: vol,
      musicOffsetSec: offsetSec,
    });
    await fs.copyFile(volCache, outFile);
  } else {
    await fs.copyFile(preMusicPath, outFile);
  }
}

/**
 * Tiered preview: reuse cached FFmpeg passes when only music/captions/grade change.
 */
export async function runTieredPreview(args) {
  const key = stableHash({
    jobId: args.jobId,
    highlightId: args.hl?.id,
    settings: args.settings || {},
    renderSettings: args.meta?.renderSettings || {},
    sourceDuration: args.meta?.sourceDuration,
    rawClipPath: args.hl?.rawClipPath,
    rawClipUrl: args.hl?.rawClipUrl,
    montageSegments: args.hl?.montage_segments || null,
    start: args.hl?.start_time,
    end: args.hl?.end_time,
  });
  if (inFlightPreviews.has(key)) {
    console.log(`[preview] ${args.hl?.id || '?'} join in-flight`);
    return inFlightPreviews.get(key);
  }
  const run = runTieredPreviewBuild(args).finally(() => inFlightPreviews.delete(key));
  inFlightPreviews.set(key, run);
  return run;
}

async function runTieredPreviewBuild({
  jobId,
  jobWorkDir,
  meta,
  hl,
  settings,
  previewsDir,
}) {
  const t0 = Date.now();
  const trimStart = settings.start_time ?? hl.start_time;
  const trimEnd = settings.end_time ?? hl.end_time;
  const hookOffset = Number(settings.hook_offset_in_clip);
  const hookPeakFromOffset =
    settings.cold_open === true && Number.isFinite(hookOffset)
      ? trimStart + hookOffset
      : null;
  const exportSettings = {
    start_time: trimStart,
    end_time: trimEnd,
    hook_teaser_duration:
      settings.cold_open === true
        ? (settings.hook_teaser_duration ?? hl.hook_teaser_duration ?? 2.2)
        : 0,
    hook_peak_time:
      hookPeakFromOffset ??
      (Number.isFinite(Number(settings.hook_peak_time))
        ? Number(settings.hook_peak_time)
        : undefined),
    hook_offset_in_clip: settings.hook_offset_in_clip,
    cold_open: settings.cold_open === true,
    previewNonce: settings.previewNonce ?? null,
    hook: settings.hook ?? hl.hook,
  };

  const previewRender = normalizeRenderSettings(
    {
      ...(meta.renderSettings || {}),
      aspectRatio: settings.aspectRatio || meta.renderSettings?.aspectRatio,
      wideOverlay: settings.wideOverlay === true,
      captionStyle:
        settings.caption_style ?? hl.caption_style ?? meta.renderSettings?.captionStyle,
      music: settings.music === true,
      musicAuto: settings.musicAuto,
      musicVolume: settings.musicVolume ?? meta.renderSettings?.musicVolume,
      musicTrackId: settings.musicTrackId ?? meta.renderSettings?.musicTrackId,
      customMusicPath: settings.customMusicPath ?? meta.renderSettings?.customMusicPath,
    },
    meta.mood,
  );

  const previewWide = settings.wideOverlay === true;

  const captionStyle =
    settings.caption_style ?? hl.caption_style ?? previewRender.captionStyle ?? 'fire';

  const rawPathGuess = hl.rawClipPath
    ? path.join(jobWorkDir, hl.rawClipPath)
    : path.join(jobWorkDir, 'raw-clips', `raw_${hl.id}.mp4`);

  const musicResolvedEarly =
    settings.music === true
      ? await resolveMusicForClip({
          mood: meta.mood,
          highlight: hl,
          renderSettings: previewRender,
        })
      : null;

  const rawFp = await fileFingerprint(rawPathGuess);
  let keys = buildPreviewKeys({
    exportSettings,
    settings,
    previewRender,
    hl,
    rawPath: rawFp,
    musicResolved: musicResolvedEarly,
    processHighlight: hl,
    previewWide,
  });

  const cacheDir = path.join(previewsDir, 'cache', hl.id);
  await fs.mkdir(cacheDir, { recursive: true });
  const statePath = path.join(cacheDir, 'state.json');
  const state = await loadCacheState(statePath);

  const pass1Path = path.join(cacheDir, 'pass1.mp4');
  const pass2Path = path.join(cacheDir, 'pass2.mp4');
  const preMusicPath = path.join(cacheDir, 'pre_music.mp4');
  const outputName = `preview_${hl.id}.mp4`;
  const outFile = path.join(previewsDir, outputName);

  const tier = resolveTier(state, keys);
  const highlightStub = highlightFromExport(hl, exportSettings, state);
  const rawChanged = !state || state.rawKey !== keys.rawKey;

  if (rawChanged) {
    await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(cacheDir, { recursive: true });
  }

  console.log(`[preview] ${hl.id} tier=${tier} (musicVol=${previewRender.musicVolume})`);

  if (tier === 'noop') {
    try {
      await fs.access(outFile);
      const previewStems = await buildStemExtras(
        jobId,
        previewsDir,
        hl,
        preMusicPath,
        musicResolvedEarly,
        highlightStub,
      );
      console.log(`[preview] ${hl.id} noop ${Date.now() - t0}ms`);
      return previewPayload({
        jobId,
        outputName,
        tier,
        hookTeaserMeasuredSec: highlightStub.hook_teaser_measured_sec,
        clipDurationMeasured: highlightStub.clip_duration_measured,
        previewStems,
      });
    } catch {
      /* fall through */
    }
  }

  if (tier === 'music') {
    try {
      await fs.access(preMusicPath);
      await runFastMusicMix({
        preMusicPath,
        outFile,
        cacheDir,
        musicResolved: musicResolvedEarly,
        highlight: highlightStub,
        musicVolume: previewRender.musicVolume,
        musicOffsetSec: musicResolvedEarly?.offsetSec ?? 0,
      });
      const previewStems = await buildStemExtras(
        jobId,
        previewsDir,
        hl,
        preMusicPath,
        musicResolvedEarly,
        highlightStub,
      );
      await saveCacheState(statePath, {
        ...keys,
        pass1Path,
        pass2Path,
        preMusicPath,
        outputName,
        hookTeaserMeasuredSec: highlightStub.hook_teaser_measured_sec,
        clipDurationMeasured: highlightStub.clip_duration_measured,
      });
      console.log(`[preview] ${hl.id} music-only ${Date.now() - t0}ms`);
      return previewPayload({
        jobId,
        outputName,
        tier: 'music',
        hookTeaserMeasuredSec: highlightStub.hook_teaser_measured_sec,
        clipDurationMeasured: highlightStub.clip_duration_measured,
        previewStems,
      });
    } catch (err) {
      console.warn(`[preview] music-only failed, full render: ${err.message}`);
    }
  }

  const {
    exportHl,
    rawPath,
    processHighlight,
    transcriptSegments,
    hookTeaserMeasuredSec,
    clipDurationMeasured,
  } = await prepareExportRawClip(meta, hl, exportSettings, jobWorkDir, { preview: true });

  const musicResolved =
    settings.music === true
      ? await resolveMusicForClip({
          mood: meta.mood,
          highlight: { ...hl, ...processHighlight },
          renderSettings: previewRender,
        })
      : null;
  const renderedRawFp = await fileFingerprint(rawPath);
  keys = buildPreviewKeys({
    exportSettings,
    settings,
    previewRender,
    hl,
    rawPath: renderedRawFp,
    musicResolved,
    processHighlight,
    previewWide,
  });
  const boostOpts = getClipBoostRenderOptions(hl);
  const clipOptions = {
    aspectRatio: previewRender.aspectRatio || settings.aspectRatio || '9:16',
    smartCrop: settings.smartCrop !== false,
    wideOverlay: previewWide,
    wideOverlayRegion: settings.wideOverlayRegion,
    captions: settings.captions === true,
    showHook: settings.showHook === true || Boolean(boostOpts.showHook),
    clipBoosted: Boolean(hl.clip_boosted),
    captionStyle,
    webcam: settings.webcam,
    clipLocalTimestamps: true,
    music: settings.music === true && Boolean(musicResolved),
    musicPath: musicResolved?.path || null,
    musicVolume: previewRender.musicVolume,
    musicOffsetSec: musicResolved?.offsetSec ?? 0,
    colorGrade: settings.colorGrade === true,
    aiStrength: settings.aiStrength ?? 75,
    ctaText: String(settings.ctaText ?? '').trim(),
    gameplayFraming: settings.gameplayFraming || previewRender.gameplayFraming || 'wide',
    preview: true,
    outputName,
    cachePaths: { pass1: pass1Path, pass2: pass2Path, preMusic: preMusicPath },
  };

  const highlightForRender = {
    ...processHighlight,
    caption_style: captionStyle,
  };

  const finishPreview = async (
    resolvedTier,
    {
      musicBaked = false,
      hookTeaserMeasuredSec: hookMeasuredOverride,
      clipDurationMeasured: clipMeasuredOverride,
    } = {},
  ) => {
    const resolvedHookSec =
      hookMeasuredOverride ?? hookTeaserMeasuredSec ?? processHighlight.hook_teaser_measured_sec;
    const resolvedClipSec =
      clipMeasuredOverride ?? clipDurationMeasured ?? processHighlight.clip_duration_measured;
    const previewStems =
      settings.music === true && musicResolved && !musicBaked
        ? await buildStemExtras(
            jobId,
            previewsDir,
            hl,
            preMusicPath,
            musicResolved,
            highlightForRender,
          )
        : null;
    await saveCacheState(statePath, {
      ...keys,
      pass1Path,
      pass2Path,
      preMusicPath,
      outputName,
      hookTeaserMeasuredSec: resolvedHookSec,
      clipDurationMeasured: resolvedClipSec,
    });
    console.log(`[preview] ${hl.id} ${resolvedTier} ${Date.now() - t0}ms`);
    return previewPayload({
      jobId,
      outputName,
      tier: resolvedTier,
      hookTeaserMeasuredSec: resolvedHookSec,
      clipDurationMeasured: resolvedClipSec,
      effectiveStartTime: exportHl.start_time,
      effectiveEndTime: exportHl.end_time,
      previewStems,
      musicBaked,
    });
  };

  if (tier === 'captions') {
    try {
      await fs.access(pass1Path);
      await processClip({
        sourceVideo: rawPath,
        workDir: previewsDir,
        highlight: highlightForRender,
        transcriptSegments: [...transcriptSegments],
        options: {
          ...clipOptions,
          startFromPass: 2,
          stopAfterPass: 2,
        },
      });
      await applyMusicToPreview({
        preMusicPath,
        outFile,
        musicResolved,
        highlight: highlightForRender,
        musicVolume: previewRender.musicVolume,
        musicOffsetSec: musicResolved?.offsetSec ?? 0,
      });
      return finishPreview('captions', { musicBaked: Boolean(settings.music && musicResolved) });
    } catch (err) {
      console.warn(`[preview] captions-only failed, full render: ${err.message}`);
    }
  }

  if (tier === 'grade') {
    try {
      await processClip({
        sourceVideo: rawPath,
        workDir: previewsDir,
        highlight: highlightForRender,
        transcriptSegments: [...transcriptSegments],
        options: {
          ...clipOptions,
          stopAfterPass: 1,
        },
      });
      await processClip({
        sourceVideo: rawPath,
        workDir: previewsDir,
        highlight: highlightForRender,
        transcriptSegments: [...transcriptSegments],
        options: {
          ...clipOptions,
          startFromPass: 2,
          stopAfterPass: 2,
        },
      });
      await applyMusicToPreview({
        preMusicPath,
        outFile,
        musicResolved,
        highlight: highlightForRender,
        musicVolume: previewRender.musicVolume,
        musicOffsetSec: musicResolved?.offsetSec ?? 0,
      });
      return finishPreview('grade', { musicBaked: Boolean(settings.music && musicResolved) });
    } catch (err) {
      console.warn(`[preview] grade tier failed, full render: ${err.message}`);
    }
  }

  const canHookFastPreview =
    exportSettings.cold_open === true &&
    settings.captions !== true &&
    settings.music !== true &&
    settings.colorGrade !== true &&
    !previewWide &&
    !settings.webcam?.enabled;

  if (canHookFastPreview) {
    try {
      const nominalMain = Math.max(0.5, exportHl.end_time - exportHl.start_time);
      const requestedHook = getHookTeaserRequested(exportHl);
      const rawInfo = await probeClipQuick(rawPath);
      const rawHasHook = (rawInfo.duration || 0) >= nominalMain + requestedHook * 0.35;
      const hookPreviewOpts = {
        aspectRatio: clipOptions.aspectRatio,
        showHook: clipOptions.showHook,
        hook: exportSettings.hook ?? hl.hook,
        colorGrade: false,
        aiStrength: clipOptions.aiStrength,
        clipBoosted: clipOptions.clipBoosted,
        knownHookTeaserSec: requestedHook,
      };
      let hookResult;
      if (rawHasHook) {
        hookResult = await renderHookPreviewFromRaw(
          rawPath,
          outFile,
          { ...exportHl, ...highlightForRender },
          hookPreviewOpts,
        );
      } else {
        const sourceVideo =
          meta.sourceVideoPath || path.join(jobWorkDir, meta.sourceVideo || 'source.mp4');
        const { mainPath } = await ensureMainCopyForHook(sourceVideo, exportHl, jobWorkDir);
        console.log(
          `[preview] ${hl.id} hook-fast build from main (raw ${(rawInfo.duration || 0).toFixed(2)}s ` +
            `< ${(nominalMain + requestedHook).toFixed(2)}s)`,
        );
        hookResult = await renderHookPreviewFast(mainPath, outFile, exportHl, hookPreviewOpts);
      }
      return finishPreview('hook-fast', {
        hookTeaserMeasuredSec: hookResult.hookTeaserMeasuredSec ?? requestedHook,
        clipDurationMeasured: hookResult.clipDurationMeasured,
      });
    } catch (err) {
      console.error(`[preview] hook-fast failed: ${err.message}`);
      throw err;
    }
  }

  await processClip({
    sourceVideo: rawPath,
    workDir: previewsDir,
    highlight: highlightForRender,
    transcriptSegments: [...transcriptSegments],
    options: {
      ...clipOptions,
      stopAfterPass: 3,
    },
  });

  let musicBaked = false;
  if (settings.music === true && musicResolved) {
    try {
      await applyMusicToPreview({
        preMusicPath,
        outFile,
        musicResolved,
        highlight: highlightForRender,
        musicVolume: previewRender.musicVolume,
        musicOffsetSec: musicResolved?.offsetSec ?? 0,
      });
      musicBaked = true;
    } catch (err) {
      console.warn(`[preview] music mix after full render failed: ${err.message}`);
    }
  }

  return finishPreview('full', { musicBaked });
}

async function applyMusicToPreview({
  preMusicPath,
  outFile,
  musicResolved,
  highlight,
  musicVolume,
  musicOffsetSec = 0,
}) {
  if (!musicResolved?.path) return;
  await runFastMusicMix({
    preMusicPath,
    outFile,
    cacheDir: path.dirname(preMusicPath),
    musicResolved,
    highlight,
    musicVolume,
    musicOffsetSec,
  });
}
