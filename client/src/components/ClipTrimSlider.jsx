import { useRef } from 'react';
import { formatTime } from '../utils/helpers';
import { dragTrimTimes, MAX_MAIN_SEC } from '../utils/trimLimits';

/**
 * Single timeline with start/end handles — opposite handle stays fixed at max length.
 */
export default function ClipTrimSlider({
  min,
  max,
  start,
  end,
  onChange,
  onDraggingChange,
  sourceDuration = 0,
  minClipSec = 8,
}) {
  const span = Math.max(1, max - min);
  const leftPct = ((start - min) / span) * 100;
  const widthPct = ((end - start) / span) * 100;
  const mainSec = Math.max(0, end - start);
  const draggingRef = useRef(null);

  const applyDrag = (anchor, raw) => {
    const next = dragTrimTimes({
      anchor,
      start,
      end,
      raw,
      min,
      max,
      sourceDuration,
      minClipSec,
      maxMainSec: MAX_MAIN_SEC,
    });
    onChange({ start: next.start, end: next.end });
  };

  const onTrackPointerDown = (e) => {
    onDraggingChange?.(true);
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const t = min + ratio * span;
    const distStart = Math.abs(t - start);
    const distEnd = Math.abs(t - end);
    if (distStart <= distEnd) {
      draggingRef.current = 'start';
      applyDrag('start', t);
    } else {
      draggingRef.current = 'end';
      applyDrag('end', t);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onTrackPointerMove = (e) => {
    if (!draggingRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const t = min + ratio * span;
    applyDrag(draggingRef.current, t);
  };

  const onTrackPointerUp = (e) => {
    const wasDragging = Boolean(draggingRef.current);
    draggingRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (wasDragging) onDraggingChange?.(false);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:items-center text-sm text-theme-muted tabular-nums">
        <span className="shrink-0">{formatTime(min)} Quelle</span>
        <span className="text-peak-purple font-medium text-center sm:text-left">
          {formatTime(start)} – {formatTime(end)}
        </span>
        <span className="shrink-0 sm:text-right">{formatTime(max)}</span>
      </div>

      <div
        className="editor-trim-track"
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={onTrackPointerUp}
        onPointerCancel={onTrackPointerUp}
        role="group"
        aria-label="Clip-Zeitraum"
      >
        <div className="absolute inset-x-3 top-1/2 -translate-y-1/2 h-2 rounded-full bg-theme-surface pointer-events-none" />
        <div
          className="absolute top-1/2 -translate-y-1/2 h-2 rounded-full bg-gradient-to-r from-violet-600 to-purple-500 pointer-events-none"
          style={{
            left: `calc(0.75rem + (100% - 1.5rem) * ${leftPct / 100})`,
            width: `calc((100% - 1.5rem) * ${widthPct / 100})`,
          }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3.5 h-7 rounded-lg bg-white shadow-[0_0_12px_rgba(139,108,248,0.5)] border-2 border-peak-purple pointer-events-none z-10"
          style={{ left: `calc(0.75rem + (100% - 1.5rem) * ${leftPct / 100} - 7px)` }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3.5 h-7 rounded-lg bg-white shadow-[0_0_12px_rgba(139,108,248,0.5)] border-2 border-peak-purple pointer-events-none z-10"
          style={{
            left: `calc(0.75rem + (100% - 1.5rem) * ${(leftPct + widthPct) / 100} - 7px)`,
          }}
        />
      </div>

      <p className="text-sm text-theme-muted">
        Hauptteil <span className="text-theme tabular-nums">{mainSec.toFixed(1)} s</span>
        <span className="opacity-70"> (max. {MAX_MAIN_SEC} s) — linker Griff = Start, rechter = Ende</span>
      </p>
    </div>
  );
}
