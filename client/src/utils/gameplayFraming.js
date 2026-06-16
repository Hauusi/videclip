/** Landscape source + 9:16 export → client-side framing preview without re-render. */
export function isGameplayFramingAvailable(aspectRatio, sourceWidth, sourceHeight) {
  if (aspectRatio !== '9:16') return false;
  const w = Number(sourceWidth) || 1920;
  const h = Number(sourceHeight) || 1080;
  return w / h > 1.25;
}

export function isLandscapeVideo(aspect) {
  return Number(aspect) > 1.25;
}

/** Center 9:16 strip from 16:9: video width as % of portrait container (height-filled). */
export const FILL_WIDTH_FROM_LANDSCAPE_PCT = ((16 / 9) / (9 / 16)) * 100;

/** Zoom baked 9:16 overview back to classic center strip. */
export const FILL_ZOOM_FROM_PORTRAIT = (16 / 9) / (9 / 16);

/** Zoom pre-rendered blur-letterbox 9:16 back to center 4:3 crop (overview fallback). */
export const CROP_ZOOM_FROM_PORTRAIT = (4 / 3) / (9 / 16);

export const GAMEPLAY_FRAMING_MODES = {
  wide: { id: 'wide', label: 'Wide', hint: '16:9', title: 'Volle 16:9-Breite mit Blur-Rändern' },
  crop: { id: 'crop', label: 'Crop', hint: '4:3', title: 'Zentrierter 4:3-Ausschnitt mit Blur-Rändern' },
  fill: { id: 'fill', label: 'Fill', hint: '9:16', title: 'Klassischer 9:16-Zuschnitt (volle Höhe)' },
};

export function normalizeGameplayFramingMode(raw) {
  if (raw === 'crop' || raw === 'fill') return raw;
  return 'wide';
}

export function getGameplayFramingLabel(mode) {
  return GAMEPLAY_FRAMING_MODES[normalizeGameplayFramingMode(mode)]?.label ?? 'Wide';
}

/** Uncropped landscape clip — required for realtime CSS framing (not baked overview). */
export function resolveRawFramingClipUrl(highlight, jobId) {
  if (highlight?.rawClipUrl) return highlight.rawClipUrl;
  if (highlight?.rawClipPath && jobId) {
    return `/api/files/${jobId}/${String(highlight.rawClipPath).replace(/\\/g, '/')}`;
  }
  return null;
}

/** Raw landscape clip preferred; overview 9:16 as fallback if raw fails to load. */
export function resolveFramingClipSources(highlight, jobId) {
  const rawUrl = resolveRawFramingClipUrl(highlight, jobId);
  const overviewUrl = highlight?.overviewUrl || null;
  return {
    primaryUrl: rawUrl || overviewUrl,
    fallbackUrl: rawUrl && overviewUrl ? overviewUrl : null,
    isRaw: Boolean(rawUrl),
  };
}
