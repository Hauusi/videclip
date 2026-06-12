import { useId } from 'react';

/**
 * PeakClip mountain mark — crisp vector icon for sidebar & favicon.
 */
export default function PeakClipMark({ className = '', title = 'PeakClip' }) {
  const uid = useId().replace(/:/g, '');
  const gradMain = `peak-main-${uid}`;
  const gradLeft = `peak-left-${uid}`;
  const gradRidge = `peak-ridge-${uid}`;
  const gradSnow = `peak-snow-${uid}`;
  const gradFlag = `peak-flag-${uid}`;

  return (
    <svg
      viewBox="0 0 52 52"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={title}
      className={className}
    >
      <defs>
        <linearGradient id={gradMain} x1="26" y1="8" x2="26" y2="42" gradientUnits="userSpaceOnUse">
          <stop stopColor="#b4afff" />
          <stop offset="0.55" stopColor="#9490ff" />
          <stop offset="1" stopColor="#6b66d9" />
        </linearGradient>
        <linearGradient id={gradLeft} x1="8" y1="42" x2="18" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#d4d0ff" />
          <stop offset="1" stopColor="#b4afff" />
        </linearGradient>
        <linearGradient id={gradRidge} x1="22" y1="42" x2="34" y2="10" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7a75e8" />
          <stop offset="1" stopColor="#5a55c4" />
        </linearGradient>
        <linearGradient id={gradSnow} x1="12" y1="28" x2="20" y2="18" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" />
          <stop offset="1" stopColor="#ede9fe" stopOpacity="0.35" />
        </linearGradient>
        <linearGradient id={gradFlag} x1="33" y1="2" x2="42" y2="8" gradientUnits="userSpaceOnUse">
          <stop stopColor="#e8d4ff" />
          <stop offset="1" stopColor="#deb8ff" />
        </linearGradient>
      </defs>

      {/* Soft ground glow */}
      <ellipse cx="26" cy="43.5" rx="19" ry="2.8" fill="#9490ff" opacity="0.18" />

      {/* Main mountain mass */}
      <path
        d="M5 41.5 L16.5 24.5 L21.8 30.8 L30.5 9.5 L43.5 41.5 Z"
        fill={`url(#${gradMain})`}
      />

      {/* Left slope — lit face */}
      <path d="M5 41.5 L16.5 24.5 L11.5 41.5 Z" fill={`url(#${gradLeft})`} />

      {/* Valley depth */}
      <path
        d="M16.5 24.5 L21.8 30.8 L17.2 41.5 L11.5 41.5 Z"
        fill="#5a55c4"
        opacity="0.42"
      />

      {/* Right ridge shadow */}
      <path d="M21.8 30.8 L30.5 9.5 L29.2 30.8 Z" fill={`url(#${gradRidge})`} opacity="0.9" />

      {/* Left snow cap */}
      <path d="M13.8 27.2 L16.5 24.5 L18.8 27.8 Z" fill={`url(#${gradSnow})`} />

      {/* Main peak snow */}
      <path d="M27.8 14.2 L30.5 9.5 L32.8 14.8 Z" fill="#ffffff" opacity="0.92" />
      <path d="M29.4 11.8 L30.5 9.5 L31.4 12.2 Z" fill="#ffffff" />

      {/* Summit highlight */}
      <circle cx="30.5" cy="9.5" r="1.1" fill="#ffffff" opacity="0.85" />

      {/* Flag pole */}
      <line
        x1="30.5"
        y1="9.5"
        x2="30.5"
        y2="3.2"
        stroke="#5a55c4"
        strokeWidth="1.6"
        strokeLinecap="round"
      />

      {/* Swallowtail flag */}
      <path
        d="M30.5 3.2 H39.2 L37 5.2 L39.5 7.2 L36.8 7.2 L34.2 9.2 H30.5 V3.2 Z"
        fill={`url(#${gradFlag})`}
      />
      <path d="M37 5.2 L39.5 7.2 L35 6.6 Z" fill="#fdf4ff" opacity="0.55" />
    </svg>
  );
}
