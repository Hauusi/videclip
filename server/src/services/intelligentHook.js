import { stripFillers } from './preprocess.js';
import { scoreLine } from './highlightCandidates.js';
import { clampColdOpenPeakTime, getMinColdOpenPeakOffset } from './coldOpenTiming.js';

const DEFAULT_TEASER_SEC = 2.2;
const MIN_TEASER_SEC = 1.5;
const MAX_TEASER_SEC = 2.8;

const TEASER_BOOST = [
  /\b(oh my god|no way|what the|holy shit|holy|bro|wtf|omg|insane|crazy)\b/i,
  /\b(oh mein gott|auf keinen|krass|wahnsinn|alter|scheiße|wtf|omg)\b/i,
  /\b(laugh|lacht|haha|lol|hilarious)\b/i,
];

const CLIFFHANGER_BOOST = [
  /\b(wait until|but then|what happens|you won't believe|and then)\b/i,
  /\b(warte bis|und dann|was passiert|glaub mir|stell dir vor)\b/i,
  /\b(secret|truth|reveal|geheim|wahrheit|enthüll)\b/i,
];

function segStart(seg) {
  return Number(seg.offset ?? seg.start ?? 0);
}

function segDuration(seg) {
  return Number(seg.duration || 0.5);
}

function segmentsInRange(segments, start, end) {
  if (!segments?.length) return [];
  const out = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const t = segStart(seg);
    if (t < start || t > end) continue;
    const prev = segments[i - 1];
    const prevEnd = prev ? segStart(prev) + segDuration(prev) : t;
    const gap = Math.max(0, t - prevEnd);
    out.push({ seg, t, gap, index: i });
  }
  return out;
}

/** Best moment to show in the cold-open video teaser (impact / reaction / payoff). */
export function scoreTeaserMoment(text, gapBefore, positionRatio) {
  let score = scoreLine(text, gapBefore);
  const clean = stripFillers(text);
  const words = clean.split(/\s+/).filter(Boolean);

  if (words.length >= 4 && words.length <= 16) score += 5;
  if (words.length <= 2) score -= 4;

  for (const re of TEASER_BOOST) {
    if (re.test(clean)) score += 9;
  }
  if (/!/.test(clean)) score += 4;

  if (positionRatio >= 0.45 && positionRatio <= 0.88) score += 6;
  if (positionRatio >= 0.35 && positionRatio < 0.45) score += 1;
  if (positionRatio < 0.35) score -= 18;
  if (positionRatio < 0.12) score -= 8;
  if (positionRatio > 0.95) score -= 5;

  return score;
}

/** Line that teases without spoiling — ideally before the teaser peak. */
const DANGLING_END_RE =
  /(?:^|\s)(sonst|und|oder|aber|weil|dass|wenn|ich|er|sie|es|dem|den|der|can|will|würde|muss|kann|bin|ist|have|can|will|would)\s*$/i;

/** Cliffhanger must read as a complete tease, not a cut-off transcript fragment. */
export function isValidCliffhangerText(text) {
  const clean = stripFillers(String(text || ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || clean.length < 10) return false;

  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < 4 || words.length > 18) return false;
  if (DANGLING_END_RE.test(clean)) return false;
  if (/[,;:]\s*$/.test(clean) && !/[?!…]\s*$/.test(clean)) return false;

  if (/[?!…]\s*$/.test(clean)) return true;
  if (/!$/.test(clean) && words.length >= 4) return true;
  if (words.length >= 7 && /\.\s*$/.test(clean)) return true;
  if (/^(was|wie|warum|wieso|what|how|why|wait|warte)\b/i.test(clean) && words.length >= 5) {
    return true;
  }

  return false;
}

export function scoreCliffhangerMoment(text, gapBefore, positionRatio, teaserTime, segTime) {
  if (!isValidCliffhangerText(text)) return -999;

  let score = scoreLine(text, gapBefore) * 0.55;
  const clean = stripFillers(text);
  const words = clean.split(/\s+/).filter(Boolean);

  if (/\?\s*$/.test(clean)) score += 14;
  if (/\.\.\.|…/.test(clean)) score += 9;
  if (/!$/.test(clean) && words.length <= 10) score += 3;

  for (const re of CLIFFHANGER_BOOST) {
    if (re.test(clean)) score += 11;
  }

  if (Number.isFinite(teaserTime) && Number.isFinite(segTime)) {
    const delta = teaserTime - segTime;
    if (delta >= 2 && delta <= 25) score += 8;
    if (segTime > teaserTime + 1) score -= 12;
  }

  if (positionRatio < 0.7) score += 5;
  if (positionRatio > 0.85) score -= 6;

  if (words.length >= 5 && words.length <= 12) score += 6;
  if (words.length > 16) score -= 10;

  return score;
}

export function formatCliffhangerText(text, maxLen = 72) {
  let clean = stripFillers(String(text || '')).replace(/\s+/g, ' ').trim();
  if (!clean) return '';

  if (!/[?!…]$/.test(clean) && !/\.$/.test(clean)) {
    clean = `${clean}…`;
  }

  if (clean.length <= maxLen) return isValidCliffhangerText(clean) ? clean : '';

  const cut = clean.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  let trimmed = lastSpace > 24 ? cut.slice(0, lastSpace).trim() : cut.trim();
  if (!/[?!…]$/.test(trimmed)) trimmed += '…';
  return isValidCliffhangerText(trimmed) ? trimmed : '';
}

function buildPhrasesFromRange(inRange, maxWords = 14, maxGapSec = 0.85) {
  const phrases = [];
  if (!inRange.length) return phrases;

  let words = [];
  let phraseStart = inRange[0].t;

  const flush = (endT) => {
    if (words.length < 3) {
      words = [];
      return;
    }
    const text = words.join(' ').trim();
    if (text) {
      phrases.push({ text, t: phraseStart, end: endT });
    }
    words = [];
  };

  for (let i = 0; i < inRange.length; i++) {
    const row = inRange[i];
    const chunk = stripFillers(String(row.seg.text || '')).trim();
    if (!chunk) continue;

    if (!words.length) phraseStart = row.t;

    const prev = inRange[i - 1];
    const gap =
      prev && i > 0
        ? Math.max(0, row.t - (prev.t + segDuration(prev.seg)))
        : row.gap;

    if (words.length && gap > maxGapSec) {
      flush(prev ? prev.t : row.t);
      phraseStart = row.t;
    }

    for (const w of chunk.split(/\s+/).filter(Boolean)) {
      words.push(w);
      if (words.length >= maxWords) {
        flush(row.t);
        phraseStart = row.t;
        break;
      }
    }
  }

  if (words.length >= 3) {
    flush(inRange[inRange.length - 1].t);
  }

  return phrases;
}

function cliffhangerFromTitle(title) {
  const t = stripFillers(String(title || '')).replace(/\s+/g, ' ').trim();
  if (!t || /^top moment$/i.test(t) || t.length < 8 || t.length > 60) return '';

  let line = t;
  if (!/[?!…]$/.test(line)) line += '…';
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 3 || DANGLING_END_RE.test(line)) return '';

  return words.length <= 12 ? line : formatCliffhangerText(line, 72) || line;
}

function synthesizeCliffhanger(highlight, teaserLine, inRange, teaserTime) {
  const fromTitle = cliffhangerFromTitle(highlight?.title);
  if (fromTitle) return fromTitle;

  const teaser = stripFillers(teaserLine);
  if (teaser.length >= 12 && isValidCliffhangerText(teaser)) {
    return formatCliffhangerText(teaser, 72);
  }

  return fallbackCliffhanger(inRange, teaserTime, teaserLine);
}

function wordOverlapRatio(a, b) {
  const wa = new Set(
    String(a)
      .toLowerCase()
      .replace(/[^\wäöüß\s]/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
  const wb = String(b)
    .toLowerCase()
    .replace(/[^\wäöüß\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (!wa.size || !wb.length) return 0;
  let hits = 0;
  for (const w of wb) {
    if (wa.has(w)) hits += 1;
  }
  return hits / wb.length;
}

function teaserDurationForLine(text) {
  const words = stripFillers(text).split(/\s+/).filter(Boolean).length;
  if (words <= 5) return MIN_TEASER_SEC;
  if (words <= 10) return DEFAULT_TEASER_SEC;
  return MAX_TEASER_SEC;
}

function pickTeaserPeak(inRange, start, end) {
  const duration = end - start;
  const minOffset = getMinColdOpenPeakOffset(duration);
  let best = null;
  let bestScore = -Infinity;

  for (const row of inRange) {
    const offsetSec = row.t - start;
    if (offsetSec < minOffset) continue;

    const ratio = duration > 0 ? offsetSec / duration : 0.5;
    const s = scoreTeaserMoment(String(row.seg.text || ''), row.gap, ratio);
    if (s > bestScore) {
      bestScore = s;
      best = { time: row.t, line: String(row.seg.text || '').trim(), score: s };
    }
  }

  if (best) return best;

  const fallbackTime = start + Math.max(minOffset, duration * 0.72);
  const fallbackRow = inRange.find((r) => Math.abs(r.t - fallbackTime) < 2.5);
  return {
    time: fallbackTime,
    line: fallbackRow ? String(fallbackRow.seg.text || '').trim() : '',
    score: fallbackRow
      ? scoreTeaserMoment(
          String(fallbackRow.seg.text || ''),
          fallbackRow.gap,
          duration > 0 ? (fallbackTime - start) / duration : 0.72,
        )
      : 0,
  };
}

function pickCliffhanger(inRange, start, end, teaserTime, teaserLine) {
  const duration = end - start;
  let best = null;
  let bestScore = -Infinity;

  const phrases = buildPhrasesFromRange(inRange);

  for (const phrase of phrases) {
    if (wordOverlapRatio(phrase.text, teaserLine) > 0.68) continue;
    const ratio = duration > 0 ? (phrase.t - start) / duration : 0.5;
    const s = scoreCliffhangerMoment(phrase.text, 0, ratio, teaserTime, phrase.t);
    if (s > bestScore) {
      bestScore = s;
      best = { line: phrase.text, score: s };
    }
  }

  for (const row of inRange) {
    const ratio = duration > 0 ? (row.t - start) / duration : 0.5;
    const line = String(row.seg.text || '').trim();
    if (!line || wordOverlapRatio(line, teaserLine) > 0.72) continue;

    const s = scoreCliffhangerMoment(line, row.gap, ratio, teaserTime, row.t);
    if (s > bestScore) {
      bestScore = s;
      best = { line, score: s };
    }
  }

  return best;
}

function fallbackCliffhanger(inRange, teaserTime, teaserLine) {
  let before = null;
  let beforeDist = Infinity;

  for (const row of inRange) {
    if (row.t >= teaserTime) continue;
    const dist = teaserTime - row.t;
    if (dist < beforeDist && dist >= 1.5) {
      beforeDist = dist;
      before = String(row.seg.text || '').trim();
    }
  }

  if (before && wordOverlapRatio(before, teaserLine) < 0.65) {
    return formatCliffhangerText(before);
  }

  const templates = [
    'Wait until you see this…',
    'This is about to get wild…',
    'You need to see what happens next…',
    'Warte, bis du das siehst…',
    'Das musst du dir ansehen…',
  ];
  return templates[Math.floor(teaserTime) % templates.length];
}

/**
 * Local hook analysis: best teaser scene + matching cliffhanger line (zero API tokens).
 */
export function analyzeClipHook(segments, startTime, endTime) {
  const start = Number(startTime);
  const end = Number(endTime);
  const inRange = segmentsInRange(segments, start, end);

  if (!inRange.length) {
    const mid = start + (end - start) * 0.72;
    return {
      teaser_peak_time: mid,
      teaser_line: '',
      teaser_score: 0,
      cliffhanger_text: 'Wait for this…',
      cliffhanger_score: 0,
      teaser_duration: DEFAULT_TEASER_SEC,
    };
  }

  const teaser = pickTeaserPeak(inRange, start, end);
  const teaserTime = teaser?.time ?? start + (end - start) * 0.72;
  const teaserLine = teaser?.line || '';

  const cliff = pickCliffhanger(inRange, start, end, teaserTime, teaserLine);
  let cliffText = cliff?.line ? formatCliffhangerText(cliff.line) : '';

  if (!cliffText || !isValidCliffhangerText(cliffText)) {
    cliffText = synthesizeCliffhanger(
      { title: '' },
      teaserLine,
      inRange,
      teaserTime,
    );
  }

  return {
    teaser_peak_time: teaserTime,
    teaser_line: teaserLine,
    teaser_score: teaser?.score ?? 0,
    cliffhanger_text: cliffText,
    cliffhanger_score: cliff?.score ?? 0,
    teaser_duration: teaserDurationForLine(teaserLine),
  };
}

function scoreTeaserAtTime(segments, time, start, end) {
  const row = segmentsInRange(segments, start, end).find((r) => Math.abs(r.t - time) < 2);
  if (!row) return 0;
  const duration = end - start;
  const ratio = duration > 0 ? (time - start) / duration : 0.5;
  return scoreTeaserMoment(String(row.seg.text || ''), row.gap, ratio);
}

/**
 * Merge Claude picks with local intelligent hook (teaser scene ≠ cliffhanger text).
 */
export function resolveIntelligentHook(segments, highlight) {
  const start = Number(highlight.start_time);
  const end = Number(highlight.end_time);
  const analyzed = analyzeClipHook(segments, start, end);

  let teaserPeak = analyzed.teaser_peak_time;
  const claudePeak = Number(highlight.hook_peak_time);
  if (Number.isFinite(claudePeak) && claudePeak >= start && claudePeak <= end) {
    const localAtClaude = scoreTeaserAtTime(segments, claudePeak, start, end);
    if (localAtClaude >= analyzed.teaser_score * 0.82) {
      teaserPeak = claudePeak;
    }
  }

  teaserPeak = clampColdOpenPeakTime(start, end, teaserPeak);

  let cliffText = analyzed.cliffhanger_text;
  if (!isValidCliffhangerText(cliffText)) {
    cliffText = synthesizeCliffhanger(
      highlight,
      analyzed.teaser_line,
      segmentsInRange(segments, start, end),
      teaserPeak,
    );
  }

  const claudeHook = String(highlight.hook || '').trim();
  if (
    claudeHook &&
    wordOverlapRatio(claudeHook, analyzed.teaser_line) < 0.7 &&
    isValidCliffhangerText(claudeHook)
  ) {
    const cliffFromClaude = formatCliffhangerText(claudeHook);
    const claudeScore = scoreCliffhangerMoment(
      claudeHook,
      0,
      (teaserPeak - start) / Math.max(end - start, 1),
      teaserPeak,
      teaserPeak - 3,
    );
    if (cliffFromClaude && claudeScore >= analyzed.cliffhanger_score * 0.75) {
      cliffText = cliffFromClaude;
    }
  }

  if (!isValidCliffhangerText(cliffText)) {
    cliffText = synthesizeCliffhanger(
      highlight,
      analyzed.teaser_line,
      segmentsInRange(segments, start, end),
      teaserPeak,
    );
  }

  const teaserLine =
    analyzed.teaser_line ||
    segmentsInRange(segments, start, end).find((r) => Math.abs(r.t - teaserPeak) < 2)?.seg
      ?.text ||
    '';

  return {
    hook_peak_time: teaserPeak,
    hook_teaser_duration: analyzed.teaser_duration,
    hook: cliffText,
    hook_teaser_line: String(teaserLine).trim().slice(0, 160),
    intelligent_hook: true,
  };
}

/** Cliffhanger hint for candidate list (compact, no tokens). */
export function findCliffhangerHint(timeline, windowStart, windowEnd, peakTime) {
  if (!timeline?.length) return '';
  const duration = windowEnd - windowStart;
  let best = '';
  let bestScore = -Infinity;

  for (const item of timeline) {
    if (item.start < windowStart || item.start > windowEnd) continue;
    const ratio = duration > 0 ? (item.start - windowStart) / duration : 0.5;
    const s = scoreCliffhangerMoment(
      item.text,
      0,
      ratio,
      peakTime ?? item.start + 5,
      item.start,
    );
    if (s > bestScore) {
      bestScore = s;
      best = item.text;
    }
  }

  const formatted = formatCliffhangerText(best, 70);
  return isValidCliffhangerText(formatted) ? formatted : '';
}
