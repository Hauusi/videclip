import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { ensureDir } from './tempFiles.js';

/**
 * Monthly analytics report - runs alongside cleanup cron (0 7 1 * *)
 * Aggregates: video counts, game categories, processing times, error rates
 */

const ANALYTICS_DIR = path.join(config.serverRoot, 'data', 'analytics');
const REPORT_RETENTION_MONTHS = 12;

async function ensureAnalyticsDir() {
  await ensureDir(ANALYTICS_DIR);
}

function getMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function getPreviousMonthKey() {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return getMonthKey(prev);
}

async function scanJobWorkspaces() {
  const stats = {
    totalJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    gameCategories: {},
    processingTimes: [],
    sourceTypes: { youtube: 0, local: 0, unknown: 0 },
    highlightCounts: [],
    avgHighlightsPerVideo: 0,
    montageJobs: 0,
    avgKillsPerMontage: [],
    errors: {},
  };

  try {
    await ensureDir(config.tempRoot);
    const entries = await fs.readdir(config.tempRoot, { withFileTypes: true });

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('_')) continue; // Skip _previews etc

      const jobDir = path.join(config.tempRoot, ent.name);
      const metaPath = path.join(jobDir, 'meta.json');

      let meta = null;
      try {
        const raw = await fs.readFile(metaPath, 'utf8');
        meta = JSON.parse(raw);
      } catch {
        continue; // Skip dirs without valid meta
      }

      // Only count jobs from previous month
      const completedAt = meta.completedAt || meta.createdAt;
      if (!completedAt) continue;
      const jobMonth = getMonthKey(new Date(completedAt));
      if (jobMonth !== getPreviousMonthKey()) continue;

      stats.totalJobs++;

      // Status
      if (meta.error || meta.status === 'error') {
        stats.failedJobs++;
        const errCode = meta.error?.code || meta.errorCode || 'UNKNOWN';
        stats.errors[errCode] = (stats.errors[errCode] || 0) + 1;
      } else if (meta.status === 'completed') {
        stats.completedJobs++;
      }

      // Source type
      const sourceType = meta.sourceType || (meta.url?.includes('youtube') ? 'youtube' : 'unknown');
      if (sourceType === 'youtube') stats.sourceTypes.youtube++;
      else if (sourceType === 'local') stats.sourceTypes.local++;
      else stats.sourceTypes.unknown++;

      // Game category
      const category = meta.detectedGame || meta.category || 'unknown';
      stats.gameCategories[category] = (stats.gameCategories[category] || 0) + 1;

      // Processing time
      if (meta.startedAt && meta.completedAt) {
        const duration = new Date(meta.completedAt) - new Date(meta.startedAt);
        if (duration > 0 && duration < 30 * 60 * 1000) { // Max 30 min
          stats.processingTimes.push(duration);
        }
      }

      // Highlights
      const highlights = meta.highlights || meta.result?.highlights || [];
      stats.highlightCounts.push(highlights.length);

      // Montage jobs (CS2 shooter jobs)
      const isMontage = highlights.some(h => h.montage_segments || h.montageKills);
      if (isMontage || category === 'cs2' || category === 'counter-strike') {
        stats.montageJobs++;
        const kills = highlights.reduce((sum, h) => {
          return sum + (h.montageKills?.length || h.kills?.length || 0);
        }, 0);
        if (kills > 0) stats.avgKillsPerMontage.push(kills);
      }
    }
  } catch (err) {
    console.error('[MonthlyAnalytics] Error scanning jobs:', err.message);
  }

  // Calculate averages
  if (stats.processingTimes.length > 0) {
    stats.avgProcessingTime = stats.processingTimes.reduce((a, b) => a + b, 0) / stats.processingTimes.length;
    stats.medianProcessingTime = stats.processingTimes.sort((a, b) => a - b)[Math.floor(stats.processingTimes.length / 2)];
    stats.minProcessingTime = Math.min(...stats.processingTimes);
    stats.maxProcessingTime = Math.max(...stats.processingTimes);
  }

  if (stats.highlightCounts.length > 0) {
    stats.avgHighlightsPerVideo = stats.highlightCounts.reduce((a, b) => a + b, 0) / stats.highlightCounts.length;
  }

  if (stats.avgKillsPerMontage.length > 0) {
    stats.avgKillsPerMontageValue = stats.avgKillsPerMontage.reduce((a, b) => a + b, 0) / stats.avgKillsPerMontage.length;
  }

  return stats;
}

async function loadHistoricalData() {
  const history = [];
  try {
    await ensureAnalyticsDir();
    const files = await fs.readdir(ANALYTICS_DIR);
    for (const file of files.sort().reverse().slice(0, REPORT_RETENTION_MONTHS)) {
      if (!file.endsWith('.json')) continue;
      const raw = await fs.readFile(path.join(ANALYTICS_DIR, file), 'utf8');
      const report = JSON.parse(raw);
      history.push(report);
    }
  } catch {
    // Ignore missing history
  }
  return history;
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function generateTextReport(stats, history = []) {
  const month = getPreviousMonthKey();
  const lines = [
    `========================================`,
    `  Videclip Monthly Report: ${month}`,
    `========================================`,
    ``,
    `📊 JOB STATISTICS`,
    `-----------------`,
    `Total jobs processed:     ${stats.totalJobs}`,
    `Successful completions:   ${stats.completedJobs} (${((stats.completedJobs / stats.totalJobs) * 100).toFixed(1)}%)`,
    `Failed jobs:              ${stats.failedJobs} (${((stats.failedJobs / stats.totalJobs) * 100).toFixed(1)}%)`,
    ``,
    `⏱️  PROCESSING TIME`,
    `-------------------`,
    stats.avgProcessingTime ? `Average:                  ${formatDuration(stats.avgProcessingTime)}` : 'Average:                  N/A',
    stats.medianProcessingTime ? `Median:                   ${formatDuration(stats.medianProcessingTime)}` : 'Median:                   N/A',
    stats.minProcessingTime ? `Fastest:                  ${formatDuration(stats.minProcessingTime)}` : 'Fastest:                  N/A',
    stats.maxProcessingTime ? `Slowest:                  ${formatDuration(stats.maxProcessingTime)}` : 'Slowest:                  N/A',
    ``,
    `🎮 GAME CATEGORIES`,
    `------------------`,
    ...Object.entries(stats.gameCategories)
      .sort(([, a], [, b]) => b - a)
      .map(([cat, count]) => `  ${cat.padEnd(20)} ${count} (${((count / stats.totalJobs) * 100).toFixed(1)}%)`),
    ``,
    `🎯 HIGHLIGHTS`,
    `-------------`,
    `Avg highlights/video:     ${stats.avgHighlightsPerVideo.toFixed(1)}`,
    `Shooter montage jobs:     ${stats.montageJobs}`,
    stats.avgKillsPerMontageValue ? `Avg kills per montage:    ${stats.avgKillsPerMontageValue.toFixed(1)}` : '',
    ``,
    `🔗 SOURCE TYPES`,
    `---------------`,
    `  YouTube:                ${stats.sourceTypes.youtube}`,
    `  Local upload:           ${stats.sourceTypes.local}`,
    `  Unknown/other:          ${stats.sourceTypes.unknown}`,
    ``,
  ];

  if (Object.keys(stats.errors).length > 0) {
    lines.push(
      `⚠️  ERROR BREAKDOWN`,
      `-------------------`,
      ...Object.entries(stats.errors)
        .sort(([, a], [, b]) => b - a)
        .map(([code, count]) => `  ${code.padEnd(20)} ${count}`),
      ``
    );
  }

  if (history.length > 0) {
    lines.push(
      `📈 TREND (last ${history.length} months)`,
      `----------------`,
      ...history.slice(0, 6).map(h => `  ${h.month}: ${h.totalJobs} jobs, ${(h.avgHighlightsPerVideo || 0).toFixed(1)} avg highlights`),
      ``
    );
  }

  lines.push(
    `========================================`,
    `Generated: ${new Date().toISOString()}`,
    `========================================`
  );

  return lines.filter(Boolean).join('\n');
}

export async function runMonthlyAnalytics(options = {}) {
  const { dryRun = false } = options;
  const monthKey = getPreviousMonthKey();

  console.log(`[MonthlyAnalytics] Generating report for ${monthKey}...`);

  const stats = await scanJobWorkspaces();
  const history = await loadHistoricalData();

  const report = {
    month: monthKey,
    generatedAt: new Date().toISOString(),
    ...stats,
  };

  const textReport = generateTextReport(stats, history);

  if (!dryRun) {
    await ensureAnalyticsDir();

    // Save JSON
    const jsonPath = path.join(ANALYTICS_DIR, `${monthKey}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');

    // Save text report
    const txtPath = path.join(ANALYTICS_DIR, `${monthKey}-report.txt`);
    await fs.writeFile(txtPath, textReport, 'utf8');

    // Also save as latest.txt for easy reading
    const latestPath = path.join(ANALYTICS_DIR, 'latest.txt');
    await fs.writeFile(latestPath, textReport, 'utf8');

    console.log(`[MonthlyAnalytics] Report saved:`);
    console.log(`  - JSON: ${jsonPath}`);
    console.log(`  - Text: ${txtPath}`);
    console.log(`  - Latest: ${latestPath}`);
  }

  // Log summary to console
  console.log(textReport);

  return {
    success: true,
    month: monthKey,
    stats,
    dryRun,
  };
}

export async function triggerAnalyticsNow(dryRun = false) {
  console.log('[MonthlyAnalytics] Manual trigger requested');
  return runMonthlyAnalytics({ dryRun });
}

// API endpoint helper
export async function getLatestReport() {
  try {
    const latestPath = path.join(ANALYTICS_DIR, 'latest.txt');
    return await fs.readFile(latestPath, 'utf8');
  } catch {
    return null;
  }
}

export async function getReportHistory() {
  return loadHistoricalData();
}
