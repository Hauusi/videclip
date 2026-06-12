const LEGACY_SIZE_RATIO = { small: 0.25, medium: 0.35, large: 0.45 };

const LEGACY_POSITIONS = {
  'top-left': { x_percent: 3, y_percent: 3 },
  'top-right': { x_percent: 68, y_percent: 3 },
  'bottom-left': { x_percent: 3, y_percent: 75 },
  'bottom-right': { x_percent: 68, y_percent: 75 },
};

export function isWebcamPipEnabled(webcam) {
  const sel = webcam?.selection;
  return Boolean(webcam?.enabled && sel?.width > 0 && sel?.height > 0);
}

function even(n) {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function resolvePipSettings(webcam) {
  const pip = webcam.pip || {};
  const legacy = LEGACY_POSITIONS[webcam.position] || LEGACY_POSITIONS['top-right'];
  const legacySize = (LEGACY_SIZE_RATIO[webcam.size] ?? 0.35) * 100;

  return {
    x_percent: pip.x_percent ?? legacy.x_percent,
    y_percent: pip.y_percent ?? legacy.y_percent,
    size_percent: pip.size_percent ?? legacySize,
    shape: pip.shape ?? webcam.shape ?? 'rectangle',
    border: pip.border ?? 'none',
    opacity: pip.opacity ?? 100,
  };
}

function buildWebcamShapeFilter(w, h, shape) {
  if (shape !== 'circle') {
    return '';
  }
  const r = Math.min(w, h) / 2;
  return `,format=yuva420p,geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='if(lt(hypot(X-${w}/2,Y-${h}/2}),${r}),255,0)'`;
}

function buildBorderFilter(border) {
  if (!border || border === 'none') {
    return '';
  }
  const color = border === 'white' ? 'white' : 'black';
  return `,pad=iw+6:ih+6:3:3:${color}`;
}

function buildOpacityFilter(opacity) {
  const alpha = clamp(opacity / 100, 0.5, 1);
  if (alpha >= 0.99) {
    return '';
  }
  return `,format=yuva420p,colorchannelmixer=aa=${alpha.toFixed(3)}`;
}

/**
 * Webcam PiP filter_complex (no split — two [0:v] branches + overlay).
 * Returns a single graph string ending in [out].
 */
export function buildWebcamPipVideoGraph(mainChain, webcam, mainDimensions, options = {}) {
  const sel = webcam.selection;
  const pip = resolvePipSettings(webcam);
  const baseInputLabel = options.baseInputLabel || null;

  const x = Math.round(sel.x);
  const y = Math.round(sel.y);
  const w = Math.max(2, Math.round(sel.width));
  const h = Math.max(2, Math.round(sel.height));

  const mainW = even(mainDimensions?.width ?? 1080);
  const mainH = even(mainDimensions?.height ?? 1920);

  const sizeRatio = clamp(pip.size_percent / 100, 0.2, 0.6);
  const pipWidth = even(mainW * sizeRatio);
  const pipHeight = even(pipWidth * (h / w));

  let pipX = Math.round(mainW * (pip.x_percent / 100));
  let pipY = Math.round(mainH * (pip.y_percent / 100));
  pipX = clamp(pipX, 0, Math.max(0, mainW - pipWidth));
  pipY = clamp(pipY, 0, Math.max(0, mainH - pipHeight));

  const shapeFilter = buildWebcamShapeFilter(w, h, pip.shape);
  const borderFilter = buildBorderFilter(pip.border);
  const opacityFilter = buildOpacityFilter(pip.opacity);
  const pipPostScale = `${borderFilter}${opacityFilter}`;

  const mainBranch = baseInputLabel
    ? `[${baseInputLabel}]copy[main]`
    : `[0:v]${mainChain},scale=${mainW}:${mainH}[main]`;

  const graph = [
    `[0:v]crop=${w}:${h}:${x}:${y}${shapeFilter},scale=${pipWidth}:${pipHeight}${pipPostScale}[pip]`,
    mainBranch,
    `[main][pip]overlay=${pipX}:${pipY}[out]`,
  ].join(';');

  console.log(
    `[webcam pip] crop ${w}x${h}@${x},${y} → ${pipWidth}x${pipHeight} at ${pipX},${pipY}`,
  );

  return graph;
}
