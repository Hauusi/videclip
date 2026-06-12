const FILLERS = /\b(um|uh|like|you know|sort of|kind of|i mean|basically|actually|literally)\b/gi;

function stripFillers(text) {
  return String(text || '')
    .replace(FILLERS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const IMPACT_WORDS = new Set([
  'never', 'always', 'secret', 'insane', 'crazy', 'unbelievable', 'shocking', 'wow', 'wtf', 'omg',
  'niemals', 'geheim', 'krass', 'wahnsinn', 'unglaublich', 'schock', 'alter', 'bro', 'wait', 'warte',
  'best', 'worst', 'finally', 'truth', 'beste', 'schlimmste', 'endlich', 'wahrheit',
  'why', 'how', 'what', 'warum', 'wieso', 'look', 'schau', 'guck', 'listen', 'hör',
  'joke', 'laugh', 'funny', 'hilarious', 'lol', 'haha', 'witz', 'lachen', 'lustig',
  'react', 'reaction', 'scared', 'no', 'way', 'yes', 'ja', 'nein', 'heilige', 'holy',
]);

const IMPACT_PATTERNS = [
  /\b(oh my god|no way|what the|holy shit|holy|wtf|omg)\b/i,
  /\b(oh mein gott|auf keinen|alter|scheiße)\b/i,
];

export function isImpactWord(text) {
  const clean = stripFillers(text)
    .replace(/[^\wäöüßÄÖÜ]/gi, ' ')
    .trim()
    .toLowerCase();
  if (!clean || clean.length < 3) return false;

  const token = clean.split(/\s+/)[0];
  if (token.length >= 4 && IMPACT_WORDS.has(token)) return true;

  for (const re of IMPACT_PATTERNS) {
    if (re.test(clean)) return true;
  }

  if (/!/.test(String(text || '')) && token.length >= 3) return true;
  return false;
}

/** Max one highlighted word every `minGap` words. */
export function pickHighlightIndices(words, { minGap = 3, enabled = true } = {}) {
  if (!enabled || !words?.length) return new Set();

  const indices = new Set();
  let sinceLast = minGap;

  for (let i = 0; i < words.length; i++) {
    sinceLast += 1;
    if (sinceLast < minGap) continue;
    if (!isImpactWord(words[i].text)) continue;
    indices.add(i);
    sinceLast = 0;
  }

  return indices;
}

export function normalizeCaptionStyle(style) {
  const s = String(style || 'bold').toLowerCase();
  if (s === 'minimal' || s === 'fire') return s;
  return 'bold';
}
