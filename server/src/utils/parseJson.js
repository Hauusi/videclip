import { jsonrepair } from 'jsonrepair';

/** Extract the outermost JSON array from model output. */
export function extractJsonArray(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  }

  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON array found in response');
  }

  return cleaned.slice(start, end + 1);
}

/** Parse a JSON array from Claude output, repairing common LLM mistakes. */
export function parseJsonArray(raw) {
  const extracted = extractJsonArray(raw);

  try {
    const parsed = JSON.parse(extracted);
    if (!Array.isArray(parsed)) throw new Error('Expected JSON array');
    return parsed;
  } catch {
    const repaired = jsonrepair(extracted);
    const parsed = JSON.parse(repaired);
    if (!Array.isArray(parsed)) throw new Error('Expected JSON array');
    return parsed;
  }
}
