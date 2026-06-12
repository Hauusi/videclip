export default function ProgressSteps({ steps = [], current = 0, progress = 0 }) {
  const pct = Math.max(0, Math.min(100, Number(progress) || 0));
  return (
    <div className="space-y-2">
      {steps.length > 0 && (
        <div className="flex flex-wrap gap-2 text-sm text-gray-500">
          {steps.map((label, i) => (
            <span key={label} className={i <= current ? 'text-violet-300' : ''}>
              {label}
            </span>
          ))}
        </div>
      )}
      <div className="h-2 bg-surface-elevated rounded-full overflow-hidden">
        <div
          className="h-full gradient-accent transition-all duration-500 rounded-full"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
