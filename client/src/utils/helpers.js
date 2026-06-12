export function viralColor(score) {
  if (score >= 8) return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30';
  if (score >= 5) return 'text-amber-400 bg-amber-400/10 border-amber-400/30';
  return 'text-red-400 bg-red-400/10 border-red-400/30';
}

export function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function buildScript(highlight, ctaText) {
  const lines = [`HOOK: ${highlight.hook}`, '', `BODY: ${highlight.reason}`];
  const cta = String(ctaText ?? '').trim();
  if (cta) {
    lines.push('', `CTA: ${cta}`);
  }
  return lines.join('\n');
}

const YOUTUBE_ID_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

export function youtubeVideoId(url) {
  return url?.trim().match(YOUTUBE_ID_RE)?.[1] || '';
}

export function isValidYouTubeUrl(url) {
  return Boolean(youtubeVideoId(url));
}

export const ACCEPTED_VIDEO_ACCEPT =
  'video/mp4,video/quicktime,video/webm,video/x-matroska,video/avi,.mp4,.mov,.webm,.mkv,.m4v,.avi';

export function isAcceptedVideoFile(file) {
  if (!file) return false;
  if (/\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(file.name || '')) return true;
  return /^video\//i.test(file.type || '');
}

export const STEPS = [
  { key: 'fetching', label: 'Fetching' },
  { key: 'analyzing', label: 'Analyzing' },
  { key: 'editing', label: 'Editing' },
  { key: 'transcribing', label: 'Transcribing clips' },
  { key: 'ready', label: 'Ready' },
];

export const MOODS = [
  { id: 'hype', label: 'Hype', emoji: '⚡' },
  { id: 'chill', label: 'Chill', emoji: '🌊' },
  { id: 'emotional', label: 'Emotional', emoji: '💜' },
];

export const PLATFORMS = [
  { id: 'shorts', label: 'YT Shorts', icon: '▶' },
  { id: 'tiktok', label: 'TikTok', icon: '♪' },
  { id: 'reels', label: 'Reels', icon: '◎' },
];

export function isMontageHighlight(highlight) {
  return (
    highlight?.montage_type === 'shooter_multikill' ||
    (highlight?.montage_segments?.length >= 2 && highlight?.clip_type === 'shooter_multikill')
  );
}

/** Rendered clip length — montages use output_duration, not VOD span. */
export function getHighlightDisplayDuration(highlight) {
  if (!highlight) return 0;
  const measured = Number(highlight.clip_duration_measured);
  if (Number.isFinite(measured) && measured > 0.5) return measured;
  if (Number(highlight.output_duration) > 0.5) return Number(highlight.output_duration);
  if (isMontageHighlight(highlight) && highlight.montage_segments?.length) {
    return highlight.montage_segments.reduce((s, seg) => s + (Number(seg.duration) || 0), 0);
  }
  return Math.max(1, (Number(highlight.end_time) || 0) - (Number(highlight.start_time) || 0));
}

/** Job-level detected game for clip tags (unknown when not identified). */
export function formatDetectedGame(contentGame) {
  const game = String(contentGame || '').trim();
  if (!game || game === 'Gaming' || game === 'FPS' || game === 'Generic') return 'unknown';
  return game;
}
