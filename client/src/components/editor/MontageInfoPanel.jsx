import { formatTime } from '../../utils/helpers';
import DebugKillExportPanel from '../DebugKillExportPanel.jsx';

export default function MontageInfoPanel({
  highlight,
  killCount = 0,
  outputSec = 0,
  debugKillExport = null,
  showDebug = false,
}) {
  const segments = highlight?.montage_segments || [];

  return (
    <div className="montage-info-panel">
      <div className="montage-info-panel-head">
        <span className="montage-info-panel-icon" aria-hidden>
          ⚔
        </span>
        <div>
          <p className="montage-info-panel-title">
            {killCount} {killCount === 1 ? 'Kill' : 'Kills'} als Jump-Cuts
            {highlight?.has_payoff ? ' + Defuse-Finale' : ''}
          </p>
          <p className="montage-info-panel-sub">
            <span className="tabular-nums font-medium text-theme">{formatTime(outputSec)}</span> Ausgabe
            {highlight?.source_span_start != null && highlight?.source_span_end != null && (
              <>
                {' '}
                · VOD {formatTime(highlight.source_span_start)}–{formatTime(highlight.source_span_end)}
              </>
            )}
          </p>
        </div>
      </div>
      <p className="text-2xs text-theme-muted leading-relaxed">
        Schnitte kommen aus den Kill-Momenten — Framing live unter der Vorschau. Export mit{' '}
        <span className="text-theme">„Clip exportieren“</span> unten.
      </p>
      {segments.length > 0 && (
        <p className="text-2xs text-theme-muted tabular-nums leading-relaxed">
          Segmente:{' '}
          {segments
            .filter((s) => s.segment_type !== 'payoff')
            .map(
              (s, i) =>
                `${formatTime(s.raw_time ?? s.peak_time ?? s.start)} (${formatTime(s.start)}+${Number(s.duration).toFixed(1)}s)`,
            )
            .join(' · ')}
        </p>
      )}
      {showDebug && segments.some((s) => s.debug_download_url) && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {segments
            .filter((s) => s.segment_type !== 'payoff' && s.debug_download_url)
            .map((s, i) => (
              <a
                key={`${s.start}-${i}`}
                href={s.debug_download_url}
                download
                className="text-2xs px-2 py-1 rounded-md border border-amber-500/30 text-amber-200/90 hover:bg-amber-500/10 tabular-nums"
              >
                ↓ Kill {i + 1}
              </a>
            ))}
        </div>
      )}
      {showDebug && debugKillExport ? (
        <DebugKillExportPanel debugKillExport={debugKillExport} compact />
      ) : null}
    </div>
  );
}
