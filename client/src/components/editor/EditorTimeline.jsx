import { useMemo, useRef, useState, useCallback } from 'react';
import { formatTime } from '../../utils/helpers';
import { formatTimecode } from '../../utils/timecode';
import { dragTrimTimes, MAX_MAIN_SEC } from '../../utils/trimLimits';
import MontageClipsTrack from './MontageClipsTrack';

function IconBtn({ title, onClick, disabled, children, active }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`editor-timeline-icon-btn ${active ? 'editor-timeline-icon-btn--active' : ''}`}
    >
      {children}
    </button>
  );
}

function TrimTrack({
  min,
  max,
  start,
  end,
  onChange,
  onDraggingChange,
  sourceDuration,
  zoom,
  minClipSec = 8,
}) {
  const span = Math.max(1, max - min);
  const leftPct = ((start - min) / span) * 100;
  const widthPct = ((end - start) / span) * 100;
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
    onChange?.({ start: next.start, end: next.end });
  };

  const onPointerDown = (e) => {
    onDraggingChange?.(true);
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const t = min + ratio * span;
    const distStart = Math.abs(t - start);
    const distEnd = Math.abs(t - end);
    draggingRef.current = distStart <= distEnd ? 'start' : 'end';
    applyDrag(draggingRef.current, t);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (!draggingRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    applyDrag(draggingRef.current, min + ratio * span);
  };

  const onPointerUp = (e) => {
    const was = Boolean(draggingRef.current);
    draggingRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (was) onDraggingChange?.(false);
  };

  return (
    <div
      className="editor-timeline-track editor-timeline-track--trim"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="editor-timeline-track-inner" style={{ width: `${zoom * 100}%` }}>
        <div className="editor-timeline-trim-bg" />
        <div
          className="editor-timeline-trim-range"
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        />
        <div
          className="editor-timeline-trim-handle editor-timeline-trim-handle--start"
          style={{ left: `${leftPct}%` }}
        />
        <div
          className="editor-timeline-trim-handle editor-timeline-trim-handle--end"
          style={{ left: `${leftPct + widthPct}%` }}
        />
      </div>
    </div>
  );
}

export default function EditorTimeline({
  isMontage = false,
  totalSec = 0,
  currentSec = 0,
  onSeek,
  isPlaying = false,
  onPlayPause,
  onSkipBack,
  onSkipForward,
  segments = [],
  onSegmentsChange,
  activeSegmentIndex = -1,
  trimMin = 0,
  trimMax = 0,
  trimStart = 0,
  trimEnd = 0,
  onTrimChange,
  onTrimDragging,
  sourceDuration = 0,
  onSplit,
  onSetIn,
  onSetOut,
  canSplit = false,
  thumbnailUrl = null,
  musicEnabled = false,
  musicLabel = 'Musik',
  musicVolume = 15,
  onMusicToggle,
  onMusicVolumeChange,
  onAddAudio,
  onRemoveAudio,
}) {
  const [zoom, setZoom] = useState(1);
  const trackScrollRef = useRef(null);

  const rulerMarks = useMemo(() => {
    if (totalSec <= 0) return [];
    const step = totalSec > 120 ? 10 : totalSec > 45 ? 5 : 2;
    const marks = [];
    for (let t = 0; t <= totalSec; t += step) marks.push(t);
    return marks;
  }, [totalSec]);

  const playheadPct = totalSec > 0 ? Math.min(100, (currentSec / totalSec) * 100) : 0;

  const seekFromClientX = useCallback(
    (clientX, el) => {
      if (!el || totalSec <= 0) return;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onSeek?.(ratio * totalSec);
    },
    [onSeek, totalSec],
  );

  return (
    <section className="editor-timeline" aria-label="Timeline">
      <div className="editor-timeline-toolbar">
        <div className="editor-timeline-toolbar-left">
          <IconBtn
            title={isMontage ? 'Segment am Playhead kürzen (Ende)' : 'Am Playhead schneiden'}
            onClick={onSplit}
            disabled={!canSplit}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" d="M6 4v16M18 4v16M4 8h4M16 8h4M4 16h4M16 16h4" />
            </svg>
          </IconBtn>
          {!isMontage && (
            <>
              <IconBtn title="In-Punkt am Playhead" onClick={onSetIn}>
                <span className="text-2xs font-bold">In</span>
              </IconBtn>
              <IconBtn title="Out-Punkt am Playhead" onClick={onSetOut}>
                <span className="text-2xs font-bold">Out</span>
              </IconBtn>
            </>
          )}
        </div>

        <div className="editor-timeline-transport">
          <IconBtn title="−2s" onClick={onSkipBack}>
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z" />
            </svg>
          </IconBtn>
          <IconBtn title={isPlaying ? 'Pause' : 'Abspielen'} onClick={onPlayPause} active={isPlaying}>
            {isPlaying ? (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7L8 5z" />
              </svg>
            )}
          </IconBtn>
          <IconBtn title="+2s" onClick={onSkipForward}>
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
            </svg>
          </IconBtn>
          <span className="editor-timeline-timecode tabular-nums">
            {formatTimecode(currentSec)} / {formatTimecode(totalSec)}
          </span>
        </div>

        <div className="editor-timeline-zoom">
          <span className="editor-timeline-zoom-icon" aria-hidden>
            −
          </span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.25}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="editor-timeline-zoom-slider"
            aria-label="Zoom"
          />
          <span className="editor-timeline-zoom-icon" aria-hidden>
            +
          </span>
        </div>
      </div>

      <div className="editor-timeline-options">
        <button
          type="button"
          className={`editor-timeline-opt-btn ${musicEnabled ? 'editor-timeline-opt-btn--active' : ''}`}
          onClick={() => (musicEnabled ? onMusicToggle?.(false) : onAddAudio?.())}
        >
          {musicEnabled ? '♪ Musik an' : '+ Musik'}
        </button>
        {musicEnabled && (
          <label className="editor-timeline-volume">
            <span className="sr-only">Lautstärke</span>
            <input
              type="range"
              min={0}
              max={40}
              value={musicVolume}
              onChange={(e) => onMusicVolumeChange?.(Number(e.target.value))}
              className="editor-timeline-zoom-slider"
            />
            <span className="text-2xs text-theme-muted tabular-nums w-8">{musicVolume}%</span>
          </label>
        )}
        {!isMontage && (
          <span className="editor-timeline-opt-hint text-2xs text-theme-muted ml-auto hidden sm:inline">
            Trim: Griffe ziehen · In/Out am Playhead
          </span>
        )}
        {isMontage && (
          <span className="editor-timeline-opt-hint text-2xs text-theme-muted ml-auto hidden sm:inline">
            Kill-Clips: Griffe ziehen zum Verlängern/Kürzen
          </span>
        )}
      </div>

      <div className="editor-timeline-body" ref={trackScrollRef}>
        <div className="editor-timeline-lane editor-timeline-lane--ruler">
          <span className="editor-timeline-lane-label" aria-hidden />
          <div className="editor-timeline-track-wrap">
            <div
              className="editor-timeline-ruler"
              onPointerDown={(e) => seekFromClientX(e.clientX, e.currentTarget)}
            >
              <div className="editor-timeline-ruler-inner" style={{ width: `${zoom * 100}%` }}>
                {rulerMarks.map((t) => (
                  <span key={t} className="editor-timeline-ruler-mark" style={{ left: `${(t / totalSec) * 100}%` }}>
                    {formatTime(t)}
                  </span>
                ))}
                <div className="editor-timeline-playhead" style={{ left: `${playheadPct}%` }} />
              </div>
            </div>
          </div>
        </div>

        <div className="editor-timeline-lane editor-timeline-lane--video">
          <span className="editor-timeline-lane-label">Video</span>
          <div className="editor-timeline-track-wrap">
            {isMontage ? (
              <MontageClipsTrack
                segments={segments}
                totalSec={totalSec}
                activeIndex={activeSegmentIndex}
                onSeek={onSeek}
                onSegmentsChange={onSegmentsChange}
                onDraggingChange={onTrimDragging}
                sourceDuration={sourceDuration}
                zoom={zoom}
                thumbnailUrl={thumbnailUrl}
              />
            ) : (
              <TrimTrack
                min={trimMin}
                max={trimMax}
                start={trimStart}
                end={trimEnd}
                onChange={onTrimChange}
                onDraggingChange={onTrimDragging}
                sourceDuration={sourceDuration}
                zoom={zoom}
              />
            )}
          </div>
        </div>

        <div className="editor-timeline-lane editor-timeline-lane--audio">
          <span className="editor-timeline-lane-label">Audio</span>
          <div className="editor-timeline-track-wrap editor-timeline-audio-wrap">
            {musicEnabled ? (
              <div className="editor-timeline-audio-clip" style={{ width: `${zoom * 100}%` }}>
                <div className="editor-timeline-audio-clip-inner">
                  <span className="editor-timeline-audio-label">♪ {musicLabel}</span>
                  <button
                    type="button"
                    className="editor-timeline-audio-remove"
                    title="Musik entfernen"
                    onClick={() => onRemoveAudio?.()}
                  >
                    ×
                  </button>
                </div>
                <div className="editor-timeline-audio-wave" aria-hidden />
              </div>
            ) : (
              <button type="button" className="editor-timeline-add-audio" onClick={() => onAddAudio?.()}>
                + Audio hinzufügen
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
