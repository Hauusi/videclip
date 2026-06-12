import { useCallback, useEffect, useRef, useState } from 'react';
import WebcamPipPreview from './WebcamPipPreview';
import SourceFrameBackdrop from './SourceFrameBackdrop';
import { defaultWidePipSettings as buildDefaultWidePip } from '../utils/pipLayout';

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function getContainedLayout(containerW, containerH, sourceW, sourceH) {
  if (!containerW || !containerH || !sourceW || !sourceH) return null;
  const scale = Math.min(containerW / sourceW, containerH / sourceH);
  const drawW = sourceW * scale;
  const drawH = sourceH * scale;
  return {
    offsetX: (containerW - drawW) / 2,
    offsetY: (containerH - drawH) / 2,
    drawW,
    drawH,
  };
}

export function defaultWidePipSettings(selection) {
  return buildDefaultWidePip(selection);
}

export function defaultWideSelection(sourceW, sourceH) {
  const w = sourceW || 1920;
  const h = sourceH || 1080;
  return {
    x: Math.round(w * 0.12),
    y: Math.round(h * 0.08),
    width: Math.round(w * 0.76),
    height: Math.round(h * 0.72),
  };
}

export default function WideOverlaySelector({
  imageUrl,
  videoUrl,
  seekSec = 0,
  clipPreviewUrl = null,
  sourceWidth,
  sourceHeight,
  value,
  onChange,
  clipDuration = 30,
}) {
  const containerRef = useRef(null);
  const [dragging, setDragging] = useState(null);
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });

  const srcW = value.sourceWidth || sourceWidth || 1920;
  const srcH = value.sourceHeight || sourceHeight || 1080;
  const selection = value.selection;
  const layout = getContainedLayout(displaySize.w, displaySize.h, srcW, srcH);

  const updateDisplaySize = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setDisplaySize({ w: el.clientWidth, h: el.clientHeight });
  }, []);

  useEffect(() => {
    updateDisplaySize();
    window.addEventListener('resize', updateDisplaySize);
    return () => window.removeEventListener('resize', updateDisplaySize);
  }, [updateDisplaySize, imageUrl]);

  const toSourceCoords = useCallback(
    (dispX, dispY, dispW, dispH) => {
      if (!layout) return null;
      const relX = dispX - layout.offsetX;
      const relY = dispY - layout.offsetY;
      if (relX < 0 || relY < 0 || relX + dispW > layout.drawW + 1 || relY + dispH > layout.drawH + 1) {
        return null;
      }
      return {
        x: Math.round((relX / layout.drawW) * srcW),
        y: Math.round((relY / layout.drawH) * srcH),
        width: Math.round((dispW / layout.drawW) * srcW),
        height: Math.round((dispH / layout.drawH) * srcH),
      };
    },
    [layout, srcH, srcW],
  );

  const toDisplayCoords = useCallback(
    (sel) => {
      if (!sel || !layout) return null;
      return {
        x: layout.offsetX + (sel.x / srcW) * layout.drawW,
        y: layout.offsetY + (sel.y / srcH) * layout.drawH,
        width: (sel.width / srcW) * layout.drawW,
        height: (sel.height / srcH) * layout.drawH,
      };
    },
    [layout, srcH, srcW],
  );

  const handleDimensions = (w, h) => {
    const width = sourceWidth || w || 1920;
    const height = sourceHeight || h || 1080;
    onChange({
      ...value,
      sourceWidth: width,
      sourceHeight: height,
      endOffset: value.endOffset ?? clipDuration,
    });
    updateDisplaySize();
  };

  const setSelectionFromDisplay = useCallback(
    (disp) => {
      const v = toSourceCoords(disp.x, disp.y, disp.width, disp.height);
      if (!v || v.width < 24 || v.height < 24) return;
      onChange({
        ...value,
        sourceWidth: srcW,
        sourceHeight: srcH,
        selection: v,
        pip: value.pip || defaultWidePipSettings(v),
      });
    },
    [onChange, srcH, srcW, toSourceCoords, value],
  );

  const getPointerDisp = (e) => {
    const rect = containerRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e) => {
    if (!layout) return;
    e.preventDefault();
    const ptr = getPointerDisp(e);
    const disp = toDisplayCoords(selection);

    if (disp) {
      const handle = 12;
      const onRight = ptr.x >= disp.x + disp.width - handle;
      const onBottom = ptr.y >= disp.y + disp.height - handle;
      const inside =
        ptr.x >= disp.x &&
        ptr.x <= disp.x + disp.width &&
        ptr.y >= disp.y &&
        ptr.y <= disp.y + disp.height;

      if (onRight && onBottom) {
        setDragging({ mode: 'resize', startPtr: ptr, startDisp: { ...disp } });
        return;
      }
      if (inside) {
        setDragging({ mode: 'move', startPtr: ptr, startDisp: { ...disp } });
        return;
      }
    }

    setDragging({
      mode: 'draw',
      startPtr: ptr,
      startDisp: { x: ptr.x, y: ptr.y, width: 0, height: 0 },
    });
  };

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e) => {
      const ptr = getPointerDisp(e);
      const { mode, startPtr, startDisp } = dragging;

      if (mode === 'draw') {
        setSelectionFromDisplay({
          x: Math.min(startPtr.x, ptr.x),
          y: Math.min(startPtr.y, ptr.y),
          width: Math.abs(ptr.x - startPtr.x),
          height: Math.abs(ptr.y - startPtr.y),
        });
        return;
      }

      if (mode === 'move') {
        const dx = ptr.x - startPtr.x;
        const dy = ptr.y - startPtr.y;
        setSelectionFromDisplay({
          x: clamp(startDisp.x + dx, layout.offsetX, layout.offsetX + layout.drawW - startDisp.width),
          y: clamp(startDisp.y + dy, layout.offsetY, layout.offsetY + layout.drawH - startDisp.height),
          width: startDisp.width,
          height: startDisp.height,
        });
        return;
      }

      if (mode === 'resize') {
        const maxX = layout.offsetX + layout.drawW;
        const maxY = layout.offsetY + layout.drawH;
        setSelectionFromDisplay({
          x: startDisp.x,
          y: startDisp.y,
          width: clamp(ptr.x - startDisp.x, 32, maxX - startDisp.x),
          height: clamp(ptr.y - startDisp.y, 32, maxY - startDisp.y),
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
  }, [dragging, layout, setSelectionFromDisplay]);

  const dispSel = toDisplayCoords(selection);
  const startOff = value.startOffset ?? 0;
  const endOff = value.endOffset ?? clipDuration;

  return (
    <div className="space-y-3 border border-emerald-500/20 rounded-xl p-3 bg-emerald-500/5">
      <p className="text-xs text-emerald-300/90 font-medium">
        Bereich auf dem 16:9-Original markieren (Buch, Menü, UI)
      </p>
      <div
        ref={containerRef}
        className="relative aspect-video min-h-[160px] sm:min-h-0 w-full bg-black rounded-lg overflow-hidden cursor-crosshair select-none touch-none"
        onPointerDown={onPointerDown}
      >
        <SourceFrameBackdrop
          imageUrl={imageUrl}
          videoUrl={videoUrl}
          seekSec={seekSec}
          alt="Wide overlay source"
          onDimensions={handleDimensions}
        />
        {dispSel && dispSel.width > 4 && (
          <div
            className="absolute border-2 border-dashed border-emerald-400 bg-emerald-400/15 pointer-events-none"
            style={{
              left: dispSel.x,
              top: dispSel.y,
              width: dispSel.width,
              height: dispSel.height,
            }}
          >
            <span className="absolute -top-5 left-0 text-2xs text-emerald-400 font-medium">
              Wide-UI
            </span>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() =>
            onChange({
              ...value,
              selection: defaultWideSelection(srcW, srcH),
              pip: defaultWidePipSettings(defaultWideSelection(srcW, srcH)),
            })
          }
          className="text-xs px-2 py-1 rounded-lg border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
        >
          Vorschlag (Mitte)
        </button>
      </div>
      <p className="text-xs text-theme-muted">
        Rechteck ziehen wie bei der Webcam — wird in der Vorschau und im Export eingeblendet.
      </p>
      {selection?.width > 0 && (
        <WebcamPipPreview
          imageUrl={clipPreviewUrl || imageUrl}
          videoUrl={clipPreviewUrl ? null : videoUrl}
          seekSec={seekSec}
          sourceWidth={srcW}
          sourceHeight={srcH}
          selection={selection}
          pip={value.pip || defaultWidePipSettings(selection)}
          onPipChange={(pip) => onChange({ ...value, pip })}
          maxSizePercent={96}
          minSizePercent={40}
          accent="emerald"
          label="9:16 — Größe & Position (Wide-UI)"
          layoutMode="wide"
        />
      )}

      <div className="grid grid-cols-2 gap-2 text-xs text-theme-muted">
        <label>
          Von (s)
          <input
            type="number"
            min={0}
            max={endOff}
            step={0.5}
            value={startOff}
            onChange={(e) =>
              onChange({ ...value, startOffset: Math.max(0, Number(e.target.value)) })
            }
            className="mt-1 w-full peak-input !rounded-lg !py-1 !px-2 !text-sm"
          />
        </label>
        <label>
          Bis (s)
          <input
            type="number"
            min={startOff + 0.5}
            max={clipDuration}
            step={0.5}
            value={endOff}
            onChange={(e) =>
              onChange({
                ...value,
                endOffset: Math.min(clipDuration, Number(e.target.value)),
              })
            }
            className="mt-1 w-full peak-input !rounded-lg !py-1 !px-2 !text-sm"
          />
        </label>
      </div>
    </div>
  );
}
