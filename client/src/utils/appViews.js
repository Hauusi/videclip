/** App view IDs — foundation for workspace routing (Phase 0+). */
export const APP_VIEWS = {
  HOME: 'home',
  CLIPS: 'clips',
  LIBRARY: 'library',
  EDITOR: 'editor',
};

/** Map legacy `activeView` + session state to a resolved view. */
export function resolveAppView({ activeView, editingHighlightId, result }) {
  if (editingHighlightId && result) return APP_VIEWS.EDITOR;
  if (activeView === 'projects') return APP_VIEWS.LIBRARY;
  if (result) return APP_VIEWS.CLIPS;
  return APP_VIEWS.HOME;
}

export function isLibraryView(activeView) {
  return activeView === 'projects';
}
