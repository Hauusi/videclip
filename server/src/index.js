import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import apiRoutes from './routes/api.js';
import { config, isAnthropicKeyConfigured } from './config.js';
import { ffmpegPath } from './lib/ffmpeg.js';
import { cleanupOldJobs, ensureDir } from './services/tempFiles.js';
import { friendlyError } from './utils/errors.js';
import { refreshYoutubeCookies } from './services/cookieRefresh.js';

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
