import { useEffect, useRef } from 'react';
import { isVideoMediaUrl } from '../utils/trimLimits';

/**
 * Background for overlay pickers: JPEG thumbnail or seeked source video frame.
 */
export default function SourceFrameBackdrop({
  imageUrl,
  videoUrl,
  seekSec = 0,
  alt = 'Source frame',
  className = 'w-full h-full object-contain pointer-events-none',
  onDimensions,
}) {
  const videoRef = useRef(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoUrl || !isVideoMediaUrl(videoUrl)) return undefined;

    const seek = () => {
      const t = Math.max(0, Number(seekSec) || 0);
      if (Number.isFinite(v.duration) && v.duration > 0 && t > v.duration - 0.05) {
        v.currentTime = Math.max(0, v.duration - 0.1);
      } else {
        v.currentTime = t;
      }
    };

    if (v.readyState >= 1) seek();
    v.addEventListener('loadedmetadata', seek);
    return () => v.removeEventListener('loadedmetadata', seek);
  }, [videoUrl, seekSec]);

  if (videoUrl && isVideoMediaUrl(videoUrl)) {
    return (
      <video
        ref={videoRef}
        src={videoUrl}
        className={className}
        muted
        playsInline
        preload="metadata"
        onLoadedData={(e) => {
          const el = e.currentTarget;
          onDimensions?.(el.videoWidth, el.videoHeight);
        }}
      />
    );
  }

  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={alt}
        className={className}
        draggable={false}
        onLoad={(e) => {
          const el = e.currentTarget;
          onDimensions?.(el.naturalWidth, el.naturalHeight);
        }}
      />
    );
  }

  return <div className="w-full h-full bg-surface-elevated animate-pulse" />;
}
