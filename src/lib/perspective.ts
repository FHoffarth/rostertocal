import {
  distance,
  quadPoints,
  type Point,
  type QuadSelection,
} from '../models/quad';

/**
 * Perspective rectification.
 *
 * The selection is a quad on the original photo; OCR wants a flat strip.
 * This maps one to the other with a projective transform, and it is a
 * *derived image only* - the canonical quad on the source image is never
 * touched, so nothing here can move the geometry that owns date-to-cell
 * mapping.
 */

/**
 * Coefficients of the projective map from the unit square to a quad:
 *
 *   x = (a * u + b * v + c) / (g * u + h * v + 1)
 *   y = (d * u + e * v + f) / (g * u + h * v + 1)
 *
 * with (u,v) = (0,0) at topLeft, (1,0) topRight, (1,1) bottomRight and
 * (0,1) bottomLeft.
 */
export interface Homography {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  h: number;
}

/**
 * Closed-form unit-square -> quad mapping (Heckbert). No iteration, no
 * matrix solver, so the same quad always yields the same coefficients
 * bit for bit.
 */
export function squareToQuad(q: QuadSelection): Homography {
  const [p0, p1, p2, p3] = quadPoints(q); // TL, TR, BR, BL
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;

  if (sx === 0 && sy === 0) {
    // The quad is a parallelogram: the map is affine.
    return {
      a: p1.x - p0.x,
      b: p3.x - p0.x,
      c: p0.x,
      d: p1.y - p0.y,
      e: p3.y - p0.y,
      f: p0.y,
      g: 0,
      h: 0,
    };
  }

  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const den = dx1 * dy2 - dy1 * dx2;
  if (den === 0) {
    throw new Error('Degenerate quad: corners are collinear');
  }
  const g = (sx * dy2 - sy * dx2) / den;
  const h = (dx1 * sy - dy1 * sx) / den;

  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h,
  };
}

/** Where (u,v) in the unit square lands on the source image. */
export function mapUnitToSource(m: Homography, u: number, v: number): Point {
  const w = m.g * u + m.h * v + 1;
  return {
    x: (m.a * u + m.b * v + m.c) / w,
    y: (m.d * u + m.e * v + m.f) / w,
  };
}

/**
 * The inverse map: a point on the source image -> (u,v) in the unit
 * square. Needed for the PDF text path, where tokens already have exact
 * source coordinates and only need placing along the row.
 */
export function mapSourceToUnit(m: Homography, x: number, y: number): Point {
  // Invert the 3x3 [[a,b,c],[d,e,f],[g,h,1]] and apply it.
  const A = m.a;
  const B = m.b;
  const C = m.c;
  const D = m.d;
  const E = m.e;
  const F = m.f;
  const G = m.g;
  const H = m.h;

  const i00 = E - F * H;
  const i01 = C * H - B;
  const i02 = B * F - C * E;
  const i10 = F * G - D;
  const i11 = A - C * G;
  const i12 = C * D - A * F;
  const i20 = D * H - E * G;
  const i21 = B * G - A * H;
  const i22 = A * E - B * D;

  const w = i20 * x + i21 * y + i22;
  if (w === 0) return { x: NaN, y: NaN };
  return {
    x: (i00 * x + i01 * y + i02) / w,
    y: (i10 * x + i11 * y + i12) / w,
  };
}

/* ------------------------------------------------------------------ *
 * Output sizing
 * ------------------------------------------------------------------ */

/**
 * Rectified size rule, deterministic and bounded:
 *
 *   width  = max(|top edge|, |bottom edge|) * upscale
 *   height = max(|left edge|, |right edge|) * upscale
 *
 * The longer of each opposing pair, because a perspective-shortened far
 * end must not decide the resolution of the near end - taking the max
 * keeps every glyph at least its original size. Both are then clamped,
 * so a wild selection cannot ask for a gigabyte of canvas.
 */
export const MIN_RECTIFIED_WIDTH = 16;
export const MAX_RECTIFIED_WIDTH = 6000;
export const MIN_RECTIFIED_HEIGHT = 8;
export const MAX_RECTIFIED_HEIGHT = 600;

export interface RectifiedSize {
  width: number;
  height: number;
}

export function rectifiedSize(q: QuadSelection, upscale = 1): RectifiedSize {
  const topLen = distance(q.topLeft, q.topRight);
  const bottomLen = distance(q.bottomLeft, q.bottomRight);
  const leftLen = distance(q.topLeft, q.bottomLeft);
  const rightLen = distance(q.topRight, q.bottomRight);

  const width = clamp(
    Math.round(Math.max(topLen, bottomLen) * upscale),
    MIN_RECTIFIED_WIDTH,
    MAX_RECTIFIED_WIDTH,
  );
  const height = clamp(
    Math.round(Math.max(leftLen, rightLen) * upscale),
    MIN_RECTIFIED_HEIGHT,
    MAX_RECTIFIED_HEIGHT,
  );
  return { width, height };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/* ------------------------------------------------------------------ *
 * Rasterisation
 * ------------------------------------------------------------------ */

export interface RectifyResult {
  canvas: HTMLCanvasElement;
  /** The map used, so callers can place tokens back if they need to. */
  homography: Homography;
  width: number;
  height: number;
}

/**
 * Render the quad as a flat strip.
 *
 * Inverse mapping with bilinear sampling: for every output pixel we ask
 * where it came from, so the result has no holes. Canvas 2D has no
 * projective draw, and a WebGL path would trade determinism for speed we
 * do not need on a strip this size.
 */
export function rectifyQuad(
  source: HTMLCanvasElement,
  quad: QuadSelection,
  upscale = 1,
): RectifyResult {
  const { width, height } = rectifiedSize(quad, upscale);
  const m = squareToQuad(quad);

  // Read only the part of the source the quad can touch.
  const pts = quadPoints(quad);
  const bx0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x))) - 1);
  const by0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y))) - 1);
  const bx1 = Math.min(source.width, Math.ceil(Math.max(...pts.map((p) => p.x))) + 1);
  const by1 = Math.min(source.height, Math.ceil(Math.max(...pts.map((p) => p.y))) + 1);
  const bw = Math.max(1, bx1 - bx0);
  const bh = Math.max(1, by1 - by0);

  const sctx = source.getContext('2d', { willReadFrequently: true });
  if (!sctx) throw new Error('Canvas 2D context unavailable');
  const src = sctx.getImageData(bx0, by0, bw, bh);
  const sd = src.data;

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const octx = out.getContext('2d');
  if (!octx) throw new Error('Canvas 2D context unavailable');
  const dst = octx.createImageData(width, height);
  const dd = dst.data;

  for (let oy = 0; oy < height; oy++) {
    const v = (oy + 0.5) / height;
    for (let ox = 0; ox < width; ox++) {
      const u = (ox + 0.5) / width;
      const w = m.g * u + m.h * v + 1;
      const sxf = (m.a * u + m.b * v + m.c) / w - bx0;
      const syf = (m.d * u + m.e * v + m.f) / w - by0;
      const di = (oy * width + ox) * 4;

      if (sxf < 0 || syf < 0 || sxf > bw - 1 || syf > bh - 1) {
        // Outside the picture: white, so OCR sees paper rather than noise.
        dd[di] = dd[di + 1] = dd[di + 2] = 255;
        dd[di + 3] = 255;
        continue;
      }

      const x0 = Math.floor(sxf);
      const y0 = Math.floor(syf);
      const x1 = Math.min(x0 + 1, bw - 1);
      const y1 = Math.min(y0 + 1, bh - 1);
      const fx = sxf - x0;
      const fy = syf - y0;

      const i00 = (y0 * bw + x0) * 4;
      const i10 = (y0 * bw + x1) * 4;
      const i01 = (y1 * bw + x0) * 4;
      const i11 = (y1 * bw + x1) * 4;

      for (let ch = 0; ch < 3; ch++) {
        const top = sd[i00 + ch] * (1 - fx) + sd[i10 + ch] * fx;
        const bottom = sd[i01 + ch] * (1 - fx) + sd[i11 + ch] * fx;
        dd[di + ch] = Math.round(top * (1 - fy) + bottom * fy);
      }
      dd[di + 3] = 255;
    }
  }

  octx.putImageData(dst, 0, 0);
  return { canvas: out, homography: m, width, height };
}
