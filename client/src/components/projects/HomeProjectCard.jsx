import { expiryLabel } from '../../utils/projects';

export default function HomeProjectCard({ project, onOpen }) {
  const badge = expiryLabel(project);
  const thumb = project.thumbnailUrl || null;

  return (
    <button
      type="button"
      onClick={() => onOpen?.(project)}
      className="home-project-card"
      title={project.title}
    >
      <div className="home-project-card-media">
        {thumb ? (
          <img src={thumb} alt="" className="home-project-card-thumb" loading="lazy" />
        ) : (
          <div className="home-project-card-thumb home-project-card-thumb--empty">
            <span aria-hidden>▶</span>
          </div>
        )}
        <div className="home-project-card-shade" aria-hidden />
        {badge && <span className="home-project-card-badge">{badge}</span>}
        {project.saved && (
          <span className="home-project-card-badge home-project-card-badge--saved">★</span>
        )}
        {project.clipCount > 0 && (
          <span className="home-project-card-clips">{project.clipCount} Clips</span>
        )}
      </div>
      <div className="home-project-card-body">
        <p className="home-project-card-title">{project.title}</p>
        <p className="home-project-card-meta">{project.plan || 'ClipBasic'}</p>
      </div>
    </button>
  );
}
