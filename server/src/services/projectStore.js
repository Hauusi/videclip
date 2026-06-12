import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { jobWorkspaceExists } from './jobPersistence.js';

const STORE_PATH = path.join(config.serverRoot, 'data', 'projects.json');
export const UNSAVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function ensureStore() {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  try {
    await fs.access(STORE_PATH);
  } catch {
    await fs.writeFile(STORE_PATH, '[]', 'utf8');
  }
}

async function readAll() {
  await ensureStore();
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeAll(projects) {
  await ensureStore();
  await fs.writeFile(STORE_PATH, JSON.stringify(projects, null, 2), 'utf8');
}

function projectFromResult(jobId, result) {
  const hl0 = result?.highlights?.[0];
  const now = Date.now();
  return {
    id: jobId,
    jobId,
    title: hl0?.title || result?.sourceName || 'Video',
    url: result?.url || '',
    sourceType: result?.sourceType || 'youtube',
    thumbnailUrl: result?.projectThumbnailUrl || hl0?.thumbnailUrl || null,
    clipCount: result?.highlights?.length || 0,
    mood: result?.mood || 'hype',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + UNSAVED_RETENTION_MS,
    saved: false,
    plan: 'ClipBasic',
  };
}

export async function registerProject(jobId, result) {
  if (!jobId || !result) return null;
  const projects = await readAll();
  const fresh = projectFromResult(jobId, result);
  const idx = projects.findIndex((p) => p.id === jobId);
  if (idx >= 0) {
    const prev = projects[idx];
    projects[idx] = {
      ...prev,
      ...fresh,
      createdAt: prev.createdAt || fresh.createdAt,
      saved: prev.saved,
      expiresAt: prev.saved ? null : fresh.expiresAt,
    };
  } else {
    projects.unshift(fresh);
  }
  await writeAll(projects.slice(0, 200));
  return projects.find((p) => p.id === jobId);
}

export async function listProjects({ savedOnly = false } = {}) {
  let projects = await readAll();
  const now = Date.now();

  projects = await Promise.all(
    projects.map(async (p) => {
      const workspace = await jobWorkspaceExists(p.jobId);
      return { ...p, workspaceAvailable: workspace };
    }),
  );

  if (savedOnly) {
    return projects.filter((p) => p.saved);
  }

  return projects.filter((p) => p.saved || !p.expiresAt || p.expiresAt > now);
}

export async function getProject(jobId) {
  const projects = await readAll();
  return projects.find((p) => p.id === jobId) || null;
}

export async function updateProject(jobId, patch = {}) {
  const projects = await readAll();
  const idx = projects.findIndex((p) => p.id === jobId);
  if (idx < 0) return null;

  const prev = projects[idx];
  const saved = patch.saved === true ? true : patch.saved === false ? false : prev.saved;
  const next = {
    ...prev,
    ...patch,
    saved,
    updatedAt: Date.now(),
    expiresAt: saved ? null : patch.expiresAt ?? prev.expiresAt ?? Date.now() + UNSAVED_RETENTION_MS,
  };
  projects[idx] = next;
  await writeAll(projects);
  return next;
}

export async function deleteProject(jobId) {
  const projects = await readAll();
  const next = projects.filter((p) => p.id !== jobId);
  if (next.length === projects.length) return false;
  await writeAll(next);
  return true;
}

/** Job dirs that must not be deleted by temp cleanup. */
export async function getProtectedJobIds() {
  const projects = await readAll();
  const now = Date.now();
  const ids = new Set();
  for (const p of projects) {
    if (p.saved || (p.expiresAt && p.expiresAt > now)) {
      ids.add(p.jobId);
    }
  }
  return ids;
}

export async function pruneExpiredProjects() {
  const projects = await readAll();
  const now = Date.now();
  const next = projects.filter((p) => p.saved || !p.expiresAt || p.expiresAt > now);
  if (next.length !== projects.length) {
    await writeAll(next);
  }
  return projects.length - next.length;
}
