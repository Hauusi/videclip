import { useMemo, useState } from 'react';
import ClipTile from '../components/clip/ClipTile';
import DebugKillExportPanel from '../components/DebugKillExportPanel.jsx';
import { PLATFORMS } from '../utils/helpers';
import { CLIP_SORT_OPTIONS, prepareClipFeed } from '../utils/clipFeed';

export default function ClipFeed({
  highlights = [],
  detectedGame = 'unknown',
  onEdit,
  onDownloadAll,
  debugKillExport,
  showDebugUi = false,
  sourceTitle,
}) {
  const [platformFilter, setPlatformFilter] = useState('all');
  const [sortBy, setSortBy] = useState('score');

  const clips = useMemo(
    () => prepareClipFeed(highlights, { platformFilter, sortBy }),
    [highlights, platformFilter, sortBy],
  );

  return (
    <section className="clip-feed animate-fade-in px-4 lg:px-6 pb-6 max-w-[1600px] mx-auto w-full">
      <div className="clip-feed-header">
        <div>
          <h2 className="type-display text-xl sm:text-2xl font-bold text-theme tracking-tight">
            Deine Clips
            <span className="ml-2 text-peak-purple font-semibold">({clips.length})</span>
          </h2>
          <p className="text-sm text-theme-muted mt-1">
            {sourceTitle ? (
              <>
                <span className="text-theme">{sourceTitle}</span>
                {' · '}
              </>
            ) : null}
            KI-ausgewählte Highlights — bearbeiten für Hook, Untertitel & Export
          </p>
        </div>
      </div>

      <div className="clip-feed-toolbar">
        <div className="clip-feed-toolbar-group">
          <span className="type-label hidden sm:inline">Filter</span>
          <button
            type="button"
            onClick={() => setPlatformFilter('all')}
            className={`peak-chip ${platformFilter === 'all' ? 'peak-chip-active' : ''}`}
          >
            Alle
          </button>
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPlatformFilter((f) => (f === p.id ? 'all' : p.id))}
              className={`peak-chip ${platformFilter === p.id ? 'peak-chip-active' : ''}`}
            >
              {p.icon} {p.label}
            </button>
          ))}
        </div>

        <div className="clip-feed-toolbar-group">
          <span className="type-label hidden sm:inline">Sortieren</span>
          {CLIP_SORT_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setSortBy(opt.id)}
              className={`peak-chip ${sortBy === opt.id ? 'peak-chip-active' : ''}`}
            >
              {opt.id === 'score' && sortBy === 'score' ? '★ ' : ''}
              {opt.label}
            </button>
          ))}
        </div>

        {clips.length > 0 && onDownloadAll && (
          <button type="button" onClick={onDownloadAll} className="peak-btn-secondary !py-2 !px-4 !text-sm ml-auto">
            ↓ ZIP Export
          </button>
        )}
      </div>

      {showDebugUi && <DebugKillExportPanel debugKillExport={debugKillExport} />}

      {clips.length === 0 ? (
        <div className="clip-feed-empty peak-panel p-10 text-center mt-4">
          <p className="text-theme font-medium">Keine Clips für diesen Filter</p>
          <p className="text-sm text-theme-muted mt-2">Wähle „Alle“ oder einen anderen Sortier-Modus.</p>
        </div>
      ) : (
        <div className="clip-feed-grid">
          {clips.map((h, i) => (
            <ClipTile
              key={h.id}
              highlight={h}
              index={i}
              onEdit={onEdit}
              detectedGame={detectedGame}
              staggerIndex={i}
            />
          ))}
        </div>
      )}
    </section>
  );
}
