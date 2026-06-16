import { useRef, useMemo, useCallback, useEffect } from 'react';
import {
  buildOutputLayout,
  resizeSegmentEnd,
  resizeSegmentStart,
} from '../../utils/montageTimeline';

const MIN_CLIP_SEC = 1.15;

/**
 * Montage kills on the output timeline — draggable in/out handles per clip.
 * Uses delta dragging with a fixed timeline scale so totalSec changes do not jitter handles.
 */
export default function MontageClipsTrack({
  segments = [],
  totalSec = 0,
  activeIndex = -1,
  onSeek,
  onSegmentsChange,
  onDraggingChange,
  sourceDuration = 0,
  zoom = 1,
  thumbnailUrl = null,
}) {
  const layout = useMemo(() => buildOutputLayout(segments), [segments]);
  const trackRef = useRef(null);
  const innerRef = useRef(null);
  const dragRef = useRef(null);
  const draggedRef = useRef(false);

  const pxToSecAt = useCallback((clientX, scaleSec) => {
    const el = innerRef.current || trackRef.current;
    if (!el || scaleSec <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * scaleSec;
  }, []);

  const applyDrag = useCallback(
    (clientX) => {
      const drag = dragRef.current;
      if (!drag) return;

      const base = drag.initialSegments;
      const { index, edge, initialClientX, pxPerSec, initialDuration } = drag;
      if (!pxPerSec || pxPerSec <= 0) return;

      const deltaSec = (clientX - initialClientX) / pxPerSec;

      if (edge === 'end') {
        const newDur = Math.max(MIN_CLIP_SEC, initialDuration + deltaSec);
        const next = resizeSegmentEnd(base, index, newDur, { sourceDuration });
        onSegmentsChange?.(next);
        return;
      }

      const next = resizeSegmentStart(base, index, deltaSec, { sourceDuration });
      onSegmentsChange?.(next);
    },
    [onSegmentsChange, sourceDuration],
  );

  const endDrag = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    onDraggingChange?.(false);
  }, [onDraggingChange]);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragRef.current) return;
      draggedRef.current = true;
      applyDrag(e.clientX);
    };
    const onUp = () => endDrag();

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [applyDrag, endDrag]);

  const onHandleDown = (e, index, edge) => {
    e.stopPropagation();
    e.preventDefault();
    const row = layout[index];
    if (!row) return;

    const el = innerRef.current || trackRef.current;
    const rect = el?.getBoundingClientRect();
    const pxPerSec = rect && totalSec > 0 ? rect.width / totalSec : 0;

    draggedRef.current = false;
    dragRef.current = {
      index,
      edge,
      initialClientX: e.clientX,
      pxPerSec,
      initialDuration: row.duration,
      initialSegments: segments.map((s) => ({ ...s })),
    };
    onDraggingChange?.(true);
  };

  const onTrackPointerDown = (e) => {
    if (dragRef.current) return;
    if (e.target.closest('.editor-timeline-clip-handle')) return;
    onSeek?.(pxToSecAt(e.clientX, totalSec));
  };

  if (!layout.length || totalSec <= 0) return null;

  return (
    <div
      ref={trackRef}
      className="editor-timeline-track editor-timeline-track--montage-clips"
      onPointerDown={onTrackPointerDown}
    >
      <div
        ref={innerRef}
        className="editor-timeline-track-inner"
        style={{ width: `${zoom * 100}%` }}
      >
        {thumbnailUrl && (
          <div className="editor-timeline-thumb-strip" aria-hidden>
            <img src={thumbnailUrl} alt="" className="editor-timeline-thumb-img" />
          </div>
        )}
        {layout.map((row) => {
          const leftPct = (row.outStart / totalSec) * 100;
          const widthPct = Math.max(3, (row.duration / totalSec) * 100);
          const isActive = row.index === activeIndex;
          return (
            <div
              key={`${row.sourceStart}-${row.index}-${row.duration.toFixed(2)}`}
              className={`editor-timeline-clip editor-timeline-clip--montage editor-timeline-clip--editable ${
                isActive ? 'editor-timeline-clip--active' : ''
              }`}
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              onClick={(e) => {
                e.stopPropagation();
                if (draggedRef.current) {
                  draggedRef.current = false;
                  return;
                }
                onSeek?.(row.outStart);
              }}
            >
              <button
                type="button"
                className="editor-timeline-clip-handle editor-timeline-clip-handle--start"
                aria-label={`Kill ${row.index + 1} Start`}
                onPointerDown={(e) => onHandleDown(e, row.index, 'start')}
              />
              <span className="editor-timeline-clip-label">Kill {row.index + 1}</span>
              <button
                type="button"
                className="editor-timeline-clip-handle editor-timeline-clip-handle--end"
                aria-label={`Kill ${row.index + 1} Ende`}
                onPointerDown={(e) => onHandleDown(e, row.index, 'end')}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
