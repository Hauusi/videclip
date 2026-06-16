import { useMemo } from 'react';
import { formatTime } from '../../utils/helpers';

/**
 * Montage kill segments as a clickable bar under the preview.
 * `onSeek(sec)` — position in the preview/output timeline.
 */
export default function KillTimeline({
  segments = [],
  totalSec = 0,
  activeIndex = -1,
  onSeek,
  className = '',
}) {
  const kills = useMemo(
    () => segments.filter((s) => s.segment_type !== 'payoff'),
    [segments],
  );

  if (!kills.length || totalSec <= 0) return null;

  return (
    <div className={`kill-timeline ${className}`} role="list" aria-label="Kill-Segmente">
      <div className="kill-timeline-track">
        {kills.map((seg, i) => {
          const start = Number(seg.start) || 0;
          const dur = Number(seg.duration) || 1;
          const widthPct = Math.max(4, (dur / totalSec) * 100);
          const leftPct = Math.min(96, (start / totalSec) * 100);
          const peak = seg.raw_time ?? seg.peak_time ?? seg.start;
          const isActive = i === activeIndex;

          return (
            <button
              key={`${start}-${i}`}
              type="button"
              role="listitem"
              title={`Kill ${i + 1} · ${formatTime(peak)}`}
              className={`kill-timeline-seg ${isActive ? 'kill-timeline-seg--active' : ''}`}
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              onClick={() => onSeek?.(start)}
            >
              <span className="kill-timeline-seg-label">{i + 1}</span>
            </button>
          );
        })}
      </div>
      <div className="kill-timeline-labels">
        {kills.map((seg, i) => (
          <span key={`lbl-${i}`} className="kill-timeline-time">
            Kill {i + 1} · {formatTime(seg.raw_time ?? seg.peak_time ?? seg.start)}
          </span>
        ))}
      </div>
    </div>
  );
}
