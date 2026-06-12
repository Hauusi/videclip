import HomeProjectCard from './HomeProjectCard';
import AnalyzingProjectCard from './AnalyzingProjectCard';

const HOME_LIMIT = 8;

export default function HomeProjectsRail({
  projects = [],
  onOpenProject,
  onViewAll,
  analyzing = false,
  job = null,
}) {
  const visible = projects.slice(0, HOME_LIMIT);
  if (!visible.length && !analyzing) return null;

  return (
    <section className="home-projects-rail" aria-label="Deine Projekte">
      <div className="home-projects-rail-inner">
        <div className="home-projects-rail-head">
          <div>
            <p className="type-label">Deine Projekte</p>
            <p className="text-sm text-theme-muted mt-0.5 hidden sm:block">
              {analyzing
                ? 'Neue Analyse läuft — erscheint gleich in deiner Liste'
                : 'Fertige Analysen — jederzeit weiterbearbeiten'}
            </p>
          </div>
          {projects.length > 0 && (
            <button type="button" onClick={onViewAll} className="home-projects-rail-link">
              Alle anzeigen
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>

        <div className="home-projects-rail-scroll scrollbar-thin">
          <div className="home-projects-rail-track">
            {analyzing && (
              <AnalyzingProjectCard
                progress={job?.progress ?? 12}
                message={job?.message || ''}
              />
            )}
            {visible.map((project) => (
              <HomeProjectCard
                key={project.id}
                project={project}
                onOpen={onOpenProject}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
