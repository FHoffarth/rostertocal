import type { DayShift } from './shifts';

/**
 * A crop band in *source image* pixel coordinates.
 *
 * `skew` is the vertical offset of the band's right end relative to its
 * left end, in source pixels. A photo is never perfectly square-on, and
 * over a 31-column roster even one degree of tilt walks a row clean out
 * of a straight band - so a band has two ends, not one top edge.
 */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
  skew?: number;
}

/** Vertical offset of the band at a given source x. */
export function skewAt(rect: CropRect, x: number): number {
  const skew = rect.skew ?? 0;
  if (!skew || rect.w <= 0) return 0;
  return (skew * (x - rect.x)) / rect.w;
}

/** One recognised token with its horizontal extent in source pixels. */
export interface OcrToken {
  text: string;
  confidence: number;
  /** Left edge, source-image px. */
  x0: number;
  /** Right edge, source-image px. */
  x1: number;
}

/** A day column: geometry owns which x-range belongs to which day. */
export interface DayColumn {
  /** 1..31 */
  day: number;
  x0: number;
  x1: number;
}

export type SourceKind = 'image' | 'pdf-text' | 'pdf-render';

/** The loaded page the user is aligning against. */
export interface RosterPage {
  kind: SourceKind;
  /** Downscaled working canvas used for cropping + OCR. */
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** Object URL, if any - must be revoked on replace/unmount. */
  objectUrl?: string;
}

export interface RosterDraft {
  /** Month anchor, "YYYY-MM". Day numbers are resolved against this. */
  month: string;
  days: DayShift[];
}
