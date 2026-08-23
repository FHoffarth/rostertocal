import { useCallback, useRef } from 'react';
import {
  moveCorner,
  moveQuad,
  quadPoints,
  QUAD_CORNERS,
  type QuadCorner,
  type QuadSelection,
} from '../models/quad';

type DragTarget = QuadCorner | 'whole';

interface Props {
  label: string;
  variant: 'date' | 'employee';
  quad: QuadSelection;
  /** Source-image dimensions the quad is expressed in. */
  sourceWidth: number;
  sourceHeight: number;
  /** Displayed width in CSS px, for source->screen scaling. */
  displayWidth: number;
  /** Displayed height in CSS px. */
  displayHeight: number;
  invalidReason?: string;
  onChange: (q: QuadSelection) => void;
}

const CORNER_LABEL: Record<QuadCorner, string> = {
  topLeft: 'top left',
  topRight: 'top right',
  bottomRight: 'bottom right',
  bottomLeft: 'bottom left',
};

/**
 * Four corners over the roster preview.
 *
 * A hand-held photo puts a row somewhere between rotated and
 * trapezoidal, and no rectangle - however tilted - covers that. Four
 * independent corners express rotation and perspective at once, which is
 * why there is no rotation slider: the corners already say it.
 *
 * Everything the user drags is converted straight into source-image
 * pixels. Nothing about the current zoom survives past this component.
 */
export function QuadCropper({
  label,
  variant,
  quad,
  sourceWidth,
  sourceHeight,
  displayWidth,
  displayHeight,
  invalidReason,
  onChange,
}: Props) {
  const scale = displayWidth / sourceWidth || 1;
  const drag = useRef<{
    target: DragTarget;
    x: number;
    y: number;
    start: QuadSelection;
  } | null>(null);

  const onPointerDown = useCallback(
    (target: DragTarget) => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        // Capture keeps the drag alive when the finger leaves the handle.
        (e.target as Element).setPointerCapture?.(e.pointerId);
      } catch {
        // Synthetic or already-released pointers: the drag still works.
      }
      drag.current = { target, x: e.clientX, y: e.clientY, start: quad };
    },
    [quad],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      e.preventDefault();
      // Screen delta -> source pixels. This is the only conversion, and
      // it goes one way: no source coordinate is ever read back off the
      // screen.
      const dx = (e.clientX - d.x) / scale;
      const dy = (e.clientY - d.y) / scale;
      onChange(
        d.target === 'whole'
          ? moveQuad(d.start, dx, dy, sourceWidth, sourceHeight)
          : moveCorner(d.start, d.target, dx, dy, sourceWidth, sourceHeight),
      );
    },
    [onChange, scale, sourceWidth, sourceHeight],
  );

  const endDrag = useCallback(() => {
    drag.current = null;
  }, []);

  const pts = quadPoints(quad);
  const polygon = pts.map((p) => `${p.x * scale},${p.y * scale}`).join(' ');

  /**
   * A date row is a few pixels tall on screen while a corner handle is
   * 48px, so the label would otherwise sit right on top of the day
   * numbers the user is trying to line up with. When the selection is
   * thinner than a touch target the label moves clear above it.
   *
   * Presentation only - the canonical quad is untouched.
   */
  const displayedHeight =
    Math.min(
      Math.hypot(quad.bottomLeft.x - quad.topLeft.x, quad.bottomLeft.y - quad.topLeft.y),
      Math.hypot(quad.bottomRight.x - quad.topRight.x, quad.bottomRight.y - quad.topRight.y),
    ) * scale;
  const thin = displayedHeight < 48;

  return (
    <div
      className={`quad ${variant === 'employee' ? 'employee' : ''} ${
        invalidReason ? 'invalid' : ''
      }`}
    >
      <svg
        className="quad-shape"
        width={displayWidth}
        height={displayHeight}
        viewBox={`0 0 ${displayWidth} ${displayHeight}`}
        aria-hidden="true"
      >
        <polygon
          points={polygon}
          onPointerDown={onPointerDown('whole')}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      </svg>

      <span
        className={`quad-tag ${thin ? 'clear' : ''}`}
        style={{ left: quad.topLeft.x * scale, top: quad.topLeft.y * scale }}
      >
        {label}
      </span>

      {QUAD_CORNERS.map((corner) => (
        <button
          key={corner}
          type="button"
          className={`quad-handle ${corner}`}
          style={{ left: quad[corner].x * scale, top: quad[corner].y * scale }}
          aria-label={`${label}: ${CORNER_LABEL[corner]} corner`}
          onPointerDown={onPointerDown(corner)}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      ))}
    </div>
  );
}
