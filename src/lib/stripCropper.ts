import { skewAt, type CropRect } from '../models/roster';

/**
 * Cropping the two anchor strips out of the working canvas.
 * Crops are transient: callers release them right after OCR.
 */

export function clampRect(rect: CropRect, w: number, h: number): CropRect {
  const x = Math.max(0, Math.min(rect.x, w - 1));
  const y = Math.max(0, Math.min(rect.y, h - 1));
  return {
    x,
    y,
    w: Math.max(1, Math.min(rect.w, w - x)),
    h: Math.max(1, Math.min(rect.h, h - y)),
    skew: rect.skew,
  };
}

/**
 * Crop a region, optionally upscaling. Tesseract reads small roster text
 * far better at ~2x, and a single strip stays cheap even upscaled.
 */
export function cropToCanvas(
  source: HTMLCanvasElement,
  rect: CropRect,
  upscale = 1,
): HTMLCanvasElement {
  const r = clampRect(rect, source.width, source.height);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(r.w * upscale));
  out.height = Math.max(1, Math.round(r.h * upscale));
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const skew = r.skew ?? 0;
  if (skew === 0) {
    ctx.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
    return out;
  }

  // Undo the band's tilt while cropping, so a tilted row comes out
  // horizontal and OCR sees a clean single line.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.save();
  ctx.scale(upscale, upscale);
  // Vertical shear: a point at source x is lifted by skew * (x - r.x) / r.w.
  ctx.transform(1, -skew / r.w, 0, 1, 0, 0);
  ctx.translate(-r.x, -r.y);
  ctx.drawImage(source, 0, 0);
  ctx.restore();
  return out;
}

/**
 * Grayscale + local adaptive threshold.
 *
 * A phone photo is never evenly lit: one global contrast stretch leaves
 * the shaded end of a wide roster strip unreadable while the bright end
 * blows out. Comparing each pixel against the mean of its own
 * neighbourhood (via an integral image, so it stays O(n)) keeps both
 * ends legible.
 */
export const ADAPTIVE_BIAS = 0.9;

export function preprocessForOcr(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const w = canvas.width;
  const h = canvas.height;
  if (w < 2 || h < 2) return canvas;

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  const gray = new Float64Array(w * h);
  for (let i = 0, g = 0; i < d.length; i += 4, g++) {
    gray[g] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  }

  // Integral image, one row/column of padding.
  const sum = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      sum[(y + 1) * (w + 1) + (x + 1)] = sum[y * (w + 1) + (x + 1)] + rowSum;
    }
  }

  // A window about the height of the band covers a character and its
  // surroundings without reaching into the next lighting zone.
  const radius = Math.max(4, Math.round(h / 2));

  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const total =
        sum[(y1 + 1) * (w + 1) + (x1 + 1)] -
        sum[y0 * (w + 1) + (x1 + 1)] -
        sum[(y1 + 1) * (w + 1) + x0] +
        sum[y0 * (w + 1) + x0];
      const mean = total / area;
      const v = gray[y * w + x] < mean * ADAPTIVE_BIAS ? 0 : 255;
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Default strip guesses so the user only nudges instead of drawing. */
export function defaultStrips(width: number, height: number): {
  dateStrip: CropRect;
  employeeStrip: CropRect;
} {
  const h = Math.max(24, Math.round(height * 0.06));
  return {
    dateStrip: { x: 0, y: Math.round(height * 0.12), w: width, h, skew: 0 },
    employeeStrip: { x: 0, y: Math.round(height * 0.35), w: width, h, skew: 0 },
  };
}

/** Re-export so callers do not have to reach into the model module. */
export { skewAt };
