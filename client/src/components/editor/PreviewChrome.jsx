import { previewFrameClass } from '../../utils/responsiveLayout';

/**
 * Unified preview frame — aspect box + overlay slot + children (video layer).
 */
export default function PreviewChrome({
  aspectRatio = '9:16',
  badge = null,
  topLeft = null,
  className = '',
  children,
}) {
  return (
    <div className={`preview-chrome ${previewFrameClass(aspectRatio)} ${className}`}>
      {topLeft && <div className="preview-chrome-topleft">{topLeft}</div>}
      {badge && <div className="preview-chrome-badge">{badge}</div>}
      <div className="preview-chrome-stage">{children}</div>
    </div>
  );
}
