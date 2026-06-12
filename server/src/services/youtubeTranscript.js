import { YoutubeTranscript } from 'youtube-transcript';
import { AppError } from '../utils/errors.js';
import { fetchSubtitlesViaYtdlp } from './youtubeSubtitles.js';
import { transcribeSourceForHighlightDetection } from './transcript.js';

/** Normalize youtube-transcript items to { text, offset, duration } in seconds. */
function normalizeItem(item) {
  let offset = Number(item.offset);
  let duration = Number(item.duration || 1);
  if (offset > 5000) offset /= 1000;
  if (duration > 5000) duration /= 1000;
  return {
    text: String(item.text || '').trim(),
    offset,
    duration: Math.max(0.05, duration),
  };
}

async function fetchYoutubeTranscriptNpm(videoId) {
  console.log('[youtube-transcript] Trying npm package for', videoId);
  const items = await YoutubeTranscript.fetchTranscript(videoId);
  const segments = items.map(normalizeItem).filter((s) => s.text);
  if (!segments.length) {
    throw new AppError('YouTube returned an empty transcript', 404);
  }
  console.log('[youtube-transcript] npm package:', segments.length, 'lines');
  return segments;
}

/**
 * Resolve YouTube transcript with fallbacks (always tries hardest source first):
 * 1. yt-dlp subtitles (authenticated — same as video download)
 * 2. youtube-transcript npm
 * 3. Groq STT on downloaded source (chunked for long VODs)
 */
export async function resolveYoutubeTranscript({
  videoId,
  url,
  workDir,
  sourceVideo,
  sourceDuration,
  title = '',
  description = '',
  onProgress,
} = {}) {
  const failures = [];

  if (url && workDir) {
    try {
      const segments = await fetchSubtitlesViaYtdlp(url, workDir);
      if (segments?.length) {
        return { segments, source: 'ytdlp-subs' };
      }
      failures.push('ytdlp: no subtitle files');
    } catch (err) {
      if (err?.code === 'COOKIES_EXPIRED') {
        failures.push('ytdlp: auth (skipped — STT fallback)');
        console.warn('[youtube-transcript] yt-dlp subs auth failed, trying STT…');
      } else {
        failures.push(`ytdlp: ${err.message?.slice(0, 120)}`);
        console.warn('[youtube-transcript] yt-dlp subs failed:', err.message?.slice(0, 160));
      }
    }
  }

  if (videoId) {
    try {
      const segments = await fetchYoutubeTranscriptNpm(videoId);
      return { segments, source: 'youtube-transcript' };
    } catch (err) {
      failures.push(`npm: ${err.message?.slice(0, 120)}`);
      console.warn('[youtube-transcript] npm package failed:', err.message?.slice(0, 160));
    }
  }

  if (sourceVideo && workDir) {
    try {
      onProgress?.('Keine YouTube-Untertitel — transkribiere Audio…');
      const result = await transcribeSourceForHighlightDetection(sourceVideo, workDir, {
        videoTitle: title,
        description,
        sourceDuration,
        onProgress,
      });
      if (result?.segments?.length) {
        return { segments: result.segments, source: 'groq-stt' };
      }
      failures.push('stt: empty result');
    } catch (err) {
      failures.push(`stt: ${err.message?.slice(0, 120)}`);
      console.warn('[youtube-transcript] STT fallback failed:', err.message?.slice(0, 160));
    }
  }

  console.error('[youtube-transcript] All sources failed:', failures.join(' | '));
  return null;
}

/** @deprecated Use resolveYoutubeTranscript */
export async function fetchYoutubeTranscript(videoId) {
  if (!videoId) {
    throw new AppError('Invalid YouTube video ID', 400);
  }
  return fetchYoutubeTranscriptNpm(videoId);
}
