import { describe, expect, it } from 'vitest';
import {
  extractTableRows,
  findColumns,
  groupIntoLines,
  MIN_HEADER_MATCHES,
  type TableTextItem,
} from '../lib/tableRows';

/**
 * The fixture below is a synthetic replica of the *layout* of a real
 * crew roster (an airline crew-planning PDF). No real personal data is
 * reproduced: the name, staff id and any identifying figures are made
 * up. Only the column geometry and the shapes that break naive parsing
 * are real:
 *
 *   - a duty whose Start is on one day's row and whose End is on the
 *     next day's row
 *   - an activity sequence that wraps onto a second printed line
 *   - two separate entries on one calendar day
 *   - a duty running past the end of the month
 *   - blank cells that must stay blank
 */

const HEADERS = [
  'Day',
  'Pairing',
  'Duty',
  'Start',
  'End',
  'Length sch/act',
  'Rest after',
  'Activity sequence',
];

/** x positions taken from the real document's column layout. */
const X = {
  Day: 30,
  Pairing: 78,
  Duty: 134,
  Start: 186,
  End: 232,
  Length: 276,
  Rest: 372,
  Activity: 440,
};

let uid = 0;
function at(text: string, x: number, y: number): TableTextItem {
  uid += 1;
  // width proportional to the text, as a proportional font would give
  return { text, x0: x, x1: x + text.length * 4.2, y, height: 8 };
}

function headerLine(y: number): TableTextItem[] {
  return [
    at('Day', X.Day, y),
    at('Pairing', X.Pairing, y),
    at('Duty', X.Duty, y),
    at('Start', X.Start, y),
    at('End', X.End, y),
    at('Length', X.Length, y),
    at('sch/act', X.Length + 30, y),
    at('Rest', X.Rest, y),
    at('after', X.Rest + 20, y),
    at('Activity', X.Activity, y),
    at('sequence', X.Activity + 36, y),
  ];
}

/** The body of the fixture roster. */
function body(): TableTextItem[] {
  const rows: TableTextItem[] = [];
  // A duty that opens on one day and closes on the next.
  rows.push(
    ...[
      at('05 Mo', X.Day, 120),
      at('C132', X.Pairing, 120),
      at('Duty', X.Duty, 120),
      at('20:30', X.Start, 120),
      at('AA132 SIN 2145 HEL 0615 35L In-flight', X.Activity, 120),
    ],
    // wrapped continuation of the activity sequence
    ...[at('rest', X.Activity, 129)],
    ...[
      at('06 Tu', X.Day, 140),
      at('C132', X.Pairing, 140),
      at('Duty', X.Duty, 140),
      at('06:45', X.End, 140),
      at('15:15/15:15', X.Length, 140),
      at('42:00', X.Rest, 140),
    ],
    // standby: a full-day entry with both times present
    ...[
      at('09 Fr', X.Day, 160),
      at('S', X.Pairing, 160),
      at('00:00', X.Start, 160),
      at('23:59', X.End, 160),
      at('23:59/23:59', X.Length, 160),
      at('FT', X.Activity, 160),
    ],
    // two separate entries on the same calendar day
    ...[
      at('21 We', X.Day, 180),
      at('C132', X.Pairing, 180),
      at('Duty', X.Duty, 180),
      at('08:30', X.Start, 180),
      at('16:30', X.End, 180),
      at('PTC 0830-1630 FFA', X.Activity, 180),
    ],
    ...[
      at('21 We', X.Day, 192),
      at('C132', X.Pairing, 192),
      at('Duty', X.Duty, 192),
      at('23:25', X.Start, 192),
      at('AA131 HEL 0025 SIN 1835 (DH)', X.Activity, 192),
    ],
    // the month ends mid-duty and the table keeps going
    ...[
      at('31 Mo', X.Day, 210),
      at('C132', X.Pairing, 210),
      at('Duty', X.Duty, 210),
      at('06:30', X.End, 210),
    ],
    ...[
      at('01 Tu', X.Day, 222),
      at('C132', X.Pairing, 222),
      at('Duty', X.Duty, 222),
      at('23:30', X.Start, 222),
    ],
  );
  return rows;
}

const OPTIONS = { headerLabels: HEADERS, rowAnchorColumn: 'Day' };

function extract(extra: TableTextItem[] = []) {
  return extractTableRows([...headerLine(100), ...body(), ...extra], OPTIONS);
}

describe('lines', () => {
  it('groups items on the same baseline into one line', () => {
    const lines = groupIntoLines(headerLine(100));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(11);
  });

  it('separates lines that are a full line-height apart', () => {
    const lines = groupIntoLines([at('a', 10, 100), at('b', 10, 120)]);
    expect(lines).toHaveLength(2);
  });

  it('orders each line left to right', () => {
    const lines = groupIntoLines([at('b', 200, 100), at('a', 10, 100)]);
    expect(lines[0].map((i) => i.text)).toEqual(['a', 'b']);
  });
});

describe('the printed header owns the columns', () => {
  it('finds every header label, including multi-word ones', () => {
    const found = findColumns(groupIntoLines(headerLine(100)), HEADERS);
    expect(found).not.toBeNull();
    expect(found!.columns.map((c) => c.name)).toEqual([
      'Day',
      'Pairing',
      'Duty',
      'Start',
      'End',
      'Length sch/act',
      'Rest after',
      'Activity sequence',
    ]);
  });

  it('produces contiguous, non-overlapping column ranges', () => {
    const { columns } = findColumns(groupIntoLines(headerLine(100)), HEADERS)!;
    for (let i = 1; i < columns.length; i++) {
      expect(columns[i].x0).toBeCloseTo(columns[i - 1].x1, 6);
      expect(columns[i].x1).toBeGreaterThan(columns[i].x0);
    }
  });

  it('fails closed when no header line is present', () => {
    const r = extractTableRows(body(), OPTIONS);
    expect(r.ok).toBe(false);
    expect(r.rows).toEqual([]);
    expect(r.diagnostic).toMatch(/no header line matched/);
    expect(MIN_HEADER_MATCHES).toBeGreaterThan(2);
  });

  it('fails closed when the row anchor column is missing', () => {
    const r = extractTableRows([...headerLine(100), ...body()], {
      headerLabels: HEADERS,
      rowAnchorColumn: 'Report',
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostic).toMatch(/row anchor column/);
  });
});

describe('a partial header map fails closed', () => {
  /**
   * Found on a real low-resolution roster render: the recogniser read
   * only 4 of the 8 printed headers, and because boundaries are
   * midpoints between the headers that *were* found, the missing
   * columns' values were served up inside their neighbours - a Length
   * value appeared inside the End cell, a Start time inside Duty. Wrong
   * evidence, presented confidently. It must refuse instead.
   */
  function partialHeaderLine(y: number): TableTextItem[] {
    return [
      at('Day', X.Day, y),
      at('Duty', X.Duty, y),
      at('End', X.End, y),
      at('Activity', X.Activity, y),
      at('sequence', X.Activity + 36, y),
    ];
  }

  it('refuses when an expected column was not located', () => {
    const r = extractTableRows([...partialHeaderLine(100), ...body()], OPTIONS);
    expect(r.ok).toBe(false);
    expect(r.rows).toEqual([]);
    expect(r.missingHeaders.sort()).toEqual(
      ['Length sch/act', 'Pairing', 'Rest after', 'Start'].sort(),
    );
    expect(r.diagnostic).toMatch(/would absorb their values/);
  });

  it('does not let a surviving column swallow a missing one', () => {
    const r = extractTableRows([...partialHeaderLine(100), ...body()], OPTIONS);
    // With End detected but "Length sch/act" not, the End cell would
    // otherwise have contained both values.
    expect(r.rows).toHaveLength(0);
  });

  it('reports every expected header as missing when no header is found', () => {
    const r = extractTableRows(body(), OPTIONS);
    expect(r.ok).toBe(false);
    expect(r.missingHeaders).toEqual(HEADERS);
  });

  it('a complete header reports nothing missing', () => {
    const r = extract();
    expect(r.ok).toBe(true);
    expect(r.missingHeaders).toEqual([]);
  });
});

describe('rows carry what is printed and nothing more', () => {
  it('reads a duty that opens on one day', () => {
    const row = extract().rows.find((r) => r.cells.Day === '05 Mo')!;
    expect(row.cells.Pairing).toBe('C132');
    expect(row.cells.Start).toBe('20:30');
    // The duty has not ended on this row, and that stays unknown.
    expect(row.cells.End).toBe('');
    expect(row.cells['Rest after']).toBe('');
  });

  it('reads the end of that duty on the following day, unlinked', () => {
    const row = extract().rows.find((r) => r.cells.Day === '06 Tu')!;
    expect(row.cells.End).toBe('06:45');
    expect(row.cells.Start).toBe('');
    // Extraction does not join the two rows into one duty. That is
    // interpretation, and it belongs to a later stage.
    expect(row.cells['Length sch/act']).toBe('15:15/15:15');
  });

  it('folds a wrapped activity sequence into the row that opened it', () => {
    const rows = extract().rows;
    const row = rows.find((r) => r.cells.Day === '05 Mo')!;
    expect(row.cells['Activity sequence']).toBe(
      'AA132 SIN 2145 HEL 0615 35L In-flight rest',
    );
    expect(row.lineCount).toBe(2);
    // the continuation did not become a row of its own
    expect(rows.filter((r) => r.cells.Day === '').length).toBe(0);
  });

  it('keeps two entries on the same calendar day as two rows', () => {
    const same = extract().rows.filter((r) => r.cells.Day === '21 We');
    expect(same).toHaveLength(2);
    expect(same[0].cells['Activity sequence']).toBe('PTC 0830-1630 FFA');
    expect(same[1].cells['Activity sequence']).toBe('AA131 HEL 0025 SIN 1835 (DH)');
  });

  it('keeps rows that run past the end of the month', () => {
    const days = extract().rows.map((r) => r.cells.Day);
    expect(days).toContain('31 Mo');
    expect(days).toContain('01 Tu');
    // no attempt is made to decide which month "01 Tu" belongs to
    expect(days.indexOf('01 Tu')).toBeGreaterThan(days.indexOf('31 Mo'));
  });

  it('leaves blank cells blank rather than filling them in', () => {
    for (const row of extract().rows) {
      for (const value of Object.values(row.cells)) {
        expect(typeof value).toBe('string');
      }
    }
    const standby = extract().rows.find((r) => r.cells.Day === '09 Fr')!;
    expect(standby.cells.Duty).toBe('');
    expect(standby.cells.Pairing).toBe('S');
  });

  it('does not interpret any value it extracts', () => {
    const row = extract().rows.find((r) => r.cells.Day === '09 Fr')!;
    // times stay text, not parsed into minutes or a timezone
    expect(row.cells.Start).toBe('00:00');
    expect(row.cells.End).toBe('23:59');
    expect(row).not.toHaveProperty('startMinutes');
    expect(row).not.toHaveProperty('timezone');
  });
});

describe('text under no column is reported, never reassigned', () => {
  it('collects a stray token far outside the table', () => {
    const stray = at('page 1 of 2', 900, 300);
    const r = extract([stray]);
    expect(r.unassigned.map((i) => i.text)).toContain('page 1 of 2');
    for (const row of r.rows) {
      expect(Object.values(row.cells).join(' ')).not.toContain('page 1 of 2');
    }
  });

  it('does not attach a pre-header line to any row', () => {
    const banner = at('Personal Roster', X.Day, 60);
    const r = extract([banner]);
    expect(r.rows.every((row) => !Object.values(row.cells).join(' ').includes('Personal'))).toBe(
      true,
    );
  });

  it('assigns a token to the column its centre falls in', () => {
    const { columns } = findColumns(groupIntoLines(headerLine(100)), HEADERS)!;
    const end = columns.find((c) => c.name === 'End')!;
    const boundary = at('X', end.x1 + 1, 400);
    const r = extract([at('99 Zz', X.Day, 400), boundary]);
    const row = r.rows.find((x) => x.cells.Day === '99 Zz')!;
    expect(row.cells.End).toBe('');
    expect(row.cells['Length sch/act']).toBe('X');
  });
});
