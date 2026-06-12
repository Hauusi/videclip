import { useState, useRef, useCallback } from 'react';
import { formatTime, viralColor, PLATFORMS, getHighlightDisplayDuration, isMontageHighlight } from '../utils/helpers';
import { highlightDescription } from '../utils/highlightText';

export default function HighlightOverviewCard({ highlight, index, onEdit, detectedGame = 'unknown' }) {
  const [hovered, setHovered] = useState(false);
  const videoRef = useRef(null);
  const thumb = highlight.thumbnailUrl;
  const videoSrc = highlight.overviewUrl || highlight.plainPreviewUrl || null;
  const durationSec = Math.max(1, getHighlightDisplayDuration(highlight));
  const isMontage = isMontageHighlight(highlight);
  const killCount = highlight.montage_kill_count || highlight.montage_segments?.length || 0;
  const score = highlight.viral_score ?? 0;

  const handleEnter = useCallback(() => {
    setHovered(true);
    const v = videoRef.current;
    if (!v) return;
    v.muted = true;
    v.loop = true;
    v.play().catch(() => {});
  }, []);

  const handleLeave = useCallback(() => {
    setHovered(false);
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    try {
      v.currentTime = 0;
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <article
      className="group peak-panel overflow-hidden flex flex-col h-full w-full animate-fade-in hover:shadow-card-hover transition-all duration-300"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <div className="relative w-full aspect-[9/16] bg-black overflow-hidden">
        {videoSrc ? (
          <video
            ref={videoRef}
            src={videoSrc}
            muted
            playsInline
            preload="metadata"
            poster={thumb || undefined}
            className="absolute inset-0 w-full h-full object-cover bg-black transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : thumb ? (
          <img
            src={thumb}
            alt=""
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div
            className="absolute inset-0 animate-pulse"
            style={{ background: 'var(--t-elevated)' }}
          />
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-black/40 pointer-events-none" />

        {hovered && videoSrc && (
          <span className="absolute top-2.5 left-12 z-10 px-2 py-0.5 rounded-md bg-black/60 backdrop-blur-sm text-[10px] text-white font-medium uppercase tracking-wide">
            Preview
          </span>
        )}

        <span
          className={`absolute top-2.5 right-2.5 z-10 px-2 py-1 rounded-lg text-xs font-bold border backdrop-blur-sm ${viralColor(score)}`}
        >
          {score}/10
        </span>

        <span className="absolute top-2.5 left-2.5 z-10 w-7 h-7 rounded-lg bg-black/50 backdrop-blur-sm border border-white/10 flex items-center justify-center text-xs font-bold text-white">
          {index + 1}
        </span>

        <span className="absolute bottom-2.5 right-2.5 z-10 px-2 py-0.5 rounded-md bg-black/60 backdrop-blur-sm text-2xs text-white tabular-nums font-medium">
          {formatTime(durationSec)}
        </span>

        {!videoSrc && (
          <span className="absolute bottom-10 inset-x-2 z-10 text-center text-2xs text-amber-200/90 bg-black/50 backdrop-blur-sm rounded py-1">
            Neu analysieren für Vorschau
          </span>
        )}

        <div
          className={`absolute inset-0 z-20 flex items-center justify-center bg-black/45 backdrop-blur-[1px] transition-opacity duration-200 ${
            hovered ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          <button
            type="button"
            onClick={() => onEdit(highlight.id)}
            className="peak-btn-primary !py-3 !px-6 flex items-center gap-2 shadow-glow-lg scale-95 group-hover:scale-100 transition-transform"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Bearbeiten
          </button>
        </div>
      </div>

      <div className="p-4 flex flex-col flex-1 min-h-[130px] gap-2.5">
        <div className="flex-1 min-h-0">
          <h3 className="font-semibold text-theme text-sm leading-snug line-clamp-2 group-hover:text-peak-purple transition-colors">
            {highlight.title || `Clip ${index + 1}`}
          </h3>
          <p className="text-2xs text-theme-muted mt-1 tabular-nums">
            {isMontage
              ? `${killCount} Kills · ${formatTime(durationSec)} Montage`
              : `${formatTime(highlight.start_time)} – ${formatTime(highlight.end_time)}`}
          </p>
          <div className="flex flex-wrap gap-1 mt-2">
            {highlight.platform_fit?.slice(0, 2).map((p) => {
              const meta = PLATFORMS.find((x) => x.id === p);
              return (
                <span
                  key={p}
                  className="text-[10px] px-1.5 py-0.5 rounded-md bg-peak-purple/10 text-peak-purple border border-peak-purple/20"
                >
                  {meta?.icon} {meta?.label || p}
                </span>
              );
            })}
            {isMontage && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/25">
                ⚡ {killCount} Kills
              </span>
            )}
            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-white/5 text-theme-muted border border-white/10">
              🎮 {detectedGame}
            </span>
          </div>
          <p className="text-xs text-theme-muted line-clamp-2 leading-relaxed mt-2 opacity-90">
            {highlightDescription(highlight)}
          </p>
        </div>

        <button
          type="button"
          onClick={() => onEdit(highlight.id)}
          className="w-full shrink-0 sm:hidden peak-btn-primary !py-2.5 !text-sm"
        >
          Bearbeiten
        </button>
      </div>
    </article>
  );
}
