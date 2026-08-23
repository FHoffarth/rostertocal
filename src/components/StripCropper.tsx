import { useCallback, useRef } from 'react';
import type { CropRect } from '../models/roster';

export type Mode = 'move' | 'n' | 's' | 'w' | 'e';

interface Props {
  label: string;
  variant: 'date' | 'employee';
  rect: CropRect;
  /** Source-image dimensions the rect is expressed in. */
  sourceWidth: number;
  sourceHeight: number;
  /** Displayed width in CSS px, for source->screen scaling. */
  displayWidth: number;
  onChange: (rect: CropRect) => void;
}

/** Never let a band collapse below something a thumb can grab again. */
export const MIN_H = 20;

/**
 * Apply one drag to a band, in source-image pixels.
 *
 * Pure on purpose: this is the only place a gesture turns into geometry,
 * so it is the thing that has to stay correct when the view zooms. The
 * caller converts screen movement into source pixels first; nothing in
 * here knows or cares what the current zoom is.
 */
export function applyBandDrag(
  mode: Mode,
  start: CropRect,
  dySource: number,
  sourceWidth: number,
  sourceHeight: number,
): CropRect {
  const s = start;
  const skew = s.skew ?? 0;
  let next: CropRect;
  switch (mode) {
    case 'move':
      next = { ...s, y: s.y + dySource };
      break;
    case 'n':
      next = { ...s, y: s.y + dySource, h: s.h - dySource };
      break;
    case 's':
      next = { ...s, h: s.h + dySource };
      break;
    case 'w':
      // Lift the left end; the right end stays where it is.
      next = { ...s, y: s.y + dySource, skew: skew - dySource };
      break;
    case 'e':
      next = { ...s, skew: skew + dySource };
      break;
  }
  return clampBand(next, sourceWidth, sourceHeight);
}

/**
 * One anchor band over the roster preview.
 *
 * The band spans the page and has two ends: drag the left or right
 * circle up and down to follow a row that is not perfectly level. That
 * covers the tilt every hand-held photo has, without asking anyone to
 * rotate an image by hand.
 *
 * Handles are 48px touch targets. The two end handles sit inside the
 * band's own width so they stay reachable on a 320px screen; the top and
 * bottom ones overhang into the padding the scroller reserves for them.
 */
export function StripCropper({
  label,
  variant,
  rect,
  sourceWidth,
  sourceHeight,
  displayWidth,
  onChange,
}: Props) {
  const scale = displayWidth / sourceWidth || 1;
  const drag = useRef<{ mode: Mode; x: number; y: number; start: CropRect } | null>(null);

  const onPointerDown = useCallback(
    (mode: Mode) => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        // Capture keeps the drag alive when the finger leaves the band.
        (e.target as Element).setPointerCapture?.(e.pointerId);
      } catch {
        // Some engines reject capture for synthetic or already-released
        // pointers; the drag still works without it.
      }
      drag.current = { mode, x: e.clientX, y: e.clientY, start: { ...rect } };
    },
    [rect],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      e.preventDefault();
      // Screen delta -> source-pixel delta.
      const dy = (e.clientY - d.y) / scale;
      onChange(applyBandDrag(d.mode, d.start, dy, sourceWidth, sourceHeight));
    },
    [onChange, scale, sourceWidth, sourceHeight],
  );

  const endDrag = useCallback(() => {
    drag.current = null;
  }, []);

  const skew = rect.skew ?? 0;
  const style: React.CSSProperties = {
    left: rect.x * scale,
    top: rect.y * scale,
    width: rect.w * scale,
    height: rect.h * scale,
    transform: skew ? `skewY(${Math.atan2(skew, rect.w) * (180 / Math.PI)}deg)` : undefined,
    transformOrigin: 'left center',
  };

  return (
    <div
      className={`strip ${variant === 'employee' ? 'employee' : ''}`}
      style={style}
      onPointerDown={onPointerDown('move')}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      role="group"
      aria-label={label}
    >
      <span className="tag">{label}</span>
      {(['n', 's', 'w', 'e'] as Mode[]).map((m) => (
        <button
          key={m}
          type="button"
          className={`handle ${m}`}
          aria-label={
            m === 'w' || m === 'e'
              ? `${label}: ${m === 'w' ? 'left' : 'right'} end up or down`
              : `${label}: ${m === 'n' ? 'top' : 'bottom'} edge`
          }
          onPointerDown={onPointerDown(m)}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      ))}
    </div>
  );
}

/**
 * Keep the band on the image and grabbable. Both ends are checked, so a
 * tilted band cannot be pushed off the top or bottom edge.
 */
export function clampBand(r: CropRect, w: number, h: number): CropRect {
  const out = { ...r, x: 0, w };
  if (out.h < MIN_H) out.h = MIN_H;
  if (out.h > h) out.h = h;
  const skew = out.skew ?? 0;
  const lowestTop = Math.min(out.y, out.y + skew);
  const highestBottom = Math.max(out.y, out.y + skew) + out.h;
  if (lowestTop < 0) out.y -= lowestTop;
  if (highestBottom > h) out.y -= highestBottom - h;
  return out;
}
