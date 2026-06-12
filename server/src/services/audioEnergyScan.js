import { spawn } from 'child_process';
import path from 'path';
import { ffmpegPath } from '../lib/ffmpeg.js';

const SAMPLE_RATE = 8000;
const BUCKET_SEC = 0.5;
const SAMPLES_PER_BUCKET = Math.round(SAMPLE_RATE * BUCKET_SEC);
const BASELINE_HALF_BUCKETS = 60; // ±30s rolling baseline

/**
 * One-pass loudness scan over the whole video (mono 8kHz PCM, RMS per 0.5s).
 * This is the source of truth for "real moment" detection: screams, laughs,
 * and hype reactions show up as loudness spikes vs. the local baseline,
 * regardless of caption quality.
 *
 * @returns {Promise<{bucketSec:number, length:number, db:Float32Array, delta:Float32Array, durationSec:number}>}
 */
export function scanAudioEnergy(sourceVideo) {
  const bin = path.resolve(ffmpegPath);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    sourceVideo,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE),
    '-f',
    's16le',
    'pipe:1',
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    const buckets = [];
    let sumSq = 0;
    let count = 0;
    let leftover = null;
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const buf = leftover ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);

      for (let i = 0; i < usable; i += 2) {
        const s = buf.readInt16LE(i) / 32768;
        sumSq += s * s;
        count += 1;
        if (count >= SAMPLES_PER_BUCKET) {
          const rms = Math.sqrt(sumSq / count);
          buckets.push(rms > 1e-5 ? 20 * Math.log10(rms) : -100);
          sumSq = 0;
          count = 0;
        }
      }
      leftover = usable < buf.length ? Buffer.from(buf.subarray(usable)) : null;
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', reject);
    proc.on('close', () => {
      if (count >= SAMPLES_PER_BUCKET / 4) {
        const rms = Math.sqrt(sumSq / count);
        buckets.push(rms > 1e-5 ? 20 * Math.log10(rms) : -100);
      }
      if (buckets.length < 4) {
        reject(new Error(`Audio scan produced no data: ${stderr.slice(0, 160)}`));
        return;
      }
      resolve(buildScan(buckets));
    });
  });
}

/** Smooth + compute per-bucket delta vs. rolling local baseline. */
function buildScan(rawDb) {
  const n = rawDb.length;
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = rawDb[Math.max(0, i - 1)];
    const b = rawDb[i];
    const c = rawDb[Math.min(n - 1, i + 1)];
    db[i] = (a + b + c) / 3;
  }

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + db[i];

  const delta = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - BASELINE_HALF_BUCKETS);
    const hi = Math.min(n - 1, i + BASELINE_HALF_BUCKETS);
    const localAvg = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    delta[i] = db[i] - localAvg;
  }

  return {
    bucketSec: BUCKET_SEC,
    length: n,
    db,
    delta,
    durationSec: n * BUCKET_SEC,
  };
}

function bucketIndex(scan, timeSec) {
  return Math.max(0, Math.min(scan.length - 1, Math.floor(timeSec / scan.bucketSec)));
}

/**
 * Loudness spikes vs. local baseline — these are the "real moments".
 * @returns {Array<{time:number, strength:number}>} strength = dB above baseline
 */
export function findAudioPeaks(scan, { minDeltaDb = 5, minSpacingSec = 25, maxPeaks = 40 } = {}) {
  if (!scan?.length) return [];
  const { delta, bucketSec } = scan;
  const raw = [];

  for (let i = 2; i < scan.length - 2; i++) {
    const d = delta[i];
    if (d < minDeltaDb) continue;
    if (d >= delta[i - 1] && d >= delta[i + 1] && d >= delta[i - 2] && d >= delta[i + 2]) {
      raw.push({ time: i * bucketSec, strength: d });
    }
  }

  raw.sort((a, b) => b.strength - a.strength);

  const picked = [];
  for (const p of raw) {
    if (picked.length >= maxPeaks) break;
    if (picked.some((q) => Math.abs(q.time - p.time) < minSpacingSec)) continue;
    picked.push(p);
  }

  return picked.sort((a, b) => a.time - b.time);
}

/**
 * Audio stats for a clip window (cheap, in-memory).
 * @returns {{maxDelta:number, avgDelta:number, peakTime:number}}
 */
export function windowAudioStats(scan, startSec, endSec) {
  if (!scan?.length) return { maxDelta: 0, avgDelta: 0, peakTime: startSec };

  const lo = bucketIndex(scan, startSec);
  const hi = bucketIndex(scan, endSec);
  let maxDelta = -Infinity;
  let sum = 0;
  let peakIdx = lo;

  for (let i = lo; i <= hi; i++) {
    const d = scan.delta[i];
    sum += d;
    if (d > maxDelta) {
      maxDelta = d;
      peakIdx = i;
    }
  }

  const count = hi - lo + 1;
  return {
    maxDelta: Number.isFinite(maxDelta) ? maxDelta : 0,
    avgDelta: count > 0 ? sum / count : 0,
    peakTime: peakIdx * scan.bucketSec,
  };
}

/**
 * Window audio contribution for the candidate composite (0–150).
 * Scaled so a real scream/hype spike outweighs mediocre text scores.
 */
export function windowAudioScore(stats, audioWeight = 1) {
  if (!stats) return 0;
  const raw = Math.max(0, stats.maxDelta) * 9 + Math.max(0, stats.avgDelta) * 5;
  return Math.round(Math.min(150, raw * audioWeight));
}
