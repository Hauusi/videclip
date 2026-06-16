import VideoSourceInput from '../components/layout/VideoSourceInput';
import HomeProjectCard from '../components/projects/HomeProjectCard';
import AnalyzingProjectCard from '../components/projects/AnalyzingProjectCard';

const FEATURES = [
  { icon: '⚡', label: 'KI-Highlight-Erkennung' },
  { icon: '🎯', label: 'Cold-Open Hooks' },
  { icon: '📱', label: '9:16 Shorts-Export' },
];

const HOME_LIMIT = 5;

export default function HomeWorkspace({
  url,
  onUrlChange,
  onUrlPaste,
  onAnalyze,
  onLocalUpload,
  onClearLocal,
  analyzing,
  urlError,
  localFileName,
  projects = [],
  onOpenProject,
  onViewAllProjects,
  job = null,
}) {
  const recent = projects.slice(0, HOME_LIMIT);
  const showBento = recent.length > 0 || analyzing;

  return (
    <div className="home-workspace relative flex-1 flex flex-col w-full min-h-0 animate-fade-in-up">
      <div className="home-workspace-hero relative z-10 px-4 sm:px-6">
        <div className="w-full max-w-3xl mx-auto text-center space-y-8 py-10 sm:py-14 lg:py-16">
          <div className="space-y-4">
            <p className="text-2xs font-semibold uppercase tracking-[0.22em] text-peak-purple">
              Only the peaks
            </p>
            <h1 className="type-display text-2xl sm:text-[2rem] font-bold text-theme tracking-tight leading-tight">
              Link oder Datei —{' '}
              <span className="gradient-text-clip">virale Clips</span> in Minuten
            </h1>
            <p className="text-sm sm:text-base text-theme-muted max-w-lg mx-auto leading-relaxed">
              YouTube-Link einfügen oder Video hochladen. PeakClip findet die besten Momente und
              bereitet Hook, Untertitel und Export vor.
            </p>
          </div>

          {analyzing ? (
            <div className="peak-panel p-6 shadow-glow-lg text-center analyzing-hero-status">
              <p className="text-sm font-medium text-theme">Analyse läuft im Hintergrund</p>
              <p className="text-xs text-theme-muted mt-2">
                {job?.message || 'Clips erscheinen gleich — Fortschritt unten in der Leiste.'}
              </p>
            </div>
          ) : (
            <div className="peak-panel p-2 shadow-glow-lg text-left">
              <VideoSourceInput
                variant="hero"
                url={url}
                onUrlChange={onUrlChange}
                onUrlPaste={onUrlPaste}
                onAnalyze={onAnalyze}
                onLocalUpload={onLocalUpload}
                onClearLocal={onClearLocal}
                analyzing={analyzing}
                urlError={urlError}
                localFileName={localFileName}
              />
            </div>
          )}

          <div className="flex flex-wrap justify-center gap-2 pt-1">
            {FEATURES.map((f) => (
              <span key={f.label} className="import-feature-pill">
                <span aria-hidden>{f.icon}</span>
                {f.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {showBento && (
        <section className="home-bento relative z-10 px-4 sm:px-6 pb-8 sm:pb-10" aria-label="Workspace">
          <div className="home-bento-grid max-w-6xl mx-auto">
            <div className="home-bento-panel home-bento-panel--recent">
              <div className="home-bento-head">
                <div>
                  <p className="type-label">Zuletzt bearbeitet</p>
                  <p className="text-sm text-theme-muted mt-0.5 hidden sm:block">
                    Fertige Analysen — jederzeit weiterbearbeiten
                  </p>
                </div>
                {projects.length > 0 && (
                  <button type="button" onClick={onViewAllProjects} className="home-projects-rail-link">
                    Alle in Bibliothek
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                )}
              </div>
              {recent.length > 0 ? (
                <div className="home-bento-rail scrollbar-thin">
                  {recent.map((project) => (
                    <HomeProjectCard key={project.id} project={project} onOpen={onOpenProject} />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-theme-muted py-6">Noch keine Projekte — starte deine erste Analyse oben.</p>
              )}
            </div>

            {analyzing && (
              <div className="home-bento-panel home-bento-panel--status">
                <p className="type-label mb-3">Analyse läuft</p>
                <AnalyzingProjectCard progress={job?.progress ?? 12} message={job?.message || ''} />
                <p className="text-xs text-theme-muted mt-3 leading-relaxed">
                  Du kannst die Bibliothek öffnen — die Analyse läuft weiter.
                </p>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
