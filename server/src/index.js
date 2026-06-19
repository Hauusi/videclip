import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import apiRoutes from './routes/api.js';
import { config, isAnthropicKeyConfigured } from './config.js';
import { ffmpegPath } from './lib/ffmpeg.js';
import { cleanupOldJobs, ensureDir } from './services/tempFiles.js';
import { friendlyError } from './utils/errors.js';
import { refreshYoutubeCookies } from './services/cookieRefresh.js';
import { runMonthlyDeepCleanup, triggerMonthlyCleanupNow } from './services/monthlyCleanup.js';
import { runMonthlyAnalytics, triggerAnalyticsNow } from './services/monthlyAnalytics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.on('uncaughtException', (err) => console.error('UNCAUGHT:', err));
process.on('unhandledRejection', (err) => console.error('UNHANDLED:', err));

// Ensure relative paths resolve from server/
process.chdir(config.serverRoot);

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/assets', express.static(path.join(config.assetsRoot)));
app.use('/api', apiRoutes);

const clientDist = path.join(__dirname, '../../client/dist');
const hasClientDist = fs.existsSync(path.join(clientDist, 'index.html'));

if (hasClientDist) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  res.status(err.statusCode || 500).json({
    error: friendlyError(err),
    code: err.code || 'APP_ERROR',
  });
});

await ensureDir(config.tempRoot);
await cleanupOldJobs();
setInterval(cleanupOldJobs, 10 * 60 * 1000);

refreshYoutubeCookies({ force: false }).catch((err) => {
  console.warn('[cookies] Startup refresh:', err.message);
});

const COOKIE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
  refreshYoutubeCookies({ force: false }).catch((err) => {
    console.warn('[cookies] Scheduled refresh:', err.message);
  });
}, COOKIE_REFRESH_INTERVAL_MS);

// Monthly maintenance cron job: 7:00 AM on 1st of every month (0 7 1 * *)
const MONTHLY_CRON = '0 7 1 * *';
if (cron.validate(MONTHLY_CRON)) {
  // Schedule cleanup
  cron.schedule(MONTHLY_CRON, async () => {
    console.log('[Cron] Monthly maintenance triggered by schedule');
    await runMonthlyDeepCleanup();
  }, {
    scheduled: true,
    timezone: 'Europe/Berlin'
  });

  // Schedule analytics (runs 5 minutes later to avoid overlap)
  cron.schedule('5 7 1 * *', async () => {
    console.log('[Cron] Monthly analytics triggered by schedule');
    await runMonthlyAnalytics();
  }, {
    scheduled: true,
    timezone: 'Europe/Berlin'
  });

  console.log(`[Cron] Monthly maintenance scheduled: ${MONTHLY_CRON} (cleanup at 7:00, analytics at 7:05)`);
} else {
  console.error('[Cron] Invalid cron expression for monthly maintenance');
}

// Trigger both jobs immediately as requested
console.log('[Cron] Starting monthly maintenance now (immediate execution)...');
(async () => {
  try {
    await triggerMonthlyCleanupNow();
    // Small delay between jobs
    await new Promise(r => setTimeout(r, 1000));
    await triggerAnalyticsNow();
  } catch (err) {
    console.error('[Cron] Immediate maintenance failed:', err.message);
  }
})();

app.listen(config.port, () => {
  console.log('');
  console.log('  Videclip is running');
  console.log(`  Backend:  http://localhost:${config.port}`);
  if (hasClientDist) {
    console.log(`  App (UI): http://localhost:${config.port}  (built client)`);
  }
  console.log('  Dev UI:   http://localhost:5173  (when client dev server is running)');
  console.log('');
  if (!isAnthropicKeyConfigured()) {
    console.warn(
      '  ⚠ ANTHROPIC_API_KEY missing — set a real key in server/.env for AI analysis',
    );
  }
  console.log(`  FFmpeg: ${ffmpegPath}`);
  console.log('');
});
