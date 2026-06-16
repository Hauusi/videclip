import { useState } from 'react';

/** Vertical expandable sections — Cinema Editor sheet (Phase 2). */
export default function EditorStepList({
  sections,
  defaultOpen = 'clip',
  panelRef,
  className = '',
}) {
  const [openId, setOpenId] = useState(defaultOpen);

  return (
    <div className={`editor-step-list ${className}`}>
      {sections.map((section) => {
        const isOpen = openId === section.id;
        return (
          <div key={section.id} className={`editor-step-list-item ${isOpen ? 'editor-step-list-item--open' : ''}`}>
            <button
              type="button"
              className="editor-step-list-trigger"
              aria-expanded={isOpen}
              onClick={() => setOpenId(isOpen ? '' : section.id)}
            >
              <span className="editor-step-list-num">{section.step}</span>
              <span className="editor-step-list-text">
                <span className="editor-step-list-title">{section.title}</span>
                {section.subtitle && (
                  <span className="editor-step-list-sub">{section.subtitle}</span>
                )}
              </span>
              <svg
                className={`editor-step-list-chevron ${isOpen ? 'editor-step-list-chevron--open' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {isOpen && (
              <div
                ref={section.id === openId ? panelRef : undefined}
                className="editor-step-list-panel animate-fade-in"
              >
                {section.children}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
