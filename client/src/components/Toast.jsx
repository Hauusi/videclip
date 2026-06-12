export default function Toast({ toasts, onDismiss }) {
  if (!toasts?.length) return null;
  return (
    <div className="fixed bottom-4 left-3 right-3 sm:left-auto sm:right-4 z-50 flex flex-col gap-2 max-w-md safe-bottom pointer-events-none [&>*]:pointer-events-auto">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`animate-fade-in rounded-xl border px-4 py-3 shadow-card text-sm backdrop-blur-xl ${
            t.type === 'error'
              ? 'bg-red-950/90 border-red-500/40 text-red-100'
              : 'bg-surface-card/95 border-peak-purple/30 text-gray-100'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="break-words text-left">{t.message}</p>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              className="text-peak-muted hover:text-white shrink-0 w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/[0.06]"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
