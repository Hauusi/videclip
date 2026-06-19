import PeakClipLogo from '../brand/PeakClipLogo';
import ThemeToggle from './ThemeToggle';
import { formatRelativeTime, projectClipLabel } from '../../utils/projects';

const NAV = [
  {
    id: 'overview',
    label: 'Start',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
      </svg>
    ),
  },
  {
    id: 'projects',
    label: 'Bibliothek',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 7a2 2 0 012-2h3l1.5 2H18a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2V7z"
        />
      </svg>
    ),
  },
];

function NavButton({ item, isActive, collapsed, onNavigate }) {
  return (
    <button
      type="button"
      disabled={item.disabled}
      title={collapsed ? item.label : undefined}
      onClick={() => !item.disabled && onNavigate?.(item.id)}
      className={`peak-nav-item ${collapsed ? 'justify-center px-2' : ''} ${
        isActive ? 'peak-nav-active' : item.disabled ? 'opacity-50 cursor-not-allowed' : 'peak-nav-idle'
      }`}
    >
      <span className="shrink-0 opacity-90">{item.icon}</span>
      {!collapsed && <span className="truncate">{item.label}</span>}
    </button>
  );
}

export default function AppSidebar({
  active = 'overview',
  onNavigate,
  collapsed = false,
  onToggleCollapse,
  history = [],
  activeJobId,
  onLoadProject,
  onNewProject,
  onHome,
  theme,
  onToggleTheme,
}) {
  return (
    <aside
      className={`hidden lg:flex shrink-0 flex-col peak-sidebar transition-[width] duration-200 ease-out overflow-hidden ${
        collapsed ? 'w-[76px]' : 'w-[268px]'
      }`}
      aria-label="Hauptnavigation"
    >
      <div
        className={`border-b flex items-center gap-2 ${
          collapsed ? 'px-3 pt-6 pb-4 justify-center' : 'px-4 pt-7 pb-5'
        }`}
        style={{ borderColor: 'var(--t-border)' }}
      >
        <PeakClipLogo collapsed={collapsed} onClick={onHome} />
        {!collapsed && onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            className="ml-auto shrink-0 w-8 h-8 rounded-lg border text-theme-muted hover:text-theme flex items-center justify-center text-sm transition-colors"
            style={{ borderColor: 'var(--t-border)' }}
            aria-label="Menü einklappen"
          >
            ‹
          </button>
        )}
      </div>

      {collapsed && onToggleCollapse && (
        <div className="px-2 pt-2">
          <button
            type="button"
            onClick={onToggleCollapse}
            className="w-full h-9 rounded-lg border text-theme-muted hover:text-theme flex items-center justify-center text-sm"
            style={{ borderColor: 'var(--t-border)' }}
            aria-label="Menü ausklappen"
          >
            ›
          </button>
        </div>
      )}

      <nav className={`space-y-1 ${collapsed ? 'p-2' : 'px-3 py-3'}`}>
        {!collapsed && <p className="type-label px-3 mb-2">Workspace</p>}
        {NAV.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            isActive={active === item.id}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        ))}
        {!collapsed && onNewProject && (
          <button
            type="button"
            onClick={onNewProject}
            className="w-full mt-2 peak-btn-primary !py-2.5 !text-sm flex items-center justify-center gap-2"
          >
            <span className="text-lg leading-none">+</span>
            Neues Video
          </button>
        )}
      </nav>

      {!collapsed && history.length > 0 && (
        <div className="flex-1 min-h-0 flex flex-col px-3 pb-2 overflow-hidden">
          <p className="type-label px-1 mb-2 shrink-0">Zuletzt</p>
          <ul className="space-y-1 overflow-y-auto scrollbar-thin flex-1 min-h-0 pr-0.5">
            {history.map((entry) => {
              const isActive = activeJobId && entry.jobId === activeJobId;
              const when = formatRelativeTime(entry.updatedAt || entry.createdAt || entry.at);
              const clips = projectClipLabel(entry.clipCount);
              return (
                <li key={entry.id || entry.jobId || entry.at}>
                  <button
                    type="button"
                    onClick={() => onLoadProject?.(entry)}
                    className={`w-full text-left px-2.5 py-2 rounded-xl border transition-colors ${
                      isActive
                        ? 'bg-peak-purple/12 border-peak-purple/30'
                        : 'border-transparent hover:border-[var(--t-border)] hover:bg-[color-mix(in_srgb,var(--t-text)_4%,transparent)]'
                    }`}
                  >
                    <p className="text-sm font-medium text-theme truncate leading-snug">
                      {entry.title || 'Video'}
                    </p>
                    <p className="text-[10px] text-theme-muted mt-0.5 truncate">
                      {[clips, when].filter(Boolean).join(' · ')}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!collapsed && !history.length && <div className="flex-1" />}

      {collapsed && <div className="flex-1" />}

      {!collapsed && (
        <div
          className="mx-3 mb-2 p-3 rounded-2xl border border-peak-purple/20 bg-gradient-to-br from-peak-purple/10 to-transparent"
        >
          <p className="text-sm font-semibold text-theme">Pro</p>
          <p className="text-xs text-theme-muted mt-1 leading-snug">Bald: unbegrenzte Analysen</p>
        </div>
      )}

      <div
        className={`space-y-2 ${collapsed ? 'p-2' : 'px-3 py-3'}`}
        style={{ borderTop: '1px solid var(--t-border)' }}
      >
        <ThemeToggle theme={theme} onToggle={onToggleTheme} collapsed={collapsed} />
      </div>
    </aside>
  );
}
