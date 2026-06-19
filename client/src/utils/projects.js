import { formatTime, getHighlightDisplayDuration } from './helpers';

export const UNSAVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function buildProjectFromAnalysis(completed, historyKey, fallbackTitle) {
  const result = completed.result;
  const jobId = completed.id || result?.jobId;
  const hl0 = result?.highlights?.[0];
  const now = Date.now();
  const title =
    hl0?.title || result?.sourceName || fallbackTitle || 'Video';

  return {
    id: jobId,
    jobId,
    title,
    url: historyKey || result?.url || '',
    sourceType: result?.sourceType || 'youtube',
    thumbnailUrl: result?.projectThumbnailUrl || hl0?.thumbnailUrl || null,
    clipCount: result?.highlights?.length || 0,
    mood: result?.mood || 'hype',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + UNSAVED_RETENTION_MS,
    saved: false,
    plan: 'ClipBasic',
    resultSnapshot: result,
  };
}

export function daysUntilExpiry(expiresAt) {
  if (!expiresAt) return null;
  const diff = Number(expiresAt) - Date.now();
  if (diff <= 0) return 0;
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

export function formatRelativeTime(ts) {
  const diff = Date.now() - Number(ts);
  if (!Number.isFinite(diff) || diff < 0) return '';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'gerade eben';
  if (mins < 60) return `vor ${mins} Min.`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `vor ${hrs} Std.`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `vor ${days} T.`;
  return new Date(Number(ts)).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
}

export function projectClipLabel(count) {
  const n = Number(count) || 0;
  if (n <= 0) return 'Analyse öffnen';
  return n === 1 ? '1 Clip' : `${n} Clips`;
}

/** Max kill count across highlights in snapshot (for library sort + meta). */
export function projectPeakKills(project) {
  const highlights = project?.resultSnapshot?.highlights || [];
  let max = 0;
  for (const h of highlights) {
    const k = h.montage_kill_count || h.montage_segments?.length || 0;
    if (k > max) max = k;
  }
  return max;
}

/** Longest clip duration in snapshot (seconds). */
export function projectPeakDuration(project) {
  const highlights = project?.resultSnapshot?.highlights || [];
  let max = 0;
  for (const h of highlights) {
    const d = getHighlightDisplayDuration(h);
    if (d > max) max = d;
  }
  return max > 0 ? max : null;
}

export function projectPreviewUrl(project) {
  const highlights = project?.resultSnapshot?.highlights || [];
  const top = [...highlights].sort(
    (a, b) =>
      (b.montage_kill_count || b.montage_segments?.length || 0) -
      (a.montage_kill_count || a.montage_segments?.length || 0),
  )[0];
  return top?.overviewUrl || top?.plainPreviewUrl || null;
}

export const LIBRARY_SORT_OPTIONS = [
  { id: 'date', label: 'Datum' },
  { id: 'kills', label: 'Kills' },
  { id: 'title', label: 'Titel' },
];

export function filterLibraryProjects(projects, { tab = 'all', query = '' } = {}) {
  let list = projects;
  if (tab === 'saved') list = list.filter((p) => p.saved);
  if (tab === 'expiring') {
    list = list.filter((p) => {
      if (p.saved) return false;
      const days = daysUntilExpiry(p.expiresAt);
      return days != null && days <= 3;
    });
  }
  const q = String(query || '').trim().toLowerCase();
  if (q) list = list.filter((p) => (p.title || '').toLowerCase().includes(q));
  return list;
}

export function sortLibraryProjects(projects, sortBy = 'date') {
  const list = [...projects];
  switch (sortBy) {
    case 'title':
      return list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'de'));
    case 'kills':
      return list.sort(
        (a, b) =>
          projectPeakKills(b) - projectPeakKills(a) ||
          (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt),
      );
    default:
      return list.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  }
}

export function projectMetaLine(project) {
  const parts = [];
  const n = Number(project.clipCount) || 0;
  if (n > 0) {
    parts.push(n === 1 ? '1 Clip' : `${n} Clips`);
    const kills = projectPeakKills(project);
    const dur = projectPeakDuration(project);
    if (kills > 0) parts.push(kills === 1 ? '1 Kill' : `bis ${kills} Kills`);
    else if (dur) parts.push(formatTime(dur));
  } else {
    parts.push('Analyse öffnen');
  }
  const rel = formatRelativeTime(project.updatedAt || project.createdAt);
  if (rel) parts.push(rel);
  return parts.join(' · ');
}

export function expiryLabel(project) {
  if (project.saved) return null;
  const days = daysUntilExpiry(project.expiresAt);
  if (days == null || days > 3) return null;
  if (days <= 0) return 'Läuft heute ab';
  if (days === 1) return 'Noch 1 Tag';
  return `Noch ${days} Tage`;
}

export function mergeProjectLists(localProjects, serverProjects) {
  const map = new Map();
  for (const p of serverProjects || []) {
    map.set(p.id, { ...p, fromServer: true });
  }
  for (const p of localProjects || []) {
    const existing = map.get(p.id);
    map.set(p.id, {
      ...(existing || {}),
      ...p,
      saved: existing?.saved ?? p.saved,
      expiresAt: p.saved || existing?.saved ? null : p.expiresAt ?? existing?.expiresAt,
      resultSnapshot: p.resultSnapshot || existing?.resultSnapshot,
      thumbnailUrl: p.thumbnailUrl || existing?.thumbnailUrl,
      fromServer: Boolean(existing?.fromServer),
    });
  }
  return [...map.values()].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
}

export function migrateHistoryToProjects(history) {
  if (!Array.isArray(history) || !history.length) return [];
  const now = Date.now();
  return history.map((h) => ({
    id: h.jobId || `legacy-${h.at}`,
    jobId: h.jobId,
    title: h.title || 'Video',
    url: h.url || '',
    sourceType: h.sourceType || 'youtube',
    thumbnailUrl: null,
    clipCount: 0,
    createdAt: h.at || now,
    updatedAt: h.at || now,
    expiresAt: (h.at || now) + UNSAVED_RETENTION_MS,
    saved: false,
    plan: 'ClipBasic',
    resultSnapshot: null,
  }));
}
