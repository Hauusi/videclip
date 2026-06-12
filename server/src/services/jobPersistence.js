import fs from 'fs/promises';
import path from 'path';
import { jobDir } from './tempFiles.js';

/** Rehydrate a completed analyze job from on-disk meta.json (survives server restarts). */
export async function loadCompletedJobFromDisk(jobId) {
  const metaPath = path.join(jobDir(jobId), 'meta.json');
  try {
    const raw = await fs.readFile(metaPath, 'utf8');
    const meta = JSON.parse(raw);
    return {
      id: jobId,
      type: 'analyze',
      status: 'completed',
      step: 'ready',
      progress: 100,
      message: 'Ready',
      result: { ...meta, jobId: meta.jobId || jobId },
      createdAt: meta.createdAt || null,
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export async function jobWorkspaceExists(jobId) {
  try {
    await fs.access(path.join(jobDir(jobId), 'meta.json'));
    return true;
  } catch {
    return false;
  }
}
