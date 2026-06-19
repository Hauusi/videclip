/** Debug UI (kill export panel, segment links) — `?debug=1` only. */
export function isDebugUiEnabled() {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('debug') === '1';
}
