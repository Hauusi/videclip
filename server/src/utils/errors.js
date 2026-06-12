import { config } from '../config.js';

export class AppError extends Error {
  constructor(message, statusCode = 400, code = 'APP_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function friendlyError(err) {
  const msg = err?.message || String(err);
  if (
    msg.includes('ANTHROPIC_API_KEY') ||
    /authentication_error|invalid x-api-key/i.test(msg)
  ) {
    return 'Invalid or missing Anthropic API key. Set ANTHROPIC_API_KEY in server/.env (from console.anthropic.com)';
  }
  if (/not_found_error|Claude model.*not found/i.test(msg)) {
    return msg.includes('CLAUDE_MODEL') ? msg : 'Claude model not found. Set CLAUDE_MODEL=claude-sonnet-4-6 in server/.env';
  }
  if (/invalid JSON|JSON at position/i.test(msg)) {
    return 'AI returned malformed JSON. Please try Analyze again.';
  }
  if (/ffmpeg.*not found|ffmpeg-static/i.test(msg)) {
    return 'FFmpeg not available. Run npm install in the server folder.';
  }
  if (msg.includes('cookies expired') || msg.includes('cookies.txt not found at:')) {
    return msg;
  }
  if (msg.startsWith('Video download failed:') || msg.includes('Piped API')) {
    const detail = msg.replace(/^Video download failed:\s*/i, '').trim();
    return detail.length > 220 ? `${detail.slice(0, 220)}…` : detail || 'Video download failed.';
  }
  if (msg.includes('Transcript is disabled') || msg.includes('No transcript')) {
    return 'No captions available for this video. Try another URL.';
  }
  if (msg.includes('Video unavailable') || msg.includes('Private video')) {
    return 'Video unavailable or private. Check the URL.';
  }
  if (msg.includes('Invalid YouTube')) {
    return 'Invalid YouTube URL. Use a standard watch or youtu.be link.';
  }
  if (msg.startsWith('FFmpeg processing failed:')) {
    return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
  }
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}
