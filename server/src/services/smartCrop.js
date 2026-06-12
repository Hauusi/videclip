import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { runCommand } from './exec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'face_crop.py');

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

/** Output dimensions after crop (no scaling). */
export function getCroppedDimensions(videoW, videoH, aspect) {
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
