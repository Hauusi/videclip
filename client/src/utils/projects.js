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

export function expiryLabel(project) {
  if (project.saved) return null;
  const days = daysUntilExpiry(project.expiresAt);
  if (days == null) return null;
  if (days <= 0) return 'Läuft ab';
  if (days === 1) return '1 Tag vor Ablauf';
  return `${days} Tage vor Ablauf`;
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
