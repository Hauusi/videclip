const PIPELINE = [
  { keys: ['fetching'], label: 'Import', desc: 'Video wird geladen' },
  { keys: ['analyzing'], label: 'KI-Analyse', desc: 'Highlights werden erkannt' },
  {
    keys: ['editing', 'transcribing'],
    label: 'Clips erstellen',
    desc: 'Schnitt, Untertitel & Rendering',
  },
  { keys: ['ready'], label: 'Fertig', desc: 'Bereit zum Bearbeiten' },
];

function stepIndex(step) {
  if (!step) return -1;
  if (step === 'ready') return 3;
  const i = PIPELINE.findIndex((p) => p.keys.includes(step));
  return i >= 0 ? i : 0;
}

export default function AnalysisFooter({ active, job, analyzing }) {
  if (!active) return null;

  const current = stepIndex(job?.step);
  const progress = job?.progress ?? (analyzing ? 12 : 0);
  const circumference = 2 * Math.PI * 18;
  const dash = (progress / 100) * circumference;
  const currentStep = PIPELINE[current] || PIPELINE[0];

  return (
    <footer className="shrink-0 border-t peak-bar px-4 lg:px-6 py-4 safe-bottom">
      <div className="max-w-[1600px] mx-auto flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden mb-3">
            <div
              className="h-full bg-peak-gradient rounded-full transition-all duration-500 ease-out"
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-thin pb-0.5">
            {PIPELINE.map((step, i) => {
              const done = current > i || job?.step === 'ready';
              const isCurrent = current === i;
              return (
                <div key={step.label} className="flex items-center shrink-0">
                  <div
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-2xs font-medium transition-colors ${
                      done
                        ? 'text-peak-purple'
                        : isCurrent
                          ? 'text-white bg-white/[0.06]'
                          : 'text-gray-600'
                    }`}
                  >
                    <span
                      className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                        done
                          ? 'bg-peak-purple/20 text-peak-purple'
                          : isCurrent
                            ? 'bg-peak-purple text-white'
                            : 'bg-white/[0.04] text-gray-600'
                      }`}
                    >
                      {done ? '✓' : i + 1}
                    </span>
                    <span className="hidden sm:inline whitespace-nowrap">{step.label}</span>
                  </div>
                  {i < PIPELINE.length - 1 && (
                    <span className="text-gray-700 mx-0.5 hidden md:inline">·</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          <div className="relative w-16 h-16">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 40 40">
              <circle cx="20" cy="20" r="18" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2.5" />
              <circle
                cx="20"
                cy="20"
                r="18"
                fill="none"
                stroke="url(#peakProg)"
                strokeWidth="2.5"
                strokeDasharray={`${dash} ${circumference}`}
                strokeLinecap="round"
                className="transition-all duration-500"
              />
              <defs>
                <linearGradient id="peakProg" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#9490ff" />
                  <stop offset="100%" stopColor="#deb8ff" />
                </linearGradient>
              </defs>
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-white tabular-nums">
              {Math.round(progress)}%
            </span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">
              {job?.step === 'ready' ? 'Fertig!' : currentStep.label}
            </p>
            <p className="text-xs text-peak-muted max-w-[220px] truncate">
              {job?.message || currentStep.desc}
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
