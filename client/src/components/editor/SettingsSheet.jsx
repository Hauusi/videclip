import { useEffect } from 'react';

export default function SettingsSheet({ open, onClose, title = 'Einstellungen', children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="settings-sheet-root" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="settings-sheet-backdrop" onClick={onClose} aria-label="Schließen" />
      <aside className="settings-sheet">
        <header className="settings-sheet-header">
          <h2 className="settings-sheet-title">{title}</h2>
          <button type="button" onClick={onClose} className="settings-sheet-close" aria-label="Schließen">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>
        <div className="settings-sheet-body scrollbar-thin">{children}</div>
      </aside>
    </div>
  );
}
