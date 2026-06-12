import path from 'path';
import { ffmpegPath } from '../lib/ffmpeg.js';
import { runCommand } from './exec.js';
import { scaleAudioBoost } from './gameCategory.js';

const MAX_VOLUME_RE = /max_volume:\s*([-\d.]+)\s*dB/i;
const MEAN_VOLUME_RE = /mean_volume:\s*([-\d.]+)\s*dB/i;
const SILENCE_START_RE = /silence_start:\s*([\d.]+)/gi;
const SILENCE_END_RE = /silence_end:\s*([\d.]+)/gi;

async function runFfmpegAudio(sourceVideo, start, dur, audioFilter) {
  const bin = path.resolve(ffmpegPath);
  const { stderr } = await runCommand(bin, [
    '-hide_banner',
    '-ss',
    String(start),
    '-t',
    String(dur),
    '-i',
    sourceVideo,
    '-af',
    audioFilter,
    '-f',
    'null',
    '-',
  ]);
  return stderr;
}

function parseVolumeStats(stderr) {
  const maxMatch = stderr.match(MAX_VOLUME_RE);
  const meanMatch = stderr.match(MEAN_VOLUME_RE);
  return {
    maxDb: maxMatch ? parseFloat(maxMatch[1]) : -40,
    meanDb: meanMatch ? parseFloat(meanMatch[1]) : -35,
  };
}

/** Measure loudness spikes across sub-chunks (reaction / scream / laugh proxy). */
async function measureVolumeSpikes(sourceVideo, start, dur, chunks = 5) {
  const chunkDur = dur / chunks;
  const peaks = [];

  for (let i = 0; i < chunks; i++) {
    const chunkStart = start + i * chunkDur;
    try {
      const stderr = await runFfmpegAudio(sourceVideo, chunkStart, Math.max(2, chunkDur), 'volumedetect');
      peaks.push(parseVolumeStats(stderr).maxDb);
    } catch {
      peaks.push(-40);
    }
  }

  if (!peaks.length) return { spikeScore: 0, variance: 0, peakMax: -40 };

  const peakMax = Math.max(...peaks);
  const mean = peaks.reduce((a, b) => a + b, 0) / peaks.length;
  const variance = peaks.reduce((s, p) => s + (p - mean) ** 2, 0) / peaks.length;

  const spikeScore = Math.max(0, Math.min(18, variance * 0.35 + Math.max(0, peakMax + 22) * 0.6));

  return { spikeScore, variance, peakMax, peaks };
}

/** Bursty speech (short loud bursts between silence) ≈ stress / scream / laugh. */
async function measureAudioBursts(sourceVideo, start, dur) {
  try {
    const stderr = await runFfmpegAudio(
      sourceVideo,
      start,
      dur,
      'silencedetect=noise=-32dB:d=0.25',
    );

    const silenceStarts = [...stderr.matchAll(SILENCE_START_RE)].map((m) =>
      parseFloat(m[1]),
    );
    const silenceEnds = [...stderr.matchAll(SILENCE_END_RE)].map((m) => parseFloat(m[1]));

    const burstCount = Math.min(silenceStarts.length, silenceEnds.length);
    if (burstCount < 2) return 0;

    let shortBursts = 0;
    for (let i = 0; i < burstCount; i++) {
      const burstLen = (silenceStarts[i] || dur) - (silenceEnds[i - 1] || 0);
      if (burstLen > 0.2 && burstLen < 2.5) shortBursts += 1;
    }

    return Math.min(10, shortBursts * 2.5);
  } catch {
    return 0;
  }
}

/**
 * Multi-signal audio emotion score (0–45).
 * Volume spikes, energy, burst patterns — separates lore talk from real moments.
 */
export async function measureWindowAudio(sourceVideo, startSec, durationSec, { lite = false } = {}) {
  if (!sourceVideo) {
    return { total: 0, peakBoost: 0, energyBoost: 0, spikeBoost: 0, burstBoost: 0 };
  }

  const start = Math.max(0, Number(startSec) || 0);
  const dur = Math.min(45, Math.max(4, Number(durationSec) || 12));

  try {
    const baseStderr = await runFfmpegAudio(sourceVideo, start, dur, 'volumedetect');
    const { maxDb, meanDb } = parseVolumeStats(baseStderr);
    const peakBoost = Math.max(0, Math.min(16, (maxDb + 28) * 0.9));
    const energyBoost = Math.max(0, Math.min(8, (meanDb + 32) * 0.45));

    if (lite) {
      const total = Math.round(Math.min(24, peakBoost + energyBoost));
      return { total, peakBoost, energyBoost, spikeBoost: 0, burstBoost: 0 };
    }

    const [spikes, burstBoost] = await Promise.all([
      measureVolumeSpikes(sourceVideo, start, dur, 3),
      measureAudioBursts(sourceVideo, start, dur),
    ]);
    const spikeBoost = Math.round(spikes.spikeScore);
    const total = Math.round(Math.min(45, peakBoost + energyBoost + spikeBoost + burstBoost));

    return { total, peakBoost, energyBoost, spikeBoost, burstBoost };
  } catch (err) {
    console.warn('[audio-score] window measure failed:', err.message?.slice(0, 80));
    return { total: 0, peakBoost: 0, energyBoost: 0, spikeBoost: 0, burstBoost: 0 };
  }
}

/** Legacy single-number boost (backward compatible). */
export async function measureWindowAudioBoost(sourceVideo, startSec, durationSec) {
  const result = await measureWindowAudio(sourceVideo, startSec, durationSec);
  return result.total;
}

/**
 * Enrich top candidates with audio + optional visual multi-signal boosts.
 */
export async function boostCandidatesWithMultiSignal(candidates, sourceVideo, options = {}) {
  if (!sourceVideo || !candidates?.length) return candidates;

  const limit = options.limit ?? 15;
  const includeVisual = options.includeVisual !== false;
  const liteAudio = options.liteAudio === true;
  // skipAudio: audio already baked into composite via full-video energy scan
  const skipAudio = options.skipAudio === true;
  const categoryProfile = options.categoryProfile || null;
  const slice = candidates.slice(0, limit);

  const measureWindowVisualEvents = includeVisual
    ? (await import('./candidateVisualScore.js')).measureWindowVisualEvents
    : null;

  const enriched = await Promise.all(
    slice.map(async (c) => {
      const dur = c.end_time - c.start_time;
      const audio = skipAudio
        ? { total: 0, spikeBoost: 0, burstBoost: 0 }
        : await measureWindowAudio(sourceVideo, c.start_time, dur, { lite: liteAudio });
      const visualBoost =
        measureWindowVisualEvents != null
          ? await measureWindowVisualEvents(sourceVideo, c.start_time, dur)
          : 0;

      const audioBoost = skipAudio ? 0 : scaleAudioBoost(audio.total, categoryProfile);
      const signalBoost = audioBoost + (visualBoost || 0);
      const local_score = Math.round((c.local_score || 0) + signalBoost);

      const flags = [...(c.flags || [])];
      if (audio.spikeBoost >= 8) flags.push('audio-spike');
      if (audio.burstBoost >= 5) flags.push('audio-burst');
      if (visualBoost >= 6) flags.push('visual-event');

      return {
        ...c,
        local_score,
        audio_boost: skipAudio ? (c.audio_boost ?? 0) : audioBoost,
        visual_boost: visualBoost || 0,
        signal_scores: {
          audio,
          visual: visualBoost || 0,
          transcript: c.transcript_delta ?? 0,
        },
        flags: [...new Set(flags)],
      };
    }),
  );

  const boostMap = new Map(enriched.map((c) => [c.id, c]));

  const merged = candidates.map((c) => boostMap.get(c.id) || c);
  merged.sort((a, b) => b.local_score - a.local_score);

  const maxScore = merged[0]?.local_score || 1;
  return merged.map((c, i) => ({
    ...c,
    list_index: i + 1,
    confidence: Math.min(99, Math.round((c.local_score / maxScore) * 100)),
  }));
}

/** @deprecated Use boostCandidatesWithMultiSignal */
export async function boostCandidatesWithAudio(candidates, sourceVideo, limit = 15) {
  return boostCandidatesWithMultiSignal(candidates, sourceVideo, { limit });
}

/** Heuristic: gaming / reaction content benefits more from visual scoring weight. */
export function isLikelyGameplayContent(title = '', description = '') {
  const text = `${title} ${description}`.toLowerCase();
  return /\b(game|gameplay|stream|twitch|minecraft|fortnite|valorant|react|horror|jumpscare|let'?s play|gaming|boss|level|speedrun)\b/i.test(
    text,
  );
}
