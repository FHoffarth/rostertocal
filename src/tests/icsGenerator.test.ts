import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildUid,
  escapeIcsText,
  foldLine,
  formatYmd,
  generateIcs,
  parseHm,
  parseYmd,
  toIcsLocal,
} from '../lib/icsGenerator';
import { RecognitionSource, type DayShift, type ShiftDef } from '../models/shifts';

const STAMP = '20260823T101500Z';

const DEFS: ShiftDef[] = [
  { code: 'F', label: 'Fruehdienst', start: '06:00', end: '14:00', isOff: false },
  { code: 'N', label: 'Nachtdienst', start: '22:00', end: '06:00', isOff: false },
  { code: 'OFF', label: 'Frei', start: '00:00', end: '00:00', isOff: true },
];

function day(dateStr: string, shiftCode: string | null): DayShift {
  return {
    dateStr,
    shiftCode,
    confidence: 1,
    source: RecognitionSource.USER_CONFIRMED,
    confirmed: true,
  };
}

function gen(days: DayShift[], defs = DEFS, opts = {}) {
  return generateIcs(days, defs, { dtstamp: STAMP, ...opts });
}

function lines(ics: string): string[] {
  return ics.split('\r\n');
}

describe('local calendar arithmetic', () => {
  it('round-trips YMD without touching Date', () => {
    expect(formatYmd(parseYmd('2026-08-23'))).toBe('2026-08-23');
  });

  it('rejects malformed and impossible dates', () => {
    expect(() => parseYmd('2026-8-23')).toThrow();
    expect(() => parseYmd('2026-13-01')).toThrow();
    expect(() => parseYmd('2026-02-30')).toThrow();
  });

  it('crosses month boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-09-01', -1)).toBe('2026-08-31');
  });

  it('crosses year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('handles leap days', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2100-02-28', 1)).toBe('2100-03-01'); // 2100 is not a leap year
    expect(addDays('2000-02-28', 1)).toBe('2000-02-29'); // 2000 is
  });

  it('adds spans longer than a month', () => {
    expect(addDays('2026-01-15', 60)).toBe('2026-03-16');
    expect(addDays('2026-03-16', -60)).toBe('2026-01-15');
  });

  it('parses wall-clock times', () => {
    expect(parseHm('06:00')).toBe(360);
    expect(parseHm(' 22:30 ')).toBe(1350);
    expect(() => parseHm('24:00')).toThrow();
  });

  it('formats ICS local timestamps', () => {
    expect(toIcsLocal('2026-08-23', 360)).toBe('20260823T060000');
  });
});

describe('VCALENDAR envelope', () => {
  it('emits the required header fields', () => {
    const out = lines(gen([day('2026-08-23', 'F')]));
    expect(out[0]).toBe('BEGIN:VCALENDAR');
    expect(out).toContain('VERSION:2.0');
    expect(out).toContain('CALSCALE:GREGORIAN');
    expect(out).toContain('METHOD:PUBLISH');
    expect(out.some((l) => l.startsWith('PRODID:'))).toBe(true);
    expect(out.filter((l) => l === 'END:VCALENDAR')).toHaveLength(1);
  });

  it('uses CRLF line endings and ends with one', () => {
    const ics = gen([day('2026-08-23', 'F')]);
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.includes('\n\n')).toBe(false);
  });

  it('includes a Europe/Berlin VTIMEZONE by default and can omit it', () => {
    expect(gen([day('2026-08-23', 'F')])).toContain('BEGIN:VTIMEZONE');
    expect(gen([day('2026-08-23', 'F')])).toContain('TZID:Europe/Berlin');
    expect(gen([day('2026-08-23', 'F')], DEFS, { includeVtimezone: false })).not.toContain(
      'BEGIN:VTIMEZONE',
    );
  });
});

describe('VEVENT generation', () => {
  it('writes a normal day shift with Europe/Berlin formatting', () => {
    const out = lines(gen([day('2026-08-23', 'F')]));
    expect(out).toContain('DTSTART;TZID=Europe/Berlin:20260823T060000');
    expect(out).toContain('DTEND;TZID=Europe/Berlin:20260823T140000');
    expect(out).toContain('SUMMARY:F Fruehdienst');
    expect(out.some((l) => l.startsWith('DTSTAMP:'))).toBe(true);
  });

  it('rolls an overnight shift onto the next local day', () => {
    const out = lines(gen([day('2026-08-23', 'N')]));
    expect(out).toContain('DTSTART;TZID=Europe/Berlin:20260823T220000');
    expect(out).toContain('DTEND;TZID=Europe/Berlin:20260824T060000');
  });

  it('rolls an overnight shift across a month boundary', () => {
    const out = lines(gen([day('2026-08-31', 'N')]));
    expect(out).toContain('DTSTART;TZID=Europe/Berlin:20260831T220000');
    expect(out).toContain('DTEND;TZID=Europe/Berlin:20260901T060000');
  });

  it('rolls an overnight shift across a year boundary', () => {
    const out = lines(gen([day('2026-12-31', 'N')]));
    expect(out).toContain('DTEND;TZID=Europe/Berlin:20270101T060000');
  });

  it('rolls an overnight shift across a leap day', () => {
    const out = lines(gen([day('2028-02-28', 'N')]));
    expect(out).toContain('DTEND;TZID=Europe/Berlin:20280229T060000');
  });

  it('treats a 24h shift as overnight (end <= start)', () => {
    const defs: ShiftDef[] = [
      { code: 'D24', label: '24h', start: '08:00', end: '08:00', isOff: false },
    ];
    const out = lines(gen([day('2026-08-23', 'D24')], defs));
    expect(out).toContain('DTSTART;TZID=Europe/Berlin:20260823T080000');
    expect(out).toContain('DTEND;TZID=Europe/Berlin:20260824T080000');
  });

  it('excludes off days, unknown codes and unresolved cells', () => {
    const ics = gen([
      day('2026-08-23', 'OFF'),
      day('2026-08-24', null),
      day('2026-08-25', 'ZZZ'),
      day('2026-08-26', 'F'),
    ]);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain('20260826T060000');
  });
});

describe('deterministic UID', () => {
  it('is stable across runs and independent of the clock', () => {
    const a = gen([day('2026-08-23', 'N')]);
    const b = generateIcs([day('2026-08-23', 'N')], DEFS, { dtstamp: '20990101T000000Z' });
    const uid = 'UID:shift-2026-08-23-N-user@rostertocal.local';
    expect(a).toContain(uid);
    expect(b).toContain(uid);
  });

  it('includes date, code and namespace', () => {
    expect(buildUid('2026-08-23', 'N', 'me@rostertocal.local')).toBe(
      'shift-2026-08-23-N-me@rostertocal.local',
    );
  });

  it('differs per day and per code', () => {
    const ics = gen([day('2026-08-23', 'F'), day('2026-08-24', 'N')]);
    const uids = lines(ics).filter((l) => l.startsWith('UID:'));
    expect(new Set(uids).size).toBe(2);
  });
});

describe('RFC text handling', () => {
  it('escapes backslash, comma, semicolon and newline', () => {
    expect(escapeIcsText('a\\b,c;d\ne')).toBe('a\\\\b\\,c\\;d\\ne');
  });

  it('escapes inside a generated SUMMARY', () => {
    const defs: ShiftDef[] = [
      { code: 'F', label: 'Frueh, ab 6; ok', start: '06:00', end: '14:00', isOff: false },
    ];
    const out = lines(gen([day('2026-08-23', 'F')], defs));
    expect(out).toContain('SUMMARY:F Frueh\\, ab 6\\; ok');
  });

  it('folds long lines to 75 octets with a leading space', () => {
    const long = 'SUMMARY:' + 'x'.repeat(200);
    const folded = foldLine(long).split('\r\n');
    expect(folded.length).toBeGreaterThan(1);
    expect(folded[0]).toHaveLength(75);
    for (const cont of folded.slice(1)) expect(cont.startsWith(' ')).toBe(true);
    expect(folded.join('').replace(/^ | (?=x)/g, '')).toBeTruthy();
    expect(folded.map((l, i) => (i ? l.slice(1) : l)).join('')).toBe(long);
  });

  it('never splits a multi-byte character', () => {
    const folded = foldLine('SUMMARY:' + 'ä'.repeat(80)).split('\r\n');
    for (const l of folded) {
      expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
      expect(l).not.toContain('�');
    }
    expect(folded.map((l, i) => (i ? l.slice(1) : l)).join('')).toBe(
      'SUMMARY:' + 'ä'.repeat(80),
    );
  });

  it('leaves short lines untouched', () => {
    expect(foldLine('VERSION:2.0')).toBe('VERSION:2.0');
  });

  it('folds long content inside a generated calendar', () => {
    const defs: ShiftDef[] = [
      { code: 'F', label: 'L'.repeat(120), start: '06:00', end: '14:00', isOff: false },
    ];
    for (const l of lines(gen([day('2026-08-23', 'F')], defs))) {
      expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    }
  });
});

describe('optional alarm', () => {
  it('omits VALARM by default', () => {
    expect(gen([day('2026-08-23', 'F')])).not.toContain('BEGIN:VALARM');
  });

  it('emits VALARM when configured', () => {
    const out = lines(gen([day('2026-08-23', 'F')], DEFS, { alarmMinutesBefore: 45 }));
    expect(out).toContain('BEGIN:VALARM');
    expect(out).toContain('TRIGGER:-PT45M');
    expect(out).toContain('ACTION:DISPLAY');
  });

  it('treats null as no alarm', () => {
    expect(gen([day('2026-08-23', 'F')], DEFS, { alarmMinutesBefore: null })).not.toContain(
      'VALARM',
    );
  });
});
