import { useCallback, useEffect, useRef, useState } from 'react';
import WebcamPipPreview, { defaultPipSettings } from './WebcamPipPreview.jsx';
import SourceFrameBackdrop from './SourceFrameBackdrop.jsx';

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
    scale,
  };
}

export default function WebcamSelector({
  imageUrl,
  videoUrl,
  seekSec = 0,
  clipPreviewUrl = null,
  sourceWidth,
  sourceHeight,
  value,
  onChange,
}) {
  const containerRef = useRef(null);
  const [dragging, setDragging] = useState(null);
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });

  const srcW = value.sourceWidth || sourceWidth || value.videoWidth || 1920;
  const srcH = value.sourceHeight || sourceHeight || value.videoHeight || 1080;
  const selection = value.selection;
  const pip = value.pip || defaultPipSettings();

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
      videoWidth: width,
      videoHeight: height,
      pip: value.pip || defaultPipSettings(),
      selection:
        value.selection || {
          x: Math.round(w * 0.65),
          y: Math.round(h * 0.02),
          width: Math.round(w * 0.3),
          height: Math.round(h * 0.22),
        },
    });
    updateDisplaySize();
  };

  const setSelectionFromDisplay = useCallback(
    (disp) => {
      const v = toSourceCoords(disp.x, disp.y, disp.width, disp.height);
      if (!v || v.width < 8 || v.height < 8) return;
      onChange({
        ...value,
        sourceWidth: srcW,
        sourceHeight: srcH,
        pip: value.pip || defaultPipSettings(),
        selection: v,
      });
    },
    [onChange, srcH, srcW, toSourceCoords, value],
  );

  const getPointerDisp = (e) => {
    const rect = containerRef.current.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
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
        const x = Math.min(startPtr.x, ptr.x);
        const y = Math.min(startPtr.y, ptr.y);
        const width = Math.abs(ptr.x - startPtr.x);
        const height = Math.abs(ptr.y - startPtr.y);
        setSelectionFromDisplay({ x, y, width, height });
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
        const width = clamp(ptr.x - startDisp.x, 24, maxX - startDisp.x);
        const height = clamp(ptr.y - startDisp.y, 24, maxY - startDisp.y);
        setSelectionFromDisplay({
          x: startDisp.x,
          y: startDisp.y,
          width,
          height,
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

  return (
    <div className="space-y-3 border-t border-theme pt-3">
      <p className="text-xs text-theme-muted uppercase tracking-wide">
        Webcam area (full {srcW}×{srcH} source frame)
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
          alt="Select webcam on source frame"
          onDimensions={handleDimensions}
        />
        {dispSel && dispSel.width > 4 && (
          <div
            className="absolute border-2 border-dashed border-red-500 bg-red-500/10 pointer-events-none"
            style={{
              left: dispSel.x,
              top: dispSel.y,
              width: dispSel.width,
              height: dispSel.height,
            }}
          >
            <span className="absolute -top-5 left-0 text-2xs text-red-400 font-medium whitespace-nowrap">
              Webcam
            </span>
          </div>
        )}
      </div>
      <p className="text-xs text-theme-muted">
        Draw on the original 16:9 frame. Coordinates are saved for the source video.
      </p>

      {selection?.width > 0 && (
        <WebcamPipPreview
          imageUrl={clipPreviewUrl || imageUrl}
          videoUrl={clipPreviewUrl ? null : videoUrl}
          seekSec={seekSec}
          sourceWidth={srcW}
          sourceHeight={srcH}
          selection={selection}
          pip={pip}
          onPipChange={(nextPip) =>
            onChange({
              ...value,
              pip: { ...pip, ...nextPip },
              shape: nextPip.shape,
            })
          }
        />
      )}
    </div>
  );
}
