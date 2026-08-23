/**
 * Token -> shift code normalisation.
 *
 * Hard rule: a token that cannot be matched against a *known* code stays
 * unknown (null). We never invent a shift code, and we never raise a
 * confidence value - repairs can only lower it.
 */

/** Glyph pairs Tesseract routinely confuses on small roster cells. */
const CONFUSIONS: Record<string, string[]> = {
  '0': ['O', 'D'],
  O: ['0', 'D'],
  '1': ['I', 'L', 'T'],
  I: ['1', 'L'],
  L: ['1', 'I'],
  '5': ['S'],
  S: ['5'],
  '8': ['B'],
  B: ['8'],
  '6': ['G'],
  G: ['6'],
  '2': ['Z'],
  Z: ['2'],
  '4': ['A'],
  U: ['V'],
  V: ['U'],
};

/** Penalty applied when a match was only reachable via glyph repair. */
export const REPAIR_PENALTY = 0.25;

/**
 * Penalty for a match that needed a character added or removed.
 * A crop that clips one glyph is as common as a misread one ("OF" for
 * "OFF"), but it is weaker evidence - so these land under the
 * uncertainty threshold and get shown for review.
 */
export const LENGTH_REPAIR_PENALTY = 0.4;

/** Tokens that unambiguously spell "no work". */
const OFF_WORDS = new Set(['OFF', 'FREI', 'FREE', 'FR', 'RUHE', 'X']);

export const OFF_CODE = 'OFF';

/**
 * Strip OCR noise: collapse whitespace, drop punctuation that is never
 * part of a roster code, uppercase.
 */
export function cleanToken(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\s ]+/g, '')
    .replace(/[.,;:_|'"`^~*()[\]{}<>!?]/g, '')
    .toUpperCase();
}

export interface NormalizeResult {
  /** Matched code, or null when unresolved. */
  code: string | null;
  /** Never higher than the incoming OCR confidence. */
  confidence: number;
  /** True when a glyph-confusion repair was needed to match. */
  repaired: boolean;
  /** The cleaned token, for display in the correction UI. */
  cleaned: string;
}

/** Expand one token into candidate spellings via single-glyph swaps. */
function repairCandidates(token: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < token.length; i++) {
    const alts = CONFUSIONS[token[i]];
    if (!alts) continue;
    for (const alt of alts) {
      out.push(token.slice(0, i) + alt + token.slice(i + 1));
    }
  }
  return out;
}

/** True when one string is reachable from the other by one edit. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length === long.length) {
    let diffs = 0;
    for (let i = 0; i < short.length; i++) if (short[i] !== long[i]) diffs++;
    return diffs === 1;
  }
  // One insertion: skip a single character of the longer string.
  for (let i = 0; i < long.length; i++) {
    if (short === long.slice(0, i) + long.slice(i + 1)) return true;
  }
  return false;
}

/**
 * Normalise one recognised token against the set of codes the user
 * actually has. `knownCodes` comes from shift memory, so the search
 * space shrinks as the user teaches the app.
 */
export function normalizeShiftToken(
  raw: string,
  knownCodes: Iterable<string>,
  ocrConfidence = 1,
): NormalizeResult {
  const cleaned = cleanToken(raw ?? '');
  const known = new Set(
    Array.from(knownCodes, (c) => cleanToken(c)).filter((c) => c.length > 0),
  );

  if (cleaned.length === 0) {
    return { code: null, confidence: 0, repaired: false, cleaned };
  }

  if (known.has(cleaned)) {
    return { code: cleaned, confidence: ocrConfidence, repaired: false, cleaned };
  }

  if (OFF_WORDS.has(cleaned)) {
    return { code: OFF_CODE, confidence: ocrConfidence, repaired: false, cleaned };
  }

  for (const cand of repairCandidates(cleaned)) {
    if (known.has(cand)) {
      return {
        code: cand,
        confidence: Math.max(0, ocrConfidence - REPAIR_PENALTY),
        repaired: true,
        cleaned,
      };
    }
    if (OFF_WORDS.has(cand)) {
      return {
        code: OFF_CODE,
        confidence: Math.max(0, ocrConfidence - REPAIR_PENALTY),
        repaired: true,
        cleaned,
      };
    }
  }

  // A clipped or doubled glyph: match only against codes we already
  // know, and only when exactly one edit separates them.
  const vocabulary = new Set([...known, ...OFF_WORDS]);
  const oneEdit = [...vocabulary].filter(
    (c) => Math.abs(c.length - cleaned.length) === 1 && withinOneEdit(c, cleaned),
  );
  if (oneEdit.length > 0) {
    // A crop that clips a glyph is far more common than one that invents
    // one, so the longest candidate wins - but only if it wins alone.
    const longest = Math.max(...oneEdit.map((c) => c.length));
    const best = oneEdit.filter((c) => c.length === longest);
    if (best.length === 1) {
      const match = best[0];
      return {
        code: known.has(match) ? match : OFF_CODE,
        confidence: Math.max(0, ocrConfidence - LENGTH_REPAIR_PENALTY),
        repaired: true,
        cleaned,
      };
    }
  }

  // Unresolved. Keep the cleaned text so the user sees what was read.
  return { code: null, confidence: 0, repaired: false, cleaned };
}

/**
 * Parse a day number out of a date-strip token ("1", "01", "1.", "Mo 1").
 * Returns null when the token holds no plausible day-of-month.
 */
export function parseDayToken(raw: string): number | null {
  const digits = (raw ?? '').match(/\d{1,2}/g);
  if (!digits || digits.length === 0) return null;
  // A date-strip cell may read "Mo1" or "1Mo"; take the first number.
  const n = Number(digits[0]);
  if (!Number.isInteger(n) || n < 1 || n > 31) return null;
  return n;
}
