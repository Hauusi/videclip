import PeakClipMark from './PeakClipMark';

export default function PeakClipLogo({ collapsed = false, className = '', onClick }) {
  const content = collapsed ? (
    <PeakClipMark className={`h-11 w-11 shrink-0 ${className}`} title="PeakClip" />
  ) : (
    <div className={`flex items-center gap-3 shrink-0 min-w-0 ${className}`}>
      <PeakClipMark className="h-12 w-12 shrink-0" title="" aria-hidden />
      <div className="flex flex-col min-w-0 leading-none gap-1">
        <span className="text-[19px] font-bold tracking-tight whitespace-nowrap">
          <span className="text-theme">Peak</span>
          <span className="text-peak-purple">Clip</span>
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-theme-muted whitespace-nowrap">
          Only the peaks
        </span>
      </div>
    </div>
  );

  if (!onClick) return content;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Zur Startseite"
      className={`group rounded-xl transition-colors hover:bg-[color-mix(in_srgb,var(--t-text)_5%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-peak-purple/35 ${
        collapsed ? 'p-1' : 'px-1 py-0.5 -mx-1'
      }`}
    >
      {content}
    </button>
  );
}
