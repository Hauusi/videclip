const EXTENSION_URL =
  'https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc';

export default function CookiesExpiredModal({
  open,
  cookiesPath,
  refreshing,
  mode = 'cookies',
  onAutoRefresh,
  onRetry,
  onClose,
}) {
  if (!open) return null;

  const isDatacenter = mode === 'datacenter';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div
        className="peak-panel shadow-glow-lg max-w-lg w-full p-6 space-y-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cookies-modal-title"
      >
        <div>
          <h2 id="cookies-modal-title" className="text-lg font-semibold text-white">
            {isDatacenter ? 'YouTube blockiert Server-IP' : 'YouTube-Anmeldung nötig'}
          </h2>
          <p className="text-base text-gray-400 mt-2 leading-relaxed">
            {isDatacenter
              ? 'Deine Cookies sind in Ordnung — YouTube lehnt Anfragen vom Hetzner-Server ab (Rechenzentrum-IP). Ein Browser-Login auf dem Server hilft hier nicht.'
              : 'PeakClip hat die Anmeldung automatisch erneuert — das hat diesmal nicht gereicht. Einmal im Browser bei YouTube anmelden, danach läuft es wieder ohne manuelle Cookies-Datei.'}
          </p>
        </div>

        <div className="text-base text-gray-300 space-y-2 leading-relaxed">
          {isDatacenter ? (
            <>
              <p>
                <strong className="text-white">Lösung:</strong> Residential-Proxy in{' '}
                <code className="text-violet-300">/opt/videclip/server/.env</code> setzen:
              </p>
              <p className="text-xs font-mono text-gray-400 break-all bg-black/30 rounded-lg p-2">
                YTDLP_PROXY=http://user:pass@host:port
              </p>
              <p className="text-xs text-gray-500">
                Danach: <code className="text-violet-300">systemctl restart videclip</code>
              </p>
              <p className="text-xs text-gray-500">
                Oder PeakClip lokal auf deinem PC nutzen — dort funktioniert YouTube ohne Proxy.
              </p>
            </>
          ) : (
            <>
              <p>
                <strong className="text-white">Automatisch:</strong> „Erneut versuchen“ — es öffnet
                sich ggf. ein Browserfenster. Dort bei YouTube einloggen und das Fenster offen
                lassen, bis der Vorgang fertig ist.
              </p>
              <p className="text-xs text-gray-500">
                Auf dem Live-Server (Hetzner) stattdessen: Extension{' '}
                <a
                  href={EXTENSION_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-violet-400 hover:text-violet-300 underline"
                >
                  Get cookies.txt LOCALLY
                </a>{' '}
                → hochladen nach{' '}
                <code className="text-violet-300">/opt/videclip/server/cookies.txt</code>
              </p>
              <p className="text-xs font-mono text-gray-400 break-all bg-black/30 rounded-lg p-2">
                {cookiesPath || 'cookies.txt im Projektordner'}
              </p>
            </>
          )}
        </div>

        <div className="flex flex-col-reverse sm:flex-row flex-wrap gap-2 sm:justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={refreshing}
            className="w-full sm:w-auto min-h-[44px] px-4 py-2 rounded-xl text-sm border border-white/10 text-gray-400 hover:border-white/20 disabled:opacity-50"
          >
            Abbrechen
          </button>
          {!isDatacenter && (
            <button
              type="button"
              onClick={onAutoRefresh}
              disabled={refreshing}
              className="w-full sm:w-auto min-h-[44px] px-4 py-2 rounded-xl text-sm gradient-accent text-white font-medium disabled:opacity-50"
            >
              {refreshing ? 'Browser öffnet…' : 'Erneut versuchen'}
            </button>
          )}
          <button
            type="button"
            onClick={onRetry}
            disabled={refreshing}
            className="w-full sm:w-auto min-h-[44px] px-4 py-2 rounded-xl text-sm border border-violet-500/40 text-violet-200 hover:border-violet-400 disabled:opacity-50"
          >
            Nur Analyze wiederholen
          </button>
        </div>
      </div>
    </div>
  );
}
