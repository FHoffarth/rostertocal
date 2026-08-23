import type { DayShift, ShiftDef } from '../models/shifts';

export const TZID = 'Europe/Berlin';
export const PRODID = '-//RosterToCal//MVP 0.1//EN';

/* ------------------------------------------------------------------ *
 * Pure local-calendar arithmetic.
 * Deliberately NOT using the Date parser: new Date('2026-08-23') is
 * parsed as UTC midnight and shifts the day for negative-offset zones.
 * ------------------------------------------------------------------ */

export interface Ymd {
  y: number;
  m: number; // 1..12
  d: number; // 1..31
}

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

export function parseYmd(s: string): Ymd {
  const m = YMD_RE.exec(s);
  if (!m) throw new Error(`Invalid date string: ${s}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) throw new Error(`Invalid month in ${s}`);
  if (d < 1 || d > daysInMonth(y, mo)) throw new Error(`Invalid day in ${s}`);
  return { y, m: mo, d };
}

export function formatYmd(v: Ymd): string {
  return `${pad4(v.y)}-${pad2(v.m)}-${pad2(v.d)}`;
}

/** Add n days (n may be negative) purely in the local calendar. */
export function addDays(s: string, n: number): string {
  const parsed = parseYmd(s);
  let { y, m } = parsed;
  let d = parsed.d + n;
  while (d > daysInMonth(y, m)) {
    d -= daysInMonth(y, m);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  while (d < 1) {
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
    d += daysInMonth(y, m);
  }
  return formatYmd({ y, m, d });
}

/** "HH:MM" -> minutes since local midnight. */
export function parseHm(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Invalid time string: ${s}`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) throw new Error(`Invalid time string: ${s}`);
  return h * 60 + mi;
}

/** "YYYY-MM-DD" + minutes -> "YYYYMMDDTHHMMSS" (local, no Z). */
export function toIcsLocal(dateStr: string, minutes: number): string {
  const { y, m, d } = parseYmd(dateStr);
  const h = Math.floor(minutes / 60);
  const mi = minutes % 60;
  return `${pad4(y)}${pad2(m)}${pad2(d)}T${pad2(h)}${pad2(mi)}00`;
}

/* ------------------------------------------------------------------ *
 * RFC 5545 text handling
 * ------------------------------------------------------------------ */

/** Escape TEXT values: backslash, semicolon, comma, newline. */
export function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

const utf8 = new TextEncoder();

/**
 * Fold a content line to <= 75 octets per RFC 5545 3.1.
 * Folds on octet boundaries but never splits a multi-byte character.
 */
export function foldLine(line: string): string {
  if (utf8.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curOctets = 0;
  // First line budget 75 octets; continuation lines 74 (leading space counts).
  let budget = 75;
  for (const ch of line) {
    const n = utf8.encode(ch).length;
    if (curOctets + n > budget) {
      out.push(cur);
      cur = '';
      curOctets = 0;
      budget = 74;
    }
    cur += ch;
    curOctets += n;
  }
  if (cur) out.push(cur);
  return out.join('\r\n ');
}

/* ------------------------------------------------------------------ *
 * VTIMEZONE - Europe/Berlin
 * Static definition matching the current EU rule (last Sunday of March
 * / October). Correct for dates from 1996 onward.
 * ------------------------------------------------------------------ */

const VTIMEZONE_BERLIN = [
  'BEGIN:VTIMEZONE',
  `TZID:${TZID}`,
  'X-LIC-LOCATION:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

export interface IcsOptions {
  /** Local namespace for deterministic UIDs. */
  userNamespace?: string;
  /** Minutes before start for a VALARM. Omitted when undefined/null. */
  alarmMinutesBefore?: number | null;
  /** Fixed DTSTAMP (UTC "YYYYMMDDTHHMMSSZ"). Injected for deterministic tests. */
  dtstamp?: string;
  /** Include the VTIMEZONE block. Default true. */
  includeVtimezone?: boolean;
}

export const DEFAULT_NAMESPACE = 'user@rostertocal.local';

/** Deterministic UID: no randomness, no clock. */
export function buildUid(dateStr: string, code: string, ns: string): string {
  return `shift-${dateStr}-${code}-${ns}`;
}

function utcStamp(d: Date): string {
  return (
    `${pad4(d.getUTCFullYear())}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

export interface EventInput {
  day: DayShift;
  def: ShiftDef;
}

/**
 * Build one VEVENT body (unfolded lines).
 * Overnight rule: endMinutes <= startMinutes -> end lands on the next
 * local calendar day.
 */
export function buildVevent(
  input: EventInput,
  opts: { userNamespace: string; dtstamp: string; alarmMinutesBefore?: number | null },
): string[] {
  const { day, def } = input;
  const startMin = parseHm(def.start);
  const endMin = parseHm(def.end);
  const endDate = endMin <= startMin ? addDays(day.dateStr, 1) : day.dateStr;

  const summary = def.label ? `${def.code} ${def.label}` : def.code;

  const lines = [
    'BEGIN:VEVENT',
    `UID:${buildUid(day.dateStr, def.code, opts.userNamespace)}`,
    `DTSTAMP:${opts.dtstamp}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `DTSTART;TZID=${TZID}:${toIcsLocal(day.dateStr, startMin)}`,
    `DTEND;TZID=${TZID}:${toIcsLocal(endDate, endMin)}`,
  ];

  const alarm = opts.alarmMinutesBefore;
  if (alarm !== undefined && alarm !== null) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(summary)}`,
      `TRIGGER:-PT${Math.max(0, Math.round(alarm))}M`,
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT');
  return lines;
}

/**
 * Generate a VCALENDAR from days.
 * Off-days, unknown codes and unresolved days produce no event.
 */
export function generateIcs(
  days: DayShift[],
  defs: ShiftDef[],
  opts: IcsOptions = {},
): string {
  const ns = opts.userNamespace ?? DEFAULT_NAMESPACE;
  const dtstamp = opts.dtstamp ?? utcStamp(new Date());
  const byCode = new Map(defs.map((d) => [d.code.toUpperCase(), d]));

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  if (opts.includeVtimezone !== false) lines.push(...VTIMEZONE_BERLIN);

  for (const day of days) {
    if (!day.shiftCode) continue;
    const def = byCode.get(day.shiftCode.toUpperCase());
    if (!def || def.isOff) continue;
    lines.push(
      ...buildVevent(
        { day, def },
        { userNamespace: ns, dtstamp, alarmMinutesBefore: opts.alarmMinutesBefore },
      ),
    );
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
