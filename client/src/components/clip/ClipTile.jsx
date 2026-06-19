import { useState, useRef, useCallback } from 'react';
import {
  formatTime,
  viralColor,
  PLATFORMS,
  getHighlightDisplayDuration,
  isMontageHighlight,
} from '../../utils/helpers';

/**
 * 9:16 clip tile for the clip feed (Phase 0 foundation → Phase 1 feed).
 */
export default function ClipTile({
  highlight,
  index = 0,
  onEdit,
  onExport,
  detectedGame = 'unknown',
  exportDisabled = true,
  staggerIndex = 0,
}) {
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

  const metaLine = isMontage
    ? `${killCount} ${killCount === 1 ? 'Kill' : 'Kills'} · ${formatTime(durationSec)}`
    : `${formatTime(highlight.start_time)} – ${formatTime(highlight.end_time)}`;

  return (
    <article
      className="clip-tile group"
      style={{ animationDelay: `${Math.min(staggerIndex, 12) * 45}ms` }}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <div className="clip-tile-media">
        {videoSrc ? (
          <video
            ref={videoRef}
            src={videoSrc}
            muted
            playsInline
            preload="metadata"
            poster={thumb || undefined}
            className="clip-tile-video"
          />
        ) : thumb ? (
          <img src={thumb} alt="" className="clip-tile-video" loading="lazy" />
        ) : (
          <div className="clip-tile-video clip-tile-video--empty" />
        )}

        <div className="clip-tile-shade" aria-hidden />

        {isMontage && killCount > 0 && (
          <span className="clip-tile-kills">{killCount} KILLS</span>
        )}

        {score > 0 && (
          <span className={`clip-tile-score ${viralColor(score)}`}>Peak {score}</span>
        )}

        <span className="clip-tile-duration">{formatTime(durationSec)}</span>

        {!videoSrc && (
          <span className="clip-tile-hint">Neu analysieren für Vorschau</span>
        )}

        <div className={`clip-tile-actions ${hovered ? 'clip-tile-actions--visible' : ''}`}>
          {!exportDisabled && onExport && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onExport(highlight);
              }}
              className="clip-tile-btn clip-tile-btn--secondary"
            >
              Export
            </button>
          )}
          <button
            type="button"
            onClick={() => onEdit?.(highlight.id)}
            className="clip-tile-btn clip-tile-btn--primary"
          >
            Bearbeiten
          </button>
        </div>
      </div>

      <div className="clip-tile-body">
        <h3 className="clip-tile-title">{highlight.title || `Clip ${index + 1}`}</h3>
        <p className="clip-tile-meta">{metaLine}</p>
        <div className="clip-tile-tags">
          {highlight.platform_fit?.slice(0, 2).map((p) => {
            const meta = PLATFORMS.find((x) => x.id === p);
            return (
              <span key={p} className="clip-tile-tag">
                {meta?.icon} {meta?.label || p}
              </span>
            );
          })}
          {detectedGame !== 'unknown' && (
            <span className="clip-tile-tag clip-tile-tag--muted">🎮 {detectedGame}</span>
          )}
        </div>
      </div>
    </article>
  );
}
