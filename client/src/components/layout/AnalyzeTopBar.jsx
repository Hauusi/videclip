import VideoSourceInput from './VideoSourceInput';

export default function AnalyzeTopBar({
  url,
  onUrlChange,
  onUrlPaste,
  onAnalyze,
  onLocalUpload,
  onClearLocal,
  analyzing,
  urlError,
  localFileName,
  history = [],
  onHistoryPick,
  clipCount = 0,
}) {
  return (
    <div className="shrink-0 border-b peak-bar px-4 lg:px-6 py-3 safe-top sticky top-0 z-20">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 max-w-[1600px] mx-auto w-full">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-peak-muted mb-1.5 hidden sm:block">
            {clipCount > 0
              ? `${clipCount} Clips gefunden — neues Video analysieren`
              : 'Neues Video analysieren'}
          </p>
          <VideoSourceInput
            variant="compact"
            url={url}
            onUrlChange={onUrlChange}
            onUrlPaste={onUrlPaste}
            onAnalyze={onAnalyze}
            onLocalUpload={onLocalUpload}
            onClearLocal={onClearLocal}
            analyzing={analyzing}
            urlError={urlError}
            localFileName={localFileName}
            analyzeLabel="Analysieren"
            analyzingLabel="Läuft…"
          />
        </div>

        {history.length > 0 && (
          <div className="flex flex-wrap gap-1.5 items-center sm:max-w-[280px] shrink-0">
            {history.slice(0, 3).map((h) => (
              <button
                key={h.at}
                type="button"
                onClick={() => onHistoryPick?.(h)}
                className="text-2xs px-2 py-1 rounded-md peak-panel-elevated hover:border-peak-purple/30 text-theme-muted hover:text-theme truncate max-w-[120px] transition-colors"
                title={h.title}
              >
                {h.title}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
