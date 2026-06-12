import { useCallback, useEffect, useRef, useState } from 'react';
import { pipHeightPercent916, pipHeightPercentWebcam, defaultWidePipSettings } from '../utils/pipLayout';
import SourceFrameBackdrop from './SourceFrameBackdrop';
import { isVideoMediaUrl } from '../utils/trimLimits';

const DEFAULT_PIP = {
  x_percent: 68,
  y_percent: 3,
  size_percent: 35,
  shape: 'rectangle',
  border: 'white',
  opacity: 100,
};

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function borderStyle(border) {
  if (border === 'white') return '3px solid white';
  if (border === 'black') return '3px solid black';
  return 'none';
}

export function defaultPipSettings(overrides = {}) {
  return { ...DEFAULT_PIP, ...overrides };
}

export default function WebcamPipPreview({
  imageUrl,
  videoUrl = null,
  seekSec = 0,
  sourceWidth,
  sourceHeight,
  selection,
  pip,
  onPipChange,
  compact = false,
  maxSizePercent = 60,
  minSizePercent = 20,
  accent = 'violet',
  label = 'Webcam PiP',
  layoutMode = 'webcam',
}) {
  const frameRef = useRef(null);
  const [dragging, setDragging] = useState(null);

  const srcW = sourceWidth || 1920;
  const srcH = sourceHeight || 1080;
  const sel = selection;
  const pipState =
    layoutMode === 'wide'
      ? { ...defaultWidePipSettings(sel), ...pip }
      : { ...DEFAULT_PIP, ...pip };

  const cropW = sel?.width || 1;
  const cropH = sel?.height || 1;
  const cropX = sel?.x || 0;
  const cropY = sel?.y || 0;

  const contentAspect = cropW / cropH;
  const sizePct = clamp(pipState.size_percent ?? 35, minSizePercent, maxSizePercent);
  const heightPct =
    layoutMode === 'wide'
      ? pipHeightPercent916(sizePct, contentAspect)
      : pipHeightPercentWebcam(sizePct, cropW, cropH);

  const updatePip = useCallback(
    (patch) => onPipChange?.({ ...pipState, ...patch }),
    [onPipChange, pipState],
  );

  const getFramePct = useCallback((clientX, clientY) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: ((clientX - rect.left) / rect.width) * 100,
      y: ((clientY - rect.top) / rect.height) * 100,
    };
  }, []);

  const onPointerDown = (e, mode) => {
    e.preventDefault();
    e.stopPropagation();
    const ptr = getFramePct(e.clientX, e.clientY);
    setDragging({
      mode,
      startPtr: ptr,
      startPip: {
        x_percent: pipState.x_percent,
        y_percent: pipState.y_percent,
        size_percent: pipState.size_percent,
      },
    });
  };

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e) => {
      const ptr = getFramePct(e.clientX, e.clientY);
      const { mode, startPtr, startPip } = dragging;
      const maxX = 100 - sizePct;
      const maxY = 100 - heightPct;

      if (mode === 'move') {
        updatePip({
          x_percent: clamp(startPip.x_percent + (ptr.x - startPtr.x), 0, maxX),
          y_percent: clamp(startPip.y_percent + (ptr.y - startPtr.y), 0, maxY),
        });
        return;
      }

      if (mode === 'resize') {
        const newSize = clamp(ptr.x - startPip.x_percent, minSizePercent, maxSizePercent);
        const newMaxY =
          100 -
          (layoutMode === 'wide'
            ? pipHeightPercent916(newSize, contentAspect)
            : pipHeightPercentWebcam(newSize, cropW, cropH));
        updatePip({
          size_percent: newSize,
          x_percent: clamp(startPip.x_percent, 0, 100 - newSize),
          y_percent: clamp(startPip.y_percent, 0, newMaxY),
        });
      }
    };

    const onUp = () => setDragging(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [
    dragging,
    getFramePct,
    sizePct,
    heightPct,
    cropW,
    cropH,
    contentAspect,
    layoutMode,
    updatePip,
    minSizePercent,
    maxSizePercent,
  ]);

  if (!sel?.width || !sel?.height) {
    if (compact) return null;
    return (
      <p className="text-xs text-theme-muted">Draw a webcam area on the source frame above first.</p>
    );
  }

  const frame = (
    <div
      ref={frameRef}
      className={`relative aspect-[9/16] w-full bg-black overflow-hidden select-none touch-none ${
        compact ? 'h-full' : 'w-full max-w-full sm:max-w-[280px] mx-auto rounded-lg'
      }`}
    >
      <div className="absolute inset-0 pointer-events-none">
        <SourceFrameBackdrop
          imageUrl={isVideoMediaUrl(imageUrl) ? null : imageUrl}
          videoUrl={isVideoMediaUrl(imageUrl) ? imageUrl : null}
          seekSec={0}
          alt="9:16 clip preview"
          className="w-full h-full object-cover"
        />
      </div>

      <div
        className={`absolute overflow-hidden cursor-move touch-none z-10 ${
          pipState.border && pipState.border !== 'none' ? 'shadow-lg' : ''
        }`}
        style={{
          left: `${pipState.x_percent}%`,
          top: `${pipState.y_percent}%`,
          width: `${sizePct}%`,
          aspectRatio: `${cropW} / ${cropH}`,
          opacity: clamp((pipState.opacity ?? 100) / 100, 0.5, 1),
          borderRadius: pipState.shape === 'circle' ? '50%' : '6px',
          border: borderStyle(pipState.border),
          boxSizing: 'border-box',
        }}
        onPointerDown={(e) => onPointerDown(e, 'move')}
      >
        {videoUrl && isVideoMediaUrl(videoUrl) ? (
          <video
            src={videoUrl}
            muted
            playsInline
            preload="metadata"
            className="absolute pointer-events-none max-w-none object-cover"
            style={{
              width: `${(srcW / cropW) * 100}%`,
              height: `${(srcH / cropH) * 100}%`,
              left: `${-(cropX / cropW) * 100}%`,
              top: `${-(cropY / cropH) * 100}%`,
            }}
            onLoadedMetadata={(e) => {
              try {
                e.currentTarget.currentTime = Math.max(0, Number(seekSec) || 0);
              } catch {
                /* ignore */
              }
            }}
          />
        ) : (
          <img
            src={imageUrl}
            alt="Webcam PiP"
            className="absolute pointer-events-none max-w-none"
            draggable={false}
            style={{
              width: `${(srcW / cropW) * 100}%`,
              height: `${(srcH / cropH) * 100}%`,
              left: `${-(cropX / cropW) * 100}%`,
              top: `${-(cropY / cropH) * 100}%`,
            }}
          />
        )}
        <div
          className={`absolute bottom-0 right-0 w-4 h-4 rounded-tl cursor-se-resize touch-none z-20 ${
            accent === 'emerald' ? 'bg-emerald-500' : 'bg-violet-500'
          }`}
          onPointerDown={(e) => onPointerDown(e, 'resize')}
        />
      </div>
    </div>
  );

  if (compact) {
    return frame;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-theme-muted uppercase tracking-wide">{label}</p>
      {frame}
      <p className="text-xs text-theme-muted text-center">
        Drag PiP to move · corner handle to resize
      </p>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-theme-muted flex justify-between">
            <span>PiP size</span>
            <span>{Math.round(sizePct)}% width</span>
          </label>
          <input
            type="range"
            min={minSizePercent}
            max={maxSizePercent}
            step={1}
            value={sizePct}
            onChange={(e) => {
              const next = Number(e.target.value);
              const maxY =
                100 -
                (layoutMode === 'wide'
                  ? pipHeightPercent916(next, contentAspect)
                  : pipHeightPercentWebcam(next, cropW, cropH));
              updatePip({
                size_percent: next,
                x_percent: clamp(pipState.x_percent, 0, 100 - next),
                y_percent: clamp(pipState.y_percent, 0, maxY),
              });
            }}
            className="w-full accent-violet-500 mt-1"
          />
        </div>

        <div>
          <label className="text-xs text-theme-muted flex justify-between">
            <span>Opacity</span>
            <span>{pipState.opacity ?? 100}%</span>
          </label>
          <input
            type="range"
            min={50}
            max={100}
            step={1}
            value={pipState.opacity ?? 100}
            onChange={(e) => updatePip({ opacity: Number(e.target.value) })}
            className="w-full accent-violet-500 mt-1"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-theme-muted">Shape</label>
            <select
              value={pipState.shape || 'rectangle'}
              onChange={(e) => updatePip({ shape: e.target.value })}
              className="mt-1 w-full peak-input !rounded-lg !py-1.5 !px-2 !text-sm"
            >
              <option value="rectangle">Rectangle</option>
              <option value="circle">Circle</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-theme-muted">Border</label>
            <select
              value={pipState.border || 'none'}
              onChange={(e) => updatePip({ border: e.target.value })}
              className="mt-1 w-full peak-input !rounded-lg !py-1.5 !px-2 !text-sm"
            >
              <option value="none">None</option>
              <option value="white">White (3px)</option>
              <option value="black">Black (3px)</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
