import { useState, useRef, useEffect } from 'react';
import { expiryLabel } from '../../utils/projects';

export default function ProjectCard({ project, onOpen, onToggleSave, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const badge = expiryLabel(project);
  const thumb = project.thumbnailUrl
    ? project.thumbnailUrl.startsWith('/')
      ? project.thumbnailUrl
      : project.thumbnailUrl
    : null;

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  return (
    <article className="project-card group">
      <button
        type="button"
        onClick={() => onOpen?.(project)}
        className="project-card-thumb-wrap"
      >
        {thumb ? (
          <img src={thumb} alt="" className="project-card-thumb" loading="lazy" />
        ) : (
          <div className="project-card-thumb project-card-thumb--empty">
            <span className="text-3xl opacity-40">▶</span>
          </div>
        )}
        {badge && <span className="project-card-expiry">{badge}</span>}
        {project.saved && <span className="project-card-saved">Gespeichert</span>}
      </button>

      <div className="project-card-meta">
        <button
          type="button"
          onClick={() => onOpen?.(project)}
          className="project-card-title text-left flex-1 min-w-0"
          title={project.title}
        >
          {project.title}
        </button>
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="project-card-menu-btn"
            aria-label="Projekt-Menü"
          >
            ···
          </button>
          {menuOpen && (
            <div className="project-card-menu">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onToggleSave?.(project, !project.saved);
                }}
              >
                {project.saved ? 'Aus Gespeicherten entfernen' : 'Speichern'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onOpen?.(project);
                }}
              >
                Öffnen
              </button>
              <button
                type="button"
                className="text-red-400"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete?.(project);
                }}
              >
                Löschen
              </button>
            </div>
          )}
        </div>
      </div>
      <p className="project-card-plan">
        {project.plan || 'ClipBasic'}
        {project.clipCount > 0 ? ` · ${project.clipCount} Clips` : ''}
      </p>
    </article>
  );
}
