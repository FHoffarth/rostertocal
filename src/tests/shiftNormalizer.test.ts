import { describe, expect, it } from 'vitest';
import {
  cleanToken,
  LENGTH_REPAIR_PENALTY,
  normalizeShiftToken,
  parseDayToken,
  REPAIR_PENALTY,
} from '../lib/shiftNormalizer';

const KNOWN = ['F', 'F1', 'S', 'N', 'OFF'];

describe('cleanToken', () => {
  it('uppercases and strips surrounding whitespace', () => {
    expect(cleanToken(' n ')).toBe('N');
    expect(cleanToken('f1')).toBe('F1');
  });

  it('strips OCR punctuation noise', () => {
    expect(cleanToken('|F1.')).toBe('F1');
    expect(cleanToken('"S"')).toBe('S');
  });

  it('collapses internal and non-breaking whitespace', () => {
    expect(cleanToken('F 1')).toBe('F1');
    expect(cleanToken('F 1')).toBe('F1');
  });
});

describe('normalizeShiftToken - exact matches', () => {
  it('matches a known code', () => {
    const r = normalizeShiftToken('N', KNOWN, 0.93);
    expect(r).toMatchObject({ code: 'N', confidence: 0.93, repaired: false });
  });

  it('matches after whitespace normalisation', () => {
    expect(normalizeShiftToken(' n ', KNOWN, 0.9).code).toBe('N');
  });

  it('matches a two-character code', () => {
    expect(normalizeShiftToken('F1', KNOWN, 0.88).code).toBe('F1');
  });

  it('never raises the incoming confidence', () => {
    expect(normalizeShiftToken('F', KNOWN, 0.31).confidence).toBe(0.31);
  });
});

describe('normalizeShiftToken - off days', () => {
  it('recognises spelled-out free days', () => {
    for (const t of ['OFF', 'frei', 'Free', 'x']) {
      expect(normalizeShiftToken(t, KNOWN, 0.9).code).toBe('OFF');
    }
  });
});

describe('normalizeShiftToken - OCR confusion repair', () => {
  it('repairs digit/letter confusions into a known code', () => {
    const r = normalizeShiftToken('FI', KNOWN, 0.9); // capital i read for 1
    expect(r.code).toBe('F1');
    expect(r.repaired).toBe(true);
  });

  it('repairs 5 read for S', () => {
    const r = normalizeShiftToken('5', KNOWN, 0.8);
    expect(r.code).toBe('S');
    expect(r.repaired).toBe(true);
  });

  it('penalises repaired matches so they surface as uncertain', () => {
    const r = normalizeShiftToken('Fl', KNOWN, 0.9);
    expect(r.code).toBe('F1');
    expect(r.confidence).toBeCloseTo(0.9 - REPAIR_PENALTY, 6);
    expect(r.confidence).toBeLessThan(0.8);
  });

  it('clamps a penalised confidence at zero', () => {
    expect(normalizeShiftToken('Fl', KNOWN, 0.1).confidence).toBe(0);
  });
});

describe('normalizeShiftToken - clipped glyphs', () => {
  it('matches a token missing one character, heavily penalised', () => {
    const r = normalizeShiftToken('OF', KNOWN, 0.95);
    expect(r.code).toBe('OFF');
    expect(r.repaired).toBe(true);
    expect(r.confidence).toBeCloseTo(0.95 - LENGTH_REPAIR_PENALTY, 6);
    expect(r.confidence).toBeLessThan(0.8);
  });

  it('matches a token with one extra character', () => {
    expect(normalizeShiftToken('OFFF', KNOWN, 0.9).code).toBe('OFF');
  });

  it('refuses when one edit reaches two different codes', () => {
    // "X1" is one edit from both F1 and S1 - no honest winner.
    expect(normalizeShiftToken('1', ['F1', 'S1'], 0.9).code).toBeNull();
  });

  it('needs more than one edit to stay unknown', () => {
    expect(normalizeShiftToken('O', KNOWN, 0.9).code).toBeNull();
  });
});

describe('normalizeShiftToken - unknown stays unknown', () => {
  it('does not invent a code for an unrecognised token', () => {
    const r = normalizeShiftToken('QW', KNOWN, 0.99);
    expect(r.code).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it('keeps the cleaned text for the correction UI', () => {
    expect(normalizeShiftToken(' qw. ', KNOWN, 0.99).cleaned).toBe('QW');
  });

  it('treats an empty or punctuation-only cell as unresolved, not as off', () => {
    for (const t of ['', '   ', '...', '|']) {
      const r = normalizeShiftToken(t, KNOWN, 0.9);
      expect(r.code).toBeNull();
      expect(r.confidence).toBe(0);
    }
  });

  it('does not match a code the user has not defined', () => {
    expect(normalizeShiftToken('N', ['F', 'S'], 0.9).code).toBeNull();
  });

  it('shrinks the search space as memory grows', () => {
    expect(normalizeShiftToken('ZD', KNOWN, 0.9).code).toBeNull();
    expect(normalizeShiftToken('ZD', [...KNOWN, 'ZD'], 0.9).code).toBe('ZD');
  });
});

describe('parseDayToken', () => {
  it('reads plain and zero-padded day numbers', () => {
    expect(parseDayToken('1')).toBe(1);
    expect(parseDayToken('01')).toBe(1);
    expect(parseDayToken('31')).toBe(31);
  });

  it('reads a day out of a weekday-prefixed header cell', () => {
    expect(parseDayToken('Mo 12')).toBe(12);
    expect(parseDayToken('12.')).toBe(12);
  });

  it('rejects impossible and absent day numbers', () => {
    expect(parseDayToken('0')).toBeNull();
    expect(parseDayToken('32')).toBeNull();
    expect(parseDayToken('Mo')).toBeNull();
    expect(parseDayToken('')).toBeNull();
  });
});
