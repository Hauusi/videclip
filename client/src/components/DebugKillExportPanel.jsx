/** TEMPORARY DEBUG — remove with DEBUG_KILL_EXPORT_REMOVAL.md */

import { useState } from 'react';
import { formatTime } from '../utils/helpers';

export default function DebugKillExportPanel({ debugKillExport, compact = false }) {
  const [showIndividuals, setShowIndividuals] = useState(false);

  if (!debugKillExport?.jsonUrl) return null;

  const { summary, jsonUrl, reelAllUrl, reelPoolUrl, reelRejectedUrl, individualKills } =
    debugKillExport;

  const links = [
    { label: 'Kills JSON', url: jsonUrl, desc: 'Alle HUD-Events + Filter-Status' },
    { label: 'Reel: alle', url: reelAllUrl, desc: `Bis ${summary?.reel_max || 60} erkannte Kills` },
    { label: 'Reel: Pool', url: reelPoolUrl, desc: 'Nur Montage-Pool' },
    { label: 'Reel: verworfen', url: reelRejectedUrl, desc: 'Bestätigt, aber nicht im Pool' },
  ].filter((l) => l.url);

  return (
    <div
      className={`rounded-xl border border-amber-500/30 bg-amber-500/5 space-y-2 ${
        compact ? 'px-3 py-2' : 'px-4 py-3'
      }`}
    >
      <p className={`font-medium text-amber-300 ${compact ? 'text-xs' : 'text-sm'}`}>
        Debug: alle erkannten Kills (temporär)
      </p>
      {!compact ? (
        <p className="text-2xs text-theme-muted">
          {summary?.total_detected ?? 0} HUD-Events · {summary?.in_montage_pool ?? 0} im Montage-Pool
          · {summary?.in_final_montage ?? 0} in finalen Clips — nur auf der Clip-Übersicht oder hier
          im Editor.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {links.map((l) => (
          <a
            key={l.label}
            href={l.url}
            download
            className="peak-chip text-xs !border-amber-500/40 hover:!bg-amber-500/10"
            title={l.desc}
          >
            ↓ {l.label}
          </a>
        ))}
        {individualKills?.length ? (
          <button
            type="button"
            onClick={() => setShowIndividuals((v) => !v)}
            className="peak-chip text-xs !border-amber-500/40 hover:!bg-amber-500/10"
          >
            {showIndividuals ? '▲' : '▼'} Einzel-MP4s ({individualKills.length})
          </button>
        ) : null}
      </div>
      {showIndividuals && individualKills?.length ? (
        <div className="max-h-40 overflow-y-auto flex flex-wrap gap-1.5 pt-1">
          {individualKills.map((k) => (
            <a
              key={k.index}
              href={k.url}
              download
              className="text-2xs px-2 py-1 rounded-md border border-amber-500/25 text-amber-200/90 hover:bg-amber-500/10 tabular-nums"
              title={k.roi || ''}
            >
              #{k.index} {formatTime(k.hud_time)}
              {k.in_montage_pool ? ' · Pool' : ''}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
