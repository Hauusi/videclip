import { stripFillers } from './preprocess.js';

/** High-impact reaction keywords (DE + EN). */
export const REACTION_KEYWORDS = [
  /\b(no way|clutch|wtf|insane|crazy|omg|wow|holy|bro|let'?s go|gg|rip)\b/i,
  /\b(auf keinen|krass|wahnsinn|alter|scheiße|omg|wtf|heftig|unglaublich)\b/i,
  /\b(jump scare|jumpscare|scared|scream|schrei|lacht|haha|lol)\b/i,
  /\b(died|kill|killed|down|eliminated|victory|win|round|boss)\b/i,
  /\b(gestorben|kill|eliminiert|sieg|gewonnen|runde|boss)\b/i,
];

/** Lore / exposition / low-moment speech (penalize). */
export const LORE_MONOLOGUE_PATTERNS = [
  /\b(so basically|let me explain|backstory|lore|story time|in this world|years ago)\b/i,
  /\b(also basically|lass mich erklären|hintergrund|geschichte|vor jahren|in dieser welt)\b/i,
  /\b(the reason is|what happened was|it all started|fun fact|did you know)\b/i,
  /\b(der grund ist|es fing an|wusstest du|fun fact|erzähl)\b/i,
  /\b(chapter|episode|part \d|kapitel|folge|teil \d)\b/i,
];

export const NEGATIVE_PATTERNS = [
  /\b(subscribe|like and subscribe|link in description|patreon|sponsor)\b/i,
  /\b(abonnier|abonnieren|link in der beschreibung|sponsor)\b/i,
  /\b(welcome back|intro|outro|thanks for watching|see you next)\b/i,
  /\b(willkommen|intro|outro|danke fürs zuschauen|bis zum nächsten)\b/i,
];

const SETUP_PATTERNS = [/\?/, /\b(warum|why|how|wieso|wait|warte)\b/i];

/**
 * Per-line transcript scoring: short reactions > long monologues.
 * @param {number} [segDurationSec] - segment speech duration for rate heuristics
 */
export function scoreLine(text, gapBefore = 0, segDurationSec = 0, profile = null) {
  const clean = stripFillers(text);
  if (!clean) return -5;

  let score = 0;
  const words = clean.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // Short reactions beat long explanations — but only emphatic ones get the
  // big bonus (auto-captions split everything into short fragments).
  const emphatic = /[!?]/.test(clean) || /\b[A-ZÄÖÜ]{2,}\b/.test(clean);
  if (wordCount <= 4) score += emphatic ? 12 : 5;
  else if (wordCount <= 8) score += emphatic ? 9 : 4;
  else if (wordCount <= 14) score += 2;
  else if (wordCount >= 32) score -= 22;
  else if (wordCount >= 24) score -= 14;
  else if (wordCount >= 18) score -= 6;

  const isQuestion = /\?/.test(clean);
  const isExclaim = /!/.test(clean);
  if (isQuestion) score += 7;
  if (isExclaim) score += 8;
  if (isQuestion && wordCount <= 12) score += 5;
  if (isExclaim && wordCount <= 10) score += 6;
  if (/\.\.\.|—|–|…/.test(clean)) score += 2;

  const capsWords = clean.match(/\b[A-ZÄÖÜ]{2,}\b/g);
  if (capsWords?.length) score += Math.min(capsWords.length * 2, 8);

  const keywordBonus = profile?.keywordBonus ?? 9;
  const lorePenalty = profile?.lorePenalty ?? 18;

  for (const pattern of REACTION_KEYWORDS) {
    if (pattern.test(clean)) score += keywordBonus;
  }
  for (const pattern of profile?.keywords || []) {
    if (pattern.test(clean)) score += keywordBonus + 2;
  }
  for (const pattern of LORE_MONOLOGUE_PATTERNS) {
    if (pattern.test(clean)) score -= lorePenalty;
  }
  for (const pattern of profile?.lorePatterns || []) {
    if (pattern.test(clean)) score -= Math.round(lorePenalty * 0.85);
  }
  for (const pattern of NEGATIVE_PATTERNS) {
    if (pattern.test(clean)) score -= 28;
  }

  if (gapBefore >= 0.8) score += Math.min(gapBefore * 2.5, 8);

  const dur = Number(segDurationSec) || 0;
  if (dur > 0 && wordCount > 0) {
    const wps = wordCount / dur;
    if (wps >= 3.2 && wordCount <= 16) score += 6;
    if (wps <= 1.4 && wordCount >= 20) score -= 8;
  }

  return score;
}

function itemsInWindow(timeline, windowStart, windowEnd) {
  return timeline.filter((item) => item.end >= windowStart && item.start <= windowEnd);
}

/**
 * Window-level transcript metrics: speech rate, interaction, monologue detection.
 */
export function analyzeWindowTranscript(timeline, windowStart, windowEnd) {
  const items = itemsInWindow(timeline, windowStart, windowEnd).sort((a, b) => a.start - b.start);
  if (!items.length) {
    return {
      speechRate: 0,
      reactionLines: 0,
      monologueLines: 0,
      interactionTurns: 0,
      avgGap: 0,
      longestRunSec: 0,
    };
  }

  let totalWords = 0;
  let speechSec = 0;
  let reactionLines = 0;
  let monologueLines = 0;
  let interactionTurns = 0;
  let gapSum = 0;
  let gapCount = 0;
  let longestRunSec = 0;
  let runStart = items[0].start;
  let runEnd = items[0].end;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const words = item.text.split(/\s+/).filter(Boolean).length;
    const dur = Math.max(0.3, item.end - item.start);
    totalWords += words;
    speechSec += dur;

    if (words <= 10 && (/\?|!/.test(item.text) || REACTION_KEYWORDS.some((re) => re.test(item.text)))) {
      reactionLines += 1;
    }
    if (words >= 22 || LORE_MONOLOGUE_PATTERNS.some((re) => re.test(item.text))) {
      monologueLines += 1;
    }
    if (item.score >= 6 && words <= 14) reactionLines += 0.5;

    if (i > 0) {
      const gap = item.start - items[i - 1].end;
      if (gap >= 0.4 && gap <= 6) {
        interactionTurns += 1;
        gapSum += gap;
        gapCount += 1;
      }
      if (gap <= 1.2) {
        runEnd = item.end;
      } else {
        longestRunSec = Math.max(longestRunSec, runEnd - runStart);
        runStart = item.start;
        runEnd = item.end;
      }
    }
  }
  longestRunSec = Math.max(longestRunSec, runEnd - runStart);

  const windowDur = Math.max(1, windowEnd - windowStart);
  const speechRate = totalWords / Math.max(speechSec, 1) * 60;

  return {
    speechRate: Math.round(speechRate),
    reactionLines: Math.round(reactionLines),
    monologueLines,
    interactionTurns,
    avgGap: gapCount ? gapSum / gapCount : 0,
    longestRunSec,
    speechCoverage: speechSec / windowDur,
  };
}

/**
 * Structure scoring: peak + context + reaction; penalize lore monologues / dead interaction.
 */
export function scoreWindowStructure(timeline, windowStart, windowEnd, profile = null) {
  const items = itemsInWindow(timeline, windowStart, windowEnd).sort((a, b) => a.start - b.start);
  const transcript = analyzeWindowTranscript(timeline, windowStart, windowEnd);
  const mid = windowStart + (windowEnd - windowStart) * 0.5;

  let structureBonus = 0;
  let monologuePenalty = 0;
  let lowInteractionPenalty = 0;
  let arcLabel = 'flat';

  let peakItem = null;
  let peakScore = -Infinity;
  let contextBefore = 0;
  let reactionAfter = 0;

  for (const item of items) {
    if (item.score > peakScore) {
      peakScore = item.score;
      peakItem = item;
    }
  }

  if (peakItem) {
    const before = items.filter((it) => it.start < peakItem.start - 0.2 && it.start >= windowStart);
    const after = items.filter((it) => it.start > peakItem.start + 0.2 && it.start <= windowEnd);

    contextBefore = before.reduce((s, it) => s + it.score, 0);
    reactionAfter = after
      .filter(
        (it) =>
          it.score >= 4 ||
          /\?|!/.test(it.text) ||
          REACTION_KEYWORDS.some((re) => re.test(it.text)),
      )
      .reduce((s, it) => s + it.score, 0);

    const hasContext = before.length >= 1 && contextBefore >= 3;
    const hasReaction = reactionAfter >= 6 || after.some((it) => it.score >= 8);
    const hasPeak = peakScore >= 8;

    if (hasPeak && hasContext && hasReaction) {
      structureBonus += 18;
      arcLabel = 'peak+context+reaction';
    } else if (hasPeak && (hasContext || hasReaction)) {
      structureBonus += 10;
      arcLabel = hasContext ? 'peak+context' : 'peak+reaction';
    } else if (hasPeak) {
      structureBonus += 4;
      arcLabel = 'peak-only';
    }

    let firstTotal = 0;
    let secondPeak = 0;
    let hasSetup = false;
    for (const item of items) {
      if (item.start < mid) {
        firstTotal += item.score;
        if (SETUP_PATTERNS.some((re) => re.test(item.text))) hasSetup = true;
      } else {
        secondPeak = Math.max(secondPeak, item.score);
      }
    }
    const firstAvg = items.filter((it) => it.start < mid).length
      ? firstTotal / items.filter((it) => it.start < mid).length
      : 0;

    if (secondPeak >= 8 && secondPeak >= firstAvg * 0.7) {
      structureBonus += 8;
      if (hasSetup) arcLabel = 'setup→payoff';
    }
    if (hasSetup && secondPeak >= 6) structureBonus += 4;
    if (firstAvg > 4 && secondPeak < firstAvg * 0.5) {
      structureBonus -= 8;
      arcLabel = 'weak-tail';
    }
  }

  const monoMul = profile?.monologuePenalty ?? 1;
  if (transcript.monologueLines >= 2) {
    monologuePenalty += Math.round((12 + transcript.monologueLines * 4) * monoMul);
  }
  if (transcript.longestRunSec >= 18 && transcript.reactionLines < 2) {
    monologuePenalty += Math.round(14 * monoMul);
  }
  if (transcript.speechCoverage > 0.82 && transcript.interactionTurns < 2) {
    monologuePenalty += Math.round(10 * monoMul);
  }

  if (transcript.interactionTurns < 1 && transcript.reactionLines < 1) {
    lowInteractionPenalty += 12;
  } else if (transcript.interactionTurns < 2 && transcript.monologueLines >= 1) {
    lowInteractionPenalty += 6;
  }

  if (transcript.speechRate >= 170 && transcript.reactionLines >= 1) structureBonus += 5;
  if (transcript.reactionLines >= 3) structureBonus += 6;

  return {
    structureBonus,
    monologuePenalty,
    lowInteractionPenalty,
    arcLabel,
    transcript,
    peakScore,
  };
}

/** Convert transcript structure metrics to composite delta (≈0–35). */
export function transcriptStructureDelta(structure, profile = null) {
  if (!structure) return 0;
  const sw = profile?.structureWeight ?? 1;
  const base =
    (structure.structureBonus || 0) * sw -
    (structure.monologuePenalty || 0) -
    (structure.lowInteractionPenalty || 0);
  return Math.round(base);
}
