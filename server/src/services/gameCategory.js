/**
 * Content/game classification from title + description (Phase 1).
 * Drives category-specific highlight scoring before clips are cut.
 */

const DEFAULT_PROFILE = {
  id: 'generic',
  label: 'Generic',
  keywords: [],
  lorePatterns: [],
  keywordBonus: 9,
  lorePenalty: 18,
  audioWeight: 1,
  structureWeight: 1,
  monologuePenalty: 1,
  minClipSec: 12,
  maxClipSec: 45,
  claudeHint:
    'Pick clear payoff moments with strong reactions. Avoid long exposition without a peak.',
};

/** @type {Record<string, typeof DEFAULT_PROFILE>} */
export const CATEGORY_PROFILES = {
  shooter: {
    id: 'shooter',
    label: 'Shooter / FPS',
    keywords: [
      /\b(ace|clutch|1v\d|one v|headshot|nade|frag|pick|trade|one tap|multikill)\b/i,
      /\b(round win|won the round|gg|team kill|tk|awp|operator)\b/i,
      /\b(kill|killed|died|down|eliminated|last alive|double|triple|quad)\b/i,
      /\b(no way|insane|what|bro|let'?s go|nice|got him)\b/i,
    ],
    lorePatterns: [
      /\b(plant|planted|defus|holding|hold the|save round|waiting|rotate|default)\b/i,
      /\b(buy round|economy|eco round|utility|smoke lineup|default call)\b/i,
      /\b(taktik|strategie|buy|öko|smoke|callout|rotation|pflanzt|hält)\b/i,
    ],
    keywordBonus: 11,
    lorePenalty: 14,
    audioWeight: 1.35,
    structureWeight: 1,
    monologuePenalty: 1.3,
    minClipSec: 20,
    maxClipSec: 35,
    claudeHint:
      'FPS/shooter: prefer multikill-montage and kill-chain clips (several kills in a row). Single calm windows are never highlights.',
  },

  moba: {
    id: 'moba',
    label: 'MOBA',
    keywords: [
      /\b(penta|quadra|triple kill|teamfight|baron|drake|dragon|elder|herald)\b/i,
      /\b(ff|surrender|got him|nice|clean|outplay|flash|ult)\b/i,
      /\b(kill|killed|ace|wipe|push|end|nexus|inhib)\b/i,
      /\b(no way|insane|what|bro|let'?s go|clutch)\b/i,
    ],
    lorePatterns: [
      /\b(item build|runes|matchup|wave management|csing|last hit|farm phase)\b/i,
      /\b(build|runen|matchup|lane|farmen|last hits)\b/i,
    ],
    keywordBonus: 10,
    lorePenalty: 13,
    audioWeight: 1.15,
    structureWeight: 1.25,
    monologuePenalty: 1.2,
    minClipSec: 14,
    maxClipSec: 45,
    claudeHint:
      'MOBA: teamfights, multikills, objective steals, post-fight reactions — not lane-farm commentary.',
  },

  survival: {
    id: 'survival',
    label: 'Survival / Sandbox',
    keywords: [
      /\b(died|death|killed|rip|gg|base|raid|loot|craft|build)\b/i,
      /\b(gestorben|tod|base|raid|loot|craften|bauen)\b/i,
      /\b(oh no|no way|help|run|escape|found|discovered)\b/i,
      /\b(jump scare|scared|monster|creeper|boss)\b/i,
    ],
    lorePatterns: [
      /\b(crafting recipe|tutorial|how to build|let me show|guide)\b/i,
      /\b(rezept|tutorial|anleitung|so baust du)\b/i,
    ],
    keywordBonus: 9,
    lorePenalty: 16,
    audioWeight: 1.2,
    structureWeight: 1.1,
    monologuePenalty: 1.25,
    minClipSec: 12,
    maxClipSec: 40,
    claudeHint:
      'Survival/sandbox: deaths, discoveries, raids, boss fights — skip long crafting tutorials.',
  },

  horror: {
    id: 'horror',
    label: 'Horror',
    keywords: [
      /\b(scared|scream|screaming|oh my god|no way|wtf|help|run)\b/i,
      /\b(erschrocken|schrei|hilfe|lauf|grusel|angst)\b/i,
      /\b(jump scare|jumpscare|heart attack|i can'?t)\b/i,
    ],
    lorePatterns: [
      /\b(lore|backstory|story explanation|plot twist explained)\b/i,
      /\b(lore|hintergrund|geschichte erklärt)\b/i,
    ],
    keywordBonus: 10,
    lorePenalty: 12,
    audioWeight: 1.45,
    structureWeight: 1,
    monologuePenalty: 1.15,
    minClipSec: 10,
    maxClipSec: 32,
    claudeHint:
      'Horror: screams, jump scares, tension spikes — audio fear beats plot explanation.',
  },

  racing: {
    id: 'racing',
    label: 'Racing / Sports',
    keywords: [
      /\b(overtake|overtook|crash|podium|win|won|goal|score|clutch)\b/i,
      /\b(überhol|crash|unfall|sieg|tor|punkt)\b/i,
      /\b(no way|insane|let'?s go|final lap|photo finish)\b/i,
    ],
    lorePatterns: [
      /\b(setup|tuning|car build|meta|tier list)\b/i,
    ],
    keywordBonus: 9,
    lorePenalty: 14,
    audioWeight: 1.2,
    structureWeight: 1.05,
    monologuePenalty: 1.2,
    minClipSec: 12,
    maxClipSec: 38,
    claudeHint:
      'Racing/sports: overtakes, crashes, goals, wins — not setup/tuning talk.',
  },

  react: {
    id: 'react',
    label: 'Reaction',
    keywords: [
      /\b(react|reaction|watching|oh my god|no way|wtf|insane|crazy)\b/i,
      /\b(reagiert|reaction|schau|oh mein gott|krass|wahnsinn)\b/i,
      /\b(wait|pause|rewind|look at|did you see)\b/i,
    ],
    lorePatterns: [],
    keywordBonus: 10,
    lorePenalty: 16,
    audioWeight: 1.1,
    structureWeight: 1.15,
    monologuePenalty: 1.1,
    minClipSec: 12,
    maxClipSec: 42,
    claudeHint:
      'Reaction content: genuine surprise/laugh beats long commentary without a visible beat.',
  },

  talk: {
    id: 'talk',
    label: 'Talk / IRL',
    keywords: [
      /\b(wait|what|why|no way|actually|truth|secret|crazy|insane)\b/i,
      /\b(warte|was|warum|krass|wahrheit|geheim)\b/i,
      /\?|!/,
    ],
    lorePatterns: [
      /\b(anyway|so yeah|moving on|as i was saying)\b/i,
    ],
    keywordBonus: 8,
    lorePenalty: 20,
    audioWeight: 0.85,
    structureWeight: 1.35,
    monologuePenalty: 1.4,
    minClipSec: 14,
    maxClipSec: 45,
    claudeHint:
      'Talk/IRL: opinion peaks, arguments, reveals with setup→payoff — penalize rambling monologues.',
  },

  generic: DEFAULT_PROFILE,
};

/** Game title → category (first match wins by score). */
const GAME_MATCHERS = [
  {
    category: 'shooter',
    game: 'Counter-Strike 2',
    patterns: [/counter[- ]?strike/i, /\bcs2\b/i, /\bcs\s*2\b/i, /\bcsgo\b/i, /\bcs:go\b/i],
    weight: 12,
  },
  {
    category: 'shooter',
    game: 'Valorant',
    patterns: [/\bvalorant\b/i],
    weight: 12,
  },
  {
    category: 'shooter',
    game: 'Call of Duty',
    patterns: [/call of duty/i, /\bcod\b(?!\s*of)/i, /\bwarzone\b/i, /\bmodern warfare\b/i],
    weight: 11,
  },
  {
    category: 'shooter',
    game: 'Apex Legends',
    patterns: [/\bapex legends\b/i, /\bapex\b/i],
    weight: 10,
  },
  {
    category: 'shooter',
    game: 'Overwatch',
    patterns: [/\boverwatch\b/i],
    weight: 10,
  },
  {
    category: 'moba',
    game: 'League of Legends',
    patterns: [/league of legends/i, /\blol\b(?!\s*reaction)/i, /\blol gameplay\b/i],
    weight: 12,
  },
  {
    category: 'moba',
    game: 'Dota 2',
    patterns: [/\bdota\s*2?\b/i],
    weight: 12,
  },
  {
    category: 'moba',
    game: 'Smite',
    patterns: [/\bsmite\b/i],
    weight: 10,
  },
  {
    category: 'survival',
    game: 'Minecraft',
    patterns: [/\bminecraft\b/i, /\bmc\b(?!\s*donald)/i],
    weight: 12,
  },
  {
    category: 'survival',
    game: 'Rust',
    patterns: [/\brust\b(?!\s*lang)/i],
    weight: 11,
  },
  {
    category: 'survival',
    game: 'ARK',
    patterns: [/\bark\b/i, /\bark:\s*survival\b/i],
    weight: 10,
  },
  {
    category: 'horror',
    game: 'Horror Game',
    patterns: [
      /\bhorror game/i,
      /\bphasmophobia\b/i,
      /\boutlast\b/i,
      /\bresident evil\b/i,
      /\bfive nights\b/i,
      /\bfnaf\b/i,
    ],
    weight: 11,
  },
  {
    category: 'racing',
    game: 'Racing',
    patterns: [
      /\bforza\b/i,
      /\bgran turismo\b/i,
      /\bf1\b/i,
      /\bformula 1\b/i,
      /\bneed for speed\b/i,
    ],
    weight: 10,
  },
  {
    category: 'react',
    game: 'Reaction',
    patterns: [/\breaction\b/i, /\breact(?:s|ing)?\s+to\b/i, /\bwatch(?:es|ing)\b/i],
    weight: 8,
  },
  {
    category: 'talk',
    game: 'Just Chatting',
    patterns: [/\bjust chatting\b/i, /\birl\b/i, /\bpodcast\b/i, /\binterview\b/i, /\bvlog\b/i],
    weight: 8,
  },
];

const GAMING_FALLBACK =
  /\b(game|gameplay|stream|twitch|let'?s play|gaming|speedrun|ranked|competitive)\b/i;

/** Spoken in-game / streamer vocabulary (stronger than title alone). */
const TRANSCRIPT_GAME_PATTERNS = [
  {
    category: 'shooter',
    game: 'Counter-Strike 2',
    patterns: [
      /\b(cs2|csgo|counter.?strike)\b/i,
      /\b(awp|ak|m4|deagle|eco round|save round|buy round)\b/i,
      /\b(plant|defuse|bomb|a site|b site|mid|rotate|flash|smoke|molly)\b/i,
      /\b(ct|t side|terrorist|counter.?terrorist)\b/i,
    ],
    weight: 9,
  },
  {
    category: 'shooter',
    game: 'Valorant',
    patterns: [
      /\bvalorant\b/i,
      /\b(spike|ult|ultimate|operator|jett|sage|phoenix|omen|reyna)\b/i,
      /\b(plant|defuse|site [ab])\b/i,
    ],
    weight: 9,
  },
  {
    category: 'moba',
    game: 'League of Legends',
    patterns: [
      /\b(league of legends|lol)\b/i,
      /\b(baron|drake|dragon|elder|herald|inhib|nexus|jungler|gank)\b/i,
      /\b(penta|quadra|triple kill|teamfight|ff)\b/i,
    ],
    weight: 9,
  },
  {
    category: 'moba',
    game: 'Dota 2',
    patterns: [/\bdota\b/i, /\b(roshan|ancient|rampage|beyond godlike)\b/i],
    weight: 9,
  },
  {
    category: 'survival',
    game: 'Minecraft',
    patterns: [/\bminecraft\b/i, /\b(creeper|nether|ender|diamond|redstone)\b/i],
    weight: 8,
  },
  {
    category: 'horror',
    game: 'Horror Game',
    patterns: [/\b(phasmophobia|outlast|resident evil|five nights|fnaf)\b/i],
    weight: 8,
  },
];

const SIGNAL_WEIGHTS = {
  title: 1.35,
  description: 0.65,
  tags: 1.15,
  channel: 0.5,
  transcript: 1.75,
  visual: 2.1,
};

function matcherKey(category, game) {
  return `${category}::${game || ''}`;
}

function scoreMatchersOnText(text, matchers, multiplier = 1) {
  const scores = new Map();
  if (!text?.trim()) return scores;

  for (const matcher of matchers) {
    let pts = 0;
    for (const pattern of matcher.patterns) {
      const matches = text.match(new RegExp(pattern.source, `${pattern.flags}g`));
      if (matches?.length) pts += matcher.weight * Math.min(matches.length, 3);
    }
    if (pts > 0) {
      const key = matcherKey(matcher.category, matcher.game);
      scores.set(key, (scores.get(key) || 0) + pts * multiplier);
    }
  }
  return scores;
}

function scoreCategoryKeywords(segments, multiplier = 1) {
  const scores = new Map();
  if (!segments?.length) return scores;

  const text = segments.map((s) => s.text || '').join(' ');
  for (const [catId, profile] of Object.entries(CATEGORY_PROFILES)) {
    if (catId === 'generic' || !profile.keywords?.length) continue;
    let hits = 0;
    for (const pattern of profile.keywords) {
      const matches = text.match(new RegExp(pattern.source, `${pattern.flags}g`));
      if (matches?.length) hits += Math.min(matches.length, 4);
    }
    if (hits >= 3) {
      const key = matcherKey(catId, null);
      scores.set(key, (scores.get(key) || 0) + hits * 2.5 * multiplier);
    }
  }
  return scores;
}

function mergeScoreMaps(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [key, pts] of map) {
      merged.set(key, (merged.get(key) || 0) + pts);
    }
  }
  return merged;
}

function pickBestFromScores(scores, { gamingFallbackText = '' } = {}) {
  let best = { category: 'generic', game: null, score: 0, key: 'generic::' };

  for (const [key, score] of scores) {
    if (score > best.score) {
      const [category, game] = key.split('::');
      best = { category, game: game || null, score, key };
    }
  }

  if (best.score === 0 && GAMING_FALLBACK.test(gamingFallbackText)) {
    best = { category: 'generic', game: 'Gaming', score: 6, key: 'generic::Gaming' };
  }

  const profile = CATEGORY_PROFILES[best.category] || CATEGORY_PROFILES.generic;
  const confidence =
    best.score >= 42
      ? 94
      : best.score >= 28
        ? 88
        : best.score >= 18
          ? 80
          : best.score >= 12
            ? 72
            : best.score >= 8
              ? 62
              : best.score > 0
                ? 52
                : 35;

  return {
    category: best.category,
    game: best.game,
    confidence,
    profile,
    score: best.score,
  };
}

function formatClassificationResult(result, sources = []) {
  return {
    category: result.category,
    game: result.game,
    confidence: result.confidence,
    profile: result.profile,
    sources,
    score: result.score,
  };
}

/**
 * @returns {{ category: string, game: string|null, confidence: number, profile: object }}
 */
export function classifyContent({ title = '', description = '', tags = [] } = {}) {
  const tagText = (Array.isArray(tags) ? tags : []).join(' ');
  const scores = mergeScoreMaps(
    scoreMatchersOnText(title, GAME_MATCHERS, SIGNAL_WEIGHTS.title),
    scoreMatchersOnText(description, GAME_MATCHERS, SIGNAL_WEIGHTS.description),
    scoreMatchersOnText(tagText, GAME_MATCHERS, SIGNAL_WEIGHTS.tags),
  );
  const result = pickBestFromScores(scores, {
    gamingFallbackText: [title, description, tagText].join(' '),
  });
  const sources = [];
  if (title.trim()) sources.push('title');
  if (description.trim()) sources.push('description');
  if (tagText.trim()) sources.push('tags');
  return formatClassificationResult(result, sources);
}

export function classifyFromTranscript(segments = []) {
  if (!segments?.length) return null;
  const text = segments.map((s) => s.text || '').join(' ');
  const scores = mergeScoreMaps(
    scoreMatchersOnText(text, GAME_MATCHERS, SIGNAL_WEIGHTS.transcript * 0.55),
    scoreMatchersOnText(text, TRANSCRIPT_GAME_PATTERNS, SIGNAL_WEIGHTS.transcript),
    scoreCategoryKeywords(segments, SIGNAL_WEIGHTS.transcript * 0.4),
  );
  const result = pickBestFromScores(scores, { gamingFallbackText: text });
  if (result.score <= 0) return null;
  return formatClassificationResult(result, ['transcript']);
}

/**
 * Merge metadata, transcript, and optional visual HUD signals.
 */
export async function resolveContentClassification({
  title = '',
  description = '',
  tags = [],
  channel = '',
  segments = null,
  sourceVideo = null,
  duration = 0,
  detectVisual,
} = {}) {
  const tagText = (Array.isArray(tags) ? tags : []).join(' ');
  const sources = [];
  const text = segments?.map((s) => s.text || '').join(' ') || '';

  let scores = mergeScoreMaps(
    scoreMatchersOnText(title, GAME_MATCHERS, SIGNAL_WEIGHTS.title),
    scoreMatchersOnText(description, GAME_MATCHERS, SIGNAL_WEIGHTS.description),
    scoreMatchersOnText(tagText, GAME_MATCHERS, SIGNAL_WEIGHTS.tags),
    scoreMatchersOnText(channel, GAME_MATCHERS, SIGNAL_WEIGHTS.channel),
  );
  if (title.trim()) sources.push('title');
  if (description.trim()) sources.push('description');
  if (tagText.trim()) sources.push('tags');
  if (channel.trim()) sources.push('channel');

  if (segments?.length) {
    scores = mergeScoreMaps(
      scores,
      scoreMatchersOnText(text, GAME_MATCHERS, SIGNAL_WEIGHTS.transcript * 0.55),
      scoreMatchersOnText(text, TRANSCRIPT_GAME_PATTERNS, SIGNAL_WEIGHTS.transcript),
      scoreCategoryKeywords(segments, SIGNAL_WEIGHTS.transcript * 0.4),
    );
    sources.push('transcript');
  }

  let preliminary = pickBestFromScores(scores, {
    gamingFallbackText: [title, description, tagText, text].join(' '),
  });

  // Sample gameplay HUD when video is available — skip if text already confident shooter.
  const textConfidentShooter =
    preliminary.category === 'shooter' &&
    preliminary.confidence >= 72 &&
    (sources.includes('title') || sources.includes('tags') || sources.includes('channel'));

  const shouldRunVisual = Boolean(sourceVideo && detectVisual && !textConfidentShooter);

  if (textConfidentShooter) {
    console.log(
      `[game-visual] skipped — shooter already identified from metadata ` +
        `(${preliminary.game || 'shooter'}, conf=${preliminary.confidence}%)`,
    );
  }

  if (shouldRunVisual) {
    const visual = await detectVisual(sourceVideo, duration);
    if (visual?.category && visual.category !== 'generic') {
      const vKey = matcherKey(visual.category, visual.game);
      const visualPts = (visual.detail?.score || visual.confidence || 50) * 0.35;
      scores = mergeScoreMaps(scores, new Map([[vKey, visualPts * SIGNAL_WEIGHTS.visual]]));
      sources.push('visual');
      preliminary = pickBestFromScores(scores, {
        gamingFallbackText: [title, description, tagText, text].join(' '),
      });
    } else if (visual) {
      sources.push('visual');
    }
  }

  const uniqueSources = [...new Set(sources)];
  const multiSignalBonus =
    uniqueSources.length >= 3 ? 8 : uniqueSources.includes('visual') && uniqueSources.includes('transcript') ? 6 : 0;
  const confidence = Math.min(97, preliminary.confidence + multiSignalBonus);

  return formatClassificationResult({ ...preliminary, confidence }, uniqueSources);
}

const SHOOTER_GAME_RE =
  /counter[- ]?strike|\bcs2\b|\bcsgo\b|\bcs:go\b|valorant|overwatch|apex legends|\bcod\b|call of duty|battlefield/i;

/** True when content should use the shooter kill-montage pipeline (not linear Claude clips). */
export function isShooterContent(ctx = {}) {
  const category = ctx.category ?? ctx.contentCategory;
  const profile = ctx.profile ?? ctx.categoryProfile;
  const game = ctx.game ?? ctx.contentGame;
  if (category === 'shooter' || profile?.id === 'shooter') return true;
  return SHOOTER_GAME_RE.test(String(game || ''));
}

export function getCategoryProfile(categoryId) {
  return CATEGORY_PROFILES[categoryId] || CATEGORY_PROFILES.generic;
}

export function getCategoryLabel(categoryId) {
  return getCategoryProfile(categoryId).label;
}

/** Apply category audio multiplier to raw audio boost points. */
export function scaleAudioBoost(rawBoost, profile) {
  const weight = profile?.audioWeight ?? 1;
  return Math.round(rawBoost * weight);
}
