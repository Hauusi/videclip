export default function PreviewRenderOverlay({ label = 'Vorschau wird gerendert…' }) {
  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/70 backdrop-blur-[2px]">
      <div className="relative w-16 h-16 mb-4">
        <div className="absolute inset-0 rounded-full border-2 border-peak-purple/30" />
        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-peak-purple animate-spin" />
        <div
          className="absolute inset-2 rounded-full border-2 border-transparent border-b-peak-pink animate-spin"
          style={{ animationDirection: 'reverse', animationDuration: '1.2s' }}
        />
      </div>
      <p className="text-base font-medium text-white animate-pulse text-center px-4">{label}</p>
      <p className="text-sm text-gray-400 mt-1 text-center px-6 max-w-[280px]">
        PeakClip rendert — bitte kurz warten
      </p>
      <div className="mt-4 flex gap-1">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className="w-1.5 h-4 rounded-full bg-peak-purple/80 animate-pulse"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>
    </div>
  );
}
