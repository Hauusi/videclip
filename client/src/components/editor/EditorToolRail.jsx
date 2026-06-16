import { useState } from 'react';

const TAB_LABELS = {
  clip: 'Ausschnitt',
  hook: 'Hook',
  look: 'Look',
  overlays: 'Overlays',
  music: 'Musik',
  captions: 'Untertitel',
};

/** Inline tool tabs under the preview — edit in place, no settings overlay. */
export default function EditorToolRail({
  sections,
  defaultTab = 'clip',
  panelRef,
  className = '',
  montage = false,
}) {
  const [activeId, setActiveId] = useState(defaultTab);
  const active =
    sections.find((s) => s.id === activeId) || sections[0];

  if (!sections.length) return null;

  return (
    <section className={`editor-tool-rail ${className}`} aria-label="Clip bearbeiten">
      <div className="editor-tool-rail-head">
        <p className="type-label">Werkzeuge</p>
        {active?.subtitle && (
          <p className="editor-tool-rail-hint">{active.subtitle}</p>
        )}
      </div>

      <div className="editor-tool-tabs" role="tablist">
        {sections.map((section) => {
          const isActive = section.id === active?.id;
          const label =
            section.tabLabel ||
            (section.id === 'clip' && montage ? 'Montage' : TAB_LABELS[section.id] || section.title);
          return (
            <button
              key={section.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`editor-tool-tab ${isActive ? 'editor-tool-tab--active' : ''}`}
              onClick={() => setActiveId(section.id)}
            >
              {label}
            </button>
          );
        })}
      </div>

      {active && (
        <div
          ref={panelRef}
          key={active.id}
          role="tabpanel"
          className="editor-tool-panel animate-fade-in scrollbar-thin"
        >
          {active.children}
        </div>
      )}
    </section>
  );
}
