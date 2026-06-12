import path from 'path';
import fs from 'fs/promises';
import { config } from '../config.js';

const MOODS = ['hype', 'chill', 'emotional'];
const TRACKS = ['track1.mp3', 'track2.mp3', 'track3.mp3'];
const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|aac)$/i;

/** List audio files in a mood folder (any filename). */
export async function listMusicFilesInMood(mood) {
  const m = MOODS.includes(mood) ? mood : 'hype';
  const dir = path.join(config.assetsRoot, 'music', m);
  try {
    const names = await fs.readdir(dir);
    return names
      .filter((name) => AUDIO_EXT.test(name))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** Track roles for auto-pick (royalty-free presets in assets/music/). */
const TRACK_ROLE = {
  hype: [
    { file: 'track1.mp3', label: 'energetic', minViral: 7 },
    { file: 'track2.mp3', label: 'mid', minViral: 0 },
    { file: 'track3.mp3', label: 'punchy', minViral: 8 },
  ],
  chill: [
    { file: 'track1.mp3', label: 'soft', minViral: 0 },
    { file: 'track2.mp3', label: 'groove', minViral: 5 },
    { file: 'track3.mp3', label: 'ambient', minViral: 0 },
  ],
  emotional: [
    { file: 'track1.mp3', label: 'piano', minViral: 0 },
    { file: 'track2.mp3', label: 'build', minViral: 6 },
    { file: 'track3.mp3', label: 'cinematic', minViral: 8 },
  ],
};

export async function listPresetTracks() {
  const presets = {};
  for (const mood of MOODS) {
    const files = await listMusicFilesInMood(mood);
    if (files.length) {
      presets[mood] = files.map((full, i) => ({
        id: `${mood}-${i + 1}`,
        name: path.basename(full, path.extname(full)),
        path: `/assets/music/${mood}/${path.basename(full)}`,
        role: TRACK_ROLE[mood]?.[i]?.label || '',
        available: true,
      }));
    } else {
      presets[mood] = TRACKS.map((t, i) => ({
        id: `${mood}-${i + 1}`,
        name: `${mood.charAt(0).toUpperCase() + mood.slice(1)} ${i + 1}`,
        path: `/assets/music/${mood}/${t}`,
        role: TRACK_ROLE[mood]?.[i]?.label || '',
        available: false,
      }));
    }
  }
  return presets;
}

/** UI slider 0–100 or 0–1 → FFmpeg mix level (max 40%). */
export function normalizeMusicVolume(raw) {
  let v = Number(raw);
  if (!Number.isFinite(v)) return 0.15;
  if (v > 1) v = v / 100;
  return Math.min(0.4, Math.max(0, v));
}

function hashId(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) % 9973;
  }
  return h;
}

/**
 * Pick a preset track that fits mood + clip energy (deterministic per highlight).
 */
export function pickMusicTrackId(mood, highlight = {}) {
  const m = MOODS.includes(mood) ? mood : 'hype';
  const roles = TRACK_ROLE[m] || TRACK_ROLE.hype;
  const viral = Number(highlight.viral_score) || 6;
  const id = String(highlight.id || highlight.title || 'clip');

  const eligible = roles.filter((r) => viral >= r.minViral);
  const pool = eligible.length ? eligible : roles;
  const idx = hashId(id) % pool.length;
  const file = pool[idx].file;
  const trackNum = TRACKS.indexOf(file) + 1;
  return `${m}-${trackNum}`;
}

/** Random offset into track so clips don't all start at 0:00. */
export function musicStartOffsetSec(highlight, trackDurationEstimate = 120) {
  const id = String(highlight.id || '');
  const h = hashId(id);
  const maxStart = Math.max(0, trackDurationEstimate - 45);
  return Math.min(maxStart, (h % 1000) / 10);
}

export async function resolveMusicPath(mood, trackId, customPath) {
  if (customPath) {
    try {
      await fs.access(customPath);
      return customPath;
    } catch {
      console.warn('[music] Custom music file not found:', customPath);
      return null;
    }
  }

  if (!trackId) trackId = `${mood || 'hype'}-1`;
  const [mRaw, numRaw] = trackId.includes('-') ? trackId.split('-') : [mood || 'hype', '1'];
  const m = MOODS.includes(mRaw) ? mRaw : mood || 'hype';
  const trackIndex = Math.max(0, (parseInt(numRaw, 10) || 1) - 1);

  const canonical = TRACKS[trackIndex] || TRACKS[0];
  const canonicalPath = path.join(config.assetsRoot, 'music', m, canonical);
  try {
    await fs.access(canonicalPath);
    return canonicalPath;
  } catch {
    /* try any file in folder */
  }

  let files = await listMusicFilesInMood(m);
  if (!files.length && m !== 'hype') {
    files = await listMusicFilesInMood('hype');
  }
  if (!files.length) {
    console.warn(
      `[music] No audio in server/assets/music/${m}/ — add track1.mp3 or any .mp3 file`,
    );
    return null;
  }

  const picked = files[Math.min(trackIndex, files.length - 1)];
  if (picked !== canonicalPath) {
    console.log(`[music] Using ${path.basename(picked)} (${m}, slot ${trackIndex + 1})`);
  }
  return picked;
}

/**
 * Resolve music file for one clip (auto track per highlight unless fixed track requested).
 */
export async function resolveMusicForClip({
  mood = 'hype',
  highlight = {},
  renderSettings = {},
}) {
  if (renderSettings.music === false) return null;

  const useAuto = renderSettings.musicAuto !== false && !renderSettings.customMusicPath;
  const trackId = useAuto
    ? pickMusicTrackId(mood, highlight)
    : renderSettings.musicTrackId || `${mood}-1`;

  const musicPath = await resolveMusicPath(
    mood,
    trackId,
    renderSettings.customMusicPath || null,
  );

  if (!musicPath && renderSettings.music !== false) {
    console.warn(
      `[music] Clip ${highlight.id || '?'}: no track found (mood=${mood}). ` +
        'Place .mp3 files in server/assets/music/<mood>/ and re-run Analyze.',
    );
  } else if (musicPath) {
    console.log(
      `[music] Clip ${highlight.id || '?'}: ${path.basename(musicPath)} (${trackId}, mood=${mood})`,
    );
  }

  return musicPath
    ? {
        path: musicPath,
        trackId,
        volume: normalizeMusicVolume(renderSettings.musicVolume),
        offsetSec: musicStartOffsetSec(highlight),
      }
    : null;
}
