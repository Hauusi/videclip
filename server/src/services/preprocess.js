import {
  normalizeCaptionStyle,
  pickHighlightIndices,
} from './captionKeywords.js';

const FILLERS = /\b(um|uh|like|you know|sort of|kind of|i mean|basically|actually|literally)\b/gi;

export function stripFillers(text) {
  return text.replace(FILLERS, '').replace(/\s+/g, ' ').trim();
}

export function formatTranscriptForAi(segments) {
  const lines = [];
  let bucket = '';
  let bucketStart = 0;
  let lastEmit = -Infinity;

  for (const seg of segments) {
    const clean = stripFillers(seg.text);
    if (!clean) continue;
    bucket += (bucket ? ' ' : '') + clean;
    if (bucketStart === 0 && seg.offset >= 0) bucketStart = seg.offset;

    if (seg.offset - lastEmit >= 5 || seg === segments[segments.length - 1]) {
      const t = Math.floor(bucketStart);
      lines.push(`[${t}s] ${bucket.trim()}`);
      bucket = '';
      bucketStart = seg.offset;
      lastEmit = seg.offset;
    }
  }

  if (bucket.trim()) {
    const t = Math.floor(bucketStart);
    lines.push(`[${t}s] ${bucket.trim()}`);
  }

  return lines.join('\n');
}

export function truncateTranscript(text, maxChars = 6000) {
  if (text.length <= maxChars) return { text, chunked: false };

  const first = text.slice(0, 2000);
  const last = text.slice(-1000);
  const middleBudget = maxChars - first.length - last.length - 20;
  const middleRaw = text.slice(2000, -1000);
  const step = Math.max(1, Math.floor(middleRaw.length / middleBudget));
  let sampled = '';
  for (let i = 0; i < middleRaw.length && sampled.length < middleBudget; i += step) {
    sampled += middleRaw[i];
  }

  return {
    text: `${first}\n...[sampled]...\n${sampled}\n...[sampled]...\n${last}`,
    chunked: text.length > 6000,
    segments: chunkIntoThree(text),
  };
}

function chunkIntoThree(text) {
  const len = text.length;
  const size = Math.ceil(len / 3);
  return [text.slice(0, size), text.slice(size, size * 2), text.slice(size * 2)];
}

export function segmentsForClip(segments, startTime, endTime) {
  return segments.filter((s) => s.offset + s.duration >= startTime && s.offset <= endTime);
}

const SPEAKER_GAP = 1.5;

const SPEAKER_COLORS = [
  '&H00FFFFFF',
  '&H0000FFFF',
  '&H00FF6B6B',
  '&H0000FF00',
  '&H00FF69B4',
  '&H00FFA500',
];

/** Reference positions at 1080x1920 — stacked vertically in center area. */
const REF_SPEAKER_POSITIONS = [
  { x: 540, y: 800 },
  { x: 540, y: 700 },
  { x: 540, y: 900 },
  { x: 540, y: 600 },
  { x: 540, y: 1000 },
  { x: 540, y: 550 },
  { x: 540, y: 1050 },
];

function wordStart(seg) {
  return Number(seg.offset ?? seg.start);
}

function wordEnd(seg) {
  return wordStart(seg) + Number(seg.duration || 0.05);
}

/** Stable speaker ID for a segment (full-video timeline). */
function resolveSpeakerId(seg, prevSeg, state) {
  const groqId = seg.speaker;
  if (groqId != null && groqId !== '') {
    return `groq-${groqId}`;
  }
  if (!prevSeg) {
    return 'speaker-0';
  }
  const gap = wordStart(seg) - wordEnd(prevSeg);
  if (gap > SPEAKER_GAP) {
    state.gapTurn += 1;
    return `gap-${state.gapTurn}`;
  }
  return state.lastSpeakerId;
}

/** Annotate segments with speakerId and build persisted color map (once per video). */
export function buildSpeakerColorMap(segments) {
  const speakerColorMap = {};
  const state = { gapTurn: 0, lastSpeakerId: 'speaker-0' };
  const annotated = [];

  for (let i = 0; i < segments.length; i++) {
    const speakerId = resolveSpeakerId(segments[i], segments[i - 1], state);
    state.lastSpeakerId = speakerId;

    if (!speakerColorMap[speakerId]) {
      speakerColorMap[speakerId] =
        SPEAKER_COLORS[Object.keys(speakerColorMap).length % SPEAKER_COLORS.length];
    }

    annotated.push({ ...segments[i], speakerId });
  }

  return { speakerColorMap, segments: annotated };
}

export function getSpeakerColor(speakerColorMap, speakerId) {
  if (speakerColorMap[speakerId]) {
    return speakerColorMap[speakerId];
  }
  return SPEAKER_COLORS[0];
}

const CAPTION_MIN_GAP = 0.05;
const CAPTION_MIN_DISPLAY = 0.1;
const CAPTION_MAX_DURATION = 1.6;

/** Center caption position (1080×1920 reference). */
const CAPTION_CENTER = { x: 540, y: 800 };

const STYLE_DEFS = {
  bold: {
    name: 'Bold',
    font: 'Arial Black',
    size: 32,
    primary: '&H00FFFFFF',
    outline: '&H00000000',
    bold: 1,
    bord: 3,
    shad: 1,
  },
  minimal: {
    name: 'Minimal',
    font: 'Arial',
    size: 30,
    primary: '&H00FFFFFF',
    outline: '&H00000000',
    bold: 0,
    bord: 2,
    shad: 2,
  },
  fire: {
    name: 'Fire',
    font: 'Arial Black',
    size: 34,
    primary: '&H0000D7FF',
    outline: '&H000000FF',
    bold: 1,
    bord: 4,
    shad: 2,
  },
};

/**
 * Word-level display timing: Whisper start times stay fixed; only trim overlaps
 * and apply a short minimum visibility window (no phrase grouping).
 */
export function resolveCaptionTimings(words) {
  if (!words.length) return [];

  const entries = words.map((w) => ({ ...w })).sort((a, b) => a.start - b.start || a.end - b.end);

  for (let k = 0; k < entries.length; k++) {
    const nextStart = k < entries.length - 1 ? entries[k + 1].start : Infinity;

    if (k > 0 && entries[k].start < entries[k - 1].end - 0.001) {
      entries[k - 1].end = Math.max(
        entries[k - 1].start + 0.05,
        entries[k].start - CAPTION_MIN_GAP,
      );
    }

    entries[k].end = Math.max(entries[k].end, entries[k].start + CAPTION_MIN_DISPLAY);

    if (nextStart < Infinity) {
      entries[k].end = Math.min(entries[k].end, nextStart - CAPTION_MIN_GAP);
    }

    if (entries[k].end - entries[k].start > CAPTION_MAX_DURATION) {
      entries[k].end = entries[k].start + CAPTION_MAX_DURATION;
    }

    if (entries[k].end <= entries[k].start) {
      entries[k].end = entries[k].start + CAPTION_MIN_DISPLAY;
    }
  }

  return entries;
}

export function logCaptionSyncDiagnostics(clipId, words) {
  if (!words?.length) {
    console.warn(`[captions] ${clipId}: no caption words`);
    return;
  }
  let overlaps = 0;
  for (let i = 1; i < words.length; i++) {
    if (words[i].start < words[i - 1].end - 0.01) overlaps += 1;
  }
  const inFirst2s = words.filter((w) => w.start < 2).length;
  console.log(
    `[captions] ${clipId} sync: first@${words[0].start.toFixed(2)}s ` +
      `words_0-2s=${inFirst2s} overlaps=${overlaps} total=${words.length}`,
  );
}

/** @deprecated Speaker colors disabled — single white style. */
export function assignSpeakersByGap(words) {
  return words.map((w) => ({ ...w, speakerId: 'speaker-0', speakerIndex: 0 }));
}

/** @deprecated Speaker colors disabled. */
export function buildClipSpeakerColorMap() {
  return { 'speaker-0': '&H00FFFFFF' };
}

/** @deprecated Use word-by-word captions only. */
export function groupWordsIntoPhrases(words) {
  return words;
}

/** @deprecated */
export function alignColdOpenCaptionTimings(words) {
  return words;
}

function getCaptionPosition(resX, resY) {
  return {
    x: Math.round((CAPTION_CENTER.x / 1080) * resX),
    y: Math.round((CAPTION_CENTER.y / 1920) * resY),
  };
}

function escapeAssText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\n/g, ' ');
}

function formatAssTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.min(99, Math.floor((sec % 1) * 100));
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function buildCaptionStylesHeader(styleKey, resX) {
  const scale = Math.max(0.85, Math.min(1.15, resX / 1080));
  const lines = ['Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, Outline, Shadow, Alignment, MarginV'];

  for (const [key, def] of Object.entries(STYLE_DEFS)) {
    const size = Math.round(def.size * scale);
    lines.push(
      `Style: ${def.name},${def.font},${size},${def.primary},${def.outline},${def.bold},${def.bord},${def.shad},5,0`,
    );
  }

  return lines.join('\n');
}

function styleAssName(styleKey) {
  return STYLE_DEFS[normalizeCaptionStyle(styleKey)]?.name || 'Bold';
}

/** Per-word caption with style + optional keyword emphasis. */
function formatWordCaption(text, durationSec, resX, resY, styleKey, highlighted) {
  const escaped = escapeAssText(text);
  const { x, y } = getCaptionPosition(resX, resY);
  const style = normalizeCaptionStyle(styleKey);
  const durationMs = Math.max(50, durationSec * 1000);

  if (style === 'minimal') {
    const fade = `{\\an5\\pos(${x},${y})\\fad(40,35)`;
    const emph = highlighted ? '\\b1\\fscx108\\fscy108' : '';
    return `${fade}${emph}}${escaped}`;
  }

  if (style === 'fire') {
    const popMs = Math.min(140, Math.floor(durationMs * 0.5));
    const base = `{\\an5\\pos(${x},${y})\\blur0.3\\fscx122\\fscy122\\t(0,${popMs},\\fscx100\\fscy100)`;
    const emph = highlighted ? '\\c&H00FFFFFF&\\fscx135\\fscy135\\bord5' : '';
    return `${base}${emph}}${escaped}`;
  }

  const popMs = Math.min(120, Math.floor(durationMs * 0.45));
  const base = `{\\an5\\pos(${x},${y})\\fscx118\\fscy118\\t(0,${popMs},\\fscx100\\fscy100)`;
  const emph = highlighted ? '\\fscx130\\fscy130\\1c&H00FFFF&' : '';
  return `${base}${emph}}${escaped}`;
}

/**
 * One word per dialogue line (karaoke-style).
 * @param {object} [options]
 * @param {string} [options.style] bold | minimal | fire
 * @param {boolean} [options.highlightKeywords]
 */
export function buildAssSubtitles(words, playResX, playResY, options = {}) {
  const resX = Math.max(2, playResX || 1080);
  const resY = Math.max(2, playResY || 1920);
  const styleKey = normalizeCaptionStyle(options.style);
  const assStyle = styleAssName(styleKey);
  const highlights = pickHighlightIndices(words, {
    enabled: options.highlightKeywords !== false,
  });

  let ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${resX}
PlayResY: ${resY}

[V4+ Styles]
${buildCaptionStylesHeader(styleKey, resX)}

[Events]
Format: Layer, Start, End, Style, Text
`;

  words.forEach((word, index) => {
    const { start, end, text } = word;
    if (!text || end <= start) return;

    const line = formatWordCaption(
      text,
      end - start,
      resX,
      resY,
      styleKey,
      highlights.has(index),
    );
    ass += `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},${assStyle},${line}\n`;
  });

  return ass;
}

function wrapHookLines(text, maxChars = 18) {
  const words = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (!words.length) return ['Wait for this…'];

  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 2);
}

/**
 * Short-form hook overlay: bold stroke text, no box, max 2 lines.
 */
export function buildHookAssSubtitles(rawText, playResX, playResY, hookEndSec) {
  const resX = Math.max(2, playResX || 1080);
  const resY = Math.max(2, playResY || 1920);
  const maxChars = Math.max(12, Math.min(20, Math.floor(resX / 52)));
  const lines = wrapHookLines(rawText, maxChars);
  const text = lines.map((l) => escapeAssText(l)).join('\\N');
  const fontSize = Math.max(30, Math.min(42, Math.floor(resX / 30)));
  const marginV = Math.round(resY * 0.34);
  const end = Math.max(0.5, Number(hookEndSec) || 2);
  const cx = Math.round(resX / 2);
  const cy = Math.round(resY - marginV);

  const tags = `{\\an5\\pos(${cx},${cy})\\fad(100,80)\\fscx108\\fscy108\\t(0,90,\\fscx100\\fscy100)\\bord6\\shad3\\blur0.4\\fsp1\\1a&H40}`;

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${resX}
PlayResY: ${resY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,Arial Black,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,5,24,24,80,1

[Events]
Format: Layer, Start, End, Style, Text
Dialogue: 0,${formatAssTime(0)},${formatAssTime(end)},Hook,${tags}${text}
`;
}
