export default function SkeletonCard() {
  return (
    <div className="peak-panel overflow-hidden animate-pulse w-full max-w-[240px] mx-auto">
      <div className="aspect-[9/16] w-full bg-gradient-to-br from-surface-elevated to-surface-hover relative overflow-hidden">
        <div
          className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.04] to-transparent animate-shimmer"
          style={{ backgroundSize: '200% 100%' }}
        />
      </div>
      <div className="p-4 space-y-3">
        <div className="h-4 bg-surface-elevated rounded-lg w-4/5" />
        <div className="h-3 bg-surface-elevated rounded w-1/3" />
        <div className="h-3 bg-surface-elevated rounded w-full" />
        <div className="h-10 bg-surface-elevated rounded-xl w-full mt-2" />
      </div>
    </div>
  );
}
