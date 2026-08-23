import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  clampQuadToImage,
  isConvexQuad,
  moveCorner,
  moveQuad,
  quadArea,
  quadFromBand,
  quadPoints,
  validateQuad,
  type Point,
  type QuadSelection,
} from '../models/quad';
import {
  mapSourceToUnit,
  mapUnitToSource,
  MAX_RECTIFIED_HEIGHT,
  MAX_RECTIFIED_WIDTH,
  rectifiedSize,
  squareToQuad,
} from '../lib/perspective';
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

/**
 * The alignment selection is a quadrilateral in source-image pixels, and
 * that is the only geometry anything downstream is allowed to believe.
 * These tests exist to keep zoom, pan and viewport size out of it.
 */

const IMG_W = 2000;
const IMG_H = 793;

function rect(x: number, y: number, w: number, h: number): QuadSelection {
  return {
    topLeft: { x, y },
    topRight: { x: x + w, y },
    bottomRight: { x: x + w, y: y + h },
    bottomLeft: { x, y: y + h },
  };
}

function rotate(q: QuadSelection, deg: number, cx: number, cy: number): QuadSelection {
  const r = (deg * Math.PI) / 180;
  const f = (p: Point): Point => ({
    x: cx + (p.x - cx) * Math.cos(r) - (p.y - cy) * Math.sin(r),
    y: cy + (p.x - cx) * Math.sin(r) + (p.y - cy) * Math.cos(r),
  });
  return {
    topLeft: f(q.topLeft),
    topRight: f(q.topRight),
    bottomRight: f(q.bottomRight),
    bottomLeft: f(q.bottomLeft),
  };
}

/** A row seen at an angle: far end lower, shorter and thinner. */
const TRAPEZOID: QuadSelection = {
  topLeft: { x: 120, y: 260 },
  topRight: { x: 1850, y: 330 },
  bottomRight: { x: 1840, y: 372 },
  bottomLeft: { x: 118, y: 316 },
};

describe('the quad can express what a photograph does to a row', () => {
  it('represents an arbitrary rotated row', () => {
    const q = rotate(rect(100, 280, 1700, 50), 11.5, 950, 305);
    expect(validateQuad(q, IMG_W, IMG_H).ok).toBe(true);
    // it really is rotated: the top edge is not level
    expect(Math.abs(q.topRight.y - q.topLeft.y)).toBeGreaterThan(100);
    expect(isConvexQuad(q)).toBe(true);
  });

  it('represents a trapezoid, which the old band never could', () => {
    expect(validateQuad(TRAPEZOID, IMG_W, IMG_H).ok).toBe(true);
    const topLen = TRAPEZOID.topRight.x - TRAPEZOID.topLeft.x;
    const bottomLen = TRAPEZOID.bottomRight.x - TRAPEZOID.bottomLeft.x;
    // a band forced these to be equal; a quad does not
    expect(topLen).not.toBeCloseTo(bottomLen, 0);
  });

  it('represents a row that is taller at one end than the other', () => {
    const q: QuadSelection = {
      topLeft: { x: 100, y: 200 },
      topRight: { x: 1800, y: 240 },
      bottomRight: { x: 1800, y: 300 },
      bottomLeft: { x: 100, y: 320 },
    };
    expect(validateQuad(q, IMG_W, IMG_H).ok).toBe(true);
    const leftH = q.bottomLeft.y - q.topLeft.y;
    const rightH = q.bottomRight.y - q.topRight.y;
    expect(leftH).not.toBe(rightH);
  });
});

describe('corner dragging', () => {
  it('moves only the corner that was grabbed', () => {
    const start = rect(100, 200, 800, 60);
    const next = moveCorner(start, 'topRight', 30, -15, IMG_W, IMG_H);
    expect(next.topRight).toEqual({ x: 930, y: 185 });
    expect(next.topLeft).toEqual(start.topLeft);
    expect(next.bottomRight).toEqual(start.bottomRight);
    expect(next.bottomLeft).toEqual(start.bottomLeft);
  });

  it('each of the four corners is independently draggable', () => {
    const start = rect(100, 200, 800, 60);
    for (const corner of ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const) {
      const next = moveCorner(start, corner, 12, 7, IMG_W, IMG_H);
      expect(next[corner].x).toBe(start[corner].x + 12);
      expect(next[corner].y).toBe(start[corner].y + 7);
      const others = (['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const).filter(
        (c) => c !== corner,
      );
      for (const o of others) expect(next[o]).toEqual(start[o]);
    }
  });

  it('clamps a dragged corner to the image', () => {
    const start = rect(100, 200, 800, 60);
    const off = moveCorner(start, 'topLeft', -5000, -5000, IMG_W, IMG_H);
    expect(off.topLeft).toEqual({ x: 0, y: 0 });
    const far = moveCorner(start, 'bottomRight', 9000, 9000, IMG_W, IMG_H);
    expect(far.bottomRight).toEqual({ x: IMG_W, y: IMG_H });
  });

  it('sliding the whole selection keeps its shape', () => {
    const next = moveQuad(TRAPEZOID, 25, -12, IMG_W, IMG_H);
    const before = quadPoints(TRAPEZOID);
    const after = quadPoints(next);
    after.forEach((p, i) => {
      expect(p.x - before[i].x).toBeCloseTo(25, 9);
      expect(p.y - before[i].y).toBeCloseTo(-12, 9);
    });
    expect(quadArea(next)).toBeCloseTo(quadArea(TRAPEZOID), 6);
  });

  it('a whole-selection slide is stopped at the edge without deforming', () => {
    const next = moveQuad(rect(100, 200, 800, 60), -5000, 0, IMG_W, IMG_H);
    expect(next.topLeft.x).toBe(0);
    expect(next.topRight.x).toBe(800);
    expect(quadArea(next)).toBeCloseTo(800 * 60, 6);
  });
});

describe('invalid geometry is refused, not repaired', () => {
  it('rejects a self-intersecting bow tie', () => {
    const bow: QuadSelection = {
      topLeft: { x: 100, y: 200 },
      topRight: { x: 900, y: 200 },
      bottomRight: { x: 100, y: 260 },
      bottomLeft: { x: 900, y: 260 },
    };
    const v = validateQuad(bow, IMG_W, IMG_H);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/cross over/);
  });

  it('rejects a selection too small to hold a row', () => {
    // Every edge is long enough to pass the collapse check, so this
    // lands squarely on the area rule.
    const tiny = rect(100, 200, 19, 19);
    const v = validateQuad(tiny, IMG_W, IMG_H);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/too small/);
  });

  it('rejects a slice with no usable height', () => {
    const flat = {
      topLeft: { x: 100, y: 200 },
      topRight: { x: 900, y: 200 },
      bottomRight: { x: 900, y: 200.2 },
      bottomLeft: { x: 100, y: 200.2 },
    };
    expect(validateQuad(flat, IMG_W, IMG_H).ok).toBe(false);
  });

  it('rejects collapsed corners', () => {
    const collapsed: QuadSelection = {
      topLeft: { x: 100, y: 200 },
      topRight: { x: 101, y: 200 },
      bottomRight: { x: 900, y: 260 },
      bottomLeft: { x: 100, y: 260 },
    };
    const v = validateQuad(collapsed, IMG_W, IMG_H);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/collapsed/);
  });

  it('rejects a selection that is mostly off the picture', () => {
    const outside = rect(IMG_W - 60, IMG_H - 30, 900, 200);
    const v = validateQuad(outside, IMG_W, IMG_H);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/off the picture/);
  });

  it('rejects a non-finite corner', () => {
    const bad = { ...rect(100, 200, 800, 60), topLeft: { x: NaN, y: 200 } };
    expect(validateQuad(bad, IMG_W, IMG_H).ok).toBe(false);
  });

  it('never silently reorders corners into something plausible', () => {
    const bow: QuadSelection = {
      topLeft: { x: 100, y: 200 },
      topRight: { x: 900, y: 200 },
      bottomRight: { x: 100, y: 260 },
      bottomLeft: { x: 900, y: 260 },
    };
    // validation refuses it; it does not hand back a fixed-up quad
    const v = validateQuad(bow, IMG_W, IMG_H);
    expect(v.ok).toBe(false);
    expect(bow.bottomRight).toEqual({ x: 100, y: 260 });
  });

  it('clamping holds every corner on the image', () => {
    const c = clampQuadToImage(rect(-500, -500, 4000, 4000), IMG_W, IMG_H);
    for (const p of quadPoints(c)) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(IMG_W);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(IMG_H);
    }
  });

  it('accepts an honest row selection', () => {
    expect(validateQuad(rect(100, 280, 1700, 48), IMG_W, IMG_H).ok).toBe(true);
  });
});

describe('the perspective transform', () => {
  const cases: [string, QuadSelection][] = [
    ['axis-aligned', rect(120, 260, 1700, 50)],
    ['rotated', rotate(rect(120, 260, 1700, 50), 9, 970, 285)],
    ['trapezoid', TRAPEZOID],
  ];

  it.each(cases)('%s: the unit square lands exactly on the corners', (_name, q) => {
    const m = squareToQuad(q);
    const corners: [number, number, Point][] = [
      [0, 0, q.topLeft],
      [1, 0, q.topRight],
      [1, 1, q.bottomRight],
      [0, 1, q.bottomLeft],
    ];
    for (const [u, v, target] of corners) {
      const p = mapUnitToSource(m, u, v);
      expect(p.x).toBeCloseTo(target.x, 6);
      expect(p.y).toBeCloseTo(target.y, 6);
    }
  });

  it.each(cases)('%s: source and unit coordinates round-trip', (_name, q) => {
    const m = squareToQuad(q);
    for (const [u, v] of [
      [0.25, 0.3],
      [0.5, 0.5],
      [0.87, 0.11],
    ]) {
      const p = mapUnitToSource(m, u, v);
      const back = mapSourceToUnit(m, p.x, p.y);
      expect(back.x).toBeCloseTo(u, 6);
      expect(back.y).toBeCloseTo(v, 6);
    }
  });

  it('is deterministic: the same quad always gives the same coefficients', () => {
    const a = squareToQuad(TRAPEZOID);
    const b = squareToQuad({ ...TRAPEZOID });
    expect(a).toEqual(b);
  });

  it('a rectangle rectifies without distortion: u is linear in x', () => {
    const q = rect(100, 200, 800, 60);
    const m = squareToQuad(q);
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const p = mapUnitToSource(m, u, 0.5);
      expect(p.x).toBeCloseTo(100 + 800 * u, 6);
      expect(p.y).toBeCloseTo(230, 6);
    }
  });

  it('a rotated row becomes an axis-aligned strip: constant v is a straight line', () => {
    const q = rotate(rect(120, 260, 1700, 50), 9, 970, 285);
    const m = squareToQuad(q);
    const pts = [0, 0.25, 0.5, 0.75, 1].map((u) => mapUnitToSource(m, u, 0.5));
    // all sample points sit on one line in the source image
    const dx = pts[4].x - pts[0].x;
    const dy = pts[4].y - pts[0].y;
    for (const p of pts) {
      const cross = (p.x - pts[0].x) * dy - (p.y - pts[0].y) * dx;
      expect(Math.abs(cross)).toBeLessThan(1e-6);
    }
  });

  it('a trapezoid becomes a rectangle: equal steps in u stay inside the row', () => {
    const m = squareToQuad(TRAPEZOID);
    const top = [0, 0.5, 1].map((u) => mapUnitToSource(m, u, 0));
    const bottom = [0, 0.5, 1].map((u) => mapUnitToSource(m, u, 1));
    // the near end is taller than the far end, and the map respects that
    const nearH = bottom[0].y - top[0].y;
    const farH = bottom[2].y - top[2].y;
    expect(nearH).toBeGreaterThan(0);
    expect(farH).toBeGreaterThan(0);
    expect(nearH).not.toBeCloseTo(farH, 1);
  });

  it('refuses a degenerate quad rather than dividing by zero', () => {
    const collinear: QuadSelection = {
      topLeft: { x: 0, y: 0 },
      topRight: { x: 100, y: 0 },
      bottomRight: { x: 200, y: 0 },
      bottomLeft: { x: 300, y: 0 },
    };
    expect(() => squareToQuad(collinear)).toThrow(/[Dd]egenerate/);
  });
});

describe('rectified output sizing', () => {
  it('uses the longer of each opposing edge pair', () => {
    // top edge 1000, bottom edge 800, sides 60 and 40
    const q: QuadSelection = {
      topLeft: { x: 0, y: 0 },
      topRight: { x: 1000, y: 0 },
      bottomRight: { x: 900, y: 40 },
      bottomLeft: { x: 100, y: 60 },
    };
    const size = rectifiedSize(q, 1);
    expect(size.width).toBe(1000);
    expect(size.height).toBe(Math.round(Math.hypot(100, 60)));
  });

  it('scales with the requested upscale', () => {
    const q = rect(0, 0, 500, 40);
    expect(rectifiedSize(q, 1)).toEqual({ width: 500, height: 40 });
    expect(rectifiedSize(q, 3)).toEqual({ width: 1500, height: 120 });
  });

  it('is bounded, so a wild selection cannot ask for a huge canvas', () => {
    const huge = rect(0, 0, 100000, 9000);
    const size = rectifiedSize(huge, 3);
    expect(size.width).toBe(MAX_RECTIFIED_WIDTH);
    expect(size.height).toBe(MAX_RECTIFIED_HEIGHT);
  });

  it('never returns a zero dimension', () => {
    const tiny = rect(0, 0, 1, 1);
    const size = rectifiedSize(tiny, 1);
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    expect(rectifiedSize(TRAPEZOID, 3)).toEqual(rectifiedSize(TRAPEZOID, 3));
  });
});

describe('zoom and viewport cannot touch the source quad', () => {
  const fitWidths = [296, 351, 366]; // 320 / 375 / 390 px viewports

  it('the same physical drag means the same source movement at any zoom', () => {
    const start = rect(100, 280, 1700, 48);
    const fit = 351;
    const atFit = moveCorner(start, 'topLeft', 20 / (fit / IMG_W), 0, IMG_W, IMG_H);
    for (const z of ZOOM_STEPS) {
      const scale = (fit * z) / IMG_W;
      const scaled = moveCorner(start, 'topLeft', (20 * z) / scale, 0, IMG_W, IMG_H);
      expect(scaled.topLeft.x).toBeCloseTo(atFit.topLeft.x, 6);
    }
  });

  it('rendering the same quad at every zoom leaves it unchanged', () => {
    const q = TRAPEZOID;
    const snapshot = JSON.stringify(q);
    for (const z of ZOOM_STEPS) {
      for (const fit of fitWidths) {
        const scale = (fit * z) / IMG_W;
        // this is exactly what the component draws
        const drawn = quadPoints(q).map((p) => ({ x: p.x * scale, y: p.y * scale }));
        drawn.forEach((p, i) => {
          expect(p.x / scale).toBeCloseTo(quadPoints(q)[i].x, 6);
          expect(p.y / scale).toBeCloseTo(quadPoints(q)[i].y, 6);
        });
      }
    }
    expect(JSON.stringify(q)).toBe(snapshot);
  });

  it('a display resize does not alter the source quad', () => {
    const q = TRAPEZOID;
    const before = JSON.stringify(q);
    for (const fit of fitWidths) {
      const scale = fit / IMG_W;
      quadPoints(q).forEach((p) => ({ x: p.x * scale, y: p.y * scale }));
    }
    expect(JSON.stringify(q)).toBe(before);
  });

  it('the rectified output is identical whatever the display zoom was', () => {
    // Rectification takes the quad and the source canvas only; no zoom
    // value is an input, so the size and the transform cannot vary.
    const sizes = ZOOM_STEPS.map(() => rectifiedSize(TRAPEZOID, 3));
    const maps = ZOOM_STEPS.map(() => squareToQuad(TRAPEZOID));
    expect(new Set(sizes.map((s) => `${s.width}x${s.height}`)).size).toBe(1);
    expect(new Set(maps.map((m) => JSON.stringify(m))).size).toBe(1);
  });

  it('zoom steps go up and down and stop at the ends', () => {
    expect(zoomIn(1)).toBe(1.5);
    expect(zoomOut(1.5)).toBe(1);
    expect(zoomIn(MAX_ZOOM)).toBe(MAX_ZOOM);
    expect(zoomOut(1)).toBe(1);
  });
});

describe('day mapping happens in rectified coordinates', () => {
  const anchors = Array.from({ length: 31 }, (_, i) => ({
    day: i + 1,
    center: 0.02 + (0.96 * i) / 30,
  }));

  it('columns are built in normalised row space', () => {
    const r = buildDayColumns(anchors, 31, 1);
    expect(r.ok).toBe(true);
    expect(r.columns).toHaveLength(31);
    expect(r.columns[0].x0).toBeGreaterThanOrEqual(0);
    expect(r.columns[30].x1).toBeLessThanOrEqual(1);
  });

  it('two strips of different pixel widths agree on where a day is', () => {
    // The date quad and the row quad are independent selections, so their
    // rectified widths differ. Normalised columns are what reconcile them.
    const { columns } = buildDayColumns(anchors, 31, 1);
    const dateW = 5100;
    const rowW = 4680;
    const dateRects = cellRects(columns, dateW, 90);
    const rowRects = cellRects(columns, rowW, 120);
    dateRects.forEach((d, i) => {
      expect(d.x / dateW).toBeCloseTo(rowRects[i].x / rowW, 9);
    });
  });

  it('a token is placed by its normalised position, not its source x', () => {
    const { columns } = buildDayColumns(anchors, 31, 1);
    const u = columns[9].x0 + (columns[9].x1 - columns[9].x0) / 2;
    const { cells } = mapTokensToDays(columns, [
      { text: 'N', confidence: 0.9, x0: u - 0.002, x1: u + 0.002 },
    ]);
    expect(cells.find((c) => c.day === 10)!.text).toBe('N');
  });

  it('a token outside the row is still never snapped to a day', () => {
    const { columns } = buildDayColumns(anchors, 31, 1);
    const stray = { text: 'X', confidence: 0.9, x0: 1.4, x1: 1.5 };
    const { cells, unmapped } = mapTokensToDays(columns, [stray]);
    expect(unmapped).toEqual([stray]);
    expect(cells.every((c) => c.text === '')).toBe(true);
  });

  it('cell crops sit inside the rectified strip', () => {
    const { columns } = buildDayColumns(anchors, 31, 1);
    const rects = cellRects(columns, 4680, 120);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(4680 + 1e-9);
      expect(r.y).toBe(0);
      expect(r.h).toBe(120);
    }
  });
});

describe('migration from the old band model', () => {
  it('converts a level band exactly', () => {
    const q = quadFromBand({ x: 0, y: 100, w: 2000, h: 50 });
    expect(q).toEqual({
      topLeft: { x: 0, y: 100 },
      topRight: { x: 2000, y: 100 },
      bottomRight: { x: 2000, y: 150 },
      bottomLeft: { x: 0, y: 150 },
    });
  });

  it('converts a skewed band exactly, losing nothing', () => {
    const band = { x: 0, y: 296, w: 2000, h: 42, skew: 47 };
    const q = quadFromBand(band);
    expect(q.topLeft).toEqual({ x: 0, y: 296 });
    expect(q.topRight).toEqual({ x: 2000, y: 343 });
    expect(q.bottomRight).toEqual({ x: 2000, y: 385 });
    expect(q.bottomLeft).toEqual({ x: 0, y: 338 });
    // the old band was a parallelogram, and the quad still is one
    expect(q.topRight.y - q.topLeft.y).toBe(q.bottomRight.y - q.bottomLeft.y);
    expect(quadArea(q)).toBeCloseTo(2000 * 42, 6);
  });

  it('a converted band is valid geometry', () => {
    const q = quadFromBand({ x: 0, y: 296, w: 2000, h: 42, skew: 47 });
    expect(validateQuad(q, IMG_W, IMG_H).ok).toBe(true);
  });

  it('a band with no tilt round-trips through the transform unchanged', () => {
    const q = quadFromBand({ x: 10, y: 20, w: 400, h: 30, skew: 0 });
    const m = squareToQuad(q);
    expect(mapUnitToSource(m, 0, 0).x).toBeCloseTo(10, 9);
    expect(mapUnitToSource(m, 1, 1).y).toBeCloseTo(50, 9);
  });
});

describe('mobile layout guards (320 / 375 / 390)', () => {
  const css = readFileSync('src/index.css', 'utf-8');

  function ruleFor(selector: string): string {
    const i = css.indexOf(selector + ' {');
    expect(i, `missing rule ${selector}`).toBeGreaterThan(-1);
    return css.slice(i, css.indexOf('}', i));
  }

  it('corner handles keep a full touch target', () => {
    const rule = ruleFor('.quad-handle');
    expect(rule).toMatch(/width:\s*var\(--tap\)/);
    expect(rule).toMatch(/height:\s*var\(--tap\)/);
    expect(css).toMatch(/--tap:\s*48px/);
  });

  it('a handle is centred on its corner', () => {
    const rule = ruleFor('.quad-handle');
    expect(rule).toMatch(/margin-left:\s*calc\(var\(--tap\)\s*\/\s*-2\)/);
    expect(rule).toMatch(/margin-top:\s*calc\(var\(--tap\)\s*\/\s*-2\)/);
  });

  it('the scroller reserves room on every side for edge corners', () => {
    // A corner handle at the very edge of the picture overhangs by half a
    // touch target; without padding the scroller would clip it.
    expect(ruleFor('.zoom-layer')).toMatch(/padding:\s*28px/);
  });

  it('the stage pans instead of clipping when the picture is zoomed', () => {
    const stage = ruleFor('.stage');
    expect(stage).toMatch(/overflow:\s*auto/);
    expect(stage).toMatch(/touch-action:\s*pan-x pan-y/);
    expect(stage).toMatch(/max-width:\s*100%/);
  });

  it('dragging a handle or the selection never turns into a pan', () => {
    expect(ruleFor('.quad-handle')).toMatch(/touch-action:\s*none/);
    expect(ruleFor('.quad-shape polygon')).toMatch(/touch-action:\s*none/);
  });

  it('nothing forces the page itself to scroll sideways', () => {
    expect(ruleFor('html,\nbody')).toMatch(/overflow-x:\s*hidden/);
  });
});

/* ------------------------------------------------------------------ *
 * Unchanged-behaviour guards. This sprint changed acquisition geometry
 * only; nothing in the trust model may have moved.
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

describe('safety model unchanged by the quad sprint', () => {
  it('the four cell states are still exactly these', () => {
    expect(Object.keys(CellState).sort()).toEqual(
      ['CONFIRMED', 'EDITED', 'RECOGNIZED', 'UNRESOLVED'].sort(),
    );
  });

  it('only confirmed and edited cells are exportable', () => {
    const base = {
      dateStr: '2026-08-01',
      shiftCode: 'N',
      confidence: 1,
      source: RecognitionSource.OCR,
    };
    expect(isExportable({ ...base, state: CellState.CONFIRMED })).toBe(true);
    expect(isExportable({ ...base, state: CellState.EDITED })).toBe(true);
    expect(isExportable({ ...base, state: CellState.RECOGNIZED })).toBe(false);
    expect(isExportable({ ...base, state: CellState.UNRESOLVED })).toBe(false);
  });

  it('a disagreement is still unresolved regardless of confidence', () => {
    const v = adjudicateCell(
      { text: 'F', confidence: 0.99 },
      { text: 'OFF', confidence: 0.5 },
      KNOWN,
    );
    expect(v.state).toBe(CellState.UNRESOLVED);
    expect(v.shiftCode).toBeNull();
  });

  it('a 99% agreed reading still cannot export by itself', () => {
    const v = adjudicateCell(
      { text: 'N', confidence: 0.99 },
      { text: 'N', confidence: 0.99 },
      KNOWN,
    );
    expect(v.state).toBe(CellState.RECOGNIZED);
    expect(needsAttention(dayOf('2026-08-23', v))).toBe(true);
    expect(generateIcs([dayOf('2026-08-23', v)], DEFS, { dtstamp: 'X' })).not.toContain(
      'VEVENT',
    );
  });

  it('bulk accept still cannot reach a disputed cell', () => {
    const bad = adjudicateCell(
      { text: 'F', confidence: 0.99 },
      { text: 'OFF', confidence: 0.5 },
      KNOWN,
    );
    expect(isBulkAcceptable(dayOf('2026-08-29', bad))).toBe(false);
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
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);

    await mod.terminateOcrWorker();
    expect(terminate).toHaveBeenCalledTimes(1);

    vi.doUnmock('tesseract.js');
    vi.resetModules();
  });
});
