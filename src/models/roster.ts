import type { DayShift } from './shifts';

/**
 * An axis-aligned rectangle in pixels.
 *
 * Since alignment moved to quadrilaterals this is only ever used inside
 * an already-rectified strip, where a cell really is a plain rectangle.
 * `skew` survives solely so an old saved band can be converted - see
 * quadFromBand.
 */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Legacy band tilt, for migration only. */
  skew?: number;
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
