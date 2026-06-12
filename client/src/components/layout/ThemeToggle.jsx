export default function ThemeToggle({ theme, onToggle, collapsed = false }) {
  const isLight = theme === 'light';

  return (
    <button
      type="button"
      onClick={onToggle}
      title={isLight ? 'Dark Mode' : 'Light Mode'}
      className={`flex items-center gap-2 rounded-xl border border-[var(--t-border)] text-[var(--t-muted)] hover:text-[var(--t-text)] hover:border-peak-purple/30 transition-colors ${
        collapsed ? 'justify-center w-full p-2' : 'px-3 py-2 w-full text-sm'
      }`}
    >
      {isLight ? (
        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      ) : (
        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      )}
      {!collapsed && <span>{isLight ? 'Dark Mode' : 'Light Mode'}</span>}
    </button>
  );
}
