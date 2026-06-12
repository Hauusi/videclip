import { createReadStream } from 'fs';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import Groq from 'groq-sdk';
import { config } from '../config.js';
import { ffmpegPath } from '../lib/ffmpeg.js';
import { getVideoDuration } from './ffmpeg.js';
import { runCommand } from './exec.js';
import { AppError } from '../utils/errors.js';
import { refineWordTimings } from './captionAlign.js';
import { isViableTranscript } from './captionPipeline.js';

function quoteForLog(filePath) {
  return `"${filePath}"`;
}

const groq = new Groq({ apiKey: config.groqApiKey });

/** Parse Groq verbose_json transcription into word-level segments. */
function parseGroqTranscription(data, timeOffset = 0) {
  const segments = [];
  const offset = Math.max(0, Number(timeOffset) || 0);

  const pushWord = (w, segSpeaker) => {
    const text = String(w.word || '').trim();
    if (!text) return;
    const start = Number(w.start) + offset;
    const end = Number(w.end) + offset;
    const segment = {
      text,
      offset: start,
      duration: Math.max(0.05, end - start),
    };
    const speaker = w.speaker_id ?? w.speaker ?? segSpeaker;
    if (speaker != null) segment.speaker = speaker;
    segments.push(segment);
  };

  if (data.words?.length) {
    for (const w of data.words) pushWord(w);
    return segments;
  }

  for (const seg of data.segments || []) {
    if (seg.words?.length) {
      for (const w of seg.words) pushWord(w, seg.speaker);
    } else {
      const text = String(seg.text || '').trim();
      if (!text) continue;
      const start = Number(seg.start) + offset;
      const end = Number(seg.end) + offset;
      const segment = {
        text,
        offset: start,
        duration: Math.max(0.05, end - start),
      };
      if (seg.speaker != null) segment.speaker = seg.speaker;
      segments.push(segment);
    }
  }

  return segments;
}

const TRANSCRIPTION_CACHE_VERSION = 11;

function segmentStart(seg) {
  return Number(seg.offset ?? seg.start ?? 0);
}

function segmentEnd(seg) {
  return segmentStart(seg) + Number(seg.duration || 0.05);
}

/** True when word timings only cover the main trim (not yet shifted for a cold-open hook). */
export function transcriptIsMainTimelineOnly(segments, mainDurationSec) {
  if (!segments?.length) return true;
  const mainDur = Math.max(1, Number(mainDurationSec) || 1);
  const maxEnd = Math.max(...segments.map((s) => segmentEnd(s)));
  return maxEnd <= mainDur + 0.75;
}

/** Shift main-only STT onto hook+main playback timeline (teaser + offset main). */
export function applyColdOpenCaptionShift(segments, coldOpen, { highlightId = '' } = {}) {
  if (!coldOpen || !segments?.length) return segments;
  const mainDur = Math.max(1, Number(coldOpen.mainDuration) || 1);
  if (!transcriptIsMainTimelineOnly(segments, mainDur)) {
    return segments;
  }
  const shifted = buildColdOpenCaptionTimeline(segments, coldOpen);
  console.log(
    `[captions] Cold-open shift${highlightId ? ` ${highlightId}` : ''}: +${coldOpen.teaserSec.toFixed(2)}s ` +
      `(teaser source@${coldOpen.teaserStartInClip.toFixed(2)}s in main, ${shifted.length} words)`,
  );
  return shifted;
}

/**
 * Map main-clip transcript onto cold-open timeline (teaser + main replay).
 * @deprecated Prefer mergeColdOpenTranscripts with separate teaser STT.
 */
export function buildColdOpenCaptionTimeline(mainSegments, coldOpen) {
  const { teaserSec, teaserStartInClip, mainDuration } = coldOpen;
  const teaserEnd = teaserStartInClip + teaserSec;
  const result = [];

  for (const seg of mainSegments) {
    const start = segmentStart(seg);
    const end = segmentEnd(seg);
    const text = String(seg.text || '').trim();
    if (!text) continue;

    if (start < teaserEnd && end > teaserStartInClip) {
      const overlapStart = Math.max(start, teaserStartInClip);
      const overlapEnd = Math.min(end, teaserEnd);
      const relStart = overlapStart - teaserStartInClip;
      const relEnd = overlapEnd - teaserStartInClip;
      result.push({
        ...seg,
        text,
        offset: relStart,
        duration: Math.max(0.05, relEnd - relStart),
      });
    }

    if (start < mainDuration) {
      result.push({
        ...seg,
        text,
        offset: teaserSec + start,
        duration: Number(seg.duration || Math.max(0.05, end - start)),
      });
    }
  }

  return result.sort((a, b) => segmentStart(a) - segmentStart(b) || segmentEnd(a) - segmentEnd(b));
}

/**
 * Merge separate teaser + main STT passes onto full cold-open timeline.
 */
export function mergeColdOpenTranscripts(teaserSegments, mainSegments, coldOpen) {
  const { teaserSec } = coldOpen;
  const result = [];

  for (const seg of teaserSegments || []) {
    const text = String(seg.text || '').trim();
    if (!text) continue;
    const start = Math.max(0, segmentStart(seg));
    const end = Math.min(teaserSec, segmentEnd(seg));
    if (end <= start) continue;
    result.push({
      ...seg,
      text,
      offset: start,
      duration: Math.max(0.05, end - start),
    });
  }

  for (const seg of mainSegments || []) {
    const text = String(seg.text || '').trim();
    if (!text) continue;
    const start = segmentStart(seg);
    const end = segmentEnd(seg);
    result.push({
      ...seg,
      text,
      offset: teaserSec + start,
      duration: Math.max(0.05, end - start),
    });
  }

  return result.sort((a, b) => segmentStart(a) - segmentStart(b) || segmentEnd(a) - segmentEnd(b));
}

/**
 * Whisper word timestamps with optional audio onset correction.
 */
export function buildClipCaptionTimings(segments) {
  if (!segments.length) return segments;

  return segments.map((seg) => {
    const start = Math.max(0, segmentStart(seg));
    const end = Math.max(start + 0.05, segmentEnd(seg));
    return {
      ...seg,
      offset: start,
      duration: Math.max(0.05, end - start),
    };
  });
}

/** @deprecated Use buildClipCaptionTimings */
export function normalizeClipTranscriptTimings(segments) {
  return buildClipCaptionTimings(segments);
}

export function guessTranscriptLanguage(title = '', description = '') {
  const text = `${title} ${description}`.toLowerCase();
  if (/\b(der|die|das|und|ich|nicht|ist|ein|eine|wir|ihr|schon|auch|mal)\b/.test(text)) {
    return 'de';
  }
  if (/\b(the|and|you|this|that|with|have|from|they|what)\b/.test(text)) {
    return 'en';
  }
  return undefined;
}

/** Groq/Whisper require ISO-639-1; API responses may return full names like "German". */
const GROQ_LANGUAGE_CODES = new Set([
  'de', 'nl', 'he', 'lt', 'ml', 'te', 'sq', 'fr', 'ca', 'hi', 'fi', 'vi', 'da', 'et', 'br',
  'es', 'uk', 'no', 'th', 'az', 'hy', 'mn', 'sd', 'id', 'lv', 'bn', 'bs', 'gl', 'so', 'ka',
  'yi', 'pl', 'is', 'kk', 'km', 'am', 'lo', 'mg', 'ha', 'bg', 'ne', 'mr', 'sn', 'gu', 'ar',
  'ta', 'hr', 'mi', 'fa', 'tk', 'tl', 'su', 'yue', 'tr', 'sv', 'cs', 'hu', 'sr', 'sl', 'kn',
  'mk', 'zh', 'it', 'sw', 'be', 'uz', 'fo', 'nn', 'as', 'ru', 'cy', 'yo', 'tg', 'my', 'ln',
  'jv', 'ur', 'af', 'ht', 'ro', 'sk', 'lb', 'bo', 'tt', 'haw', 'pt', 'pa', 'si', 'oc', 'mt',
  'ja', 'eu', 'ps', 'ko', 'el', 'ms', 'la', 'sa', 'ba', 'en',
]);

const LANGUAGE_NAME_TO_ISO = {
  german: 'de',
  deutsch: 'de',
  english: 'en',
  french: 'fr',
  spanish: 'es',
  italian: 'it',
  portuguese: 'pt',
  dutch: 'nl',
  russian: 'ru',
  japanese: 'ja',
  korean: 'ko',
  chinese: 'zh',
  arabic: 'ar',
  hindi: 'hi',
  turkish: 'tr',
  polish: 'pl',
  swedish: 'sv',
  norwegian: 'no',
  danish: 'da',
  finnish: 'fi',
  czech: 'cs',
  hungarian: 'hu',
  romanian: 'ro',
  ukrainian: 'uk',
  greek: 'el',
  hebrew: 'he',
  indonesian: 'id',
  vietnamese: 'vi',
  thai: 'th',
};

export function normalizeWhisperLanguage(language) {
  if (language == null || language === '' || language === 'unknown') return undefined;

  const raw = String(language).trim();
  if (!raw) return undefined;

  const lower = raw.toLowerCase();
  if (GROQ_LANGUAGE_CODES.has(lower)) return lower;

  const mapped = LANGUAGE_NAME_TO_ISO[lower];
  if (mapped) return mapped;

  if (/^[a-z]{2}$/i.test(raw)) {
    console.warn(`[transcript] Unknown ISO language code "${raw}" — using auto-detect`);
  } else {
    console.warn(`[transcript] Unsupported language "${raw}" — using auto-detect`);
  }
  return undefined;
}

export function buildWhisperPrompt(videoTitle = '', language) {
  const title = String(videoTitle || '').trim().slice(0, 100);
  const langHint = language === 'de' ? 'Deutsch.' : language === 'en' ? 'English.' : '';
  const parts = [title, langHint, 'Word-accurate transcript of spoken dialogue.'].filter(Boolean);
  return parts.join(' ').slice(0, 200);
}

export function assessCaptionQuality(segments, clipDurationSec) {
  const duration = Math.max(1, Number(clipDurationSec) || 1);
  const wordCount = segments.length;
  const wordsPerSec = wordCount / duration;
  const lastEnd = wordCount ? segmentEnd(segments[wordCount - 1]) : 0;
  const coverage = lastEnd / duration;

  const minWords = Math.max(3, Math.floor(duration * 0.22));
  const pass = wordCount >= minWords && coverage >= 0.2 && wordsPerSec >= 0.15;

  return { pass, wordCount, wordsPerSec, coverage, minWords };
}

async function clipFileFingerprint(clipPath) {
  const stat = await fs.stat(clipPath);
  return crypto
    .createHash('sha256')
    .update(`${path.resolve(clipPath)}:${stat.size}:${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 20);
}

async function extractAudio(
  clipPath,
  audioPath,
  { startSec = 0, durationSec, sttEnhance = false } = {},
) {
  await fs.mkdir(path.dirname(audioPath), { recursive: true });

  const input = path.resolve(clipPath);
  const output = path.resolve(audioPath);
  const ffmpegBin = path.resolve(ffmpegPath);

  const args = ['-y', '-ignore_unknown', '-i', input];
  if (startSec > 0) {
    args.push('-ss', String(startSec));
  }
  if (durationSec != null && durationSec > 0) {
    args.push('-t', String(durationSec));
  }

  if (sttEnhance) {
    args.push('-af', 'highpass=f=120,lowpass=f=12000,afftdn=nr=6:nf=-25');
  }

  args.push(
    '-map',
    '0:a:0',
    '-vn',
    '-acodec',
    'pcm_s16le',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-f',
    'wav',
    output,
  );

  console.log('[transcript] Extracting WAV audio:', quoteForLog(output));

  try {
    const { stderr } = await runCommand(ffmpegBin, args);
    if (stderr) console.log('[transcript ffmpeg]', stderr.slice(-400));
  } catch (err) {
    throw new Error(`FFmpeg audio extraction failed: ${err.message}`);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const TRANSCRIPTION_CACHE_FILE = 'transcription.json';
const MAX_RATE_LIMIT_RETRIES = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryAfterSeconds(err) {
  const headers = err?.headers;
  let raw;
  if (headers) {
    if (typeof headers.get === 'function') {
      raw = headers.get('retry-after') ?? headers.get('Retry-After');
    } else {
      raw = headers['retry-after'] ?? headers['Retry-After'];
    }
  }
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 60;
}

async function loadTranscriptionCache(workDir, expected) {
  const cachePath = path.join(workDir, TRANSCRIPTION_CACHE_FILE);
  try {
    const data = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    if (data?.version !== TRANSCRIPTION_CACHE_VERSION || !data?.segments?.length) {
      return null;
    }
    if (expected?.clipHash && data.clipHash !== expected.clipHash) {
      return null;
    }
    if (expected?.model && data.model !== expected.model) {
      return null;
    }
    if (expected?.coldOpenKey && data.coldOpenKey !== expected.coldOpenKey) {
      return null;
    }
    return {
      segments: data.segments,
      language: data.language || 'unknown',
      quality: data.quality,
    };
  } catch {
    /* no cache */
  }
  return null;
}

async function saveTranscriptionCache(workDir, result) {
  await fs.writeFile(
    path.join(workDir, TRANSCRIPTION_CACHE_FILE),
    JSON.stringify(result, null, 2),
    'utf8',
  );
}

async function createGroqTranscription(audioPath, { model, language, prompt }) {
  let lastError;

  const request = {
    file: createReadStream(audioPath),
    model,
    response_format: 'verbose_json',
    timestamp_granularities: ['word'],
    temperature: 0,
  };
  if (language) {
    const lang = normalizeWhisperLanguage(language);
    if (lang) request.language = lang;
  }
  if (prompt) request.prompt = prompt;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    try {
      return await groq.audio.transcriptions.create(request);
    } catch (err) {
      lastError = err;
      const canRetry = err?.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES;
      if (!canRetry) throw err;

      const waitSec = getRetryAfterSeconds(err);
      console.warn(
        `[transcript] Groq rate limit (429), waiting ${waitSec}s before retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}`,
      );
      await sleep(waitSec * 1000);
    }
  }

  throw lastError;
}

async function transcribeAudioFile(audioPath, groqOptions) {
  const transcription = await createGroqTranscription(audioPath, groqOptions);
  if (transcription.words?.length) {
    console.log(
      '[transcript] Sample words:',
      transcription.words.slice(0, 6).map((w) => `"${w.word}" ${w.start}-${w.end}s`),
    );
  }
  return transcription;
}

function coldOpenCacheKey(coldOpen) {
  if (!coldOpen) return '';
  return `full-clip:${coldOpen.teaserSec.toFixed(2)}:${coldOpen.mainDuration.toFixed(2)}`;
}

const TRANSCRIBE_ATTEMPTS = [
  { label: 'default', useLanguage: true, usePrompt: true, sttEnhance: true },
  { label: 'auto-lang', useLanguage: false, usePrompt: false, sttEnhance: true },
  { label: 'plain', useLanguage: false, usePrompt: false, sttEnhance: false },
];

/**
 * Transcribe a pre-cut clip; word timestamps are 0-based (clip-relative).
 * Cold-open clips: full concatenated clip STT (teaser + main in one pass).
 * @param {object} [options]
 * @param {string} [options.language] ISO-639-1
 * @param {string} [options.prompt]
 * @param {boolean} [options.preview] turbo model for fast preview
 * @param {string} [options.videoTitle]
 * @param {{ teaserSec: number, teaserStartInClip: number, mainDuration: number }} [options.coldOpen]
 */
export async function transcribeClipAudio(clipVideoPath, workDir, options = {}) {
  if (!config.groqApiKey) {
    throw new AppError('GROQ_API_KEY is not set in server/.env', 500);
  }

  await fs.mkdir(workDir, { recursive: true });

  const clipPath = path.resolve(clipVideoPath);
  const clipHash = await clipFileFingerprint(clipPath);
  const coldOpen = options.coldOpen || null;
  const coldOpenKey = coldOpenCacheKey(coldOpen);
  const model = 'whisper-large-v3';
  const languageHint =
    normalizeWhisperLanguage(options.language) ||
    guessTranscriptLanguage(options.videoTitle, '');
  const promptHint = options.prompt || buildWhisperPrompt(options.videoTitle, languageHint);
  const clipDuration = coldOpen
    ? coldOpen.mainDuration + coldOpen.teaserSec
    : null;

  let probedDuration = null;
  try {
    probedDuration = await getVideoDuration(clipPath);
  } catch {
    /* optional */
  }
  const effectiveClipDuration =
    probedDuration && probedDuration > 0.5 ? probedDuration : clipDuration;

  const cached = await loadTranscriptionCache(workDir, { clipHash, model, coldOpenKey });
  if (cached && !options.skipCache) {
    console.log('[transcript] Using cached clip transcription:', workDir);
    return {
      segments: buildClipCaptionTimings(cached.segments),
      language: normalizeWhisperLanguage(cached.language) || cached.language || 'unknown',
      quality: cached.quality,
    };
  }

  const fullAudioPath = path.join(workDir, 'audio-full.wav');
  const sttAudioPath = path.join(workDir, 'audio-stt.wav');

  let rawSegments = [];
  let detectedLanguage = 'unknown';
  let quality = null;

  try {
    const mode = coldOpen ? 'full-clip (cold-open)' : 'full-clip';
    console.log(
      `[transcript] Clip: ${clipPath} model=${model} lang=${languageHint || 'auto'} (${mode})`,
    );

    await extractAudio(clipPath, fullAudioPath, { sttEnhance: true });
    const fullStat = await fs.stat(fullAudioPath);
    if (fullStat.size === 0) {
      throw new Error('Extracted clip audio is empty');
    }
    console.log('[transcript] Full clip audio:', formatBytes(fullStat.size));

    for (const attempt of TRANSCRIBE_ATTEMPTS) {
      const attemptAudio = path.join(workDir, `audio-stt-${attempt.label}.wav`);

      if (attempt.sttEnhance) {
        await extractAudio(clipPath, attemptAudio, { sttEnhance: true });
      } else {
        await extractAudio(clipPath, attemptAudio, { sttEnhance: false });
      }

      const groqOpts = {
        model,
        language: attempt.useLanguage ? languageHint : undefined,
        prompt: attempt.usePrompt ? promptHint : undefined,
      };

      console.log(`[transcript] STT attempt "${attempt.label}" (${groqOpts.language || 'auto'})`);

      const transcription = await transcribeAudioFile(attemptAudio, groqOpts);
      const segments = parseGroqTranscription(transcription);
      detectedLanguage =
        normalizeWhisperLanguage(transcription.language) || detectedLanguage;

      const durationForQuality =
        effectiveClipDuration ||
        (segments.length ? segmentEnd(segments[segments.length - 1]) : 1);
      quality = assessCaptionQuality(segments, durationForQuality);

      if (quality.pass) {
        rawSegments = segments;
        console.log(
          `[transcript] Quality OK (${attempt.label}): ${quality.wordCount} words, ` +
            `${quality.wordsPerSec.toFixed(2)} w/s, coverage ${(quality.coverage * 100).toFixed(0)}%`,
        );
        break;
      }

      console.warn(
        `[transcript] Quality FAIL (${attempt.label}): ${quality.wordCount}/${quality.minWords} words, ` +
          `${quality.wordsPerSec.toFixed(2)} w/s, coverage ${(quality.coverage * 100).toFixed(0)}%`,
      );
      rawSegments = segments;
    }

    if (rawSegments.length) {
      rawSegments = refineWordTimings(rawSegments);
    }

    await fs.unlink(fullAudioPath).catch(() => {});
    await fs.unlink(sttAudioPath).catch(() => {});
    for (const attempt of TRANSCRIBE_ATTEMPTS) {
      await fs.unlink(path.join(workDir, `audio-stt-${attempt.label}.wav`)).catch(() => {});
    }
  } catch (err) {
    console.error('[transcript] Groq clip error:', err);
    throw new AppError(`Clip transcription failed: ${err.message}`, 502);
  }

  if (!rawSegments.length) {
    if (options.allowSparseCaptions) {
      console.log('[transcript] No speech detected — skipping captions for action montage');
      return { segments: [], language: detectedLanguage || 'unknown', quality };
    }
    throw new AppError('Groq returned an empty clip transcript', 404);
  }

  if (!isViableTranscript(rawSegments)) {
    if (options.allowSparseCaptions) {
      console.warn(
        `[transcript] Sparse clip transcript (${rawSegments.length} words) — ` +
          'skipping captions for action montage',
      );
      return { segments: [], language: detectedLanguage || 'unknown', quality };
    }
    throw new AppError(
      `Caption transcript too sparse (${rawSegments.length} words) — clip needs re-transcription or trim adjustment`,
      502,
    );
  }

  if (quality && !quality.pass) {
    console.warn(
      `[transcript] Caption quality below threshold after retries — using best result (${rawSegments.length} words)`,
    );
  }

  const segments = buildClipCaptionTimings(rawSegments);
  const firstAt = segments.length ? segmentStart(segments[0]).toFixed(2) : 'none';
  const wordsInFirst2s = segments.filter((s) => segmentStart(s) < 2).length;
  console.log(
    `[transcript] ${segments.length} words, first@${firstAt}s, ${wordsInFirst2s} words in 0-2s`,
  );

  const normalizedLanguage =
    normalizeWhisperLanguage(detectedLanguage) || detectedLanguage || 'unknown';

  await saveTranscriptionCache(workDir, {
    version: TRANSCRIPTION_CACHE_VERSION,
    clipHash,
    model,
    coldOpenKey,
    segments: rawSegments,
    language: normalizedLanguage,
    quality,
  });

  return { segments, language: normalizedLanguage, quality };
}

const DETECTION_CHUNK_SEC = 600;
const DETECTION_MAX_CHUNKS = 24;
/** Groq Whisper rejects ~128MB WAV — chunk anything longer than 45 min. */
const DETECTION_FULL_STT_MAX_SEC = 45 * 60;

/**
 * Full-source STT for highlight detection when YouTube captions are unavailable.
 * Long VODs are sampled in chunks across the timeline (max 18 × 10 min).
 */
export async function transcribeSourceForHighlightDetection(
  sourceVideo,
  workDir,
  { videoTitle = '', description = '', sourceDuration, onProgress } = {},
) {
  if (!config.groqApiKey) {
    throw new AppError('GROQ_API_KEY is not set in server/.env', 500);
  }

  const detectDir = path.join(workDir, 'detect-transcript');
  await fs.mkdir(detectDir, { recursive: true });

  const cachePath = path.join(detectDir, 'source-detection.json');
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    if (cached?.segments?.length >= 20) {
      console.log(`[transcript] Using cached source detection STT (${cached.segments.length} words)`);
      return cached;
    }
  } catch {
    /* no cache */
  }

  const duration =
    Number(sourceDuration) > 0 ? Number(sourceDuration) : await getVideoDuration(sourceVideo);
  const languageHint = guessTranscriptLanguage(videoTitle, description);

  if (duration <= DETECTION_FULL_STT_MAX_SEC) {
    console.log(`[transcript] Source detection STT (full, ${(duration / 60).toFixed(0)} min)`);
    onProgress?.('Transkribiere Vollvideo für KI-Analyse…');
    const result = await transcribeClipAudio(sourceVideo, detectDir, {
      videoTitle,
      preview: false,
      language: languageHint,
    });
    const payload = { segments: result.segments, language: result.language };
    await fs.writeFile(cachePath, JSON.stringify(payload), 'utf8');
    return payload;
  }

  let chunkStarts = [];
  for (let t = 0; t < duration; t += DETECTION_CHUNK_SEC) {
    chunkStarts.push(t);
  }
  if (chunkStarts.length > DETECTION_MAX_CHUNKS) {
    const step = duration / DETECTION_MAX_CHUNKS;
    chunkStarts = [];
    for (let i = 0; i < DETECTION_MAX_CHUNKS; i++) {
      chunkStarts.push(Math.floor(i * step));
    }
  }

  console.log(
    `[transcript] Long-source detection STT: ${chunkStarts.length} chunks × ${DETECTION_CHUNK_SEC / 60}min ` +
      `(total ${(duration / 3600).toFixed(1)}h)`,
  );

  const allSegments = [];
  let detectedLang = languageHint || 'unknown';
  const model = 'whisper-large-v3';
  const prompt = buildWhisperPrompt(videoTitle, languageHint);

  for (let i = 0; i < chunkStarts.length; i++) {
    const start = chunkStarts[i];
    const chunkDur = Math.min(DETECTION_CHUNK_SEC, duration - start);
    onProgress?.(
      `Analysiere Video-Audio (Teil ${i + 1}/${chunkStarts.length}) — noch keine Clips…`,
    );

    const chunkDir = path.join(detectDir, `chunk-${i}`);
    await fs.mkdir(chunkDir, { recursive: true });
    const chunkAudio = path.join(chunkDir, 'chunk.wav');

    await extractAudio(sourceVideo, chunkAudio, {
      startSec: start,
      durationSec: chunkDur,
      sttEnhance: true,
    });

    const stat = await fs.stat(chunkAudio);
    if (stat.size === 0) continue;

    const transcription = await transcribeAudioFile(chunkAudio, {
      model,
      language: languageHint,
      prompt,
    });

    const segs = parseGroqTranscription(transcription, start);
    allSegments.push(...segs);
    detectedLang = normalizeWhisperLanguage(transcription.language) || detectedLang;
    await fs.unlink(chunkAudio).catch(() => {});
  }

  if (!allSegments.length) {
    throw new AppError('Source transcription returned no speech', 502);
  }

  const payload = {
    segments: buildClipCaptionTimings(allSegments),
    language: detectedLang,
  };
  await fs.writeFile(cachePath, JSON.stringify(payload), 'utf8');
  console.log(`[transcript] Long-source detection done: ${payload.segments.length} words`);
  return payload;
}
