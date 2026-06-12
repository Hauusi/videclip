export function extractVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/watch\?.*&v=)([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = trimmed.match(p);
    if (m) return m[1];
  }
  return null;
}

/** ?t=3003 or &start=3003 from YouTube URL (seconds). */
export function extractUrlStartSeconds(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/[?&]t=(\d+)(?:s)?/i) || url.match(/[?&]start=(\d+)/i);
  if (!m) return null;
  const sec = parseInt(m[1], 10);
  return Number.isFinite(sec) && sec >= 0 ? sec : null;
}

export function isValidYouTubeUrl(url) {
  return extractVideoId(url) !== null;
}
