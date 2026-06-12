import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export function jobDir(jobId) {
  return path.join(config.tempRoot, jobId);
}

export async function createJobWorkspace(jobId) {
  const dir = jobDir(jobId);
  await ensureDir(dir);
  return dir;
}

export async function removeDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export async function cleanupOldJobs() {
  try {
    await ensureDir(config.tempRoot);
    const { getProtectedJobIds, pruneExpiredProjects } = await import('./projectStore.js');
    await pruneExpiredProjects();
    const protectedIds = await getProtectedJobIds();
    const entries = await fs.readdir(config.tempRoot, { withFileTypes: true });
    const now = Date.now();
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (protectedIds.has(ent.name)) continue;
      const full = path.join(config.tempRoot, ent.name);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      const hasMeta = await fs
        .access(path.join(full, 'meta.json'))
        .then(() => true)
        .catch(() => false);
      const maxAge = hasMeta ? 7 * 24 * 60 * 60 * 1000 : config.cleanupMaxAgeMs;
      if (now - stat.mtimeMs > maxAge) {
        await removeDir(full);
      }
    }
  } catch {
    /* ignore */
  }
}
