import Toggle from '../Toggle';
import { MOODS } from '../../utils/helpers';

const ASPECT_LABELS = {
  '9:16': 'TikTok / Shorts',
  '1:1': 'Instagram',
  '16:9': 'YouTube',
};

const CAPTION_STYLES = [
  { id: 'minimal', label: 'Minimal' },
  { id: 'bold', label: 'Bold' },
  { id: 'fire', label: 'Fire' },
];

export default function ClipSettingsSidebar({
  aspectRatio,
  setAspectRatio,
  captionStyle,
  setCaptionStyle,
  mood,
  setMood,
  prefs,
  setPrefs,
  musicVolume,
  onMusicVolume,
  customMusicName,
  onCustomMusic,
  onSave,
  className = '',
}) {
  return (
    <aside
      className={`flex w-full xl:w-[300px] shrink-0 flex-col border-white/5 bg-[#0a0b12] overflow-y-auto xl:border-l xl:max-h-[calc(100vh-5rem)] ${className}`}
    >
      <div className="p-5 space-y-6">
        <h2 className="text-sm font-semibold text-white">Clip Einstellungen</h2>

        <section>
          <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">Format</p>
          <div className="flex flex-col gap-2">
            {['9:16', '1:1', '16:9'].map((ar) => (
              <button
                key={ar}
                type="button"
                onClick={() => setAspectRatio(ar)}
                className={`text-left px-3 py-2.5 rounded-xl border text-sm transition-colors ${
                  aspectRatio === ar
                    ? 'border-violet-500 bg-violet-500/15 text-violet-200'
                    : 'border-white/10 text-gray-400 hover:border-violet-500/30'
                }`}
              >
                <span className="font-medium">{ar}</span>
                <span className="block text-xs text-gray-500 mt-0.5">{ASPECT_LABELS[ar]}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">Untertitel-Stil</p>
          <div className="flex gap-2">
            {CAPTION_STYLES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setCaptionStyle(s.id)}
                className={`flex-1 py-2 rounded-lg text-xs font-medium border ${
                  captionStyle === s.id
                    ? 'border-violet-500 bg-violet-500/15 text-violet-200'
                    : 'border-white/10 text-gray-500'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">Musik-Stimmung</p>
          <div className="flex flex-col gap-2">
            {MOODS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMood(m.id)}
                className={`text-left px-3 py-2 rounded-xl border text-sm ${
                  mood === m.id
                    ? 'border-violet-500 bg-violet-500/15 text-violet-200'
                    : 'border-white/10 text-gray-400'
                }`}
              >
                {m.emoji} {m.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">Musik-Lautstärke</p>
          <div className="flex justify-between text-xs text-gray-400 mb-1">
            <span>Standard</span>
            <span>{musicVolume}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={40}
            value={musicVolume}
            onChange={(e) => onMusicVolume(Number(e.target.value))}
            className="w-full accent-violet-500"
          />
          <label className="mt-2 flex items-center gap-2 text-xs text-gray-500 cursor-pointer">
            <input type="file" accept="audio/*" className="hidden" onChange={onCustomMusic} />
            <span className="border border-dashed border-white/15 rounded-lg px-3 py-2 hover:border-violet-500/40 w-full text-center">
              Eigene Musik
            </span>
          </label>
          {customMusicName && (
            <p className="text-xs text-violet-400 truncate mt-1">{customMusicName}</p>
          )}
        </section>

        <section>
          <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">KI-Stärke</p>
          <div className="flex justify-between text-xs text-gray-400 mb-1">
            <span>Effekte</span>
            <span>{prefs.aiStrength ?? 75}%</span>
          </div>
          <input
            type="range"
            min={25}
            max={100}
            value={prefs.aiStrength ?? 75}
            onChange={(e) => setPrefs((p) => ({ ...p, aiStrength: Number(e.target.value) }))}
            className="w-full accent-violet-500"
          />
        </section>

        <section>
          <p className="text-xs uppercase tracking-wider text-gray-500 mb-3">Weitere Optionen</p>
          <div className="space-y-3">
            <Toggle
              label="Farb-Look"
              checked={prefs.colorGrade !== false}
              onChange={(v) => setPrefs((p) => ({ ...p, colorGrade: v }))}
            />
            <Toggle
              label="Untertitel"
              checked={prefs.captions !== false}
              onChange={(v) => setPrefs((p) => ({ ...p, captions: v }))}
            />
            <Toggle
              label="Hintergrundmusik"
              checked={prefs.music !== false}
              onChange={(v) => setPrefs((p) => ({ ...p, music: v }))}
            />
          </div>
        </section>

        <button
          type="button"
          onClick={onSave}
          className="w-full gradient-accent text-white font-semibold py-3 rounded-xl text-sm hover:opacity-90"
        >
          Einstellungen speichern
        </button>
      </div>
    </aside>
  );
}
