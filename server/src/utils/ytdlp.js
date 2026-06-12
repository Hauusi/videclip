import path from 'path';
import { config } from '../config.js';
import { ffmpegPath } from '../lib/ffmpeg.js';

/** Shared yt-dlp flags for all spawns (proxy, JS runtime, PO-token-friendly clients). */
export function buildYtdlpBaseArgs(extra = []) {
  const args = ['--remote-components', 'ejs:npm'];
  const nodePath = (config.ytdlpNodePath || 'node').trim();
  args.push('--js-runtimes', `node:${nodePath}`);
  if (ffmpegPath) {
    args.push('--ffmpeg-location', path.resolve(ffmpegPath));
  }
  const proxy = (config.ytdlpProxy || '').trim();
  if (proxy) {
    args.push('--proxy', proxy);
  }
  const extractorArgs = [];
  const clients = (config.ytdlpPlayerClients || 'mweb,web_safari,android_vr').trim();
  if (clients) {
    extractorArgs.push(`youtube:player_client=${clients}`);
  }
  const potBase = (config.ytdlpPotBaseUrl || '').trim();
  if (potBase) {
    extractorArgs.push(`youtubepot-bgutilhttp:base_url=${potBase}`);
  }
  if (extractorArgs.length) {
    args.push('--extractor-args', extractorArgs.join(';'));
  }
  return [...args, ...extra];
}

export function isDatacenterBotBlock(message, { hasAuthCookies = false } = {}) {
  const msg = String(message || '');
  return (
    hasAuthCookies &&
    /not a bot|confirm you.?re not a bot|sign in to confirm/i.test(msg)
  );
}

export function hasPotBypass() {
  return Boolean((config.ytdlpPotBaseUrl || '').trim() || (config.ytdlpProxy || '').trim());
}

export function datacenterBlockDetail() {
  return (
    'YouTube blockiert Downloads von dieser Server-IP (Rechenzentrum). Kostenlose Server-Fixes: ' +
    '(1) PO-Token-Dienst bgutil auf dem Server (siehe Docs), (2) Cloudflare WARP auf dem VPS, ' +
    '(3) yt-dlp OAuth2 einmalig im Browser autorisieren. ' +
    'Falls das nicht reicht: YTDLP_PROXY mit Residential-Proxy in server/.env.'
  );
}
