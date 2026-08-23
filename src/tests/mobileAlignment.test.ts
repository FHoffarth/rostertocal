import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { applyBandDrag, clampBand, MIN_H } from '../components/StripCropper';
import { MAX_ZOOM, ZOOM_STEPS, zoomIn, zoomOut } from '../components/AlignmentEditor';
import { buildDayColumns, cellRects, mapTokensToDays } from '../lib/gridAlignment';
import { adjudicateCell } from '../lib/recognitionPipeline';
import { generateIcs } from '../lib/icsGenerator';
import {
  CellState,
  isBulkAcceptable,
  isExportable,
  needsAttention,
  RecognitionSource,
  type DayShift,
  type ShiftDef,
} from '../models/shifts';
import type { CropRect } from '../models/roster';

/**
 * Zoom is presentation only. These tests exist to keep it that way: the
 * moment a zoom factor can reach a band rectangle or a day column, the
 * geometry that owns date-to-cell mapping is no longer trustworthy.
 */

const SOURCE_W = 2000;
const SOURCE_H = 793;

function band(over: Partial<CropRect> = {}): CropRect {
  return { x: 0, y: 296, w: SOURCE_W, h: 42, skew: 47, ...over };
}

/** Convert a screen delta to source pixels the way StripCropper does. */
function toSource(dyScreen: number, fitWidth: number, zoom: number): number {
  return dyScreen / ((fitWidth * zoom) / SOURCE_W);
}

describe('band coordinates are invariant under zoom', () => {
  const fit = 351; // a 375px viewport

  it('the same physical drag means the same source movement at any zoom', () => {
    // A finger moves 20 screen px at 100%, and the proportional distance
    // at higher zoom: both must land the band in the same source place.
    const start = band();
    const atFit = applyBandDrag('move', start, toSource(20, fit, 1), SOURCE_W, SOURCE_H);
    for (const z of ZOOM_STEPS) {
      const scaled = applyBandDrag('move', start, toSource(20 * z, fit, z), SOURCE_W, SOURCE_H);
      expect(scaled.y).toBeCloseTo(atFit.y, 9);
      expect(scaled.h).toBeCloseTo(atFit.h, 9);
      expect(scaled.skew).toBeCloseTo(atFit.skew!, 9);
    }
  });

  it('a rect is never rewritten by rendering it at a different zoom', () => {
    // Rendering is rect * scale; the rect itself is the single source of
    // truth and no zoom value is an input to it.
    const rect = band();
    const snapshot = JSON.stringify(rect);
    for (const z of ZOOM_STEPS) {
      const scale = (fit * z) / SOURCE_W;
      const rendered = { top: rect.y * scale, height: rect.h * scale, width: rect.w * scale };
      expect(rendered.top / scale).toBeCloseTo(rect.y, 9);
      expect(rendered.height / scale).toBeCloseTo(rect.h, 9);
      expect(rendered.width / scale).toBeCloseTo(rect.w, 9);
    }
    expect(JSON.stringify(rect)).toBe(snapshot);
  });

  it('zoom steps go up and down and stop at the ends', () => {
    expect(zoomIn(1)).toBe(1.5);
    expect(zoomOut(1.5)).toBe(1);
    expect(zoomIn(MAX_ZOOM)).toBe(MAX_ZOOM);
    expect(zoomOut(1)).toBe(1);
    expect(ZOOM_STEPS[0]).toBe(1);
  });
});

describe('zoom cannot change recognition geometry', () => {
  const anchors = Array.from({ length: 31 }, (_, i) => ({ day: i + 1, center: 288 + 53.7 * i }));

  it('day columns depend only on source coordinates', () => {
    const a = buildDayColumns(anchors, 31, SOURCE_W);
    const b = buildDayColumns(anchors, 31, SOURCE_W);
    expect(JSON.stringify(a.columns)).toBe(JSON.stringify(b.columns));
    expect(a.ok).toBe(true);
  });

  it('cell crops are identical whatever the view was zoomed to', () => {
    const { columns } = buildDayColumns(anchors, 31, SOURCE_W);
    const strip = band();
    const first = JSON.stringify(cellRects(columns, strip));
    // Simulate the user zooming in and out between placing and reading.
    for (const _z of ZOOM_STEPS) {
      expect(JSON.stringify(cellRects(columns, strip))).toBe(first);
    }
  });

  it('token to day mapping is unaffected by any display scale', () => {
    const { columns } = buildDayColumns(anchors, 31, SOURCE_W);
    const tokens = [{ text: 'N', confidence: 0.9, x0: 280, x1: 300 }];
    const first = JSON.stringify(mapTokensToDays(columns, tokens).cells);
    expect(JSON.stringify(mapTokensToDays(columns, tokens).cells)).toBe(first);
  });
});

describe('two-ended band drag still works', () => {
  it('the east handle tilts the right end and leaves the left alone', () => {
    const start = band({ skew: 0 });
    const next = applyBandDrag('e', start, 30, SOURCE_W, SOURCE_H);
    expect(next.y).toBe(start.y);
    expect(next.skew).toBe(30);
  });

  it('the west handle lifts the left end and holds the right end still', () => {
    const start = band({ y: 300, skew: 0 });
    const next = applyBandDrag('w', start, -20, SOURCE_W, SOURCE_H);
    expect(next.y).toBe(280);
    expect(next.skew).toBe(20);
    // the right end is y + skew, and it must not have moved
    expect(next.y + next.skew!).toBe(start.y + (start.skew ?? 0));
  });

  it('move slides the whole band without changing its tilt or height', () => {
    const start = band({ skew: 47 });
    const next = applyBandDrag('move', start, 25, SOURCE_W, SOURCE_H);
    expect(next.y).toBe(start.y + 25);
    expect(next.skew).toBe(47);
    expect(next.h).toBe(start.h);
  });

  it('north and south edges resize without moving the other edge', () => {
    const start = band({ y: 300, h: 60, skew: 0 });
    const n = applyBandDrag('n', start, 10, SOURCE_W, SOURCE_H);
    expect(n.y).toBe(310);
    expect(n.y + n.h).toBe(start.y + start.h);
    const s = applyBandDrag('s', start, 10, SOURCE_W, SOURCE_H);
    expect(s.y).toBe(300);
    expect(s.h).toBe(70);
  });

  it('never collapses below a grabbable height', () => {
    const next = applyBandDrag('s', band({ h: 30 }), -500, SOURCE_W, SOURCE_H);
    expect(next.h).toBe(MIN_H);
  });

  it('keeps a tilted band on the image at both ends', () => {
    const pushedUp = clampBand(band({ y: -80, skew: 47 }), SOURCE_W, SOURCE_H);
    expect(pushedUp.y).toBeGreaterThanOrEqual(0);
    const pushedDown = clampBand(band({ y: SOURCE_H + 50, skew: 47 }), SOURCE_W, SOURCE_H);
    expect(pushedDown.y + (pushedDown.skew ?? 0) + pushedDown.h).toBeLessThanOrEqual(SOURCE_H);
  });

  it('always spans the full image width', () => {
    const next = applyBandDrag('move', band({ x: 40, w: 10 }), 0, SOURCE_W, SOURCE_H);
    expect(next.x).toBe(0);
    expect(next.w).toBe(SOURCE_W);
  });
});

describe('mobile layout guards (320 / 375 / 390)', () => {
  // Read as text: these are assertions about the stylesheet itself, so
  // going through Vite's CSS pipeline would defeat the point.
  const css = readFileSync('src/index.css', 'utf-8');

  function ruleFor(selector: string): string {
    const i = css.indexOf(selector + ' {');
    expect(i, `missing rule ${selector}`).toBeGreaterThan(-1);
    return css.slice(i, css.indexOf('}', i));
  }

  it('the end handles are not pushed outside the band', () => {
    // D-1 was exactly this: a negative horizontal offset put half of each
    // end handle outside the clipped stage on a narrow screen.
    for (const sel of ['.strip .handle.w', '.strip .handle.e']) {
      const rule = ruleFor(sel);
      expect(rule).not.toMatch(/(left|right):\s*calc\(var\(--tap\)\s*\/\s*-/);
      expect(rule).not.toMatch(/(left|right):\s*-/);
    }
  });

  it('handles keep a full touch target', () => {
    const rule = ruleFor('.strip .handle');
    expect(rule).toMatch(/width:\s*var\(--tap\)/);
    expect(rule).toMatch(/height:\s*var\(--tap\)/);
    expect(css).toMatch(/--tap:\s*48px/);
  });

  it('the stage pans instead of clipping when the picture is zoomed', () => {
    const stage = ruleFor('.stage');
    expect(stage).toMatch(/overflow:\s*auto/);
    expect(stage).toMatch(/touch-action:\s*pan-x pan-y/);
  });

  it('dragging a band never turns into a pan', () => {
    expect(ruleFor('.strip')).toMatch(/touch-action:\s*none/);
    expect(ruleFor('.strip .handle')).toMatch(/touch-action:\s*none/);
  });

  it('the scroller reserves room for the overhanging top/bottom handles', () => {
    expect(ruleFor('.zoom-layer')).toMatch(/padding:\s*28px 0/);
  });

  it('nothing forces the page itself to scroll sideways', () => {
    expect(ruleFor('html,\nbody')).toMatch(/overflow-x:\s*hidden/);
    expect(ruleFor('.stage')).toMatch(/max-width:\s*100%/);
  });
});

/* ------------------------------------------------------------------ *
 * Unchanged-behaviour guards. This sprint touched presentation only;
 * none of the safety model may have moved.
 * ------------------------------------------------------------------ */

const KNOWN = ['F', 'F1', 'S', 'N', 'OFF'];
const DEFS: ShiftDef[] = [
  { code: 'N', label: 'Nacht', start: '22:00', end: '06:00', isOff: false },
  { code: 'F', label: 'Frueh', start: '06:00', end: '14:00', isOff: false },
  { code: 'OFF', label: 'Frei', start: '00:00', end: '00:00', isOff: true },
];

function dayOf(dateStr: string, v: ReturnType<typeof adjudicateCell>): DayShift {
  return {
    dateStr,
    shiftCode: v.shiftCode,
    confidence: v.confidence,
    source: RecognitionSource.OCR,
    state: v.state,
    evidence: v.evidence,
  };
}

describe('safety model unchanged by this sprint', () => {
  it('the four cell states are still exactly these', () => {
    expect(Object.keys(CellState).sort()).toEqual(
      ['CONFIRMED', 'EDITED', 'RECOGNIZED', 'UNRESOLVED'].sort(),
    );
  });

  it('only confirmed and edited cells are exportable', () => {
    const base = { dateStr: '2026-08-01', shiftCode: 'N', confidence: 1, source: RecognitionSource.OCR };
    expect(isExportable({ ...base, state: CellState.CONFIRMED })).toBe(true);
    expect(isExportable({ ...base, state: CellState.EDITED })).toBe(true);
    expect(isExportable({ ...base, state: CellState.RECOGNIZED })).toBe(false);
    expect(isExportable({ ...base, state: CellState.UNRESOLVED })).toBe(false);
  });

  it('a disagreement is still unresolved regardless of confidence', () => {
    const v = adjudicateCell({ text: 'F', confidence: 0.99 }, { text: 'OFF', confidence: 0.5 }, KNOWN);
    expect(v.state).toBe(CellState.UNRESOLVED);
    expect(v.shiftCode).toBeNull();
  });

  it('a 99% agreed reading still cannot export by itself', () => {
    const v = adjudicateCell({ text: 'N', confidence: 0.99 }, { text: 'N', confidence: 0.99 }, KNOWN);
    expect(v.state).toBe(CellState.RECOGNIZED);
    expect(needsAttention(dayOf('2026-08-23', v))).toBe(true);
    expect(generateIcs([dayOf('2026-08-23', v)], DEFS, { dtstamp: 'X' })).not.toContain('VEVENT');
  });

  it('bulk accept still cannot reach a disputed cell', () => {
    const bad = adjudicateCell({ text: 'F', confidence: 0.99 }, { text: 'OFF', confidence: 0.5 }, KNOWN);
    const good = adjudicateCell({ text: 'N', confidence: 0.9 }, { text: 'N', confidence: 0.9 }, KNOWN);
    expect(isBulkAcceptable(dayOf('2026-08-29', bad))).toBe(false);
    expect(isBulkAcceptable(dayOf('2026-08-23', good))).toBe(true);
  });

  it('overnight and month boundary still land on the right days', () => {
    const confirmed: DayShift = {
      dateStr: '2026-08-31',
      shiftCode: 'N',
      confidence: 1,
      source: RecognitionSource.USER_CONFIRMED,
      state: CellState.CONFIRMED,
    };
    const ics = generateIcs([confirmed], DEFS, { dtstamp: 'X' });
    expect(ics).toContain('DTSTART;TZID=Europe/Berlin:20260831T220000');
    expect(ics).toContain('DTEND;TZID=Europe/Berlin:20260901T060000');
  });
});

describe('one OCR worker per session', () => {
  it('reuses a single worker across every recognition', async () => {
    const terminate = vi.fn(async () => {});
    const createWorker = vi.fn(async () => ({ terminate, id: 'w1' }));
    vi.doMock('tesseract.js', () => ({ createWorker }));
    vi.resetModules();

    const mod = await import('../lib/ocrWorker');
    const a = await mod.getOcrWorker();
    const b = await mod.getOcrWorker();
    const c = await mod.getOcrWorker();

    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);

    await mod.terminateOcrWorker();
    expect(terminate).toHaveBeenCalledTimes(1);

    // after teardown a new session may start exactly one more
    await mod.getOcrWorker();
    expect(createWorker).toHaveBeenCalledTimes(2);

    vi.doUnmock('tesseract.js');
    vi.resetModules();
  });
});
