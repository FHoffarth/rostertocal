import type { CropRect, DayColumn, OcrToken } from '../models/roster';
import {
  fitAnchorSequence,
  type AnchorCandidate,
  type RejectedCandidate,
} from './dateAnchors';

/**
 * Geometry owns the date -> cell association.
 *
 * OCR is only allowed to say *what* it read and *where* it read it.
 * It is never allowed to decide which day a token belongs to - that is
 * derived from the day-column layout built here.
 */

export interface DayAnchor {
  day: number;
  /** Horizontal centre of the recognised day number, source px. */
  center: number;
}

export interface AlignmentResult {
  ok: boolean;
  columns: DayColumn[];
  /** Days that had no direct anchor and were interpolated. */
  interpolatedDays: number[];
  warnings: string[];
  /** What the user is told. Present only when ok is false. */
  failure?: string;
  /** Developer-only detail behind the failure. Never shown as-is. */
  diagnostic?: string;
  /** Readings that survived the fit. */
  accepted?: AnchorCandidate[];
  /** Readings that lost, and why. Developer-only. */
  rejected?: RejectedCandidate[];
}

/** Max tolerated residual of an anchor from the fitted line, in pitches. */
export const FIT_TOLERANCE = 0.35;

/**
 * The one message the user sees when the date row cannot be read.
 *
 * It says what to do, not what went wrong internally. "day 1 sits right
 * of day 24" is true and completely useless to someone holding a phone,
 * and it implies they mis-selected when the real cause was usually a
 * fragmented glyph.
 */
export const UNREADABLE_DATE_ROW =
  'We could not reliably read the date row. Adjust the blue Dates box so it covers only the day numbers, then try again.';


/**
 * Build day columns from date-strip anchors.
 *
 * Fails closed (ok: false, columns: []) when the anchors contradict a
 * left-to-right day layout, or when the anchors do not fit a consistent
 * column pitch. A wrong grid is worse than no grid.
 */
export function buildDayColumns(
  anchors: DayAnchor[],
  expectedDays: number,
  stripWidth: number,
): AlignmentResult {
  // Each anchor is one candidate reading, consuming its own token, so
  // the shared fitter can reject the contradictory ones instead of the
  // whole grid dying on the first out-of-order pair.
  const candidates: AnchorCandidate[] = anchors.map((a, i) => ({
    day: a.day,
    xNorm: a.center,
    x0: a.center,
    x1: a.center,
    confidence: 1,
    tokens: [i],
    origin: 'single' as const,
  }));
  return columnsFromCandidates(candidates, expectedDays, stripWidth);
}

/**
 * Turn candidate readings into the 31 day columns.
 *
 * The target is 31 columns, not 31 perfect labels: a handful of
 * well-placed days constrains the whole grid, and the rest are
 * interpolated from the fitted line. When the fit is underconstrained or
 * self-contradictory it fails closed - a plausible-looking grid built
 * from garbage is the one outcome worse than no grid.
 */
export function columnsFromCandidates(
  candidates: AnchorCandidate[],
  expectedDays: number,
  stripWidth: number,
): AlignmentResult {
  const warnings: string[] = [];
  const fit = fitAnchorSequence(candidates, expectedDays, stripWidth);

  if (!fit.ok || !fit.model) {
    return {
      ok: false,
      columns: [],
      interpolatedDays: [],
      warnings: [...warnings, UNREADABLE_DATE_ROW],
      failure: UNREADABLE_DATE_ROW,
      diagnostic: fit.diagnostic,
      rejected: fit.rejected,
      accepted: [],
    };
  }

  const { model, accepted } = fit;
  // Rejected candidates are NOT surfaced to the user. Most of them are
  // the losing half of a two-digit reading - the "1" of a 12, the "2" of
  // a 24 - which is the parser working correctly, not a problem anyone
  // needs to see. The full list stays in the diagnostics.

  const anchorByDay = new Map(accepted.map((c) => [c.day, c.xNorm]));
  const interpolatedDays: number[] = [];
  const centers: { day: number; center: number }[] = [];
  for (let day = 1; day <= expectedDays; day++) {
    const direct = anchorByDay.get(day);
    if (direct !== undefined) {
      centers.push({ day, center: direct });
    } else {
      interpolatedDays.push(day);
      centers.push({ day, center: model.slope * day + model.intercept });
    }
  }

  const half = model.slope / 2;
  const columns: DayColumn[] = centers.map((c, i) => {
    const prev = centers[i - 1];
    const next = centers[i + 1];
    const x0 = prev ? (prev.center + c.center) / 2 : c.center - half;
    const x1 = next ? (c.center + next.center) / 2 : c.center + half;
    return {
      day: c.day,
      x0: Math.max(0, x0),
      x1: Math.min(stripWidth, x1),
    };
  });

  if (interpolatedDays.length > 0) {
    warnings.push(
      `${interpolatedDays.length} day column(s) interpolated: ${interpolatedDays.join(', ')}`,
    );
  }

  return {
    ok: true,
    columns,
    interpolatedDays,
    warnings,
    accepted,
    rejected: fit.rejected,
    diagnostic: fit.diagnostic,
  };
}

/**
 * Crop rectangles for per-cell OCR, inside the *rectified* strip.
 *
 * By this point the row has already been flattened, so a cell is a plain
 * axis-aligned rectangle: all the rotation and perspective was spent in
 * the rectification. Columns arrive in normalised strip coordinates
 * (0..1), which is what lets the date strip and the employee strip -
 * two independent quads with different pixel widths - agree on where a
 * day is.
 */
export function cellRects(
  columns: DayColumn[],
  stripWidth: number,
  stripHeight: number,
): CropRect[] {
  return columns.map((c) => {
    const x0 = Math.max(0, c.x0) * stripWidth;
    const x1 = Math.min(1, c.x1) * stripWidth;
    return {
      x: x0,
      y: 0,
      w: Math.max(1, x1 - x0),
      h: stripHeight,
    };
  });
}

/** Default gap, as a multiple of the median token width, that splits
 *  two neighbouring characters into separate numbers. */
export const GROUP_GAP_FACTOR = 0.7;

/**
 * Glue neighbouring character tokens back into numbers.
 *
 * Character-level OCR hands back "1" and "2" for a column headed 12.
 * Before any of it can be read as a day, adjacent glyphs have to be
 * regrouped - by the gap between them, which is the only signal that
 * does not assume a grid we have not built yet. Works the same in
 * normalised coordinates, since the threshold is relative.
 */
export function groupTokens(
  tokens: OcrToken[],
  gapFactor = GROUP_GAP_FACTOR,
): OcrToken[] {
  if (tokens.length === 0) return [];
  const sorted = [...tokens].sort((a, b) => a.x0 - b.x0);
  const widths = sorted.map((t) => t.x1 - t.x0).sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)] || 1;
  const maxGap = median * gapFactor;

  const out: OcrToken[] = [];
  let cur: OcrToken | null = null;
  for (const t of sorted) {
    if (cur && t.x0 - cur.x1 <= maxGap) {
      cur = {
        text: cur.text + t.text,
        confidence: Math.min(cur.confidence, t.confidence),
        x0: cur.x0,
        x1: Math.max(cur.x1, t.x1),
      };
      out[out.length - 1] = cur;
    } else {
      cur = { ...t };
      out.push(cur);
    }
  }
  return out;
}

export interface MappedCell {
  day: number;
  /** Tokens joined left-to-right; "" when the cell is empty. */
  text: string;
  /** Lowest confidence among contributing tokens; 0 for an empty cell. */
  confidence: number;
  tokenCount: number;
}

export interface MappingResult {
  cells: MappedCell[];
  /** Tokens whose centre fell outside every column - never guessed into one. */
  unmapped: OcrToken[];
}

/**
 * Assign employee-row tokens to days by horizontal geometry only.
 * A token that falls in no column is dropped into `unmapped` rather
 * than being attached to the nearest day.
 */
export function mapTokensToDays(
  columns: DayColumn[],
  tokens: OcrToken[],
): MappingResult {
  const buckets = new Map<number, OcrToken[]>();
  const unmapped: OcrToken[] = [];

  for (const t of tokens) {
    const center = (t.x0 + t.x1) / 2;
    const col = columns.find((c) => center >= c.x0 && center < c.x1);
    if (!col) {
      unmapped.push(t);
      continue;
    }
    const list = buckets.get(col.day) ?? [];
    list.push(t);
    buckets.set(col.day, list);
  }

  const cells: MappedCell[] = columns.map((c) => {
    const list = (buckets.get(c.day) ?? []).sort((a, b) => a.x0 - b.x0);
    if (list.length === 0) {
      return { day: c.day, text: '', confidence: 0, tokenCount: 0 };
    }
    return {
      day: c.day,
      text: list.map((t) => t.text).join(''),
      // Split readings are inherently less trustworthy: take the worst.
      confidence: Math.min(...list.map((t) => t.confidence)),
      tokenCount: list.length,
    };
  });

  return { cells, unmapped };
}
