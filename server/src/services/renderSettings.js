const VALID_ASPECTS = new Set(['9:16', '1:1', '16:9']);
const VALID_CAPTION_STYLES = new Set(['bold', 'minimal', 'fire']);

/**
 * Normalize client render prefs for analyze + export.
 */
export function normalizeRenderSettings(raw = {}, mood = 'hype') {
  const m = mood || 'hype';
  let wideOverlay = 'auto';
  if (raw.wideOverlay === true) wideOverlay = true;
  else if (raw.wideOverlay === false) wideOverlay = false;

  const styleRaw = String(raw.captionStyle || raw.caption_style || 'fire').toLowerCase();

  return {
    aspectRatio: VALID_ASPECTS.has(raw.aspectRatio) ? raw.aspectRatio : '9:16',
    captionStyle: VALID_CAPTION_STYLES.has(styleRaw) ? styleRaw : 'fire',
    music: raw.music !== false,
    musicAuto: raw.musicAuto !== false,
    musicVolume: normalizeMusicVolumeSetting(raw.musicVolume),
    musicTrackId: String(raw.musicTrackId || `${m}-1`),
    customMusicPath: raw.customMusicPath || null,
    captions: raw.captions !== false,
    colorGrade: raw.colorGrade !== false,
    wideOverlay,
  };
}

/** Normalize music volume: 0–100 UI or 0–1 direct. */
export function normalizeMusicVolumeSetting(raw) {
  let v = Number(raw);
  if (!Number.isFinite(v)) return 15;
  if (v <= 1) return Math.round(v * 100);
  return Math.min(40, Math.max(0, Math.round(v)));
}

/** Auto wide overlay for landscape gaming / 16:9 sources. */
export function resolveWideOverlayEnabled(renderSettings, sourceWidth, sourceHeight) {
  const mode = renderSettings?.wideOverlay ?? 'auto';
  if (mode === true) return true;
  if (mode === false) return false;

  const w = Number(sourceWidth) || 1920;
  const h = Number(sourceHeight) || 1080;
  const aspect = renderSettings?.aspectRatio || '9:16';
  return aspect === '9:16' && w / h > 1.25;
}
