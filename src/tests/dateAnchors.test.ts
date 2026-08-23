import { describe, expect, it } from 'vitest';
import {
  buildAnchorCandidates,
  fitAnchorSequence,
  MIN_DIRECT_ANCHORS,
} from '../lib/dateAnchors';
import { columnsFromCandidates } from '../lib/gridAlignment';
import type { OcrToken } from '../models/roster';

/**
 * These reproduce the two failures a real phone produced with the quad
 * geometry already in place:
 *
 *   "Date anchor mismatch: day 1 sits right of day 24"
 *   "Date anchor mismatch: day 2 sits right of day 5"
 *
 * Both came from a two-digit day fragmenting into two glyphs, which the
 * old parser read literally as two separate days - putting a day-1
 * anchor at the far right of the row. One such token aborted the whole
 * alignment.
 */

const DAYS = 31;
const PITCH = 1 / DAYS;
const centre = (d: number) => (d - 0.5) * PITCH;

interface Glyph {
  text: string;
  x0: number;
  x1: number;
  y0?: number;
  y1?: number;
}

function tok(g: Glyph): OcrToken {
  return {
    text: g.text,
    confidence: 0.9,
    x0: g.x0,
    x1: g.x1,
    ...(g.y0 !== undefined ? { y0: g.y0, y1: g.y1 } : {}),
  } as OcrToken;
}

/** A header row. `split` days have a wide gap between their two glyphs. */
function header(readable: number[], split: number[] = []): OcrToken[] {
  const out: Glyph[] = [];
  for (const d of readable) {
    const c = centre(d);
    const s = String(d);
    if (s.length === 1) {
      out.push({ text: s, x0: c - 0.004, x1: c + 0.004, y0: 0.2, y1: 0.8 });
    } else if (split.includes(d)) {
      out.push({ text: s[0], x0: c - 0.011, x1: c - 0.004, y0: 0.2, y1: 0.8 });
      out.push({ text: s[1], x0: c + 0.004, x1: c + 0.011, y0: 0.2, y1: 0.8 });
    } else {
      out.push({ text: s[0], x0: c - 0.009, x1: c - 0.001, y0: 0.2, y1: 0.8 });
      out.push({ text: s[1], x0: c + 0.001, x1: c + 0.009, y0: 0.2, y1: 0.8 });
    }
  }
  return out.sort((a, b) => a.x0 - b.x0).map(tok);
}

function fitHeader(tokens: OcrToken[], expected = DAYS) {
  return fitAnchorSequence(buildAnchorCandidates(tokens, expected), expected);
}

function acceptedDays(tokens: OcrToken[], expected = DAYS): number[] {
  return fitHeader(tokens, expected).accepted.map((c) => c.day);
}

/** Where each day column actually ends up - the thing that matters. */
function columnCentres(tokens: OcrToken[], expected = DAYS) {
  const r = columnsFromCandidates(buildAnchorCandidates(tokens, expected), expected, 1);
  return {
    ok: r.ok,
    centre: (day: number) => {
      const c = r.columns.find((x) => x.day === day)!;
      return (c.x0 + c.x1) / 2;
    },
    interpolated: r.interpolatedDays,
    rejected: r.rejected ?? [],
  };
}

const ALL = Array.from({ length: DAYS }, (_, i) => i + 1);

describe('token grouping', () => {
  it('reads a tightly-set "24" as day 24, not day 2 and day 4', () => {
    const days = acceptedDays(header(ALL));
    expect(days).toContain(24);
    // day 2 is accepted exactly once, from its own column near the left
    expect(days.filter((d) => d === 2)).toHaveLength(1);
    const cols = columnCentres(header(ALL));
    expect(cols.centre(2)).toBeCloseTo(centre(2), 3);
    expect(cols.centre(24)).toBeCloseTo(centre(24), 3);
  });

  it('keeps genuinely separate single-digit columns apart', () => {
    const cols = columnCentres(header(ALL));
    expect(cols.ok).toBe(true);
    for (const d of [2, 3, 4, 5, 6, 7]) {
      expect(cols.centre(d)).toBeCloseTo(centre(d), 3);
    }
  });

  it('offers both readings of an adjacent digit pair as candidates', () => {
    // The parser must not commit before the sequence is fitted.
    const cands = buildAnchorCandidates(header([24]), DAYS);
    expect(cands.map((c) => c.day).sort((a, b) => a - b)).toEqual([2, 4, 24]);
  });

  it('does not merge digits that are far apart', () => {
    const wide = [
      tok({ text: '2', x0: 0.10, x1: 0.12, y0: 0.2, y1: 0.8 }),
      tok({ text: '4', x0: 0.30, x1: 0.32, y0: 0.2, y1: 0.8 }),
    ];
    expect(buildAnchorCandidates(wide, DAYS).map((c) => c.day)).toEqual([2, 4]);
  });

  it('does not merge digits on different baselines', () => {
    // A digit from the heading above the row must not join the row.
    const stacked = [
      tok({ text: '2', x0: 0.10, x1: 0.12, y0: 0.0, y1: 0.2 }),
      tok({ text: '4', x0: 0.121, x1: 0.14, y0: 0.6, y1: 0.95 }),
    ];
    expect(buildAnchorCandidates(stacked, DAYS).map((c) => c.day)).toEqual([2, 4]);
  });

  it('groups every two-digit day from 10 to 31 correctly', () => {
    const days = acceptedDays(header(ALL));
    for (let d = 10; d <= 31; d++) expect(days).toContain(d);
  });

  it('never proposes a day beyond the length of the month', () => {
    const cands = buildAnchorCandidates(header([28, 29, 30, 31]), 28);
    expect(cands.every((c) => c.day <= 28)).toBe(true);
  });
});

describe('the two failures the phone produced', () => {
  it('recovers when a trailing "31" fragments (was: day 1 right of day 24)', () => {
    // Days 25-30 unread at the low-resolution far end, 31 split, and the
    // clipped left edge means day 1 was never seen in its own column.
    const tokens = header(
      [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 31],
      [31],
    );
    const fit = fitHeader(tokens);
    expect(fit.ok).toBe(true);
    const days = fit.accepted.map((c) => c.day);
    // the stray "1" at the far right must not become a day-1 anchor
    expect(days).not.toContain(1);
    expect(days).toContain(24);
    expect(fit.rejected.some((r) => r.day === 1)).toBe(true);
  });

  it('recovers when a mid-row "26" fragments (was: day 2 right of day 5)', () => {
    const tokens = header([...ALL], [26]);
    const fit = fitHeader(tokens);
    expect(fit.ok).toBe(true);
    const days = fit.accepted.map((c) => c.day);
    // the "2" of the fragmented 26 must not become a second day-2 anchor
    expect(days.filter((d) => d === 2)).toHaveLength(1);
    // 26 itself is no longer directly readable, so it is interpolated -
    // and it still lands on the right column.
    const cols = columnCentres(tokens);
    expect(cols.interpolated).toContain(26);
    expect(cols.centre(26)).toBeCloseTo(centre(26), 2);
  });

  it('an out-of-order candidate is rejected, not fatal', () => {
    const tokens = header([...ALL], [15, 26]);
    const fit = fitHeader(tokens);
    expect(fit.ok).toBe(true);
    expect(fit.accepted.length).toBeGreaterThan(20);
  });
});

describe('heading contamination', () => {
  const heading: OcrToken[] = [
    tok({ text: '2', x0: 0.300, x1: 0.310, y0: 0.2, y1: 0.8 }),
    tok({ text: '0', x0: 0.312, x1: 0.322, y0: 0.2, y1: 0.8 }),
    tok({ text: '2', x0: 0.324, x1: 0.334, y0: 0.2, y1: 0.8 }),
    tok({ text: '6', x0: 0.336, x1: 0.346, y0: 0.2, y1: 0.8 }),
  ];

  it('a clean row is unaffected when the heading is outside the quad', () => {
    expect(acceptedDays(header(ALL))).toEqual(ALL);
  });

  it('a "2026" inside the quad cannot corrupt the grid', () => {
    const tokens = [...header(ALL), ...heading].sort((a, b) => a.x0 - b.x0);
    const fit = fitHeader(tokens);
    expect(fit.ok).toBe(true);
    expect(fit.rejected.length).toBeGreaterThan(0);
    // Every day column still lands where it belongs, whether its label
    // survived as a direct anchor or was interpolated around the noise.
    const cols = columnCentres(tokens);
    expect(cols.ok).toBe(true);
    for (const d of ALL) expect(cols.centre(d)).toBeCloseTo(centre(d), 2);
  });
});

describe('sequence fitting and fail-closed', () => {
  it('reconstructs 31 columns from a sparse but consistent set', () => {
    const fit = fitHeader(header([1, 5, 12, 18, 25, 31]));
    expect(fit.ok).toBe(true);
    const r = columnsFromCandidates(
      buildAnchorCandidates(header([1, 5, 12, 18, 25, 31]), DAYS),
      DAYS,
      1,
    );
    expect(r.ok).toBe(true);
    expect(r.columns).toHaveLength(31);
    expect(r.interpolatedDays.length).toBe(25);
    // interpolated columns land where the real ones would
    const col20 = r.columns.find((c) => c.day === 20)!;
    expect((col20.x0 + col20.x1) / 2).toBeCloseTo(centre(20), 2);
  });

  it('fails closed when there are too few readings', () => {
    const fit = fitHeader(header([7, 19]));
    expect(fit.ok).toBe(false);
    expect(fit.accepted).toEqual([]);
    expect(fit.diagnostic).toBeDefined();
  });

  it('needs at least the minimum number of consistent anchors', () => {
    const fit = fitHeader(header([3, 4, 5]));
    expect(fit.ok).toBe(false);
    expect(MIN_DIRECT_ANCHORS).toBeGreaterThan(3);
  });

  it('fails closed on inconsistent spacing', () => {
    // days at positions that no single pitch explains
    const scattered = [
      tok({ text: '1', x0: 0.01, x1: 0.02, y0: 0.2, y1: 0.8 }),
      tok({ text: '5', x0: 0.05, x1: 0.06, y0: 0.2, y1: 0.8 }),
      tok({ text: '9', x0: 0.90, x1: 0.91, y0: 0.2, y1: 0.8 }),
      tok({ text: '3', x0: 0.47, x1: 0.48, y0: 0.2, y1: 0.8 }),
      tok({ text: '7', x0: 0.12, x1: 0.13, y0: 0.2, y1: 0.8 }),
    ];
    expect(fitHeader(scattered).ok).toBe(false);
  });

  it('fails closed when the accepted days barely span the month', () => {
    const fit = fitHeader(header([14, 15, 16, 17]));
    expect(fit.ok).toBe(false);
    expect(fit.diagnostic).toMatch(/span|ambiguous|sequence/);
  });

  it('is deterministic: the same tokens always give the same model', () => {
    const tokens = header([...ALL], [26]);
    const a = fitHeader(tokens);
    const b = fitHeader(tokens);
    expect(JSON.stringify(a.model)).toBe(JSON.stringify(b.model));
    expect(a.accepted.map((c) => c.day)).toEqual(b.accepted.map((c) => c.day));
  });
});

describe('normalised positions are all that matter', () => {
  it('the same row at two rectified widths yields the same day model', () => {
    // Rectification already removed the perspective; what reaches the
    // fitter is normalised, so strip pixel size cannot change the answer.
    const tokens = header(ALL);
    const a = fitHeader(tokens);
    const b = fitHeader(tokens.map((t) => ({ ...t })));
    expect(a.accepted.map((c) => c.day)).toEqual(b.accepted.map((c) => c.day));
    expect(a.model!.slope).toBeCloseTo(b.model!.slope, 12);
  });

  it('a uniformly scaled row gives a proportionally scaled model', () => {
    const tokens = header(ALL);
    const scaled = tokens.map((t) => ({ ...t, x0: t.x0 * 0.5, x1: t.x1 * 0.5 }));
    const a = fitHeader(tokens);
    const b = fitHeader(scaled);
    expect(a.accepted.map((c) => c.day)).toEqual(b.accepted.map((c) => c.day));
    expect(b.model!.slope).toBeCloseTo(a.model!.slope * 0.5, 9);
  });
});

describe('user-facing failure text', () => {
  it('tells the user what to do and keeps the detail internal', () => {
    const r = columnsFromCandidates(
      buildAnchorCandidates(header([7, 19]), DAYS),
      DAYS,
      1,
    );
    expect(r.ok).toBe(false);
    expect(r.failure).toMatch(/adjust the blue dates box/i);
    // no internal jargon leaks into the message the user reads
    expect(r.failure).not.toMatch(/anchor|monotonic|slope|residual|candidate/i);
    expect(r.diagnostic).toBeDefined();
  });
});
