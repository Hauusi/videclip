import VideoSourceInput from './VideoSourceInput';
import HomeProjectsRail from '../projects/HomeProjectsRail';

const FEATURES = [
  { icon: '⚡', label: 'KI-Highlight-Erkennung' },
  { icon: '🎯', label: 'Cold-Open Hooks' },
  { icon: '📱', label: '9:16 Shorts-Export' },
];

export default function ImportHero({
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
  const hasProjects = projects.length > 0;
  const showProjectsRail = hasProjects || analyzing;

  return (
    <div className="import-hero relative flex-1 flex flex-col w-full min-h-0 animate-fade-in-up">
      <div
        className={`import-hero-content relative z-10 flex flex-col items-center min-h-0 px-4 sm:px-6 ${
          hasProjects
            ? 'justify-start flex-shrink-0'
            : 'justify-center flex-1'
        }`}
      >
        <div className="w-full max-w-2xl text-center space-y-8">
          <div className="space-y-3">
            <p className="text-2xs font-semibold uppercase tracking-[0.2em] text-peak-purple">
              Only the peaks
            </p>
            <h1 className="text-2xl sm:text-3xl font-bold text-theme tracking-tight">
              Link oder Datei —{' '}
              <span className="gradient-text-clip">virale Clips</span> in Minuten
            </h1>
            <p className="text-sm text-theme-muted max-w-md mx-auto leading-relaxed">
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

          <div className="flex flex-wrap justify-center gap-2">
            {FEATURES.map((f) => (
              <span
                key={f.label}
                className="inline-flex items-center gap-1.5 text-xs text-theme-muted border rounded-full px-3 py-1.5"
                style={{
                  background: 'color-mix(in srgb, var(--t-text) 3%, transparent)',
                  borderColor: 'var(--t-border)',
                }}
              >
                <span aria-hidden>{f.icon}</span>
                {f.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {showProjectsRail && (
        <HomeProjectsRail
          projects={projects}
          onOpenProject={onOpenProject}
          onViewAll={onViewAllProjects}
          analyzing={analyzing}
          job={job}
        />
      )}
    </div>
  );
}
