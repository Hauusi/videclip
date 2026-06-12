import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { runCommand } from './exec.js';
import { buildWebcamPipVideoGraph, isWebcamPipEnabled } from './webcamPip.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'wide_content_detect.py');

const UI_KEYWORD_RE =
  /\b(buch|bücher|handbuch|menu|menü|inventar|karte|map|screen|screenshot|liest|lesen|reading|journal|tagebuch|ui|interface)\b/i;

function even(n) {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

const WIDE_PIP_BORDER_PX = 3;

function widePipBorderPx(border) {
  if (!border || border === 'none') return 0;
  return WIDE_PIP_BORDER_PX;
}

function pipHeightPercent916(sizePercent, contentAspect) {
  const aspect = Math.max(0.35, Number(contentAspect) || 1);
  const wFrac = sizePercent / 100;
  return ((wFrac * 9) / aspect / 16) * 100;
}

/** PiP-style layout on the 9:16 frame (like webcam). */
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

export function computeWideOverlayLayout(wideMoment, mainW, mainH) {
  const { bbox_w, bbox_h, pip } = wideMoment;
  const p = { ...defaultWidePipSettings({ width: bbox_w, height: bbox_h }), ...pip };
  const contentAspect = bbox_w / Math.max(1, bbox_h);
  const sizeRatio = clamp(p.size_percent / 100, 0.35, 0.96);
  const borderPx = widePipBorderPx(p.border);

  const totalW = even(Math.floor(mainW * sizeRatio));
  const contentW = borderPx > 0 ? even(Math.max(2, totalW - borderPx * 2)) : totalW;
  const contentH = even(Math.floor(contentW / contentAspect));
  const totalH = borderPx > 0 ? contentH + borderPx * 2 : contentH;

  const overlayX = clamp(
    Math.round(mainW * (p.x_percent / 100)),
    0,
    Math.max(0, mainW - totalW),
  );
  const overlayY = clamp(
    Math.round(mainH * (p.y_percent / 100)),
    0,
    Math.max(0, mainH - totalH),
  );

  return {
    contentW,
    contentH,
    totalW,
    totalH,
    overlayX,
    overlayY,
    borderPx: widePipBorderPx(p.border),
    pip: p,
  };
}

function buildWideOverlayVideoStep(bbox_x, bbox_y, bbox_w, bbox_h, layout) {
  const { contentW, contentH, borderPx, pip } = layout;
  let chain = `[0:v]crop=${bbox_w}:${bbox_h}:${bbox_x}:${bbox_y},scale=${contentW}:${contentH}`;
  if (borderPx > 0) {
    const color = pip.border === 'white' ? 'white' : 'black';
    chain += `,pad=iw+${borderPx * 2}:ih+${borderPx * 2}:${borderPx}:${borderPx}:${color}`;
  }
  return `${chain}[wide]`;
}

export function isWideOverlayActive(wideMoment) {
  return Boolean(
    wideMoment?.ok &&
      wideMoment?.wide &&
      wideMoment.bbox_w > 0 &&
      wideMoment.bbox_h > 0 &&
      wideMoment.end_time > wideMoment.start_time,
  );
}

function transcriptBoostsWide(transcriptSegments, duration) {
  if (!transcriptSegments?.length) return false;
  for (const seg of transcriptSegments) {
    const t = Number(seg.offset ?? seg.start ?? 0);
    if (t < 0 || t > duration) continue;
    if (UI_KEYWORD_RE.test(String(seg.text || ''))) return true;
  }
  return false;
}

/**
 * Local wide-UI detection (OpenCV, 0 tokens).
 */
export function wideMomentFromManual(manual, duration) {
  const sel = manual?.selection;
  if (!manual?.enabled || !sel?.width || !sel?.height) return null;

  const start = Math.max(0, Number(manual.startOffset) || 0);
  const end = Math.min(duration, Number(manual.endOffset) || duration);
  if (end - start < 0.8) return null;

  return {
    ok: true,
    wide: true,
    manual: true,
    bbox_x: Math.round(sel.x),
    bbox_y: Math.round(sel.y),
    bbox_w: Math.round(sel.width),
    bbox_h: Math.round(sel.height),
    start_time: start,
    end_time: end,
    confidence: 1,
    pip: manual.pip || defaultWidePipSettings(sel),
  };
}

export async function detectWideContent(
  videoPath,
  clipStart,
  duration,
  transcriptSegments = null,
  options = {},
) {
  if (duration < 2) return null;

  try {
    await fs.access(SCRIPT);
    const args = [SCRIPT, videoPath, String(clipStart), String(duration)];
    if (options.fast) args.push('fast');
    const { stdout } = await runCommand(config.pythonPath, args);
    const data = JSON.parse(stdout.trim());
    if (!data?.ok || !data.wide) return null;

    if (transcriptBoostsWide(transcriptSegments, duration)) {
      data.confidence = Math.min(1, (data.confidence || 0.5) + 0.12);
      data.end_time = Math.min(duration, (data.end_time || duration) + 0.8);
    }

    data.pip = data.pip || defaultWidePipSettings({ width: data.bbox_w, height: data.bbox_h });
    console.log(
      `[wide-overlay] detected ${data.start_time}s–${data.end_time}s bbox=${data.bbox_w}x${data.bbox_h} conf=${data.confidence}`,
    );
    return data;
  } catch (err) {
    console.warn('[wide-overlay] detection skipped:', err.message);
    return null;
  }
}

/** Manual region wins; else local auto-detect (0 tokens). */
export async function resolveWideMoment(
  videoPath,
  clipStart,
  duration,
  transcriptSegments,
  { wideOverlay = false, manual = null, fast = false } = {},
) {
  if (wideOverlay !== true) return null;

  const fromManual = wideMomentFromManual(manual, duration);
  if (fromManual) {
    console.log(
      `[wide-overlay] manual ${fromManual.start_time}s–${fromManual.end_time}s bbox=${fromManual.bbox_w}x${fromManual.bbox_h}`,
    );
    return fromManual;
  }

  return detectWideContent(videoPath, clipStart, duration, transcriptSegments, { fast });
}

/** Apply Von/Bis sliders from UI (auto-detect + manual). */
export function applyWideTimeRange(wideMoment, region, duration) {
  if (!wideMoment || !region) return wideMoment;

  const start = Math.max(0, Number(region.startOffset) || 0);
  const end = Math.min(duration, Number(region.endOffset) || duration);
  if (end - start < 0.5) return wideMoment;

  return {
    ...wideMoment,
    start_time: start,
    end_time: end,
  };
}

/**
 * filter_complex for 9:16 + optional wide UI overlay + optional webcam PiP.
 */
export function buildVideoCompositeGraph(mainChain, options) {
  const { wideMoment, webcam, mainOutW, mainOutH } = options;

  const mainW = even(mainOutW);
  const mainH = even(mainOutH);
  const useWide = isWideOverlayActive(wideMoment);
  const usePip = isWebcamPipEnabled(webcam);

  if (!useWide && !usePip) {
    return {
      graph: `[0:v]${mainChain},scale=${mainW}:${mainH}[vout]`,
      videoOutputLabel: 'vout',
    };
  }

  if (useWide && usePip) {
    const { bbox_x, bbox_y, bbox_w, bbox_h, start_time, end_time } = wideMoment;
    const t0 = Math.max(0, Number(start_time) || 0);
    const t1 = Math.max(t0 + 0.4, Number(end_time) || t0 + 2);
    const enableExpr = `enable='between(t\\,${t0}\\,${t1})'`;
    const layout = computeWideOverlayLayout(wideMoment, mainW, mainH);
    const { overlayX, overlayY } = layout;

    const wideGraph = [
      `[0:v]${mainChain},scale=${mainW}:${mainH}[main]`,
      buildWideOverlayVideoStep(bbox_x, bbox_y, bbox_w, bbox_h, layout),
      `[main][wide]overlay=${overlayX}:${overlayY}:${enableExpr}[vwide]`,
    ].join(';');

    const pipGraph = buildWebcamPipVideoGraph(mainChain, webcam, { width: mainW, height: mainH }, {
      baseInputLabel: 'vwide',
    });

    return {
      graph: `${wideGraph};${pipGraph}`,
      videoOutputLabel: 'out',
    };
  }

  if (useWide) {
    const { bbox_x, bbox_y, bbox_w, bbox_h, start_time, end_time } = wideMoment;
    const t0 = Math.max(0, Number(start_time) || 0);
    const t1 = Math.max(t0 + 0.4, Number(end_time) || t0 + 2);
    const enableExpr = `enable='between(t\\,${t0}\\,${t1})'`;
    const layout = computeWideOverlayLayout(wideMoment, mainW, mainH);
    const { overlayX, overlayY } = layout;

    return {
      graph: [
        `[0:v]${mainChain},scale=${mainW}:${mainH}[main]`,
        buildWideOverlayVideoStep(bbox_x, bbox_y, bbox_w, bbox_h, layout),
        `[main][wide]overlay=${overlayX}:${overlayY}:${enableExpr}[vout]`,
      ].join(';'),
      videoOutputLabel: 'vout',
    };
  }

  return {
    graph: buildWebcamPipVideoGraph(mainChain, webcam, { width: mainW, height: mainH }),
    videoOutputLabel: 'out',
  };
}
