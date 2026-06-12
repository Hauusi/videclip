import HomeProjectsRail from '../projects/HomeProjectsRail';
import SkeletonCard from '../SkeletonCard';

export default function AnalyzingWorkspace({
  projects = [],
  job = null,
  onOpenProject,
  onViewAllProjects,
}) {
  const progress = job?.progress ?? 12;
  const message = job?.message || 'KI analysiert dein Video…';

  return (
    <div className="analyzing-workspace flex-1 flex flex-col min-h-0 w-full animate-fade-in-up">
      <HomeProjectsRail
        projects={projects}
        onOpenProject={onOpenProject}
        onViewAll={onViewAllProjects}
        analyzing
        job={job}
      />

      <section
        className="analyzing-clips-preview px-4 lg:px-6 pb-8 max-w-[1600px] mx-auto w-full flex-1 min-h-0"
        aria-busy="true"
        aria-label="Clips werden vorbereitet"
      >
        <div className="flex flex-wrap items-end justify-between gap-3 pt-4 pb-5">
          <div>
            <h2 className="text-xl font-bold text-theme tracking-tight">Deine Clips</h2>
            <p className="text-sm text-theme-muted mt-1">{message}</p>
          </div>
          <div className="analyzing-clips-progress-pill" aria-hidden>
            <span className="analyzing-clips-progress-ring">{Math.round(progress)}%</span>
            <span className="text-xs text-theme-muted">Analyse läuft</span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 justify-items-stretch items-stretch w-full">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="analyzing-skeleton-slot"
              style={{ animationDelay: `${i * 0.12}s` }}
            >
              <SkeletonCard />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
