import { MOODS } from '../utils/helpers';

export default function InputPanel({
  url,
  setUrl,
  mood,
  setMood,
  musicTrack,
  setMusicTrack,
  musicAuto = true,
  onMusicAuto,
  onMusicTrackPick,
  musicVolume = 15,
  onMusicVolume,
  customMusic,
  onCustomMusic,
  aspectRatio,
  setAspectRatio,
  captionStyle,
  setCaptionStyle,
  onAnalyze,
  analyzing,
  urlError,
}) {
  const tracks = [1, 2, 3];

  return (
    <div className="bg-surface-card border border-white/5 rounded-2xl p-6 shadow-card space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Neues Video</h2>
        <p className="text-xs text-gray-500 mb-4">
          Schritt 1: Link einfügen und analysieren. Die Clips bearbeiten Sie danach Karte für Karte.
        </p>
        <label className="block text-sm font-medium text-gray-300 mb-2">YouTube-URL</label>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://youtube.com/watch?v=..."
            className={`flex-1 bg-surface-elevated border rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 ${
              urlError ? 'border-red-500/50' : 'border-white/10'
            }`}
          />
          <button
            type="button"
            onClick={onAnalyze}
            disabled={analyzing}
            className="gradient-accent text-white font-semibold px-8 py-3 rounded-xl disabled:opacity-50 hover:opacity-90 transition-opacity shrink-0"
          >
            {analyzing ? 'Analysiere…' : 'Analyze'}
          </button>
        </div>
        {urlError && <p className="text-red-400 text-sm mt-2">{urlError}</p>}
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-white">Standard für alle Clips</h3>
          <p className="text-xs text-gray-500 mt-1">
            Gilt als Startwert jeder Clip-Karte. Pro Clip können Sie alles anpassen (Reihenfolge: Clip → Hook →
            … → Untertitel).
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">Seitenverhältnis</label>
          <div className="flex flex-wrap gap-2">
            {['9:16', '1:1', '16:9'].map((ar) => (
              <button
                key={ar}
                type="button"
                onClick={() => setAspectRatio(ar)}
                className={`px-4 py-2 rounded-lg text-sm border ${
                  aspectRatio === ar
                    ? 'border-violet-500 bg-violet-500/10 text-violet-300'
                    : 'border-white/10 text-gray-400'
                }`}
              >
                {ar}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">Untertitel-Stil (Standard)</label>
          <div className="flex flex-wrap gap-2">
            {[
              { id: 'fire', label: 'Fire' },
              { id: 'bold', label: 'Bold' },
              { id: 'minimal', label: 'Minimal' },
            ].map((style) => (
              <button
                key={style.id}
                type="button"
                onClick={() => setCaptionStyle(style.id)}
                className={`px-4 py-2 rounded-lg text-sm border capitalize ${
                  captionStyle === style.id
                    ? 'border-violet-500 bg-violet-500/10 text-violet-300'
                    : 'border-white/10 text-gray-400'
                }`}
              >
                {style.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-white">Musik (Hintergrund)</h3>
          <p className="text-xs text-gray-500 mt-1">
            Pro Clip automatisch passend — Lautstärke stellen Sie in Schritt 5 der Clip-Karte ein.
          </p>
        </div>
        <div>
          <div className="flex justify-between text-xs text-gray-400 mb-1">
            <span>Start-Lautstärke</span>
            <span>{musicVolume}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={40}
            step={1}
            value={musicVolume}
            onChange={(e) => onMusicVolume?.(Number(e.target.value))}
            className="w-full accent-violet-500"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {MOODS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMood(m.id)}
              className={`px-4 py-2 rounded-xl text-sm font-medium border transition-all ${
                mood === m.id
                  ? 'gradient-accent border-transparent text-white'
                  : 'border-white/10 text-gray-400 hover:border-violet-500/30'
              }`}
            >
              {m.emoji} {m.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <button
            type="button"
            onClick={() => onMusicAuto?.()}
            className={`text-xs px-3 py-1.5 rounded-lg border ${
              musicAuto
                ? 'border-violet-500 text-violet-300 bg-violet-500/10'
                : 'border-white/10 text-gray-500'
            }`}
          >
            Auto pro Clip
          </button>
          {tracks.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => {
                const id = `${mood}-${n}`;
                setMusicTrack(id);
                onMusicTrackPick?.(id);
              }}
              className={`text-xs px-3 py-1.5 rounded-lg border ${
                !musicAuto && musicTrack === `${mood}-${n}`
                  ? 'border-violet-500 text-violet-300 bg-violet-500/10'
                  : 'border-white/10 text-gray-500'
              }`}
            >
              Track {n}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
          <input type="file" accept="audio/*" className="hidden" onChange={onCustomMusic} />
          <span className="border border-dashed border-white/20 rounded-lg px-4 py-2 hover:border-violet-500/40">
            Eigene Musik hochladen
          </span>
          {customMusic && (
            <span className="text-violet-400 truncate max-w-[200px]">{customMusic}</span>
          )}
        </label>
      </div>
    </div>
  );
}
