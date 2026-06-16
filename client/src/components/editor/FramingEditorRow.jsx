import FramingBar from './FramingBar';

/** Compact framing controls + Editor toggle (side by side). */
export default function FramingEditorRow({
  framingValue,
  onFramingChange,
  editorOpen = false,
  onToggleEditor,
  showFraming = true,
}) {
  if (!showFraming && !onToggleEditor) return null;

  return (
    <div className="framing-editor-row">
      {showFraming && (
        <FramingBar
          compact
          value={framingValue}
          onChange={onFramingChange}
          className="framing-editor-row-bar"
        />
      )}
      <button
        type="button"
        className={`framing-editor-toggle ${editorOpen ? 'framing-editor-toggle--active' : ''}`}
        aria-pressed={editorOpen}
        onClick={onToggleEditor}
      >
        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
        <span>Editor</span>
      </button>
    </div>
  );
}
