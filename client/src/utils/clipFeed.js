import { getHighlightDisplayDuration } from './helpers';

export const CLIP_SORT_OPTIONS = [
  { id: 'score', label: 'Peak Score' },
  { id: 'order', label: 'Reihenfolge' },
  { id: 'kills', label: 'Kills' },
  { id: 'duration', label: 'Dauer' },
];

export function filterHighlightsByPlatform(highlights, platformFilter) {
  if (!platformFilter || platformFilter === 'all') return highlights;
  return highlights.filter((h) => h.platform_fit?.includes(platformFilter));
}

export function sortHighlights(highlights, sortBy) {
  const list = [...highlights];
  switch (sortBy) {
    case 'kills':
      return list.sort((a, b) => {
        const ka = a.montage_kill_count || a.montage_segments?.length || 0;
        const kb = b.montage_kill_count || b.montage_segments?.length || 0;
        return kb - ka || (b.viral_score || 0) - (a.viral_score || 0);
      });
    case 'duration':
      return list.sort(
        (a, b) => getHighlightDisplayDuration(b) - getHighlightDisplayDuration(a),
      );
    case 'order':
      return list;
    default:
      return list.sort((a, b) => (b.viral_score || 0) - (a.viral_score || 0));
  }
}

export function prepareClipFeed(highlights, { platformFilter = 'all', sortBy = 'score' } = {}) {
  const filtered = filterHighlightsByPlatform(highlights, platformFilter);
  return sortHighlights(filtered, sortBy);
}
