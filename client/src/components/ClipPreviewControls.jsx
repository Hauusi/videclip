import { useCallback, useEffect, useState } from 'react';
import { formatTime } from '../utils/helpers';

/**
 * Clip-relative playback bar — one time display for live-trim (source seek) and rendered clips.
 */
export default function ClipPreviewControls({
  videoRef,
  mode = 'file',
  startTime = 0,
  endTime = 0,
  totalSec,
  className = '',
}) {
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(Math.max(0.5, totalSec || 0));

  const clipDuration =
    mode === 'live'
      ? Math.max(0.5, endTime - startTime)
      : Math.max(0.5, duration || totalSec || 0);

  const syncFromVideo = useCallback(() => {
    const v = videoRef?.current;
    if (!v) return;
    if (mode === 'live') {
      const rel = Math.max(0, Math.min(clipDuration, v.currentTime - startTime));
      setCurrent(rel);
      setPlaying(!v.paused && !v.ended);
      return;
    }
    const d = v.duration;
    if (Number.isFinite(d) && d > 0) setDuration(d);
    const t = v.currentTime;
    if (Number.isFinite(t)) setCurrent(Math.max(0, t));
    setPlaying(!v.paused && !v.ended);
  }, [videoRef, mode, startTime, clipDuration]);

  useEffect(() => {
    const v = videoRef?.current;
    if (!v) return undefined;

    const onTime = () => syncFromVideo();
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onMeta = () => syncFromVideo();

    v.addEventListener('timeupdate', onTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('seeked', onMeta);
    syncFromVideo();

    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('seeked', onMeta);
    };
  }, [videoRef, syncFromVideo, mode, startTime, endTime]);

  useEffect(() => {
    if (mode === 'live') {
      setDuration(clipDuration);
      setCurrent(0);
    }
  }, [mode, clipDuration, startTime, endTime]);

  const togglePlay = () => {
    const v = videoRef?.current;
    if (!v) return;
    if (v.paused) {
      if (mode === 'live') {
        if (v.currentTime < startTime - 0.05 || v.currentTime >= endTime - 0.05) {
          try {
            v.currentTime = startTime;
          } catch {
            /* ignore */
          }
        }
      }
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  };

  const seekRatio = (ratio) => {
    const v = videoRef?.current;
    if (!v) return;
    const r = Math.max(0, Math.min(1, ratio));
    if (mode === 'live') {
      try {
        v.currentTime = startTime + r * clipDuration;
      } catch {
        /* ignore */
      }
      setCurrent(r * clipDuration);
      return;
    }
    const d = v.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    try {
      v.currentTime = r * d;
    } catch {
      /* ignore */
    }
    setCurrent(r * d);
  };

  const onBarClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    seekRatio(ratio);
  };

  const progress = clipDuration > 0 ? Math.min(1, current / clipDuration) : 0;

  return (
    <div
      className={`absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 via-black/70 to-transparent px-3 pt-8 pb-2.5 ${className}`}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          className="w-9 h-9 shrink-0 rounded-full bg-white/15 hover:bg-white/25 border border-white/20 flex items-center justify-center text-white transition-colors"
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? (
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg className="w-4 h-4 ml-0.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={onBarClick}
            className="relative w-full h-1.5 rounded-full bg-white/20 cursor-pointer group"
            aria-label="Position im Clip"
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-peak-purple group-hover:bg-violet-400 transition-colors"
              style={{ width: `${progress * 100}%` }}
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow-md -ml-1.5 pointer-events-none"
              style={{ left: `${progress * 100}%` }}
            />
          </button>
        </div>

        <span className="text-xs text-white/95 tabular-nums shrink-0 font-medium">
          {formatTime(current)} / {formatTime(clipDuration)}
        </span>
      </div>
    </div>
  );
}
