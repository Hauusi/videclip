import PeakClipLogo from '../brand/PeakClipLogo';

export default function MobileBottomBar({ isEditView, onBackToOverview, onHome }) {
  return (
    <nav
      className="lg:hidden shrink-0 border-t peak-bar safe-bottom z-30"
      aria-label="Mobile Navigation"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <PeakClipLogo collapsed className="!h-9 !w-9" onClick={onHome} />
        <button
          type="button"
          onClick={onBackToOverview}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-colors ${
            !isEditView
              ? 'text-white bg-peak-purple/15 border border-peak-purple/25'
              : 'text-peak-muted border border-transparent'
          }`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6z" />
          </svg>
          Clips
        </button>
        {isEditView && (
          <span className="flex-[2] text-center text-2xs text-peak-muted px-2 truncate">
            Editor aktiv
          </span>
        )}
      </div>
    </nav>
  );
}
