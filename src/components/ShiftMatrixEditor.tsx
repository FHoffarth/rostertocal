import { CONFIDENCE_THRESHOLD, isUncertain, type DayShift, type ShiftDef } from '../models/shifts';
import { parseYmd } from '../lib/icsGenerator';

interface Props {
  days: DayShift[];
  defs: ShiftDef[];
  warnings: string[];
  metricsLine?: string | null;
  onOpenDay: (dateStr: string) => void;
  onConfirmAll: () => void;
  onContinue: () => void;
  onBack: () => void;
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/** Weekday from a Y-M-D triple, without constructing a parsed Date. */
function weekday(dateStr: string): number {
  const { y, m, d } = parseYmd(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isOffCode(code: string | null, defs: ShiftDef[]): boolean {
  if (!code) return false;
  return defs.find((d) => d.code.toUpperCase() === code.toUpperCase())?.isOff ?? false;
}

/** Cells that must not be exported without the user looking at them. */
export function unresolvedDays(days: DayShift[]): DayShift[] {
  return days.filter((d) => isUncertain(d));
}

/**
 * CONFIRM. The whole month at a glance, every cell one tap from correct.
 *
 * Confidence is displayed, never trusted: a cell below the threshold is
 * marked and counted, and the export step refuses to move until each
 * one has been touched.
 */
export function ShiftMatrixEditor({
  days,
  defs,
  warnings,
  metricsLine,
  onOpenDay,
  onConfirmAll,
  onContinue,
  onBack,
}: Props) {
  const open = unresolvedDays(days);

  return (
    <section>
      <div className="card">
        <h2>Check what was read</h2>
        <p className="muted">
          Tap any day to change it. Orange means the recogniser was unsure, red
          dashed means nothing usable was read.
        </p>
      </div>

      {warnings.map((w) => (
        <div className="banner warn" key={w}>
          {w}
        </div>
      ))}

      {open.length > 0 ? (
        <div className="banner warn">
          {open.length} day{open.length === 1 ? '' : 's'} need
          {open.length === 1 ? 's' : ''} your confirmation.
        </div>
      ) : (
        <div className="banner ok">Nothing needs your attention. Check anything that looks wrong.</div>
      )}

      <div className="matrix">
        {days.map((d) => {
          const wd = weekday(d.dateStr);
          const off = isOffCode(d.shiftCode, defs);
          const cls = [
            'cell',
            d.confirmed ? 'confirmed' : '',
            !d.confirmed && d.shiftCode === null ? 'unknown' : '',
            !d.confirmed && d.shiftCode !== null && d.confidence < CONFIDENCE_THRESHOLD
              ? 'uncertain'
              : '',
            off ? 'off' : '',
            wd === 0 || wd === 6 ? 'weekend' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={d.dateStr}
              className={cls}
              onClick={() => onOpenDay(d.dateStr)}
              aria-label={`${d.dateStr}, ${d.shiftCode ?? 'unresolved'}`}
            >
              <span className="date">
                {WEEKDAYS[wd]} {Number(d.dateStr.slice(8))}
              </span>
              <span className={`code ${d.shiftCode ? '' : 'empty'}`}>
                {d.shiftCode ?? '—'}
              </span>
              <span className="state">
                {d.confirmed
                  ? '✓'
                  : d.shiftCode === null
                    ? 'unread'
                    : `${Math.round(d.confidence * 100)}%`}
              </span>
            </button>
          );
        })}
      </div>

      <div className="legend">
        <span>
          <i style={{ background: 'var(--ok)' }} />
          confirmed
        </span>
        <span>
          <i style={{ background: 'var(--warn)' }} />
          unsure (&lt; {Math.round(CONFIDENCE_THRESHOLD * 100)}%)
        </span>
        <span>
          <i style={{ background: 'var(--danger)' }} />
          nothing read
        </span>
      </div>

      {metricsLine && (
        <p className="metrics" style={{ marginTop: 10 }}>
          {metricsLine}
        </p>
      )}

      <div className="sticky-cta">
        <button className="primary" onClick={onContinue}>
          Continue to export
        </button>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="ghost grow" onClick={onConfirmAll} disabled={open.length === 0}>
            Accept all {open.length} as read
          </button>
          <button className="ghost" onClick={onBack}>
            Re-align
          </button>
        </div>
      </div>
    </section>
  );
}
