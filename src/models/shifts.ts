/** Recognition provenance for a single day cell. */
export enum RecognitionSource {
  PDF_TEXT = 'PDF_TEXT',
  OCR = 'OCR',
  USER_CONFIRMED = 'USER_CONFIRMED',
}

/**
 * What a cell is *trusted* to be - which is a different question from
 * what the recogniser thinks it read.
 *
 * The scanner may be wrong; the calendar must never be wrong silently.
 * So trust is a state a human moves a cell into, never a number the OCR
 * engine hands us. A 99 %-confident reading and a 40 %-confident one are
 * both RECOGNIZED, and neither exports.
 */
export enum CellState {
  /** Machine read something and its two passes agreed. Not exportable. */
  RECOGNIZED = 'RECOGNIZED',
  /** Nothing readable, or the passes disagreed. Blocks export. */
  UNRESOLVED = 'UNRESOLVED',
  /** A human looked at the machine's reading and accepted it. */
  CONFIRMED = 'CONFIRMED',
  /** A human replaced the reading with their own value. */
  EDITED = 'EDITED',
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

/** What the two independent recognition passes saw in one cell. */
export interface CellEvidence {
  /** Normalised code from the row-wide pass, null when unreadable. */
  rowCode: string | null;
  /** Normalised code from the cell-local pass, null when unreadable. */
  cellCode: string | null;
  /** Raw text of the row pass, for the correction sheet. */
  rowText: string;
  /** Raw text of the cell pass, for the correction sheet. */
  cellText: string;
  /** True when both passes produced the same code. */
  agreed: boolean;
  /** True when a code was only reached by repairing the token. */
  repaired: boolean;
  /** Why the cell is unresolved, if it is. */
  reason?: string;
}

/** One day of the roster for the single employee row. */
export interface DayShift {
  /** Local calendar date, "YYYY-MM-DD". Never a Date object. */
  dateStr: string;
  /** Normalised shift code, or null when unresolved / deliberately blank. */
  shiftCode: string | null;
  /**
   * 0..1, for display only. This value must never decide whether a cell
   * can be exported - see CellState.
   */
  confidence: number;
  source: RecognitionSource;
  state: CellState;
  /** Raw token as recognised, kept for the correction UI. */
  rawText?: string;
  /** What each pass saw. Absent for user-entered cells. */
  evidence?: CellEvidence;
}

/**
 * Cells at or above this are *displayed* as strong readings. It is a
 * presentation threshold only: nothing about export depends on it.
 */
export const CONFIDENCE_THRESHOLD = 0.8;

/**
 * The single export rule. Only a human decision makes a cell
 * exportable - no confidence value can substitute for one.
 */
export function isExportable(d: DayShift): boolean {
  return d.state === CellState.CONFIRMED || d.state === CellState.EDITED;
}

/** Cells still waiting on the user. Every one of them blocks export. */
export function needsAttention(d: DayShift): boolean {
  return !isExportable(d);
}

/** Cells the machine could not settle - these cannot be bulk-accepted. */
export function isUnresolved(d: DayShift): boolean {
  return d.state === CellState.UNRESOLVED;
}

/** Cells a human may accept in bulk on the review screen. */
export function isBulkAcceptable(d: DayShift): boolean {
  return d.state === CellState.RECOGNIZED;
}
