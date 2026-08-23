import { skewAt, type CropRect, type DayColumn, type OcrToken } from '../models/roster';

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
  /** Why alignment failed. Present only when ok is false. */
  failure?: string;
}

/** Max tolerated residual of an anchor from the fitted line, in pitches. */
export const FIT_TOLERANCE = 0.35;

export const NO_FIT = 'Could not fit a column pitch to the anchors';
export const NOT_ENOUGH_ANCHORS = 'Not enough day anchors recognised (need at least 3)';

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Least-squares fit of centre = slope * day + intercept. */
function fitLine(anchors: DayAnchor[]): { slope: number; intercept: number } | null {
  const n = anchors.length;
  if (n < 2) return null;
  const mx = mean(anchors.map((a) => a.day));
  const my = mean(anchors.map((a) => a.center));
  let num = 0;
  let den = 0;
  for (const a of anchors) {
    num += (a.day - mx) * (a.center - my);
    den += (a.day - mx) * (a.day - mx);
  }
  if (den === 0) return null;
  const slope = num / den;
  if (!Number.isFinite(slope) || slope <= 0) return null;
  return { slope, intercept: my - slope * mx };
}

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
  const warnings: string[] = [];

  const valid = anchors
    .filter((a) => Number.isInteger(a.day) && a.day >= 1 && a.day <= 31)
    .filter((a) => Number.isFinite(a.center))
    .sort((a, b) => a.center - b.center);

  // The same day read in two places is a contradiction, and there is no
  // honest way to pick a winner. Drop every reading of that day and let
  // the column be interpolated from the ones that agree.
  const counts = new Map<number, number>();
  for (const a of valid) counts.set(a.day, (counts.get(a.day) ?? 0) + 1);
  const uniq: DayAnchor[] = [];
  for (const a of valid) {
    if ((counts.get(a.day) ?? 0) > 1) continue;
    uniq.push(a);
  }
  for (const [day, n] of counts) {
    if (n > 1) warnings.push(`Day ${day} was read in ${n} places and was ignored`);
  }

  if (uniq.length < 3) {
    return {
      ok: false,
      columns: [],
      interpolatedDays: [],
      warnings: [...warnings, NOT_ENOUGH_ANCHORS],
      failure: NOT_ENOUGH_ANCHORS,
    };
  }

  // Days must increase left to right. Anything else is an anchor mismatch.
  for (let i = 1; i < uniq.length; i++) {
    if (uniq[i].day <= uniq[i - 1].day) {
      const mismatch = `Date anchor mismatch: day ${uniq[i].day} sits right of day ${uniq[i - 1].day}`;
      return {
        ok: false,
        columns: [],
        interpolatedDays: [],
        warnings: [...warnings, mismatch],
        failure: mismatch,
      };
    }
  }

  // Fit the column pitch, discarding the odd misread day number: one
  // bad anchor out of thirty must not sink an otherwise good grid. What
  // is rejected outright is a layout where the outliers are the norm.
  const minKeep = Math.max(3, Math.ceil(uniq.length * 0.6));
  let kept = uniq;
  let fit = fitLine(kept);
  const dropped: number[] = [];

  while (fit) {
    let worst: { anchor: DayAnchor; residual: number } | null = null;
    for (const a of kept) {
      const residual = Math.abs(a.center - (fit.slope * a.day + fit.intercept));
      if (!worst || residual > worst.residual) worst = { anchor: a, residual };
    }
    if (!worst || worst.residual <= FIT_TOLERANCE * fit.slope) break;
    if (kept.length - 1 < minKeep) {
      const offGrid = `Day ${worst.anchor.day} is off the column grid - re-align the date strip`;
      return {
        ok: false,
        columns: [],
        interpolatedDays: [],
        warnings: [...warnings, offGrid],
        failure: offGrid,
      };
    }
    dropped.push(worst.anchor.day);
    kept = kept.filter((a) => a !== worst!.anchor);
    fit = fitLine(kept);
  }

  if (!fit) {
    return {
      ok: false,
      columns: [],
      interpolatedDays: [],
      warnings: [...warnings, NO_FIT],
      failure: NO_FIT,
    };
  }

  if (dropped.length > 0) {
    warnings.push(
      `Ignored ${dropped.length} misplaced day number(s): ${dropped.sort((a, b) => a - b).join(', ')}`,
    );
  }

  const anchorByDay = new Map(kept.map((a) => [a.day, a.center]));
  const interpolatedDays: number[] = [];
  const centers: { day: number; center: number }[] = [];
  for (let day = 1; day <= expectedDays; day++) {
    const direct = anchorByDay.get(day);
    if (direct !== undefined) {
      centers.push({ day, center: direct });
    } else {
      interpolatedDays.push(day);
      centers.push({ day, center: fit.slope * day + fit.intercept });
    }
  }

  const half = fit.slope / 2;
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

  return { ok: true, columns, interpolatedDays, warnings };
}

/**
 * Crop rectangles for per-cell OCR of the employee strip.
 * Each cell sits at the band's height *at that column*, so a tilted
 * band still lands on the row it was drawn along.
 */
export function cellRects(columns: DayColumn[], strip: CropRect): CropRect[] {
  return columns.map((c) => {
    const x = strip.x + Math.max(0, c.x0);
    const centre = strip.x + (Math.max(0, c.x0) + c.x1) / 2;
    return {
      x,
      y: strip.y + skewAt(strip, centre),
      w: Math.max(1, c.x1 - c.x0),
      h: strip.h,
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
 * does not assume a grid we have not built yet.
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
