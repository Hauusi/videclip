import { useState } from 'react';
import ProjectCard from './ProjectCard';
import AnalyzingProjectCard from './AnalyzingProjectCard';

export default function ProjectsDashboard({
  projects = [],
  savedProjects = [],
  loading = false,
  analyzing = false,
  job = null,
  onOpenProject,
  onToggleSave,
  onDeleteProject,
  onNewVideo,
}) {
  const [tab, setTab] = useState('all');
  const list = tab === 'saved' ? savedProjects : projects;

  return (
    <div className="projects-dashboard animate-fade-in-up">
      <div className="projects-dashboard-header">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-theme tracking-tight">Projekte</h1>
          <p className="text-sm text-theme-muted mt-1">
            {analyzing
              ? 'Eine Analyse läuft — sie erscheint gleich in deiner Liste'
              : 'Fertige Analysen — 7 Tage verfügbar, gespeicherte bleiben dauerhaft'}
          </p>
        </div>
        <button type="button" onClick={onNewVideo} className="peak-btn-primary !py-2.5 !text-sm shrink-0">
          + Neues Video
        </button>
      </div>

      <div className="projects-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'all'}
          className={`projects-tab ${tab === 'all' ? 'projects-tab--active' : ''}`}
          onClick={() => setTab('all')}
        >
          Alle Projekte ({projects.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'saved'}
          className={`projects-tab ${tab === 'saved' ? 'projects-tab--active' : ''}`}
          onClick={() => setTab('saved')}
        >
          Gespeicherte Projekte ({savedProjects.length})
        </button>
      </div>

      {loading && !list.length ? (
        <div className="projects-empty">
          <p className="text-theme-muted text-sm">Projekte werden geladen…</p>
        </div>
      ) : !list.length && !analyzing ? (
        <div className="projects-empty peak-panel p-10 text-center">
          <p className="text-theme font-medium">
            {tab === 'saved' ? 'Noch keine gespeicherten Projekte' : 'Noch keine Analysen'}
          </p>
          <p className="text-sm text-theme-muted mt-2 max-w-sm mx-auto">
            {tab === 'saved'
              ? 'Speichere ein Projekt über das ···-Menü, damit es nicht nach 7 Tagen gelöscht wird.'
              : 'Füge einen YouTube-Link ein oder lade ein Video hoch — fertige Analysen erscheinen hier.'}
          </p>
          {tab === 'all' && (
            <button type="button" onClick={onNewVideo} className="peak-btn-primary mt-6 !text-sm">
              Erste Analyse starten
            </button>
          )}
        </div>
      ) : (
        <div className="projects-grid">
          {analyzing && tab === 'all' && (
            <div className="projects-grid-analyzing">
              <AnalyzingProjectCard
                progress={job?.progress ?? 12}
                message={job?.message || ''}
              />
            </div>
          )}
          {list.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onOpen={onOpenProject}
              onToggleSave={onToggleSave}
              onDelete={onDeleteProject}
            />
          ))}
        </div>
      )}
    </div>
  );
}
