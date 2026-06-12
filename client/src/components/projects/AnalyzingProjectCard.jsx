export default function AnalyzingProjectCard({ progress = 0, message = '' }) {
  const pct = Math.min(100, Math.max(0, Math.round(progress)));

  return (
    <div
      className="home-project-card home-project-card--analyzing"
      aria-busy="true"
      aria-label="Analyse läuft"
    >
      <div className="home-project-card-media home-project-card-media--analyzing">
        <div className="analyzing-card-shimmer" aria-hidden />
        <div className="analyzing-card-grid" aria-hidden />
        <div className="analyzing-card-ring" aria-hidden>
          <svg className="analyzing-card-ring-svg" viewBox="0 0 40 40">
            <circle
              className="analyzing-card-ring-track"
              cx="20"
              cy="20"
              r="16"
              fill="none"
              strokeWidth="2.5"
            />
            <circle
              className="analyzing-card-ring-progress"
              cx="20"
              cy="20"
              r="16"
              fill="none"
              strokeWidth="2.5"
              strokeDasharray={`${(pct / 100) * 100.5} 100.5`}
              strokeLinecap="round"
            />
          </svg>
          <span className="analyzing-card-ring-label">{pct}%</span>
        </div>
        <span className="analyzing-card-badge">Analyse</span>
      </div>
      <div className="home-project-card-body home-project-card-body--analyzing">
        <div className="analyzing-card-line analyzing-card-line--wide" aria-hidden />
        <div className="analyzing-card-line analyzing-card-line--narrow" aria-hidden />
        {message ? (
          <p className="analyzing-card-status">{message}</p>
        ) : (
          <p className="analyzing-card-status">KI analysiert dein Video…</p>
        )}
      </div>
    </div>
  );
}
