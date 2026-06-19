import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { runCommand } from './exec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'face_crop.py');

function even(n) {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

export async function detectFaceCrop(videoPath, startTime, duration) {
  try {
    await fs.access(SCRIPT);
    const { stdout } = await runCommand(config.pythonPath, [
      SCRIPT,
      videoPath,
      String(startTime),
      String(duration),
    ]);
    const data = JSON.parse(stdout.trim());
    if (data?.ok && data.crop_w > 0) return data;
  } catch {
    /* OpenCV unavailable — center crop */
  }
  return null;
}

/** Landscape → 9:16: blur letterbox (wide / crop) or classic center strip (fill). */
export function isGameplayBlurLetterbox(videoW, videoH, aspect, gameplayFraming = 'wide') {
  if (gameplayFraming === 'fill') return false;
  return aspect === '9:16' && videoW / videoH > 1.25;
}

/** Final 9:16 canvas pixels (export or preview). */
export function getCanvas916Dimensions(preview) {
  if (preview) return { width: 270, height: 480 };
  return { width: 1080, height: 1920 };
}

/** Output dimensions after crop (no scaling). */
export function getCroppedDimensions(videoW, videoH, aspect, gameplayFraming = 'wide') {
  if (isGameplayBlurLetterbox(videoW, videoH, aspect, gameplayFraming)) {
    const canvas = getCanvas916Dimensions(false);
    return { width: canvas.width, height: canvas.height, blurLetterbox: true };
  }
  if (aspect === '9:16') {
    const cropH = videoH;
    const cropW = Math.min(videoW, Math.floor(videoH * (9 / 16)));
    return { width: cropW, height: cropH };
  }
  if (aspect === '1:1') {
    const size = Math.min(videoW, videoH);
    return { width: size, height: size };
  }
  if (aspect === '16:9') {
    const cropW = videoW;
    const cropH = Math.min(videoH, Math.floor(videoW / (16 / 9)));
    return { width: cropW, height: cropH };
  }
  const cropH = videoH;
  const cropW = Math.min(videoW, Math.floor(videoH * (9 / 16)));
  return { width: cropW, height: cropH };
}

export function buildCropFilter(aspect, videoW, videoH, faceCrop) {
  if (aspect === '9:16') {
    const cropH = videoH;
    const cropW = Math.floor(videoH * (9 / 16));
    let cropX = Math.floor((videoW - cropW) / 2);
    const cropY = 0;

    if (faceCrop?.crop_w) {
      cropX = Math.max(0, Math.min(faceCrop.crop_x, videoW - cropW));
    }

    return `crop=${cropW}:${cropH}:${cropX}:${cropY}`;
  }

  if (aspect === '1:1') {
    const size = Math.min(videoW, videoH);
    const cropX = Math.floor((videoW - size) / 2);
    const cropY = Math.floor((videoH - size) / 2);
    return `crop=${size}:${size}:${cropX}:${cropY}`;
  }

  if (aspect === '16:9') {
    const cropW = videoW;
    const cropH = Math.floor(videoW / (16 / 9));
    const cropY = Math.floor((videoH - cropH) / 2);
    return `crop=${cropW}:${cropH}:0:${cropY}`;
  }

  const cropH = videoH;
  const cropW = Math.floor(videoH * (9 / 16));
  const cropX = Math.floor((videoW - cropW) / 2);
  return `crop=${cropW}:${cropH}:${cropX}:0`;
}

/**
 * 9:16 from landscape: gameplay centered, blurred video fill top/bottom.
 * @param {'wide'|'crop'|'fill'} gameplayFraming — wide: full 16:9; crop: center 4:3; fill: classic 9:16 strip
 * @returns {{ graph: string, videoOutputLabel: string }}
 */
export function buildBlurLetterboxGraph(
  baseChain,
  videoW,
  videoH,
  canvasW,
  canvasH,
  gameplayFraming = 'wide',
) {
  const cw = even(canvasW);
  const ch = even(canvasH);
  const chain = baseChain || 'copy';
  const fgW = cw;
  let fgSourceChain = chain;
  let fgH;

  if (gameplayFraming === 'crop') {
    const cropH = even(videoH);
    const cropW = even(Math.min(videoW, Math.floor(videoH * (4 / 3))));
    const cropX = even(Math.floor((videoW - cropW) / 2));
    fgSourceChain = `${chain},crop=${cropW}:${cropH}:${cropX}:0`;
    fgH = even(Math.round((fgW * 3) / 4));
  } else {
    fgH = even(Math.round((fgW * videoH) / videoW));
  }

  const fgX = even(Math.floor((cw - fgW) / 2));
  const fgY = even(Math.floor((ch - fgH) / 2));

  const bgChain = [
    `[0:v]${chain}`,
    `scale=${cw}:${ch}:force_original_aspect_ratio=increase`,
    `crop=${cw}:${ch}`,
    'boxblur=lr=24:cr=12:lp=2:cp=2',
    'eq=brightness=-0.06:saturation=0.88',
  ].join(',');

  const bg = `${bgChain}[bg]`;
  const fg = `[0:v]${fgSourceChain},scale=${fgW}:-2[fg]`;
  const composite = `[bg][fg]overlay=${fgX}:${fgY}[vout]`;

  return {
    graph: `${bg};${fg};${composite}`,
    videoOutputLabel: 'vout',
  };
}
