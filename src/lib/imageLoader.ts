import type { RosterPage } from '../models/roster';

/**
 * Loading a photo into a *working* canvas.
 *
 * A 12 MP phone photo decoded at full resolution is ~48 MB of RGBA, and
 * Tesseract wants its own copy. We downscale once, keep only the working
 * canvas, and revoke the object URL immediately after decode.
 */

/** Longest edge of the working canvas. Empirical trade-off: small
 *  roster digits still survive, memory stays bounded on mobile. */
export const MAX_WORKING_EDGE = 2000;

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

export function isAcceptedFile(file: File): boolean {
  if (ACCEPTED_TYPES.includes(file.type)) return true;
  // Some Android pickers hand over an empty type.
  return /\.(jpe?g|png|pdf)$/i.test(file.name);
}

export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export function scaleToFit(w: number, h: number, maxEdge = MAX_WORKING_EDGE): number {
  const longest = Math.max(w, h);
  return longest <= maxEdge ? 1 : maxEdge / longest;
}

/** Decode an image file into a downscaled canvas. Object URL is revoked here. */
export async function loadImageFile(
  file: File,
  maxEdge = MAX_WORKING_EDGE,
): Promise<RosterPage> {
  const url = URL.createObjectURL(file);
  try {
    const img = await decodeImage(url);
    const scale = scaleToFit(img.width, img.height, maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // Drop the decoded bitmap reference as early as possible.
    img.src = '';
    return { kind: 'image', canvas, width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function decodeImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = url;
  });
}

/** Free a working canvas so the backing store can be collected. */
export function releaseCanvas(canvas: HTMLCanvasElement | undefined | null): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

export function releasePage(page: RosterPage | null | undefined): void {
  if (!page) return;
  if (page.objectUrl) URL.revokeObjectURL(page.objectUrl);
  releaseCanvas(page.canvas);
}
