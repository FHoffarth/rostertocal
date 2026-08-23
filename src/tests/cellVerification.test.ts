import { describe, expect, it } from 'vitest';
import { adjudicateCell } from '../lib/recognitionPipeline';
import { buildDayColumns, cellRects, mapTokensToDays } from '../lib/gridAlignment';
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
import type { OcrToken } from '../models/roster';

/**
 * Regression cover for the failure that motivated all of this: on the
 * sample photo, day 29 truly read OFF, the row pass reported "F" at
 * 99 % because two glyphs had merged with the printed rules and been
 * filtered away, and that F sailed into the calendar.
 */

const KNOWN = ['F', 'F1', 'S', 'N', 'OFF', 'VAC', '12', 'E', 'L'];

const DEFS: ShiftDef[] = [
  { code: 'F', label: 'Frueh', start: '06:00', end: '14:00', isOff: false },
  { code: 'N', label: 'Nacht', start: '22:00', end: '06:00', isOff: false },
  { code: 'E', label: 'Early', start: '05:30', end: '13:30', isOff: false },
  { code: 'L', label: 'Late', start: '13:00', end: '21:00', isOff: false },
  { code: '12', label: 'Zwoelf', start: '08:00', end: '20:00', isOff: false },
  { code: 'VAC', label: 'Urlaub', start: '00:00', end: '00:00', isOff: true },
  { code: 'OFF', label: 'Frei', start: '00:00', end: '00:00', isOff: true },
];

function pass(text: string, confidence: number) {
  return { text, confidence };
}

function dayFrom(dateStr: string, verdict: ReturnType<typeof adjudicateCell>): DayShift {
  return {
    dateStr,
    shiftCode: verdict.shiftCode,
    confidence: verdict.confidence,
    source: RecognitionSource.OCR,
    state: verdict.state,
    evidence: verdict.evidence,
  };
}

describe('the day-29 failure cannot happen again', () => {
  it('does not let a 99 % row reading of F override a cell reading of OFF', () => {
    const v = adjudicateCell(pass('F', 0.99), pass('OFF', 0.57), KNOWN);
    expect(v.state).toBe(CellState.UNRESOLVED);
    expect(v.shiftCode).toBeNull();
    expect(v.evidence.rowCode).toBe('F');
    expect(v.evidence.cellCode).toBe('OFF');
    expect(v.evidence.agreed).toBe(false);
  });

  it('does not resolve a disagreement by preferring the higher confidence', () => {
    // Whichever side is confident, the answer is the same: ask the user.
    const rowSure = adjudicateCell(pass('F', 0.99), pass('OFF', 0.20), KNOWN);
    const cellSure = adjudicateCell(pass('F', 0.20), pass('OFF', 0.99), KNOWN);
    expect(rowSure.state).toBe(CellState.UNRESOLVED);
    expect(cellSure.state).toBe(CellState.UNRESOLVED);
    expect(rowSure.shiftCode).toBeNull();
    expect(cellSure.shiftCode).toBeNull();
  });

  it('an unresolved cell exports nothing even though a code was read', () => {
    const v = adjudicateCell(pass('F', 0.99), pass('OFF', 0.57), KNOWN);
    const ics = generateIcs([dayFrom('2026-08-29', v)], DEFS, { dtstamp: 'X' });
    expect(ics).not.toContain('BEGIN:VEVENT');
  });
});

describe('confidence never implies trust', () => {
  it('a perfectly agreed 100 % reading is still only RECOGNIZED', () => {
    const v = adjudicateCell(pass('N', 1), pass('N', 1), KNOWN);
    expect(v.state).toBe(CellState.RECOGNIZED);
    expect(isExportable(dayFrom('2026-08-01', v))).toBe(false);
    expect(needsAttention(dayFrom('2026-08-01', v))).toBe(true);
  });

  it('a 99 %-confident agreed cell produces no calendar event on its own', () => {
    const v = adjudicateCell(pass('N', 0.99), pass('N', 0.99), KNOWN);
    const ics = generateIcs([dayFrom('2026-08-23', v)], DEFS, { dtstamp: 'X' });
    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('carries the weaker of the two confidences, for display only', () => {
    const v = adjudicateCell(pass('N', 0.95), pass('N', 0.42), KNOWN);
    expect(v.confidence).toBeCloseTo(0.42, 6);
    expect(v.state).toBe(CellState.RECOGNIZED);
  });
});

describe('agreement, disagreement and silence', () => {
  it('agreeing exact readings are recognised', () => {
    const v = adjudicateCell(pass('OFF', 0.9), pass('OFF', 0.6), KNOWN);
    expect(v.state).toBe(CellState.RECOGNIZED);
    expect(v.shiftCode).toBe('OFF');
    expect(v.evidence.agreed).toBe(true);
  });

  it('one silent pass is a disagreement, not a free pass', () => {
    const rowOnly = adjudicateCell(pass('OFF', 0.9), pass('', 0), KNOWN);
    const cellOnly = adjudicateCell(pass('', 0), pass('OFF', 0.9), KNOWN);
    expect(rowOnly.state).toBe(CellState.UNRESOLVED);
    expect(cellOnly.state).toBe(CellState.UNRESOLVED);
  });

  it('two silent passes are unresolved, never an assumed blank shift', () => {
    const v = adjudicateCell(pass('', 0), pass('', 0), KNOWN);
    expect(v.state).toBe(CellState.UNRESOLVED);
    expect(v.shiftCode).toBeNull();
    expect(v.evidence.reason).toMatch(/Neither pass/);
  });

  it('records both readings so the user can judge', () => {
    const v = adjudicateCell(pass('F', 0.99), pass('OFF', 0.57), KNOWN);
    expect(v.evidence.rowText).toBe('F');
    expect(v.evidence.cellText).toBe('OFF');
    expect(v.evidence.reason).toMatch(/Row pass read "F".*cell pass read "OFF"/);
  });

  it('agreement reached only by repairing a glyph stays unresolved', () => {
    // "OF" is a clipped OFF; both passes agree, but on a guess.
    const v = adjudicateCell(pass('OF', 0.9), pass('OF', 0.9), KNOWN);
    expect(v.evidence.rowCode).toBe('OFF');
    expect(v.evidence.agreed).toBe(true);
    expect(v.evidence.repaired).toBe(true);
    expect(v.state).toBe(CellState.UNRESOLVED);
    expect(v.shiftCode).toBeNull();
  });
});

describe('multi-character codes survive the boundary', () => {
  const wide = ['OFF', 'VAC', '12'];

  it.each(wide)('%s read cleanly by both passes is recognised', (code) => {
    const v = adjudicateCell(pass(code, 0.9), pass(code, 0.8), KNOWN);
    expect(v.state).toBe(CellState.RECOGNIZED);
    expect(v.shiftCode).toBe(code);
  });

  it.each(wide)('%s clipped to its first glyph never becomes that glyph', (code) => {
    // This is the shape of the original bug: outer glyphs lost, one left.
    const clipped = code[0];
    const v = adjudicateCell(pass(clipped, 0.99), pass(code, 0.6), KNOWN);
    expect(v.state).toBe(CellState.UNRESOLVED);
    expect(v.shiftCode).toBeNull();
  });

  it.each(['N', 'E', 'L'])(
    'single-letter code %s is not silently widened by a neighbour glyph',
    (code) => {
      // Row pass caught the neighbour's ink too; cell pass saw the truth.
      const v = adjudicateCell(pass(code + 'F', 0.95), pass(code, 0.9), KNOWN);
      expect(v.state).toBe(CellState.UNRESOLVED);
      expect(v.shiftCode).toBeNull();
    },
  );

  it('does not confuse the code 12 with a day number', () => {
    const v = adjudicateCell(pass('12', 0.9), pass('12', 0.9), KNOWN);
    expect(v.shiftCode).toBe('12');
  });

  it('E and L are not quietly swapped for lookalikes', () => {
    // "F" is a plausible misread of "E"; the passes must agree exactly.
    expect(adjudicateCell(pass('F', 0.9), pass('E', 0.9), KNOWN).state).toBe(
      CellState.UNRESOLVED,
    );
    expect(adjudicateCell(pass('1', 0.9), pass('L', 0.9), KNOWN).state).toBe(
      CellState.UNRESOLVED,
    );
  });
});

describe('cells cannot steal a neighbour glyph', () => {
  // Columns are normalised along the rectified row: 0 = start, 1 = end.
  const anchors = Array.from({ length: 10 }, (_, i) => ({
    day: i + 1,
    center: 0.1 + 0.06 * i,
  }));
  const { columns } = buildDayColumns(anchors, 10, 1);
  const STRIP_W = 1000;
  const STRIP_H = 50;

  it('a cell crop never reaches past its own column', () => {
    const rects = cellRects(columns, STRIP_W, STRIP_H);
    rects.forEach((r, i) => {
      expect(r.x).toBeGreaterThanOrEqual(columns[i].x0 * STRIP_W - 1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(columns[i].x1 * STRIP_W + 1e-9);
    });
    // and no two crops overlap
    for (let i = 1; i < rects.length; i++) {
      expect(rects[i].x).toBeGreaterThanOrEqual(rects[i - 1].x + rects[i - 1].w - 1e-9);
    }
  });

  it('a wide OFF stays inside its own day and does not bleed', () => {
    const col = columns[4]; // day 5
    const width = col.x1 - col.x0;
    // O, F, F spread across almost the whole cell
    const glyphs: OcrToken[] = ['O', 'F', 'F'].map((text, i) => ({
      text,
      confidence: 0.95,
      x0: col.x0 + width * (0.08 + i * 0.28),
      x1: col.x0 + width * (0.08 + i * 0.28 + 0.24),
    }));
    const { cells, unmapped } = mapTokensToDays(columns, glyphs);
    expect(cells.find((c) => c.day === 5)!.text).toBe('OFF');
    expect(cells.find((c) => c.day === 4)!.text).toBe('');
    expect(cells.find((c) => c.day === 6)!.text).toBe('');
    expect(unmapped).toEqual([]);
  });

  it('a glyph centred past the boundary belongs to the next day, not both', () => {
    const boundary = columns[4].x1;
    const token: OcrToken = {
      text: 'N',
      confidence: 0.9,
      // normalised units: a column is about 0.06 wide
      x0: boundary - 0.002,
      x1: boundary + 0.018,
    };
    const { cells } = mapTokensToDays(columns, [token]);
    expect(cells.find((c) => c.day === 5)!.text).toBe('');
    expect(cells.find((c) => c.day === 6)!.text).toBe('N');
  });
});

describe('the export gate', () => {
  const recognized = dayFrom('2026-08-01', adjudicateCell(pass('N', 0.99), pass('N', 0.99), KNOWN));
  const unresolved = dayFrom('2026-08-02', adjudicateCell(pass('F', 0.99), pass('OFF', 0.5), KNOWN));

  it('blocks a recognised but unconfirmed cell', () => {
    expect(isExportable(recognized)).toBe(false);
    expect(generateIcs([recognized], DEFS, { dtstamp: 'X' })).not.toContain('VEVENT');
  });

  it('blocks an unresolved cell', () => {
    expect(isExportable(unresolved)).toBe(false);
    expect(generateIcs([unresolved], DEFS, { dtstamp: 'X' })).not.toContain('VEVENT');
  });

  it('exports a cell the user confirmed', () => {
    const confirmed = { ...recognized, state: CellState.CONFIRMED };
    const ics = generateIcs([confirmed], DEFS, { dtstamp: 'X' });
    expect(ics).toContain('DTSTART;TZID=Europe/Berlin:20260801T220000');
    expect(ics).toContain('DTEND;TZID=Europe/Berlin:20260802T060000');
  });

  it('exports the edited value, not the recognised one', () => {
    const edited: DayShift = {
      ...unresolved,
      shiftCode: 'F',
      state: CellState.EDITED,
      source: RecognitionSource.USER_CONFIRMED,
    };
    const ics = generateIcs([edited], DEFS, { dtstamp: 'X' });
    expect(ics).toContain('SUMMARY:F Frueh');
    expect(ics).toContain('DTSTART;TZID=Europe/Berlin:20260802T060000');
    expect(ics).not.toContain('SUMMARY:OFF');
  });

  it('an edited blank day exports nothing but no longer blocks', () => {
    const blanked: DayShift = {
      ...unresolved,
      shiftCode: null,
      state: CellState.EDITED,
    };
    expect(needsAttention(blanked)).toBe(false);
    expect(generateIcs([blanked], DEFS, { dtstamp: 'X' })).not.toContain('VEVENT');
  });

  it('one unresolved cell keeps the whole month from exporting', () => {
    const confirmed = { ...recognized, state: CellState.CONFIRMED };
    const month = [confirmed, unresolved];
    expect(month.some(needsAttention)).toBe(true);
    // The gate is a UI decision, but the engine still drops the bad cell.
    const ics = generateIcs(month, DEFS, { dtstamp: 'X' });
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });
});

describe('bulk accept', () => {
  it('covers recognised cells', () => {
    const v = adjudicateCell(pass('N', 0.9), pass('N', 0.9), KNOWN);
    expect(isBulkAcceptable(dayFrom('2026-08-01', v))).toBe(true);
  });

  it('cannot sweep up a disputed cell', () => {
    const v = adjudicateCell(pass('F', 0.99), pass('OFF', 0.5), KNOWN);
    expect(isBulkAcceptable(dayFrom('2026-08-29', v))).toBe(false);
  });

  it('cannot sweep up a cell nothing was read in', () => {
    const v = adjudicateCell(pass('', 0), pass('', 0), KNOWN);
    expect(isBulkAcceptable(dayFrom('2026-08-30', v))).toBe(false);
  });
});

describe('overnight and boundary behaviour is unchanged by the gate', () => {
  function confirmed(dateStr: string, code: string): DayShift {
    return {
      dateStr,
      shiftCode: code,
      confidence: 1,
      source: RecognitionSource.USER_CONFIRMED,
      state: CellState.CONFIRMED,
    };
  }

  it('overnight still rolls to the next local day', () => {
    const ics = generateIcs([confirmed('2026-08-23', 'N')], DEFS, { dtstamp: 'X' });
    expect(ics).toContain('DTSTART;TZID=Europe/Berlin:20260823T220000');
    expect(ics).toContain('DTEND;TZID=Europe/Berlin:20260824T060000');
  });

  it('overnight still crosses a month boundary', () => {
    const ics = generateIcs([confirmed('2026-08-31', 'N')], DEFS, { dtstamp: 'X' });
    expect(ics).toContain('DTEND;TZID=Europe/Berlin:20260901T060000');
  });

  it('overnight still crosses a year boundary', () => {
    const ics = generateIcs([confirmed('2026-12-31', 'N')], DEFS, { dtstamp: 'X' });
    expect(ics).toContain('DTEND;TZID=Europe/Berlin:20270101T060000');
  });

  it('an off code stays out even when confirmed', () => {
    const ics = generateIcs([confirmed('2026-08-23', 'VAC')], DEFS, { dtstamp: 'X' });
    expect(ics).not.toContain('BEGIN:VEVENT');
  });
});
