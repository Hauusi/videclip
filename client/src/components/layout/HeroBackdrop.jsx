import { useId } from 'react';

/**
 * App-wide ambient scenery — neon peak skyline + aurora.
 * Fixed to the main content panel (right of sidebar).
 */
export default function HeroBackdrop() {
  const uid = useId().replace(/:/g, '');
  const strokeNear = `hero-stroke-near-${uid}`;
  const strokeMid = `hero-stroke-mid-${uid}`;
  const horizon = `hero-horizon-${uid}`;
  const glow = `hero-glow-${uid}`;

  return (
    <div className="hero-backdrop" aria-hidden>
      <div className="hero-backdrop__aurora hero-backdrop__aurora--left" />
      <div className="hero-backdrop__aurora hero-backdrop__aurora--right" />
      <div className="hero-backdrop__aurora hero-backdrop__aurora--center" />

      <svg
        className="hero-backdrop__mountains"
        viewBox="-80 0 1600 360"
        preserveAspectRatio="xMidYMax slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id={strokeNear} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#9490ff" stopOpacity="0.15" />
            <stop offset="35%" stopColor="#b4afff" stopOpacity="0.85" />
            <stop offset="65%" stopColor="#deb8ff" stopOpacity="0.75" />
            <stop offset="100%" stopColor="#9490ff" stopOpacity="0.2" />
          </linearGradient>
          <linearGradient id={strokeMid} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#6b66d9" stopOpacity="0.1" />
            <stop offset="50%" stopColor="#b4afff" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#6b66d9" stopOpacity="0.1" />
          </linearGradient>
          <linearGradient id={horizon} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#9490ff" stopOpacity="0" />
            <stop offset="20%" stopColor="#b4afff" stopOpacity="0.9" />
            <stop offset="50%" stopColor="#deb8ff" stopOpacity="1" />
            <stop offset="80%" stopColor="#b4afff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#9490ff" stopOpacity="0" />
          </linearGradient>
          <filter id={glow} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Distant ridge */}
        <path
          className="hero-ridge hero-ridge--far"
          d="M-120 360 L40 210 L220 155 L400 235 L560 125 L760 205 L940 108 L1140 218 L1320 148 L1520 215 L1560 360 Z"
        />

        {/* Mid ridge */}
        <path
          className="hero-ridge hero-ridge--mid"
          d="M-60 360 L120 255 L300 175 L480 255 L640 145 L840 225 L1020 128 L1220 238 L1380 168 L1500 360 Z"
          stroke={`url(#${strokeMid})`}
        />

        {/* Edge fillers — seamless on ultra-wide screens */}
        <path
          className="hero-ridge hero-ridge--edge"
          d="M-80 360 L-80 300 L20 270 L80 360 Z"
        />
        <path
          className="hero-ridge hero-ridge--edge"
          d="M1440 360 L1440 290 L1340 260 L1280 360 Z"
        />

        {/* Foreground neon peaks */}
        <path
          className="hero-ridge hero-ridge--near"
          d="M-40 360 L180 285 L340 195 L500 275 L660 165 L820 245 L1000 148 L1160 258 L1320 188 L1480 360 Z"
          stroke={`url(#${strokeNear})`}
          filter={`url(#${glow})`}
        />

        {/* Accent summit markers */}
        <circle className="hero-summit" cx="660" cy="165" r="2.5" />
        <circle className="hero-summit" cx="1000" cy="148" r="3" />
        <circle className="hero-summit hero-summit--main" cx="1000" cy="148" r="6" />

        {/* Neon horizon line */}
        <line
          className="hero-horizon-line"
          x1="-40"
          y1="248"
          x2="1480"
          y2="248"
          stroke={`url(#${horizon})`}
          filter={`url(#${glow})`}
        />
      </svg>

      <div className="hero-backdrop__grid" />
      <div className="hero-backdrop__sides" />
      <div className="hero-backdrop__floor" />
      <div className="hero-backdrop__vignette" />
    </div>
  );
}
