import Anthropic from '@anthropic-ai/sdk';
import { config, buildHighlightSystemPrompt, isAnthropicKeyConfigured } from '../config.js';
import { AppError } from '../utils/errors.js';
import { parseJsonArray } from '../utils/parseJson.js';
import {
  findHighlightCandidates,
  formatCandidatesForClaude,
  highlightFromCandidate,
  ensureHighlightReason,
} from './highlightCandidates.js';
import { boostCandidatesWithMultiSignal } from './candidateAudioScore.js';
import { getCategoryLabel, getCategoryProfile, isShooterContent } from './gameCategory.js';
import { inferShooterFromSignals } from './shooterClusters.js';
import { scanAudioEnergy } from './audioEnergyScan.js';
import { scanShooterKillFeed } from './hudKillFeed.js';
import { finalizeHighlights } from './highlightQuality.js';
import { selectShooterHighlights } from './shooterHighlightSelect.js';

const client = () => {
  if (!isAnthropicKeyConfigured()) {
    throw new AppError(
      'Anthropic API key missing or invalid. Set ANTHROPIC_API_KEY in server/.env (get one at console.anthropic.com)',
      401,
    );
  }
  return new Anthropic({ apiKey: config.anthropicApiKey });
};

function wrapClaudeError(err) {
  const msg = err?.message || String(err);
  const status = err?.status || err?.statusCode;
  if (
    status === 401 ||
    /authentication_error|invalid x-api-key|invalid api key/i.test(msg)
  ) {
    throw new AppError(
      'Invalid Anthropic API key. Update ANTHROPIC_API_KEY in server/.env with a valid key from console.anthropic.com',
      401,
    );
  }
  if (status === 404 || /not_found_error|model:/i.test(msg)) {
    throw new AppError(
      `Claude model "${config.claudeModel}" not found. Set CLAUDE_MODEL=claude-sonnet-4-6 in server/.env`,
      404,
    );
  }
  throw err;
}

function normalizeHighlight(h, index) {
  const start = parseFloat(h.start_time) || 0;
  let end = parseFloat(h.end_time) || start + 25;
  if (end - start < 12) end = start + 12;
  if (end - start > 45) end = start + 45;

  return {
    id: `hl-${index}-${Math.random().toString(36).slice(2, 8)}`,
    start_time: start,
    end_time: end,
    title: String(h.title || 'Highlight').slice(0, 60),
    hook: String(h.hook || '').slice(0, 200),
    hook_peak_time: Number.isFinite(Number(h.hook_peak_time))
      ? parseFloat(h.hook_peak_time)
      : undefined,
    platform_fit: Array.isArray(h.platform_fit) ? h.platform_fit : ['shorts'],
    viral_score: Math.min(10, Math.max(1, Number(h.viral_score) || 5)),
    reason: ensureHighlightReason(
      {
        title: String(h.title || 'Highlight').slice(0, 60),
        reason: String(h.reason || '').trim(),
        hook: String(h.hook || ''),
        peak_line: h.peak_line,
        setup_line: h.setup_line,
        excerpt: h.excerpt,
        start_time: start,
      },
      'en',
    ),
    zoom_moments: Array.isArray(h.zoom_moments) ? h.zoom_moments.map(Number) : [],
    caption_style: ['bold', 'minimal', 'fire'].includes(h.caption_style) ? h.caption_style : 'bold',
    confidence: Number.isFinite(Number(h.confidence)) ? Number(h.confidence) : undefined,
  };
}

function parseHighlights(raw) {
  try {
    const parsed = parseJsonArray(raw);
    return parsed.map((h, i) => normalizeHighlight(h, i));
  } catch (err) {
    throw new AppError(
      `AI returned invalid JSON: ${err.message}. Try analyzing again.`,
      502,
    );
  }
}

function resolveCandidateId(pick) {
  const raw = pick.candidate_id ?? pick.id ?? pick.candidate ?? pick.pick;
  const num = parseInt(String(raw).replace(/^#/, ''), 10);
  return Number.isFinite(num) ? num : null;
}

/** Parse Claude ID-only picks and bind immutable candidate windows. */
function parseCandidatePicks(raw, candidates, outputLanguage = 'en') {
  const parsed = parseJsonArray(raw);
  const highlights = [];

  for (let i = 0; i < parsed.length; i++) {
    const pick = parsed[i];
    const listIndex = resolveCandidateId(pick);
    if (listIndex == null || listIndex < 1 || listIndex > candidates.length) {
      console.warn('[highlights] Claude returned invalid candidate_id:', pick);
      continue;
    }
    const candidate = candidates[listIndex - 1];
    const h = highlightFromCandidate(candidate, pick, highlights.length, outputLanguage);
    if (h) highlights.push(h);
  }

  if (!highlights.length) {
    throw new AppError('AI returned no valid candidate picks', 502);
  }

  return highlights;
}

function buildVideoContext({ title, duration, description, urlFocusSec }) {
  const lines = [`Video title: ${title || 'Unknown'}`];
  if (duration) lines.push(`Video duration: ${Math.round(duration)} seconds`);
  if (urlFocusSec != null) {
    lines.push(
      `Viewer linked to ~${Math.round(urlFocusSec)}s — include at least one strong clip near this moment if supported.`,
    );
  }
  if (description) {
    lines.push(`Description: ${String(description).slice(0, 180)}`);
  }
  return lines.join('\n');
}

async function requestClaude({ system, userContent, maxTokens = 520 }) {
  const response = await client().messages.create({
    model: config.claudeModel,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userContent }],
  });

  const block = response.content.find((c) => c.type === 'text');
  if (!block?.text) throw new AppError('Empty response from Claude', 502);
  return block.text;
}

async function callClaudeCandidateRank(userContent, mood, candidates, outputLanguage = 'en') {
  const system = buildHighlightSystemPrompt(mood, { outputLanguage });

  try {
    let raw = await requestClaude({ system, userContent, maxTokens: 520 });
    try {
      return parseCandidatePicks(raw, candidates, outputLanguage);
    } catch {
      raw = await requestClaude({
        system,
        userContent: `${userContent}\n\nReturn ONLY a valid JSON array with candidate_id fields.`,
        maxTokens: 520,
      });
      return parseCandidatePicks(raw, candidates, outputLanguage);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    wrapClaudeError(err);
  }
}

async function callClaudeLegacyRank(userContent, mood, outputLanguage = 'en') {
  const system = buildHighlightSystemPrompt(mood, { legacyTimestamps: true, outputLanguage });

  try {
    let raw = await requestClaude({ system, userContent, maxTokens: 520 });
    try {
      return parseHighlights(raw);
    } catch {
      raw = await requestClaude({
        system,
        userContent: `${userContent}\n\nReturn ONLY valid JSON array.`,
        maxTokens: 520,
      });
      return parseHighlights(raw);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    wrapClaudeError(err);
  }
}

export function dedupeHighlights(highlights, minGapSec = 22) {
  const sorted = [...highlights].sort(
    (a, b) => (b.viral_score || 0) - (a.viral_score || 0) || (b.confidence || 0) - (a.confidence || 0),
  );
  const kept = [];

  for (const h of sorted) {
    if (kept.length >= 7) break;
    const overlap = kept.some((k) => overlapRatio(k, h) > 0.4);
    const tooClose = kept.some((k) => Math.abs(k.start_time - h.start_time) < minGapSec);
    if (!overlap && !tooClose) kept.push(h);
  }

  return kept.length ? kept : sorted.slice(0, 5);
}

function overlapRatio(a, b) {
  const start = Math.max(a.start_time, b.start_time);
  const end = Math.min(a.end_time, b.end_time);
  if (end <= start) return 0;
  const overlap = end - start;
  const lenA = a.end_time - a.start_time;
  const lenB = b.end_time - b.start_time;
  const minLen = Math.min(lenA, lenB) || 1;
  return overlap / minLen;
}

async function getCandidates(context) {
  const { segments, duration, chapterAnchors, sourceVideo } = context;
  const dur = Number(duration) || 0;
  const isLongSource = dur >= 2 * 3600;
  const isVeryLongSource = dur >= 4 * 3600;

  // Full-video loudness scan: drives anchor discovery, not just re-ranking.
  let audioScan = context.audioScan;
  if (sourceVideo && audioScan === undefined) {
    try {
      const t0 = Date.now();
      audioScan = await scanAudioEnergy(sourceVideo);
      console.log(
        `[highlights] Audio energy scan: ${audioScan.length} buckets (${Math.round(audioScan.durationSec)}s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    } catch (err) {
      console.warn('[highlights] Audio scan failed, text-only candidates:', err.message?.slice(0, 120));
      audioScan = null;
    }
    context.audioScan = audioScan;
  }

  let categoryProfile = context.categoryProfile;
  if (isShooterContent(context)) {
    categoryProfile = getCategoryProfile('shooter');
    context.categoryProfile = categoryProfile;
    context.contentCategory = 'shooter';
  }

  if (audioScan && categoryProfile?.id !== 'shooter') {
    const inferred = inferShooterFromSignals(audioScan, segments);
    if (inferred) {
      console.log(`[highlights] Shooter inferred from gameplay: ${inferred.game} (${inferred.reason})`);
      categoryProfile = getCategoryProfile('shooter');
      context.categoryProfile = categoryProfile;
      context.contentCategory = 'shooter';
      context.contentGame = context.contentGame || inferred.game;
    }
  }

  let killFeedEvents = context.killFeedEvents;
  if (sourceVideo && categoryProfile?.id === 'shooter' && killFeedEvents === undefined) {
    killFeedEvents = await scanShooterKillFeed(sourceVideo, {
      audioScan,
      duration: dur,
      categoryProfile,
      channel: context.channel || '',
      title: context.title || '',
    });
    context.killFeedEvents = killFeedEvents;
  }

  let candidates = findHighlightCandidates(segments, duration, {
    chapterAnchors,
    categoryProfile,
    audioScan,
    killFeedEvents: killFeedEvents || [],
    channel: context.channel || '',
    title: context.title || '',
  });

  if (sourceVideo && candidates.length) {
    // Audio is already in the composite via the scan — only add visual events here
    const includeVisual = !isLongSource;
    if (audioScan && !includeVisual) return candidates;

    candidates = await boostCandidatesWithMultiSignal(candidates, sourceVideo, {
      limit: isVeryLongSource ? 6 : isLongSource ? 8 : 12,
      includeVisual,
      liteAudio: isVeryLongSource,
      categoryProfile,
      skipAudio: Boolean(audioScan),
    });
  }

  return candidates;
}

function buildCandidateRankPrompt(context, candidates) {
  const {
    duration,
    title,
    description,
    mood,
    urlFocusSec,
    outputLanguage,
    contentCategory,
    contentGame,
    categoryProfile,
  } = context;
  const langNote =
    outputLanguage === 'de'
      ? 'Antworte auf Deutsch: title und reason jeweils auf Deutsch formulieren.'
      : 'Write title and reason in English.';

  const categoryLines = [];
  if (contentCategory && contentCategory !== 'generic') {
    const label = getCategoryLabel(contentCategory);
    categoryLines.push(
      `Content category: ${label}${contentGame ? ` (${contentGame})` : ''} — category rules apply.`,
    );
    if (categoryProfile?.claudeHint) {
      categoryLines.push(categoryProfile.claudeHint);
    }
  }

  return [
    buildVideoContext({ title, duration, description, urlFocusSec }),
    langNote,
    `Mood: ${mood || 'hype'} (tie-breaker only)`,
    ...categoryLines,
    'Pick the 5 strongest candidates by standalone payoff and pacing.',
    'SHOOTER/FPS HARD RULES:',
    '- ONLY pick multikill-montage candidates (MONTAGE:Ncuts flag) when available — these are jump-cut kill compilations.',
    '- NEVER pick plant/defuse/hold/rotate/eco windows without kills. Holding a bombsite is NOT a highlight.',
    '- Reject any 30s+ calm window with no multikill-montage, hud-kills, or kill-feed flags.',
    'PRIORITIZE multikill-montage > hud-kills > kill-feed > hype-moment.',
    'multikill-montage = several kills from one round cut together — this is what viewers want.',
    'Prefer action over talk. Calm explanation or post-plant holds are NEVER highlights.',
    'Use candidate_id only — timestamps are fixed locally. Spread across timeline.',
    'Cold-open hooks are assigned locally — judge clip BODY quality (setup→payoff), not scroll-stop.',
    '',
    formatCandidatesForClaude(candidates),
    '',
    'JSON array only, exactly 5 items.',
  ].join('\n');
}

function isShooterContext(context) {
  return isShooterContent(context);
}

async function rankCandidates(context) {
  const candidates = await getCandidates(context);

  if (!candidates.length) {
    throw new AppError(
      context.hasTranscript === false
        ? 'No kill montage candidates from audio/HUD (transcript unavailable for this video).'
        : 'No highlight candidates found in transcript',
      502,
    );
  }

  if (isShooterContext(context)) {
    const highlights = selectShooterHighlights(
      candidates,
      context.segments,
      context.duration,
      {
        urlFocusSec: context.urlFocusSec,
        outputLanguage: context.outputLanguage || 'de',
      },
    );
    if (!highlights.length) {
      throw new AppError(
        'No kill montage candidates found — video may have too few combat moments for shooter clips.',
        502,
      );
    }
    return { highlights, candidates };
  }

  console.log(
    `[highlights] ${candidates.length} candidates for Claude (scores ${candidates[0].local_score}–${candidates[candidates.length - 1].local_score})`,
  );

  const userContent = buildCandidateRankPrompt(context, candidates);
  const ranked = dedupeHighlights(
    await callClaudeCandidateRank(
      userContent,
      context.mood,
      candidates,
      context.outputLanguage || 'en',
    ),
    18,
  );

  return { highlights: ranked, candidates };
}

async function analyzeFromFullTranscript(context) {
  const { formattedText, duration, title, description, mood, segments, chapterAnchors } = context;

  if (segments?.length >= 12) {
    const candidates = await getCandidates(context);
    if (candidates.length >= 4) {
      console.log(`[highlights] Candidate ranking (${candidates.length} windows)`);
      const userContent = buildCandidateRankPrompt(context, candidates);
      return callClaudeCandidateRank(
        userContent,
        mood,
        candidates,
        context.outputLanguage || 'en',
      );
    }
  }

  console.log('[highlights] Short transcript — direct Claude pass');
  const langNote =
    context.outputLanguage === 'de'
      ? 'Antworte auf Deutsch: title und reason auf Deutsch.'
      : 'Write title and reason in English.';
  const userContent = [
    buildVideoContext({ title, duration, description }),
    langNote,
    `Mood: ${mood || 'hype'}`,
    `Transcript:\n${formattedText}`,
    'Return exactly 5 highlights as a JSON array. Each clip 12–45s.',
  ].join('\n\n');

  return callClaudeLegacyRank(userContent, mood, context.outputLanguage || 'en');
}

async function analyzeFromMetadata(context) {
  const { title, description, duration, mood, outputLanguage } = context;

  console.log('[highlights] No transcript — metadata-only selection');

  const langNote =
    outputLanguage === 'de'
      ? 'Antworte auf Deutsch: title und reason auf Deutsch.'
      : 'Write title and reason in English.';

  const userContent = [
    buildVideoContext({ title, duration, description }),
    langNote,
    `Mood: ${mood || 'hype'}`,
    'No transcript. Infer 5 engaging short-form moments from title/description.',
    'Spread across the video timeline. Each clip 15–40 seconds.',
    'Return exactly 5 highlights as a JSON array with start_time and end_time.',
  ].join('\n\n');

  return callClaudeLegacyRank(userContent, mood, context.outputLanguage || 'en');
}

/**
 * @param {object} context
 * @param {boolean} context.hasTranscript
 * @param {Array} [context.segments]
 * @param {string} [context.formattedText]
 * @param {string} [context.title]
 * @param {number} [context.duration]
 * @param {string} [context.description]
 * @param {string} [context.mood]
 * @param {Array} [context.chapterAnchors]
 * @param {string} [context.sourceVideo]
 */
export async function analyzeHighlights(context) {
  const mood = context.mood || 'hype';
  const { segments, duration, urlFocusSec } = context;

  let highlights = [];
  let candidates = [];

  if (context.hasTranscript && context.segments?.length) {
    if (context.segments.length >= 15 || (context.duration && context.duration > 300)) {
      const result = await rankCandidates({ ...context, mood });
      highlights = result.highlights;
      candidates = result.candidates;
    } else {
      candidates = await getCandidates(context);
      if (isShooterContext(context) && candidates.length) {
        highlights = selectShooterHighlights(candidates, segments, duration, {
          urlFocusSec,
          outputLanguage: context.outputLanguage || 'de',
        });
      } else if (candidates.length >= 4) {
        const userContent = buildCandidateRankPrompt({ ...context, mood }, candidates);
        highlights = dedupeHighlights(
          await callClaudeCandidateRank(
            userContent,
            mood,
            candidates,
            context.outputLanguage || 'en',
          ),
          18,
        );
      } else {
        highlights = dedupeHighlights(
          await analyzeFromFullTranscript({ ...context, mood }),
          18,
        );
      }
    }
  } else if (context.formattedText && !context.formattedText.startsWith('No transcript')) {
    highlights = dedupeHighlights(
      await analyzeFromFullTranscript({ ...context, mood }),
      18,
    );
  } else if (context.sourceVideo && isShooterContext(context)) {
    console.log('[highlights] No transcript — shooter audio/HUD montage path');
    const result = await rankCandidates({ ...context, mood, segments: segments || [] });
    highlights = result.highlights;
    candidates = result.candidates;
  } else {
    console.warn(
      `[highlights] Metadata fallback (sourceVideo=${Boolean(context.sourceVideo)}, ` +
        `shooter=${isShooterContext(context)}, category=${context.contentCategory || 'n/a'})`,
    );
    highlights = dedupeHighlights(await analyzeFromMetadata({ ...context, mood }), 18);
  }

  if (segments?.length && candidates.length) {
    if (isShooterContext(context)) {
      highlights = selectShooterHighlights(candidates, segments, duration, {
        urlFocusSec,
        outputLanguage: context.outputLanguage || 'de',
      });
      console.log(`[highlights] Shooter montage-only selection: ${highlights.length} clips`);
    } else {
      highlights = finalizeHighlights(
        highlights,
        candidates,
        segments,
        duration,
        urlFocusSec,
        { contentCategory: context.contentCategory, categoryProfile: context.categoryProfile },
      );
      console.log(`[highlights] Final selection after quality pass: ${highlights.length} clips`);
    }
  } else if (!candidates.length) {
    highlights = highlights.slice(0, 5).map((h, i) => ({
      ...h,
      id: `hl-${i}-${Math.random().toString(36).slice(2, 8)}`,
    }));
  }

  return highlights;
}
