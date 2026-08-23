/** Recognition provenance for a single day cell. */
export enum RecognitionSource {
  PDF_TEXT = 'PDF_TEXT',
  OCR = 'OCR',
  USER_CONFIRMED = 'USER_CONFIRMED',
}

/** A shift definition: code -> label + local wall-clock times. */
export interface ShiftDef {
  /** Short roster token, e.g. "F1", "N". Case-normalised uppercase. */
  code: string;
  /** Human label, e.g. "Fruehdienst". */
  label: string;
  /** Local wall clock "HH:MM". Ignored when isOff. */
  start: string;
  /** Local wall clock "HH:MM". Ignored when isOff. */
  end: string;
  /** Off/free day - never exported as an event. */
  isOff: boolean;
}

/** One day of the roster for the single employee row. */
export interface DayShift {
  /** Local calendar date, "YYYY-MM-DD". Never a Date object. */
  dateStr: string;
  /** Normalised shift code, or null when unresolved. */
  shiftCode: string | null;
  /** 0..1. Meaningless unless source is OCR. */
  confidence: number;
  source: RecognitionSource;
  confirmed: boolean;
  /** Raw token as recognised, kept for the correction UI. */
  rawText?: string;
}

/** Cells at or above this are shown as normal; below is "uncertain". */
export const CONFIDENCE_THRESHOLD = 0.8;

export function isUncertain(d: DayShift): boolean {
  if (d.confirmed) return false;
  if (d.shiftCode === null) return true;
  return d.confidence < CONFIDENCE_THRESHOLD;
}
