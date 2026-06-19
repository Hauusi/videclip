import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import multer from 'multer';
import archiver from 'archiver';
import { createReadStream } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { isValidYouTubeUrl } from '../utils/youtube.js';
import { friendlyError, AppError } from '../utils/errors.js';
import { createJob, getJob, updateJob } from '../services/jobs.js';
import { loadCompletedJobFromDisk } from '../services/jobPersistence.js';
import {
  listProjects,
  getProject,
  updateProject,
  deleteProject,
} from '../services/projectStore.js';
import { runAnalyzeJob } from '../services/analyzePipeline.js';
import { jobDir, createJobWorkspace } from '../services/tempFiles.js';
import { processClip, buildFilename } from '../services/ffmpeg.js';
import { prepareExportRawClip } from '../services/clipExport.js';
import { getClipBoostRenderOptions } from '../services/clipBoost.js';
import { resolveMusicForClip, listPresetTracks } from '../services/music.js';
import {
  normalizeRenderSettings,
  resolveWideOverlayEnabled,
} from '../services/renderSettings.js';
import { config } from '../config.js';
import { refreshYoutubeCookies } from '../services/cookieRefresh.js';
import { enqueueServerPreview } from '../services/previewQueue.js';
import { runTieredPreview } from '../services/previewCache.js';

const router = Router();
const upload = multer({ dest: path.join(config.tempRoot, 'uploads') });

const VIDEO_FILE_RE = /\.(mp4|mov|webm|mkv|avi|m4v)$/i;
const videoUpload = multer({
  dest: path.join(config.tempRoot, 'uploads'),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      VIDEO_FILE_RE.test(file.originalname || '') || /^video\//i.test(file.mimetype || '');
    cb(ok ? null : new Error('Unsupported video format'), ok);
  },
});

router.get('/health', async (_req, res) => {
  res.json({ ok: true, presets: await listPresetTracks() });
});

router.post('/cookies/refresh', async (req, res) => {
  try {
    const force = req.body?.force === true;
    const result = await refreshYoutubeCookies({ force });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: friendlyError(err),
      code: err.code || 'COOKIE_REFRESH_FAILED',
    });
  }
});

router.get('/jobs/:id', async (req, res) => {
  try {
    let job = getJob(req.params.id);
    if (!job) {
      job = await loadCompletedJobFromDisk(req.params.id);
    }
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

router.get('/projects', async (req, res) => {
  try {
    const savedOnly = req.query.saved === '1';
    const projects = await listProjects({ savedOnly });
    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

router.patch('/projects/:id', async (req, res) => {
  try {
    const updated = await updateProject(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Project not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

router.delete('/projects/:id', async (req, res) => {
  try {
    const ok = await deleteProject(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

router.post('/analyze', async (req, res) => {
  try {
    const { url, mood, renderSettings } = req.body || {};
    if (!isValidYouTubeUrl(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const job = createJob('analyze', { url, mood, renderSettings });
    res.status(202).json({ jobId: job.id });

    runAnalyzeJob(job.id, { url, mood, renderSettings }).catch(() => {});
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

router.post('/analyze-upload', (req, res) => {
  videoUpload.single('video')(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        const msg =
          uploadErr.code === 'LIMIT_FILE_SIZE'
            ? 'Video ist zu groß (max. 2 GB)'
            : friendlyError(uploadErr);
        return res.status(400).json({ error: msg });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'Keine Videodatei hochgeladen' });
      }

      let renderSettings = {};
      let mood = 'hype';
      try {
        if (req.body?.renderSettings) {
          renderSettings = JSON.parse(req.body.renderSettings);
        }
        if (req.body?.mood) mood = req.body.mood;
      } catch {
        /* defaults */
      }

      const sourceName = req.file.originalname || 'upload.mp4';
      const sourceTitle = path.basename(sourceName, path.extname(sourceName));
      const job = createJob('analyze', {
        sourceType: 'local',
        sourceName,
        mood,
        renderSettings,
      });

      const workDir = await createJobWorkspace(job.id);
      const ext = path.extname(sourceName) || '.mp4';
      const dest = path.join(workDir, `source${ext}`);
      await fs.rename(req.file.path, dest);

      res.status(202).json({ jobId: job.id });

      runAnalyzeJob(job.id, {
        localSourcePath: dest,
        sourceTitle,
        mood,
        renderSettings,
      }).catch(() => {});
    } catch (err) {
      if (req.file?.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }
      if (!res.headersSent) {
        res.status(err.statusCode || 500).json({ error: friendlyError(err) });
      }
    }
  });
});

async function loadMeta(jobId) {
  const metaPath = path.join(jobDir(jobId), 'meta.json');
  const raw = await fs.readFile(metaPath, 'utf8');
  return JSON.parse(raw);
}

router.post('/clip', async (req, res) => {
  try {
    const {
      jobId,
      highlightId,
      highlight,
      settings = {},
    } = req.body || {};

    if (!jobId) throw new AppError('jobId required');

    const meta = await loadMeta(jobId);
    const hl =
      highlight ||
      meta.highlights.find((h) => h.id === highlightId) ||
      meta.highlights[0];

    if (!hl) throw new AppError('Highlight not found');

    const workDir = jobDir(jobId);
    const exportSettings = {
      start_time: settings.start_time ?? hl.start_time,
      end_time: settings.end_time ?? hl.end_time,
      hook_teaser_duration: settings.hook_teaser_duration ?? hl.hook_teaser_duration,
      hook_peak_time: settings.hook_peak_time ?? hl.hook_peak_time,
      hook_offset_in_clip: settings.hook_offset_in_clip,
      cold_open: settings.cold_open ?? hl.cold_open,
      hook: settings.hook ?? hl.hook,
    };

    const exportRender = normalizeRenderSettings(
      {
        ...(meta.renderSettings || {}),
        music: settings.music,
        musicAuto: settings.musicAuto,
        musicVolume: settings.musicVolume ?? meta.renderSettings?.musicVolume,
        musicTrackId: settings.musicTrackId ?? meta.renderSettings?.musicTrackId,
        customMusicPath: settings.customMusicPath ?? meta.renderSettings?.customMusicPath,
      },
      settings.mood || meta.mood,
    );

    const platform = settings.platform || hl.platform_fit?.[0] || 'shorts';
    const outputName = buildFilename(
      { ...hl, title: settings.title || hl.title, viral_score: hl.viral_score },
      platform,
    );

    const clipJob = createJob('clip', { jobId, highlightId: hl.id });
    res.status(202).json({ jobId: clipJob.id });

    (async () => {
      try {
        updateJob(clipJob.id, { status: 'running', message: 'Processing clip...', progress: 20 });
        const clipsDir = path.join(workDir, 'clips');
        await fs.mkdir(clipsDir, { recursive: true });

        const { rawPath, processHighlight, transcriptSegments } = await prepareExportRawClip(
          meta,
          hl,
          exportSettings,
          workDir,
        );

        const boostOpts = getClipBoostRenderOptions(hl);

        const musicResolved =
          exportRender.music !== false
            ? await resolveMusicForClip({
                mood: settings.mood || meta.mood,
                highlight: { ...hl, ...processHighlight },
                renderSettings: exportRender,
              })
            : null;

        const outFile = await processClip({
          sourceVideo: rawPath,
          workDir: clipsDir,
          highlight: {
            ...processHighlight,
            hook: exportSettings.hook ?? hl.hook,
            caption_style:
              settings.caption_style ??
              hl.caption_style ??
              meta.renderSettings?.captionStyle ??
              'fire',
            zoom_moments: [],
          },
          transcriptSegments: [...transcriptSegments],
          options: {
            aspectRatio: settings.aspectRatio || exportRender.aspectRatio || '9:16',
            smartCrop: settings.smartCrop !== false,
            wideOverlay: settings.wideOverlay === true,
            wideOverlayRegion: settings.wideOverlayRegion,
            captions: settings.captions === true,
            music: settings.music === true && Boolean(musicResolved),
            colorGrade: settings.colorGrade === true,
            aiStrength: settings.aiStrength ?? 75,
            musicPath: musicResolved?.path || null,
            musicVolume: exportRender.musicVolume,
            musicOffsetSec: musicResolved?.offsetSec ?? 0,
            ctaText: String(settings.ctaText ?? '').trim(),
            showHook: settings.showHook === true || Boolean(boostOpts.showHook),
            clipBoosted: Boolean(hl.clip_boosted),
            captionStyle:
              settings.caption_style ??
              hl.caption_style ??
              meta.renderSettings?.captionStyle ??
              'fire',
            webcam: settings.webcam,
            clipLocalTimestamps: true,
            gameplayFraming: settings.gameplayFraming || exportRender.gameplayFraming || 'wide',
            preview: false,
            outputName,
          },
        });

        const rel = path.basename(outFile);
        updateJob(clipJob.id, {
          status: 'completed',
          step: 'ready',
          progress: 100,
          result: {
            file: rel,
            downloadUrl: `/api/files/${jobId}/clips/${rel}`,
          },
        });
      } catch (err) {
        console.error('[clip] processing failed', {
          clipJobId: clipJob.id,
          jobId,
          highlightId: hl.id,
          message: err?.message,
          stack: err?.stack,
        });
        updateJob(clipJob.id, {
          status: 'error',
          step: 'error',
          error: err?.message || String(err),
          stack: err?.stack,
        });
      }
    })();
  } catch (err) {
    console.error('[clip] request error', err);
    const status = err.statusCode || 500;
    res.status(status).json({
      error: err?.message || String(err),
      stack: err?.stack,
    });
  }
});

router.post('/preview', async (req, res) => {
  try {
    const result = await enqueueServerPreview(async () => {
      const { jobId, highlightId, highlight, settings = {} } = req.body || {};
      const meta = await loadMeta(jobId);
      const hl =
        highlight ||
        meta.highlights.find((h) => h.id === highlightId) ||
        meta.highlights[0];

      const jobWorkDir = jobDir(jobId);
      const previewsDir = path.join(jobWorkDir, 'previews');
      await fs.mkdir(previewsDir, { recursive: true });

      const previewResult = await runTieredPreview({
        jobId,
        jobWorkDir,
        meta,
        hl,
        settings,
        previewsDir,
      });

      return {
        previewUrl: previewResult.previewUrl,
        hookTeaserMeasuredSec: previewResult.hookTeaserMeasuredSec,
        clipDurationMeasured: previewResult.clipDurationMeasured,
        previewTier: previewResult.tier,
        previewStems: previewResult.previewStems,
      };
    });

    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: friendlyError(err) });
  }
});

router.post('/download-all', async (req, res) => {
  try {
    const { jobId, clips } = req.body || {};
    const workDir = path.join(jobDir(jobId), 'clips');
    const files = clips?.length
      ? clips
      : (await fs.readdir(workDir).catch(() => [])).filter((f) => f.endsWith('.mp4'));

    if (!files.length) throw new AppError('No clips to download');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="videclip_${jobId.slice(0, 8)}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => res.status(500).end(err.message));
    archive.pipe(res);

    for (const file of files) {
      const full = path.isAbsolute(file) ? file : path.join(workDir, file);
      archive.file(full, { name: path.basename(full) });
    }

    await archive.finalize();
  } catch (err) {
    if (!res.headersSent) {
      res.status(err.statusCode || 500).json({ error: friendlyError(err) });
    }
  }
});

router.post('/upload-music', upload.single('music'), async (req, res) => {
  try {
    if (!req.file) throw new AppError('No file uploaded');
    const id = uuidv4();
    const dest = path.join(config.tempRoot, 'music', `${id}${path.extname(req.file.originalname)}`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(req.file.path, dest);
    res.json({ customMusicPath: dest, id });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: friendlyError(err) });
  }
});

router.get('/files/:jobId/_root/:file', async (req, res) => {
  try {
    const { jobId, file } = req.params;
    const filePath = path.join(jobDir(jobId), file);
    await fs.access(filePath);
    res.sendFile(path.resolve(filePath));
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

router.get('/files/:jobId/:folder/:file', async (req, res) => {
  try {
    const { jobId, folder, file } = req.params;
    const filePath = path.join(jobDir(jobId), folder, file);
    await fs.access(filePath);
    res.sendFile(path.resolve(filePath));
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

export default router;
