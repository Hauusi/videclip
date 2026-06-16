import { GAMEPLAY_FRAMING_MODES } from '../../utils/gameplayFraming';

function FramingIcon({ mode, active }) {
  const frameClass = active
    ? 'border-peak-purple/50 bg-peak-purple/15'
    : 'border-white/20 bg-white/5';

  if (mode === 'wide') {
    return (
      <div className={`relative h-4 w-7 rounded-[3px] border ${frameClass}`}>
        <span className="absolute inset-0 flex items-center justify-center text-[6px] font-bold text-white/75">
          16:9
        </span>
      </div>
    );
  }

  if (mode === 'crop') {
    return (
      <div className="relative flex h-5 w-5 flex-col items-center justify-center">
        <span className="absolute inset-x-0 top-0 h-px rounded-full bg-peak-purple/80" aria-hidden />
        <div className={`h-4 w-4 rounded-[3px] border ${frameClass}`}>
          <span className="flex h-full items-center justify-center text-[6px] font-bold text-white/75">
            4:3
          </span>
        </div>
        <span className="absolute inset-x-0 bottom-0 h-px rounded-full bg-peak-purple/80" aria-hidden />
      </div>
    );
  }

  return (
    <div className={`relative h-5 w-3 rounded-[3px] border ${frameClass}`}>
      <span className="absolute inset-0 flex items-center justify-center text-[5px] font-bold leading-none text-white/75">
        9:16
      </span>
    </div>
  );
}

/** Horizontal gameplay framing control (Wide / Crop / Fill). */
export default function FramingBar({ value = 'wide', onChange, className = '', compact = false }) {
  return (
    <div
      className={`framing-toolbar ${compact ? 'framing-toolbar--compact' : ''} ${className}`}
      role="group"
      aria-label="Gameplay-Ausschnitt"
    >
      {Object.values(GAMEPLAY_FRAMING_MODES).map((mode) => {
        const active = value === mode.id;
        return (
          <button
            key={mode.id}
            type="button"
            onClick={() => onChange?.(mode.id)}
            className={`framing-toolbar-btn ${active ? 'framing-toolbar-btn--active' : ''}`}
            aria-pressed={active}
            title={mode.title}
          >
            <FramingIcon mode={mode.id} active={active} />
            {!compact && <span className="framing-toolbar-label">{mode.label}</span>}
            {compact && <span className="framing-toolbar-label framing-toolbar-label--compact">{mode.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
