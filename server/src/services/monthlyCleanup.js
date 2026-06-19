import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { removeDir, ensureDir } from './tempFiles.js';

/**
 * Monthly deep cleanup - runs at 7:00 AM on the 1st of every month (cron: 0 7 1 * *)
 * More aggressive than the regular 10-minute cleanup:
 * - Removes old preview caches
 * - Purges orphaned debug files
 * - Cleans up temp directories beyond the tempRoot
 * - Logs cleanup statistics
 */

const CLEANUP_STATS = {
  lastRun: null,
  dirsRemoved: 0,
  bytesFreed: 0,
  errors: []
};

export function getMonthlyCleanupStats() {
  return { ...CLEANUP_STATS };
}

async function getDirSize(dirPath) {
  let size = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += await getDirSize(fullPath);
      } else {
        const stat = await fs.stat(fullPath).catch(() => null);
        if (stat) size += stat.size;
      }
    }
  } catch {
    // Ignore access errors
  }
  return size;
}

async function cleanupDirectory(dirPath, maxAgeMs, options = {}) {
  const { dryRun = false, pattern = null } = options;
  let removed = 0;
  let freed = 0;

  try {
    await ensureDir(dirPath);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const now = Date.now();

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (pattern && !ent.name.match(pattern)) continue;

      const fullPath = path.join(dirPath, ent.name);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat) continue;

      const age = now - stat.mtimeMs;
      if (age > maxAgeMs) {
        const dirSize = await getDirSize(fullPath);

        if (!dryRun) {
          await removeDir(fullPath);
        }

        removed++;
        freed += dirSize;
        console.log(`[MonthlyCleanup] ${dryRun ? 'Would remove' : 'Removed'}: ${ent.name} (${(dirSize / 1024 / 1024).toFixed(1)} MB, ${Math.floor(age / 24 / 60 / 60 / 1000)} days old)`);
      }
    }
  } catch (err) {
    console.error('[MonthlyCleanup] Error cleaning', dirPath, err.message);
    CLEANUP_STATS.errors.push({ path: dirPath, error: err.message, time: new Date().toISOString() });
  }

  return { removed, freed };
}

async function cleanupOldLogs(logsDir, maxAgeDays = 30) {
  let removed = 0;
  let freed = 0;

  try {
    await ensureDir(logsDir);
    const entries = await fs.readdir(logsDir, { withFileTypes: true });
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith('.log')) continue;

      const fullPath = path.join(logsDir, ent.name);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat) continue;

      if (now - stat.mtimeMs > maxAgeMs) {
        const fileSize = stat.size;
        await fs.unlink(fullPath).catch(() => {});
        removed++;
        freed += fileSize;
        console.log(`[MonthlyCleanup] Removed old log: ${ent.name} (${(fileSize / 1024).toFixed(1)} KB)`);
      }
    }
  } catch (err) {
    console.error('[MonthlyCleanup] Error cleaning logs', err.message);
  }

  return { removed, freed };
}

export async function runMonthlyDeepCleanup(options = {}) {
  const { dryRun = false, force = false } = options;
  const startTime = Date.now();

  console.log(`[MonthlyCleanup] Starting ${dryRun ? 'DRY RUN' : ''} cleanup at ${new Date().toISOString()}`);

  let totalDirsRemoved = 0;
  let totalBytesFreed = 0;
  CLEANUP_STATS.errors = [];

  // 1. Deep clean tempRoot - older than 3 days (more aggressive than regular 10-min cleanup)
  const tempResult = await cleanupDirectory(
    config.tempRoot,
    3 * 24 * 60 * 60 * 1000, // 3 days
    { dryRun }
  );
  totalDirsRemoved += tempResult.removed;
  totalBytesFreed += tempResult.freed;

  // 2. Clean preview caches (older than 7 days)
  const previewDir = path.join(config.tempRoot, '_previews');
  const previewResult = await cleanupDirectory(
    previewDir,
    7 * 24 * 60 * 60 * 1000, // 7 days
    { dryRun }
  );
  totalDirsRemoved += previewResult.removed;
  totalBytesFreed += previewResult.freed;

  // 3. Clean debug exports (older than 14 days)
  // These are temporary debug kill reels from shooter jobs
  const debugPattern = /^(?!.*_previews).*$/; // Exclude _previews
  const debugResult = await cleanupDirectory(
    config.tempRoot,
    14 * 24 * 60 * 60 * 1000, // 14 days
    { dryRun, pattern: debugPattern }
  );
  // Note: tempResult already counted these, but we're being more selective here

  // 4. Clean old logs
  const logsDir = path.join(process.cwd(), 'logs');
  const logsResult = await cleanupOldLogs(logsDir, 30);
  totalDirsRemoved += logsResult.removed;
  totalBytesFreed += logsResult.freed;

  // 5. Trim project list - remove entries older than 60 days (in-memory projects list)
  if (!dryRun) {
    try {
      const { pruneExpiredProjects } = await import('./projectStore.js');
      await pruneExpiredProjects(60); // 60 days instead of default 30
    } catch (err) {
      console.error('[MonthlyCleanup] Error pruning projects', err.message);
    }
  }

  const duration = Date.now() - startTime;

  // Update stats
  CLEANUP_STATS.lastRun = new Date().toISOString();
  CLEANUP_STATS.dirsRemoved = totalDirsRemoved;
  CLEANUP_STATS.bytesFreed = totalBytesFreed;

  console.log(`[MonthlyCleanup] Complete in ${duration}ms:`);
  console.log(`  - Directories/Files removed: ${totalDirsRemoved}`);
  console.log(`  - Space freed: ${(totalBytesFreed / 1024 / 1024).toFixed(2)} MB (${(totalBytesFreed / 1024 / 1024 / 1024).toFixed(2)} GB)`);
  if (CLEANUP_STATS.errors.length > 0) {
    console.log(`  - Errors: ${CLEANUP_STATS.errors.length}`);
  }

  return {
    success: true,
    duration,
    dirsRemoved: totalDirsRemoved,
    bytesFreed: totalBytesFreed,
    errors: CLEANUP_STATS.errors.length,
    dryRun
  };
}

/**
 * For manual triggering - run immediately
 */
export async function triggerMonthlyCleanupNow(dryRun = false) {
  console.log('[MonthlyCleanup] Manual trigger requested');
  return runMonthlyDeepCleanup({ dryRun, force: true });
}
