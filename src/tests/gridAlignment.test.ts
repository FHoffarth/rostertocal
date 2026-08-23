import { describe, expect, it } from 'vitest';
import { buildDayColumns, cellRects, mapTokensToDays, type DayAnchor } from '../lib/gridAlignment';
import type { OcrToken } from '../models/roster';

/** Anchors on a perfect grid: day d at x = 50 + 40*d. */
function evenAnchors(days: number[], pitch = 40, offset = 50): DayAnchor[] {
  return days.map((d) => ({ day: d, center: offset + pitch * d }));
}

function token(text: string, center: number, confidence = 0.95, halfWidth = 8): OcrToken {
  return { text, confidence, x0: center - halfWidth, x1: center + halfWidth };
}

describe('buildDayColumns - regular spacing', () => {
  it('builds one column per expected day', () => {
    const days = Array.from({ length: 31 }, (_, i) => i + 1);
    const r = buildDayColumns(evenAnchors(days), 31, 2000);
    expect(r.ok).toBe(true);
    expect(r.columns).toHaveLength(31);
    expect(r.interpolatedDays).toEqual([]);
    expect(r.columns[0].day).toBe(1);
    expect(r.columns[30].day).toBe(31);
  });

  it('produces contiguous, non-overlapping, increasing ranges', () => {
    const days = Array.from({ length: 30 }, (_, i) => i + 1);
    const { columns } = buildDayColumns(evenAnchors(days), 30, 2000);
    for (let i = 0; i < columns.length; i++) {
      expect(columns[i].x1).toBeGreaterThan(columns[i].x0);
      if (i > 0) expect(columns[i].x0).toBeCloseTo(columns[i - 1].x1, 6);
    }
  });

  it('clamps the outer edges to the strip width', () => {
    const r = buildDayColumns(evenAnchors([1, 2, 3, 4, 5], 40, 10), 5, 220);
    expect(r.columns[0].x0).toBeGreaterThanOrEqual(0);
    expect(r.columns[4].x1).toBeLessThanOrEqual(220);
  });
});

describe('buildDayColumns - uneven spacing', () => {
  it('tolerates small jitter around the fitted pitch', () => {
    const base = evenAnchors(Array.from({ length: 28 }, (_, i) => i + 1));
    const jittered = base.map((a, i) => ({ ...a, center: a.center + (i % 3) - 1 }));
    const r = buildDayColumns(jittered, 28, 2000);
    expect(r.ok).toBe(true);
    expect(r.columns).toHaveLength(28);
  });

  it('drops a single misread day number and interpolates its column', () => {
    const anchors = evenAnchors([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    anchors[5].center += 30; // day 6, most of a full column off
    const r = buildDayColumns(anchors, 10, 2000);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/Ignored 1 misplaced day number\(s\): 6/);
    expect(r.interpolatedDays).toEqual([6]);
    const col6 = r.columns.find((c) => c.day === 6)!;
    // the interpolated column sits on the grid, not on the bad reading
    expect((col6.x0 + col6.x1) / 2).toBeCloseTo(50 + 40 * 6, 6);
  });

  it('fails closed when the outliers are the majority', () => {
    const anchors = evenAnchors([1, 2, 3, 4, 5, 6, 7, 8]);
    anchors.forEach((a, i) => {
      if (i % 2 === 0) a.center += 30;
    });
    const r = buildDayColumns(anchors, 8, 2000);
    expect(r.ok).toBe(false);
    expect(r.columns).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/off the column grid/);
  });
});

describe('buildDayColumns - missing tokens', () => {
  it('interpolates days the date strip did not yield', () => {
    const r = buildDayColumns(evenAnchors([1, 2, 3, 5, 6, 8, 9, 10]), 10, 2000);
    expect(r.ok).toBe(true);
    expect(r.columns).toHaveLength(10);
    expect(r.interpolatedDays).toEqual([4, 7]);
    const col4 = r.columns.find((c) => c.day === 4)!;
    expect((col4.x0 + col4.x1) / 2).toBeCloseTo(50 + 40 * 4, 6);
    expect(r.warnings.join(' ')).toMatch(/interpolated/);
  });

  it('refuses to guess a grid from fewer than three anchors', () => {
    const r = buildDayColumns(evenAnchors([1, 2]), 31, 2000);
    expect(r.ok).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/at least 3/);
  });

  it('ignores day numbers outside 1..31', () => {
    const anchors = [...evenAnchors([1, 2, 3, 4]), { day: 47, center: 90 }];
    const r = buildDayColumns(anchors, 4, 2000);
    expect(r.ok).toBe(true);
    expect(r.columns).toHaveLength(4);
  });
});

describe('buildDayColumns - anchor mismatch', () => {
  it('fails closed when day numbers do not increase left to right', () => {
    const anchors: DayAnchor[] = [
      { day: 1, center: 90 },
      { day: 5, center: 130 },
      { day: 3, center: 170 },
      { day: 7, center: 210 },
    ];
    const r = buildDayColumns(anchors, 7, 2000);
    expect(r.ok).toBe(false);
    expect(r.columns).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/mismatch/);
  });

  it('discards both readings of a contradicted day and interpolates it', () => {
    const anchors = [...evenAnchors([1, 2, 3, 4, 5, 6]), { day: 3, center: 175 }];
    const r = buildDayColumns(anchors, 6, 2000);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/Day 3 was read in 2 places/);
    expect(r.interpolatedDays).toEqual([3]);
    expect(r.columns.filter((c) => c.day === 3)).toHaveLength(1);
    const col3 = r.columns.find((c) => c.day === 3)!;
    expect((col3.x0 + col3.x1) / 2).toBeCloseTo(50 + 40 * 3, 6);
  });
});

describe('mapTokensToDays', () => {
  const { columns } = buildDayColumns(
    evenAnchors(Array.from({ length: 10 }, (_, i) => i + 1)),
    10,
    2000,
  );

  it('assigns tokens to days purely by horizontal position', () => {
    const { cells } = mapTokensToDays(columns, [
      token('F', 50 + 40 * 1),
      token('N', 50 + 40 * 3),
    ]);
    expect(cells.find((c) => c.day === 1)!.text).toBe('F');
    expect(cells.find((c) => c.day === 3)!.text).toBe('N');
    expect(cells.find((c) => c.day === 2)!.text).toBe('');
  });

  it('reports empty cells with zero confidence instead of guessing', () => {
    const { cells } = mapTokensToDays(columns, []);
    expect(cells).toHaveLength(10);
    expect(cells.every((c) => c.text === '' && c.confidence === 0)).toBe(true);
  });

  it('never attaches an out-of-range token to the nearest day', () => {
    const stray = token('X', 5000);
    const { cells, unmapped } = mapTokensToDays(columns, [stray]);
    expect(unmapped).toEqual([stray]);
    expect(cells.every((c) => c.text === '')).toBe(true);
  });

  it('joins split readings in x-order and keeps the worst confidence', () => {
    const { cells } = mapTokensToDays(columns, [
      token('1', 50 + 40 * 2 + 4, 0.4, 3),
      token('F', 50 + 40 * 2 - 4, 0.9, 3),
    ]);
    const cell = cells.find((c) => c.day === 2)!;
    expect(cell.text).toBe('F1');
    expect(cell.confidence).toBe(0.4);
    expect(cell.tokenCount).toBe(2);
  });

  it('maps nothing when alignment failed', () => {
    const { cells, unmapped } = mapTokensToDays([], [token('F', 100)]);
    expect(cells).toEqual([]);
    expect(unmapped).toHaveLength(1);
  });
});

describe('cellRects', () => {
  it('offsets column ranges into the employee strip', () => {
    const { columns } = buildDayColumns(evenAnchors([1, 2, 3, 4, 5]), 5, 2000);
    const rects = cellRects(columns, { x: 12, y: 300, w: 400, h: 60 });
    expect(rects).toHaveLength(5);
    expect(rects[0].y).toBe(300);
    expect(rects[0].h).toBe(60);
    expect(rects[0].x).toBeCloseTo(12 + columns[0].x0, 6);
    expect(rects[0].w).toBeGreaterThan(0);
  });
});
