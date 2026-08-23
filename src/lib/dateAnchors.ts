import type { OcrToken } from '../models/roster';

/**
 * Structured interpretation of the date row.
 *
 * OCR proposes symbols; calendar structure decides which of them are
 * plausible. That order matters: reading each token literally and
 * trusting it is what let a fragmented "31" put a day-1 anchor at the
 * right-hand end of the row, and one such token used to sink the whole
 * grid.
 *
 * Everything here works in normalised rectified-strip coordinates
 * (0 = start of the selected row, 1 = end), so the photograph's
 * perspective has already stopped mattering by the time we get here.
 */

/** One reading a token stream could support. Candidates compete. */
export interface AnchorCandidate {
  day: number;
  /** Normalised centre along the strip. */
  xNorm: number;
  x0: number;
  x1: number;
  confidence: number;
  /** Which raw tokens this reading consumes; two readings that share a
   *  token are mutually exclusive. */
  tokens: number[];
  origin: 'single' | 'merged';
}

export interface RejectedCandidate extends AnchorCandidate {
  reason: string;
}

export interface AnchorModel {
  /** xNorm = slope * day + intercept */
  slope: number;
  intercept: number;
}

export interface AnchorFit {
  ok: boolean;
  model?: AnchorModel;
  accepted: AnchorCandidate[];
  rejected: RejectedCandidate[];
  /** Developer-facing detail. Never shown to the user as-is. */
  diagnostic?: string;
}

/* ------------------------------------------------------------------ *
 * Candidate construction
 * ------------------------------------------------------------------ */

/**
 * Two glyphs form one number only if they look like one number:
 * they must sit on the same line and almost touch. A phone photo
 * splits "24" into "2" and "4"; it also puts a "4" and a "5" from
 * neighbouring columns side by side. The difference is the gap.
 */
export const MAX_MERGE_GAP_RATIO = 0.6;
/** Fraction of glyph height that must overlap vertically to merge. */
export const MIN_VERTICAL_OVERLAP = 0.5;

/** Fewest directly recognised days that may define the whole grid. */
export const MIN_DIRECT_ANCHORS = 4;
/** The accepted days must span at least this fraction of the month. */
export const MIN_DAY_SPAN_RATIO = 0.25;
/** Residual tolerance, as a fraction of one column pitch. */
export const FIT_TOLERANCE = 0.35;
/**
 * Bounds on how much of the strip the fitted columns span.
 *
 * Deliberately loose: a user may reasonably draw the box wider than the
 * printed row, so a low coverage is not evidence of a bad fit. These
 * only catch the degenerate cases - a pitch collapsed onto one cluster
 * of digits, or one so wide the columns run far off the selection.
 */
export const MIN_ROW_COVERAGE = 0.05;
export const MAX_ROW_COVERAGE = 2.0;

/**
 * If a completely different day sequence explains nearly as much of the
 * evidence as the winner, the evidence is ambiguous rather than noisy -
 * and picking the marginal winner would be inventing a grid. Fail closed
 * instead.
 */
export const MAX_RIVAL_RATIO = 0.8;

interface Digit {
  index: number;
  value: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** False when the recogniser gave no vertical extent to compare. */
  hasY: boolean;
  confidence: number;
}

function toDigits(tokens: OcrToken[]): Digit[] {
  const out: Digit[] = [];
  tokens.forEach((t, index) => {
    const text = (t.text ?? '').trim();
    if (!/^\d$/.test(text)) return;
    // When the recogniser reported no vertical extent there is nothing
    // to compare, so the baseline test abstains rather than guessing.
    const hasY = t.y0 !== undefined && t.y1 !== undefined && t.y1 > t.y0;
    out.push({
      index,
      value: text,
      x0: t.x0,
      x1: t.x1,
      y0: hasY ? t.y0! : 0,
      y1: hasY ? t.y1! : 1,
      hasY,
      confidence: t.confidence,
    });
  });
  return out.sort((a, b) => a.x0 - b.x0 || a.index - b.index);
}

function verticalOverlap(a: Digit, b: Digit): number {
  if (!a.hasY || !b.hasY) return 1;
  const top = Math.max(a.y0, b.y0);
  const bottom = Math.min(a.y1, b.y1);
  const overlap = Math.max(0, bottom - top);
  const smaller = Math.min(a.y1 - a.y0, b.y1 - b.y0);
  return smaller <= 0 ? 1 : overlap / smaller;
}

/**
 * Every reading the tokens could support, without choosing between
 * them. A pair like "2","4" yields *both* day 2 + day 4 and day 24;
 * which survives is decided later, by whichever is consistent with the
 * rest of the row.
 */
export function buildAnchorCandidates(
  tokens: OcrToken[],
  expectedDays: number,
): AnchorCandidate[] {
  const digits = toDigits(tokens);
  const out: AnchorCandidate[] = [];

  for (let i = 0; i < digits.length; i++) {
    const d = digits[i];
    const value = Number(d.value);

    // Single-digit reading.
    if (value >= 1 && value <= 9 && value <= expectedDays) {
      out.push({
        day: value,
        xNorm: (d.x0 + d.x1) / 2,
        x0: d.x0,
        x1: d.x1,
        confidence: d.confidence,
        tokens: [d.index],
        origin: 'single',
      });
    }

    // Two-digit reading, but only when the glyphs really look joined.
    const n = digits[i + 1];
    if (!n) continue;
    const merged = value * 10 + Number(n.value);
    if (merged < 10 || merged > expectedDays) continue;
    const width = Math.max(d.x1 - d.x0, n.x1 - n.x0);
    const gap = n.x0 - d.x1;
    if (gap > width * MAX_MERGE_GAP_RATIO) continue;
    if (verticalOverlap(d, n) < MIN_VERTICAL_OVERLAP) continue;
    out.push({
      day: merged,
      xNorm: (d.x0 + n.x1) / 2,
      x0: d.x0,
      x1: n.x1,
      confidence: Math.min(d.confidence, n.confidence),
      tokens: [d.index, n.index],
      origin: 'merged',
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Sequence fitting
 * ------------------------------------------------------------------ */

interface Selection {
  chosen: AnchorCandidate[];
  residual: number;
}

/**
 * Greedily take the candidates a model explains, strongest first.
 *
 * "Strongest" is smallest residual, so a fragmented reading only wins
 * where no better-placed reading competes for the same day or the same
 * tokens. Ties break on day then x, never on OCR confidence - a
 * confident glyph in the wrong place is still in the wrong place.
 */
function collectInliers(
  candidates: AnchorCandidate[],
  model: AnchorModel,
  tolerance: number,
): Selection {
  const scored = candidates
    .map((c) => ({ c, r: Math.abs(c.xNorm - (model.slope * c.day + model.intercept)) }))
    .filter((s) => s.r <= tolerance)
    .sort((a, b) => a.r - b.r || a.c.day - b.c.day || a.c.xNorm - b.c.xNorm);

  const usedDays = new Set<number>();
  const usedTokens = new Set<number>();
  const chosen: AnchorCandidate[] = [];
  let residual = 0;

  for (const { c, r } of scored) {
    if (usedDays.has(c.day)) continue;
    if (c.tokens.some((t) => usedTokens.has(t))) continue;
    usedDays.add(c.day);
    c.tokens.forEach((t) => usedTokens.add(t));
    chosen.push(c);
    residual += r;
  }

  chosen.sort((a, b) => a.day - b.day);
  // A model is only usable if what it explains is monotonic in x.
  for (let i = 1; i < chosen.length; i++) {
    if (chosen[i].xNorm <= chosen[i - 1].xNorm) {
      return { chosen: [], residual: Infinity };
    }
  }
  return { chosen, residual };
}

function leastSquares(points: AnchorCandidate[]): AnchorModel | null {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((s, p) => s + p.day, 0) / n;
  const my = points.reduce((s, p) => s + p.xNorm, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.day - mx) * (p.xNorm - my);
    den += (p.day - mx) * (p.day - mx);
  }
  if (den === 0) return null;
  const slope = num / den;
  if (!Number.isFinite(slope) || slope <= 0) return null;
  return { slope, intercept: my - slope * mx };
}

/**
 * Every ordered pair proposes a line; the line explaining the most
 * candidates wins. Exhaustive and deterministic - the same tokens always
 * produce the same answer.
 */
function searchBestModel(
  sorted: AnchorCandidate[],
): { model: AnchorModel; sel: Selection } | null {
  let best: { model: AnchorModel; sel: Selection } | null = null;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (b.day <= a.day) continue;
      if (b.xNorm <= a.xNorm) continue;
      const slope = (b.xNorm - a.xNorm) / (b.day - a.day);
      if (!Number.isFinite(slope) || slope <= 0) continue;
      const model = { slope, intercept: a.xNorm - slope * a.day };
      const sel = collectInliers(sorted, model, FIT_TOLERANCE * slope);
      if (
        !best ||
        sel.chosen.length > best.sel.chosen.length ||
        (sel.chosen.length === best.sel.chosen.length && sel.residual < best.sel.residual)
      ) {
        best = { model, sel };
      }
    }
  }
  return best;
}

/**
 * Fit one left-to-right day sequence to the candidates.
 *
 * Deterministic and exhaustive rather than iterative: every ordered pair
 * of candidates proposes a line, the line that explains the most
 * candidates wins, and the winner is refined once by least squares. No
 * randomness, no model, no thresholds that drift - the same tokens
 * always produce the same grid.
 *
 * Contradictory readings are not errors to abort on. They are evidence
 * that loses.
 */
export function fitAnchorSequence(
  candidates: AnchorCandidate[],
  expectedDays: number,
  stripWidth = 1,
): AnchorFit {
  const rejected: RejectedCandidate[] = [];
  const reject = (c: AnchorCandidate, reason: string) => rejected.push({ ...c, reason });

  const usable = candidates.filter((c) => {
    if (c.day < 1 || c.day > expectedDays) {
      reject(c, `day ${c.day} is outside this month`);
      return false;
    }
    if (!Number.isFinite(c.xNorm)) {
      reject(c, 'no usable position');
      return false;
    }
    return true;
  });

  if (usable.length < MIN_DIRECT_ANCHORS) {
    return {
      ok: false,
      accepted: [],
      rejected: [...rejected, ...usable.map((c) => ({ ...c, reason: 'too few readings to fit a row' }))],
      diagnostic: `only ${usable.length} usable day candidate(s); need ${MIN_DIRECT_ANCHORS}`,
    };
  }

  const sorted = [...usable].sort((a, b) => a.xNorm - b.xNorm || a.day - b.day);
  const best = searchBestModel(sorted);

  if (!best || best.sel.chosen.length < MIN_DIRECT_ANCHORS) {
    return {
      ok: false,
      accepted: [],
      rejected: [
        ...rejected,
        ...usable.map((c) => ({ ...c, reason: 'no consistent left-to-right day sequence' })),
      ],
      diagnostic: `best model explained ${best?.sel.chosen.length ?? 0} of ${usable.length} candidates`,
    };
  }

  // One refinement pass: least squares over the inliers, then re-collect.
  const refinedModel = leastSquares(best.sel.chosen) ?? best.model;
  const refined = collectInliers(sorted, refinedModel, FIT_TOLERANCE * refinedModel.slope);
  const useRefined = refined.chosen.length >= best.sel.chosen.length;
  const model = useRefined ? refinedModel : best.model;
  const accepted = useRefined ? refined.chosen : best.sel.chosen;

  const acceptedKey = new Set(accepted.map((c) => `${c.day}:${c.tokens.join(',')}`));
  for (const c of usable) {
    if (!acceptedKey.has(`${c.day}:${c.tokens.join(',')}`)) {
      reject(c, 'contradicts the fitted day sequence');
    }
  }

  // Is there a rival reading of the same row that is nearly as good?
  const acceptedSet = new Set(accepted);
  const leftovers = sorted.filter((c) => !acceptedSet.has(c));
  const rival = searchBestModel(leftovers);
  const rivalCount = rival?.sel.chosen.length ?? 0;
  if (
    rivalCount >= MIN_DIRECT_ANCHORS &&
    rivalCount >= accepted.length * MAX_RIVAL_RATIO
  ) {
    return {
      ok: false,
      accepted: [],
      rejected,
      diagnostic: `ambiguous: a rival day sequence explains ${rivalCount} candidates against the winner's ${accepted.length}`,
    };
  }

  const daySpan = accepted[accepted.length - 1].day - accepted[0].day;
  if (daySpan < Math.ceil(expectedDays * MIN_DAY_SPAN_RATIO)) {
    return {
      ok: false,
      accepted: [],
      rejected,
      diagnostic: `accepted days span only ${daySpan} of ${expectedDays}; the grid would be unconstrained`,
    };
  }

  // A believable row fills a believable share of the strip the user
  // selected. A pitch that would run the columns far off either end
  // means the fit latched onto something that is not the date row.
  const coverage = (model.slope * (expectedDays - 1)) / (stripWidth || 1);
  if (coverage < MIN_ROW_COVERAGE || coverage > MAX_ROW_COVERAGE) {
    return {
      ok: false,
      accepted: [],
      rejected,
      diagnostic: `fitted column pitch would span ${coverage.toFixed(2)} of the strip`,
    };
  }

  return { ok: true, model, accepted, rejected };
}
