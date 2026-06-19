import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CROP_ZOOM_FROM_PORTRAIT,
  FILL_WIDTH_FROM_LANDSCAPE_PCT,
  FILL_ZOOM_FROM_PORTRAIT,
  isLandscapeVideo,
  normalizeGameplayFramingMode,
} from '../utils/gameplayFraming';

/** Sync blurred background layer to main video (wide / 4:3 crop). */
function useSyncedBgVideo(mainRef, bgRef, enabled) {
  useEffect(() => {
    const main = mainRef.current;
    const bg = bgRef.current;
    if (!enabled || !main || !bg) return undefined;

    const syncTime = () => {
      if (!Number.isFinite(main.currentTime)) return;
      if (Math.abs(bg.currentTime - main.currentTime) > 0.12) {
        try {
          bg.currentTime = main.currentTime;
        } catch {
          /* ignore */
        }
      }
    };

    const onPlay = () => {
      bg.play().catch(() => {});
    };
    const onPause = () => {
      bg.pause();
    };

    main.addEventListener('timeupdate', syncTime);
    main.addEventListener('seeked', syncTime);
    main.addEventListener('play', onPlay);
    main.addEventListener('pause', onPause);

    return () => {
      main.removeEventListener('timeupdate', syncTime);
      main.removeEventListener('seeked', syncTime);
      main.removeEventListener('play', onPlay);
      main.removeEventListener('pause', onPause);
    };
  }, [mainRef, bgRef, enabled]);
}

function resolveSourceAspect(videoEl, fallbackAspect) {
  const vw = videoEl?.videoWidth || 0;
  const vh = videoEl?.videoHeight || 0;
  if (vw > 0 && vh > 0) return vw / vh;
  return Number(fallbackAspect) || 16 / 9;
}

/**
 * Real-time 9:16 framing — wide: 16:9 + blur | crop: 4:3 + blur | fill: classic 9:16 center strip.
 */
export default function GameplayFramingPreview({
  src,
  fallbackSrc = null,
  mode = 'wide',
  videoRef,
  sourceAspectFallback = 16 / 9,
  children,
  onLoadedMetadata,
  onTimeUpdate,
  onCanPlay,
  playsInline = true,
}) {
  const bgRef = useRef(null);
  const [activeSrc, setActiveSrc] = useState(src);
  const [sourceAspect, setSourceAspect] = useState(sourceAspectFallback);
  const framing = normalizeGameplayFramingMode(mode);
  const landscape = isLandscapeVideo(sourceAspect);
  const showBlur = landscape && framing !== 'fill';

  useEffect(() => {
    setActiveSrc(src);
    setSourceAspect(sourceAspectFallback);
  }, [src, sourceAspectFallback]);

  useSyncedBgVideo(videoRef, bgRef, showBlur);

  const handleLoadedMetadata = useCallback(
    (e) => {
      const v = e.currentTarget;
      setSourceAspect(resolveSourceAspect(v, sourceAspectFallback));
      onLoadedMetadata?.(e);
    },
    [onLoadedMetadata, sourceAspectFallback],
  );

  const handleError = useCallback(() => {
    if (fallbackSrc && activeSrc !== fallbackSrc) {
      setActiveSrc(fallbackSrc);
      setSourceAspect(9 / 16);
    }
  }, [activeSrc, fallbackSrc]);

  const bindVideoRef = useCallback(
    (node) => {
      if (typeof videoRef === 'function') {
        videoRef(node);
      } else if (videoRef) {
        videoRef.current = node;
      }
    },
    [videoRef],
  );

  const videoProps = {
    src: activeSrc,
    playsInline,
    autoPlay: true,
    muted: true,
    preload: 'auto',
    onLoadedMetadata: handleLoadedMetadata,
    onTimeUpdate,
    onCanPlay,
    onError: handleError,
  };

  let foreground = null;

  if (landscape) {
    if (framing === 'wide') {
      foreground = (
        <div className="absolute inset-0 z-[1] flex items-center justify-center">
          <video
            ref={bindVideoRef}
            {...videoProps}
            className="block w-full h-auto max-h-full max-w-full object-contain"
          />
        </div>
      );
    } else if (framing === 'crop') {
      foreground = (
        <div className="absolute inset-0 z-[1] flex items-center justify-center">
          <div className="relative w-full aspect-[4/3] overflow-hidden">
            <video
              ref={bindVideoRef}
              {...videoProps}
              className="absolute inset-0 block h-full w-full object-cover object-center"
            />
          </div>
        </div>
      );
    } else {
      foreground = (
        <div className="absolute inset-0 z-[1] overflow-hidden">
          <video
            ref={bindVideoRef}
            {...videoProps}
            className="absolute top-1/2 left-1/2 block h-full max-w-none -translate-x-1/2 -translate-y-1/2 object-cover object-center"
            style={{ width: `${FILL_WIDTH_FROM_LANDSCAPE_PCT}%` }}
          />
        </div>
      );
    }
  } else if (framing === 'wide') {
    foreground = (
      <video
        ref={bindVideoRef}
        {...videoProps}
        className="absolute inset-0 z-[1] block h-full w-full object-contain object-center"
      />
    );
  } else {
    const zoom = framing === 'crop' ? CROP_ZOOM_FROM_PORTRAIT : FILL_ZOOM_FROM_PORTRAIT;
    foreground = (
      <video
        ref={bindVideoRef}
        {...videoProps}
        className="absolute z-[1] block origin-center object-cover object-center"
        style={{
          left: '50%',
          top: '50%',
          width: '100%',
          height: '100%',
          transform: `translate(-50%, -50%) scale(${zoom})`,
        }}
      />
    );
  }

  return (
    <div className="absolute inset-0 overflow-hidden bg-black">
      {showBlur && (
        <video
          ref={bgRef}
          src={activeSrc}
          playsInline
          autoPlay
          muted
          preload="auto"
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full scale-[1.12] object-cover blur-2xl brightness-[0.94] saturate-[0.88]"
        />
      )}
      {foreground}
      {children}
    </div>
  );
}
