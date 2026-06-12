const STOP_WORDS = new Set([
  'gaming',
  'live',
  'tv',
  'cs2',
  'csgo',
  'twitch',
  'youtube',
  'official',
  'channel',
  'stream',
  'highlights',
  'gameplay',
  'counter',
  'strike',
  'the',
  'und',
  'der',
  'die',
  'full',
  'voice',
  'comms',
  'soloq',
  'ranked',
  'match',
  'kills',
]);

/** Tokens from YouTube channel / title for kill-feed OCR matching. */
export function streamerNameTokens(channel = '', title = '') {
  const tokens = new Set();
  for (const src of [channel, title]) {
    if (!src) continue;
    for (const part of String(src).split(/[\s_|–\-:()[\]]+/)) {
      let t = part.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      if (t.length >= 4 && !STOP_WORDS.has(t)) tokens.add(t);
      if (t.length > 6) {
        t = t.replace(/(gaming|live|tv|cs2|csgo)$/i, '');
        if (t.length >= 4 && !STOP_WORDS.has(t)) tokens.add(t);
      }
    }
  }
  return [...tokens];
}

export function feedTextNamesStreamer(text, tokens) {
  if (!text || !tokens?.length) return false;
  const norm = String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm.length < 3) return false;
  return tokens.some((t) => t.length >= 3 && norm.includes(t));
}
