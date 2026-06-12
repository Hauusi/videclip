import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.join(__dirname, '..');

dotenv.config({ path: path.join(serverRoot, '.env') });

const PLACEHOLDER_KEYS = new Set(['', 'your_api_key_here', 'sk-your-key-here', 'gsk_your_key_here']);

export function isAnthropicKeyConfigured() {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  return Boolean(key) && !PLACEHOLDER_KEYS.has(key) && key.startsWith('sk-');
}

export const config = {
  serverRoot,
  port: parseInt(process.env.PORT || '3001', 10),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || '',
  groqApiKey: process.env.GROQ_API_KEY?.trim() || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  pythonPath:
    process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3'),
  tempRoot: path.join(process.env.TEMP || process.env.TMP || '/tmp', 'videclip'),
  assetsRoot: path.join(serverRoot, 'assets'),
  /** Netscape cookies file for YouTube auth (absolute path) */
  cookiesPath:
    process.env.COOKIES_PATH || 'C:\\Users\\rapha\\Desktop\\videclip\\cookies.txt',
  /** Comma-separated browsers for yt-dlp --cookies-from-browser (when DB is readable) */
  cookiesBrowsers: process.env.COOKIES_BROWSERS || 'chrome,edge,chromium,brave,firefox',
  /** Skip yt-dlp --cookies-from-browser (noisy on Windows when Chrome is open) */
  cookiesSkipBrowserExport: process.env.COOKIES_SKIP_BROWSER_EXPORT === '1',
  cookiesMaxAgeHours: parseFloat(process.env.COOKIES_MAX_AGE_HOURS || '12', 10),
  ytdlpPath:
    process.env.YTDLP_PATH ||
    'C:\\Users\\rapha\\AppData\\Roaming\\Python\\Python314\\Scripts\\yt-dlp.exe',
  /** HTTP/SOCKS proxy for yt-dlp (required on many VPS/datacenter IPs for YouTube) */
  ytdlpProxy: process.env.YTDLP_PROXY || '',
  ytdlpNodePath: process.env.YTDLP_NODE_PATH || 'node',
  ytdlpPlayerClients: process.env.YTDLP_PLAYER_CLIENTS || 'mweb,web_safari,android_vr',
  ytdlpPotBaseUrl: process.env.YTDLP_POT_BASE_URL || 'http://127.0.0.1:4416',
  puppeteerProfileDir:
    process.env.PUPPETEER_PROFILE_DIR ||
    path.join(serverRoot, '.youtube-browser-profile'),
  chromeExecutable: process.env.CHROME_EXECUTABLE || '',
  cleanupMaxAgeMs: 30 * 60 * 1000,
  /** TEMPORARY: HUD kill debug reel+json per shooter analyze. Set DEBUG_KILL_EXPORT=0 to disable. */
  debugKillExport: process.env.DEBUG_KILL_EXPORT !== '0',
};

export const MOOD_GUIDANCE = {
  hype:
    'High energy: surprises, bold claims, conflict, laughs, twists, "wow" moments. Fast pacing. Skip slow setup or monotone stretches.',
  chill:
    'Calm but captivating: clever ideas, satisfying payoffs, interesting takes. Never boring — avoid filler and long intros.',
  emotional:
    'Story peaks: vulnerability, tension, heartfelt turns, revelations. Moments that hit emotionally.',
};

export function buildHighlightSystemPrompt(mood = 'hype', options = {}) {
  const moodKey = MOOD_GUIDANCE[mood] ? mood : 'hype';
  const moodLine = MOOD_GUIDANCE[moodKey];
  const legacy = options.legacyTimestamps === true;
  const lang = options.outputLanguage === 'de' ? 'de' : 'en';
  const langRule =
    lang === 'de'
      ? 'Write title and reason in German (Deutsch).'
      : 'Write title and reason in English.';

  if (legacy) {
    return `You are an elite short-form video editor picking clips that stop the scroll.

Mood (${moodKey}) is only a soft tie-breaker: ${moodLine}

Selection rubric:
1. PAYOFF: Clear peak inside the window.
2. LENGTH: 12–45 seconds.
3. STANDALONE: Viewer understands without prior context.
4. AVOID: intros, outros, sponsor reads, dead air.

Return ONLY a JSON array. Each object:
- start_time, end_time (seconds)
- title (max 6 words)
- platform_fit: ["shorts","tiktok","reels"]
- viral_score: 6-10
- reason: one sentence
- zoom_moments: 1-3 absolute seconds at peaks
- caption_style: "bold" | "minimal" | "fire"

${langRule}

Rules: valid JSON only; no markdown.`;
  }

  return `You are an elite short-form video editor ranking pre-scored clip candidates.

Candidates are numbered #1–#12 with fixed start/end times, setup/peak/tail lines, and local scores (L:).
Cold-open hooks are assigned locally — judge clip BODY (setup→payoff after replay), NOT scroll-stop pacing.
Mood (${moodKey}) is tie-breaker only: ${moodLine}

Selection rubric (every pick MUST pass):
1. PAYOFF: Clear peak (joke, reveal, shock, argument, emotional beat) in the window.
2. STANDALONE: Viewer understands without prior context — use setup/peak/tail lines.
3. AVOID: intros, outros, "subscribe", sponsor reads, weak-tail arcs, filler, long lore monologues (lore-risk flag).
4. SPREAD: Pick 5 clips across the timeline — not all from the same minute.

You MUST pick ONLY from numbered candidates via candidate_id (integer 1–12).
Do NOT invent start_time or end_time. Do NOT output hook text.

Return ONLY a JSON array of exactly 5 objects:
- candidate_id (integer, required — matches #N in the list)
- title (max 6 words)
- platform_fit: ["shorts","tiktok","reels"]
- viral_score: 6-10 (8+ only for truly gripping moments)
- reason: one sentence why this hooks viewers
- caption_style: "bold" | "minimal" | "fire"

${langRule}

Rules: valid JSON only; double-quoted strings; escape quotes as \\"; no markdown.`;
}
