import { useState } from 'react';

export default function EditorAccordion({
  sections,
  defaultOpen = 'clip',
  panelRef,
  className = '',
}) {
  const [openId, setOpenId] = useState(defaultOpen);
  const activeIndex = sections.findIndex((s) => s.id === openId);
  const active = sections[activeIndex >= 0 ? activeIndex : 0];
  const prev = activeIndex > 0 ? sections[activeIndex - 1] : null;
  const next = activeIndex < sections.length - 1 ? sections[activeIndex + 1] : null;
  const progressPct = ((activeIndex + 1) / sections.length) * 100;

  return (
    <div className={`flex flex-col min-h-0 gap-3 ${className}`}>
      <div className="editor-step-nav shrink-0">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-2xs font-semibold uppercase tracking-wider text-theme-muted">
            Schritt {active.step} von {sections.length}
          </span>
          <span className="text-2xs text-peak-purple font-medium tabular-nums">
            {Math.round(progressPct)}%
          </span>
        </div>
        <div className="editor-step-progress" aria-hidden>
          <div className="editor-step-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>

        <div className="editor-step-grid mt-2.5" role="tablist" aria-label="Editor-Schritte">
          {sections.map((section) => {
            const isActive = openId === section.id;
            const isDone = section.step < active.step;
            return (
              <button
                key={section.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setOpenId(section.id)}
                className={`editor-step-tile ${isActive ? 'editor-step-tile--active' : ''} ${
                  isDone ? 'editor-step-tile--done' : ''
                }`}
              >
                <span className="editor-step-tile-num">{section.step}</span>
                <span className="editor-step-tile-label">{section.title}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="editor-step-body animate-fade-in flex flex-col min-h-0 overflow-hidden" role="tabpanel">
        <div className="space-y-0.5 px-4 pt-4 pb-3 border-b border-theme shrink-0">
          <p className="editor-step-heading">{active.title}</p>
          <p className="editor-step-sub">{active.subtitle}</p>
        </div>

        <div
          ref={panelRef}
          key={active.id}
          className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-4 py-3 space-y-3"
        >
          {active.children}
        </div>

        <div className="editor-step-footer shrink-0 px-4 pb-4">
          <button
            type="button"
            disabled={!prev}
            onClick={() => prev && setOpenId(prev.id)}
            className="editor-step-nav-btn"
          >
            <span className="text-peak-purple">←</span>
            <span className="truncate">{prev?.title ?? '—'}</span>
          </button>
          <button
            type="button"
            disabled={!next}
            onClick={() => next && setOpenId(next.id)}
            className="editor-step-nav-btn editor-step-nav-btn--next"
          >
            <span className="truncate">{next?.title ?? '—'}</span>
            <span className="text-peak-purple">→</span>
          </button>
        </div>
      </div>
    </div>
  );
}
