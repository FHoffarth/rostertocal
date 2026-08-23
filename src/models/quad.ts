import type { CropRect } from './roster';

/**
 * The canonical selection geometry.
 *
 * Everything here is in ORIGINAL SOURCE IMAGE PIXELS. Zoom, pan, CSS
 * scale, viewport width and device pixel ratio are presentation; none of
 * them may ever be stored here or derived back out of here. A screen
 * coordinate that reaches this model is a bug.
 *
 * Four free corners replace the old two-ended band because a hand-held
 * photo of a roster is not a parallelogram: it is rotated *and*
 * perspective-distorted, so the far end of a row is both lower and
 * narrower than the near end. A band cannot express that; a quad can.
 */

export interface Point {
  /** Source-image pixels. */
  x: number;
  /** Source-image pixels. */
  y: number;
}

/**
 * Corners in a fixed order. The order is part of the contract: it is what
 * makes the rectification deterministic, and it is never inferred from
 * the coordinates.
 */
export interface QuadSelection {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

export type QuadCorner = keyof QuadSelection;

export const QUAD_CORNERS: QuadCorner[] = [
  'topLeft',
  'topRight',
  'bottomRight',
  'bottomLeft',
];

/** Corners in winding order, which is what every geometric test needs. */
export function quadPoints(q: QuadSelection): Point[] {
  return [q.topLeft, q.topRight, q.bottomRight, q.bottomLeft];
}

export function quadFromPoints(pts: Point[]): QuadSelection {
  return {
    topLeft: pts[0],
    topRight: pts[1],
    bottomRight: pts[2],
    bottomLeft: pts[3],
  };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Shoelace area. Sign carries the winding direction. */
export function signedQuadArea(q: QuadSelection): number {
  const p = quadPoints(q);
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i];
    const b = p[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function quadArea(q: QuadSelection): number {
  return Math.abs(signedQuadArea(q));
}

/**
 * Strictly convex with a consistent winding.
 *
 * This is deliberately stricter than "simple polygon": a bow-tie fails,
 * but so does a concave quad and so does one with three collinear
 * corners. A perspective map is only well defined on a convex quad, so
 * anything else has to be refused rather than straightened out.
 */
export function isConvexQuad(q: QuadSelection): boolean {
  const p = quadPoints(q);
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i];
    const b = p[(i + 1) % 4];
    const c = p[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/** Below this many source px², a selection is not a row, it is a smudge. */
export const MIN_QUAD_AREA = 400;

/** No edge may be shorter than this, or a corner has collapsed. */
export const MIN_EDGE_LENGTH = 8;

/** At least this share of the selection must lie on the image. */
export const MIN_INSIDE_RATIO = 0.6;

export interface QuadValidation {
  ok: boolean;
  reason?: string;
}

/**
 * Refuse geometry that cannot be rectified honestly.
 *
 * Malformed corners are never quietly reordered into something
 * plausible: the corner order is the user's statement of which end is
 * which, and guessing at it would silently rotate or mirror the row.
 */
export function validateQuad(
  q: QuadSelection,
  imageWidth: number,
  imageHeight: number,
): QuadValidation {
  const pts = quadPoints(q);

  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return { ok: false, reason: 'A corner is not a finite coordinate' };
    }
  }

  for (let i = 0; i < 4; i++) {
    const len = distance(pts[i], pts[(i + 1) % 4]);
    if (len < MIN_EDGE_LENGTH) {
      return { ok: false, reason: 'Two corners have collapsed onto each other' };
    }
  }

  // Convexity first: a bow tie's two lobes cancel in the shoelace sum,
  // so its area looks like zero and "too small" would name the wrong
  // problem.
  if (!isConvexQuad(q)) {
    return { ok: false, reason: 'The corners cross over each other' };
  }

  if (quadArea(q) < MIN_QUAD_AREA) {
    return { ok: false, reason: 'The selection is too small to read' };
  }

  const inside = insideRatio(q, imageWidth, imageHeight);
  if (inside < MIN_INSIDE_RATIO) {
    return { ok: false, reason: 'Most of the selection is off the picture' };
  }

  return { ok: true };
}

/**
 * Fraction of the quad that lies on the image, sampled on a grid.
 *
 * Sampling rather than polygon clipping: it is a handful of lines
 * instead of a clipping library, and the threshold it feeds is coarse.
 */
export function insideRatio(
  q: QuadSelection,
  imageWidth: number,
  imageHeight: number,
  steps = 16,
): number {
  let inside = 0;
  let total = 0;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const u = (i + 0.5) / steps;
      const v = (j + 0.5) / steps;
      const p = bilinearPoint(q, u, v);
      total += 1;
      if (p.x >= 0 && p.x <= imageWidth && p.y >= 0 && p.y <= imageHeight) inside += 1;
    }
  }
  return total === 0 ? 0 : inside / total;
}

/** Bilinear position inside the quad. Only used for coarse sampling. */
export function bilinearPoint(q: QuadSelection, u: number, v: number): Point {
  const top = { x: lerp(q.topLeft.x, q.topRight.x, u), y: lerp(q.topLeft.y, q.topRight.y, u) };
  const bottom = {
    x: lerp(q.bottomLeft.x, q.bottomRight.x, u),
    y: lerp(q.bottomLeft.y, q.bottomRight.y, u),
  };
  return { x: lerp(top.x, bottom.x, v), y: lerp(top.y, bottom.y, v) };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hold every corner on the image. Shape is preserved where it can be. */
export function clampQuadToImage(
  q: QuadSelection,
  imageWidth: number,
  imageHeight: number,
): QuadSelection {
  const clamp = (p: Point): Point => ({
    x: Math.min(Math.max(p.x, 0), imageWidth),
    y: Math.min(Math.max(p.y, 0), imageHeight),
  });
  return {
    topLeft: clamp(q.topLeft),
    topRight: clamp(q.topRight),
    bottomRight: clamp(q.bottomRight),
    bottomLeft: clamp(q.bottomLeft),
  };
}

/** Move one corner, in source pixels, and keep it on the image. */
export function moveCorner(
  q: QuadSelection,
  corner: QuadCorner,
  dx: number,
  dy: number,
  imageWidth: number,
  imageHeight: number,
): QuadSelection {
  const moved: QuadSelection = {
    ...q,
    [corner]: { x: q[corner].x + dx, y: q[corner].y + dy },
  };
  return clampQuadToImage(moved, imageWidth, imageHeight);
}

/** Slide the whole selection without changing its shape. */
export function moveQuad(
  q: QuadSelection,
  dx: number,
  dy: number,
  imageWidth: number,
  imageHeight: number,
): QuadSelection {
  const shifted = quadFromPoints(
    quadPoints(q).map((p) => ({ x: p.x + dx, y: p.y + dy })),
  );
  // Shift back as a whole rather than clamping corners independently,
  // which would deform the selection at the edges of the picture.
  const pts = quadPoints(shifted);
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  let ox = 0;
  let oy = 0;
  if (minX < 0) ox = -minX;
  else if (maxX > imageWidth) ox = imageWidth - maxX;
  if (minY < 0) oy = -minY;
  else if (maxY > imageHeight) oy = imageHeight - maxY;
  return quadFromPoints(pts.map((p) => ({ x: p.x + ox, y: p.y + oy })));
}

/* ------------------------------------------------------------------ *
 * Migration
 * ------------------------------------------------------------------ */

/**
 * The old two-ended band, expressed exactly as a quad.
 *
 * The band was: a left edge at (x, y), a right edge lifted by `skew`,
 * and a constant height `h` measured down from each end. That is a
 * parallelogram, which is a quad - so the conversion is exact and
 * loses nothing. Existing session state survives.
 */
export function quadFromBand(band: CropRect): QuadSelection {
  const skew = band.skew ?? 0;
  const right = band.x + band.w;
  return {
    topLeft: { x: band.x, y: band.y },
    topRight: { x: right, y: band.y + skew },
    bottomRight: { x: right, y: band.y + skew + band.h },
    bottomLeft: { x: band.x, y: band.y + band.h },
  };
}
