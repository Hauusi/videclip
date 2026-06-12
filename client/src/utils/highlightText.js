import { formatTime } from './helpers';

/** Overview card description — works for old jobs without stored reason. */
export function highlightDescription(highlight) {
  const reason = String(highlight?.reason || '').trim();
  if (reason.length >= 8) return reason;

  const line = [highlight.setup_line, highlight.peak_line, highlight.hook, highlight.excerpt]
    .map((s) => String(s || '').trim())
    .find((s) => s.length >= 6);

  if (line) return line.length > 220 ? `${line.slice(0, 217)}…` : line;

  const title = String(highlight?.title || '').trim();
  if (title && title !== 'Top moment') {
    return `Starker Moment: „${title}“ — gut geeignet für Shorts.`;
  }

  const start = Number(highlight?.start_time) || 0;
  return `Spannender Ausschnitt ab ${formatTime(start)} — ideal für Shorts und Reels.`;
}
