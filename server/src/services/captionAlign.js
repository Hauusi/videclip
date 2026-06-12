/**
 * Caption timing: trust Whisper word timestamps.
 * Heavy RMS/burst filtering caused missing subs and wrong speaker words.
 */

const DISPLAY_LAG_SEC = 0.055;

function segmentStart(seg) {
  return Number(seg.offset ?? seg.start ?? 0);
}

function segmentEnd(seg) {
  return segmentStart(seg) + Number(seg.duration || 0.05);
}

/** Small uniform lag so captions don't appear before speech. */
export function refineWordTimings(segments) {
  if (!segments.length) return segments;

  const result = segments.map((seg) => {
    const start = segmentStart(seg) + DISPLAY_LAG_SEC;
    const end = Math.max(start + 0.05, segmentEnd(seg) + DISPLAY_LAG_SEC);
    return {
      ...seg,
      offset: start,
      duration: Math.max(0.05, end - start),
    };
  });

  console.log(
    `[caption-align] Applied ${(DISPLAY_LAG_SEC * 1000).toFixed(0)}ms display lag to ${result.length} words`,
  );
  return result;
}

/** @deprecated PCM alignment removed — was dropping words and mis-snapping cross-talk. */
export function alignSegmentsToAudio(segments) {
  return refineWordTimings(segments);
}

export async function readWavPcm16() {
  return new Int16Array(0);
}

export function alignmentSyncScore(segments) {
  return segments.length ? 1 : 0;
}
