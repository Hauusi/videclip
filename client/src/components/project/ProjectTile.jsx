import { useState, useRef, useEffect, useCallback } from 'react';
import { expiryLabel, projectClipLabel, projectMetaLine, projectPreviewUrl } from '../../utils/projects';

/**
 * Unified project card — `variant="rail"` (home) or `variant="grid"` (library).
 */
export default function ProjectTile({
  project,
  variant = 'grid',
  onOpen,
  onToggleSave,
  onDelete,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const badge = expiryLabel(project);
  const thumb = project.thumbnailUrl || null;
  const previewUrl = projectPreviewUrl(project);
  const isRail = variant === 'rail';
  const [hovered, setHovered] = useState(false);
  const videoRef = useRef(null);

  const handleEnter = useCallback(() => {
    if (!previewUrl) return;
    setHovered(true);
    const v = videoRef.current;
    if (!v) return;
    v.muted = true;
    v.loop = true;
    v.play().catch(() => {});
  }, [previewUrl]);

  const handleLeave = useCallback(() => {
    setHovered(false);
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    try {
      v.currentTime = 0;
    } catch {
      /* ignore */
    }
  }, []);

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

  const media = (
    <div
      className="project-tile-media"
      onMouseEnter={!isRail && previewUrl ? handleEnter : undefined}
      onMouseLeave={!isRail && previewUrl ? handleLeave : undefined}
    >
      {previewUrl ? (
        <>
          <video
            ref={videoRef}
            src={previewUrl}
            muted
            playsInline
            preload="metadata"
            poster={thumb || undefined}
            className={`project-tile-thumb project-tile-thumb--video ${hovered ? 'project-tile-thumb--playing' : ''}`}
          />
          {thumb && !hovered && (
            <img src={thumb} alt="" className="project-tile-thumb project-tile-thumb--poster" loading="lazy" />
          )}
        </>
      ) : thumb ? (
        <img src={thumb} alt="" className="project-tile-thumb" loading="lazy" />
      ) : (
        <div className="project-tile-thumb project-tile-thumb--empty">
          <span aria-hidden>▶</span>
        </div>
      )}
      <div className="project-tile-shade" aria-hidden />
      <span className="project-tile-clips">{projectClipLabel(project.clipCount)}</span>
      {badge && <span className="project-tile-badge project-tile-badge--urgent">{badge}</span>}
      {project.saved && (
        <span
          className="project-tile-badge project-tile-badge--saved"
          title="Gespeichert"
        >
          {isRail ? '★' : 'Gespeichert'}
        </span>
      )}
    </div>
  );

  if (isRail) {
    return (
      <button
        type="button"
        onClick={() => onOpen?.(project)}
        className="project-tile project-tile--rail"
        title={project.title}
      >
        {media}
        <div className="project-tile-body">
          <p className="project-tile-title">{project.title}</p>
          <p className="project-tile-meta">{projectMetaLine(project)}</p>
        </div>
      </button>
    );
  }

  return (
    <article className="project-tile project-tile--grid group">
      <button type="button" onClick={() => onOpen?.(project)} className="project-tile-hit">
        {media}
      </button>
      <div className="project-tile-footer">
        <button
          type="button"
          onClick={() => onOpen?.(project)}
          className="project-tile-title project-tile-title--btn"
          title={project.title}
        >
          {project.title}
        </button>
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="project-tile-menu-btn"
            aria-label="Projekt-Menü"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden>
              <circle cx="4" cy="10" r="1.5" />
              <circle cx="10" cy="10" r="1.5" />
              <circle cx="16" cy="10" r="1.5" />
            </svg>
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
                {project.saved ? 'Aus Gespeicherten entfernen' : 'Dauerhaft speichern'}
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
      <p className="project-tile-meta project-tile-meta--footer">{projectMetaLine(project)}</p>
    </article>
  );
}
