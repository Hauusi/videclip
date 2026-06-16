import { useMemo, useState } from 'react';
import ProjectCard from '../components/projects/ProjectCard';
import AnalyzingProjectCard from '../components/projects/AnalyzingProjectCard';
import {
  filterLibraryProjects,
  sortLibraryProjects,
  LIBRARY_SORT_OPTIONS,
} from '../utils/projects';

const TABS = [
  { id: 'all', label: 'Alle Projekte' },
  { id: 'saved', label: 'Gespeichert' },
  { id: 'expiring', label: 'Läuft ab' },
];

export default function LibraryView({
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
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState('date');

  const baseList = tab === 'saved' ? savedProjects : projects;

  const list = useMemo(() => {
    const filtered = filterLibraryProjects(baseList, { tab, query });
    return sortLibraryProjects(filtered, sortBy);
  }, [baseList, tab, query, sortBy]);

  const tabCounts = {
    all: projects.length,
    saved: savedProjects.length,
    expiring: filterLibraryProjects(projects, { tab: 'expiring' }).length,
  };

  return (
    <div className="library-view animate-fade-in-up">
      <div className="library-view-header">
        <div>
          <h1 className="type-display text-2xl sm:text-3xl font-bold text-theme tracking-tight">
            Bibliothek
          </h1>
          <p className="text-sm text-theme-muted mt-1">
            {analyzing
              ? 'Eine Analyse läuft — sie erscheint gleich in deiner Liste'
              : 'Fertige Analysen — 7 Tage verfügbar, gespeicherte bleiben dauerhaft'}
          </p>
        </div>
        <button type="button" onClick={onNewVideo} className="peak-btn-primary !py-2.5 !text-sm shrink-0 lg:hidden">
          + Neues Video
        </button>
      </div>

      <div className="library-view-controls">
        <div className="library-search-wrap">
          <svg className="library-search-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Projekte suchen…"
            className="library-search-input"
            aria-label="Projekte suchen"
          />
        </div>

        <div className="library-sort-wrap">
          <label htmlFor="library-sort" className="type-label shrink-0">
            Sortieren
          </label>
          <select
            id="library-sort"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="library-sort-select"
          >
            {LIBRARY_SORT_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="library-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`library-tab ${tab === t.id ? 'library-tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label} ({tabCounts[t.id] ?? 0})
          </button>
        ))}
      </div>

      {loading && !list.length ? (
        <div className="library-empty">
          <p className="text-theme-muted text-sm">Projekte werden geladen…</p>
        </div>
      ) : !list.length && !analyzing ? (
        <div className="library-empty peak-panel p-10 text-center">
          <p className="text-theme font-medium">
            {tab === 'saved'
              ? 'Noch keine gespeicherten Projekte'
              : tab === 'expiring'
                ? 'Keine Projekte laufen bald ab'
                : query
                  ? 'Keine Treffer'
                  : 'Noch keine Analysen'}
          </p>
          <p className="text-sm text-theme-muted mt-2 max-w-sm mx-auto">
            {tab === 'saved'
              ? 'Speichere ein Projekt über das ···-Menü, damit es nicht nach 7 Tagen gelöscht wird.'
              : query
                ? 'Versuche einen anderen Suchbegriff.'
                : 'Füge einen YouTube-Link ein oder lade ein Video hoch — fertige Analysen erscheinen hier.'}
          </p>
          {tab === 'all' && !query && (
            <button type="button" onClick={onNewVideo} className="peak-btn-primary mt-6 !text-sm">
              Erste Analyse starten
            </button>
          )}
        </div>
      ) : (
        <div className="library-grid">
          {analyzing && tab === 'all' && !query && (
            <div className="library-grid-analyzing">
              <AnalyzingProjectCard progress={job?.progress ?? 12} message={job?.message || ''} />
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
