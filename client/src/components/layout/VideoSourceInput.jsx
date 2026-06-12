import { useRef } from 'react';
import { ACCEPTED_VIDEO_ACCEPT } from '../../utils/helpers';

function UploadIcon({ className = 'w-5 h-5' }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 16V4" />
      <path d="M8 8l4-4 4 4" />
      <path d="M4 20h16" />
    </svg>
  );
}

export default function VideoSourceInput({
  url,
  onUrlChange,
  onUrlPaste,
  onAnalyze,
  onLocalUpload,
  onClearLocal,
  analyzing,
  urlError,
  localFileName = '',
  variant = 'hero',
  analyzeLabel = 'Clips finden',
  analyzingLabel = 'Analysiert…',
}) {
  const fileRef = useRef(null);
  const isHero = variant === 'hero';
  const hasLocal = Boolean(localFileName);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) onLocalUpload?.(file);
  };

  return (
    <div className="w-full">
      <div className={`import-source-row ${isHero ? 'import-source-row--hero' : 'import-source-row--compact'}`}>
        <div className="import-url-wrap">
          <span className="import-source-icon" aria-hidden>
            ▶
          </span>
          <input
            type="url"
            value={hasLocal ? '' : url}
            onChange={(e) => onUrlChange?.(e.target.value)}
            onPaste={() => onUrlPaste?.()}
            onKeyDown={(e) => e.key === 'Enter' && !analyzing && onAnalyze?.()}
            placeholder={
              hasLocal ? localFileName : 'https://youtube.com/watch?v=...'
            }
            disabled={analyzing}
            readOnly={hasLocal}
            className={`peak-input import-url-input ${isHero ? '!py-3.5 !text-base' : '!py-2.5 !text-sm'} ${
              urlError ? '!border-red-500/50 !ring-red-500/20' : ''
            } ${hasLocal ? 'import-url-input--local' : ''}`}
          />
        </div>

        <div className="import-divider" aria-hidden />

        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED_VIDEO_ACCEPT}
          className="sr-only"
          onChange={handleFileChange}
          tabIndex={-1}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={analyzing}
          className={`import-upload-btn ${isHero ? 'import-upload-btn--hero' : 'import-upload-btn--compact'}`}
          title="Lokales Video hochladen (MP4, MOV, WebM…)"
        >
          <UploadIcon className={isHero ? 'w-5 h-5' : 'w-4 h-4'} />
          <span className={isHero ? 'hidden sm:inline' : 'hidden md:inline'}>Hochladen</span>
        </button>

        <button
          type="button"
          onClick={onAnalyze}
          disabled={analyzing}
          className={`peak-btn-primary import-analyze-btn ${
            isHero
              ? 'w-full sm:w-auto sm:min-w-[160px] flex items-center justify-center gap-2 !py-3.5'
              : '!py-2.5 !px-5 !text-sm shrink-0 flex items-center gap-2'
          }`}
        >
          {analyzing ? (
            <>
              <span
                className={`border-2 border-white/30 border-t-white rounded-full animate-spin ${
                  isHero ? 'w-4 h-4' : 'w-3.5 h-3.5'
                }`}
              />
              {analyzingLabel}
            </>
          ) : (
            analyzeLabel
          )}
        </button>
      </div>

      {hasLocal && (
        <div className="import-file-chip">
          <span className="import-file-chip-icon" aria-hidden>
            <UploadIcon className="w-3.5 h-3.5" />
          </span>
          <span className="import-file-chip-name" title={localFileName}>
            {localFileName}
          </span>
          {!analyzing && (
            <button
              type="button"
              onClick={onClearLocal}
              className="import-file-chip-clear"
              aria-label="Datei entfernen"
            >
              ×
            </button>
          )}
        </div>
      )}

      {urlError && (
        <p className={`text-red-400 text-xs ${isHero ? 'mt-2 text-left px-1' : 'mt-1.5'}`}>
          {urlError}
        </p>
      )}
    </div>
  );
}
