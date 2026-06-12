/** PiP height as % of a 9:16 frame (width% × content aspect on 9-wide × 16-tall grid). */
export function pipHeightPercent916(sizePercent, contentAspect) {
  const aspect = Math.max(0.35, Number(contentAspect) || 1);
  const wFrac = sizePercent / 100;
  const pipWidthOnGrid = wFrac * 9;
  const pipHeightOnGrid = pipWidthOnGrid / aspect;
  return (pipHeightOnGrid / 16) * 100;
}

/** @deprecated webcam-only heuristic; use pipHeightPercent916 for wide UI */
export function pipHeightPercentWebcam(sizePercent, cropW, cropH) {
  return sizePercent * (cropW / cropH) * (9 / 16);
}

export function defaultWidePipSettings(selection) {
  const cropW = selection?.width || 1920;
  const cropH = selection?.height || 1080;
  const aspect = cropW / cropH;
  const sizePercent = 88;
  const heightPct = pipHeightPercent916(sizePercent, aspect);
  return {
    x_percent: Math.max(0, Math.round((100 - sizePercent) / 2)),
    y_percent: Math.max(0, Math.round((100 - heightPct) / 2)),
    size_percent: sizePercent,
    border: 'black',
    opacity: 100,
    shape: 'rectangle',
  };
}
