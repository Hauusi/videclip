import fs from 'fs/promises';
import { config } from '../config.js';
import { AppError } from './errors.js';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Parse Netscape cookies.txt into objects. */
export function parseNetscapeCookies(raw) {
  const cookies = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const name = parts[5]?.trim();
    const value = parts.slice(6).join('\t').trim();
    if (name && value) {
      cookies.push({
        name,
        value,
        domain: parts[0],
        path: parts[2],
        secure: parts[3] === 'TRUE',
      });
    }
  }
  return cookies;
}

/** Resolve cookies.txt and throw if missing (shows exact path). */
export async function requireCookiesFile() {
  const cookiesPath = config.cookiesPath;
  try {
    await fs.access(cookiesPath);
    return cookiesPath;
  } catch {
    throw new AppError(
      `cookies.txt not found at: ${cookiesPath}\nExport YouTube cookies (Netscape format) to this exact path and try again.`,
      500,
    );
  }
}

/** Parse Netscape cookies.txt into a Cookie header string. */
export async function loadCookieHeader() {
  const file = await requireCookiesFile();
  const raw = await fs.readFile(file, 'utf8');
  const cookies = parseNetscapeCookies(raw);
  return cookies.length ? cookies.map((c) => `${c.name}=${c.value}`).join('; ') : null;
}

/** Parsed cookies for optional YouTube auth helpers. */
export async function loadYtdlCookies() {
  const file = await requireCookiesFile();
  const raw = await fs.readFile(file, 'utf8');
  const parsed = parseNetscapeCookies(raw);
  return parsed.length ? parsed.map(({ name, value }) => ({ name, value })) : null;
}

export async function getYoutubeRequestOptions() {
  const cookie = await loadCookieHeader();
  const headers = { 'User-Agent': USER_AGENT };
  if (cookie) headers.Cookie = cookie;
  return { headers };
}

export async function getCookiesFilePath() {
  return requireCookiesFile();
}
