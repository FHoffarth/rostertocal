import {
  CellState,
  isBulkAcceptable,
  isExportable,
  needsAttention,
  type DayShift,
  type ShiftDef,
} from '../models/shifts';
import { parseYmd } from '../lib/icsGenerator';

interface Props {
  days: DayShift[];
  defs: ShiftDef[];
  warnings: string[];
  metricsLine?: string | null;
  onOpenDay: (dateStr: string) => void;
  onAcceptRecognized: () => void;
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

/** Every cell a human has not yet settled. All of them block export. */
export function openDays(days: DayShift[]): DayShift[] {
  return days.filter(needsAttention);
}

/** Cells the machine could not settle - these need individual attention. */
export function disputedDays(days: DayShift[]): DayShift[] {
  return days.filter((d) => d.state === CellState.UNRESOLVED);
}

/** Cells a single bulk action may accept. */
export function acceptableDays(days: DayShift[]): DayShift[] {
  return days.filter(isBulkAcceptable);
}

const STATE_LABEL: Record<CellState, string> = {
  [CellState.RECOGNIZED]: 'to check',
  [CellState.UNRESOLVED]: 'unclear',
  [CellState.CONFIRMED]: 'confirmed',
  [CellState.EDITED]: 'edited',
};

/**
 * CONFIRM. The whole month at a glance, every cell one tap from correct.
 *
 * Nothing here is exportable until a human says so. A cell the two
 * recognition passes disagreed on is marked "unclear" and cannot be
 * swept up by the bulk accept - it has to be opened.
 */
export function ShiftMatrixEditor({
  days,
  defs,
  warnings,
  metricsLine,
  onOpenDay,
  onAcceptRecognized,
  onContinue,
  onBack,
}: Props) {
  const open = openDays(days);
  const disputed = disputedDays(days);
  const acceptable = acceptableDays(days);

  return (
    <section>
      <div className="card">
        <h2>Check what was read</h2>
        <p className="muted">
          Nothing goes in your calendar until you accept it. Red cells are ones the
          two reading passes disagreed on — open those yourself.
        </p>
      </div>

      {warnings.map((w) => (
        <div className="banner warn" key={w}>
          {w}
        </div>
      ))}

      {open.length > 0 ? (
        <div className="banner warn">
          {open.length} of {days.length} days still need you
          {disputed.length > 0 ? ` — ${disputed.length} unclear` : ''}.
        </div>
      ) : (
        <div className="banner ok">All {days.length} days settled. Ready to export.</div>
      )}

      <div className="matrix">
        {days.map((d) => {
          const wd = weekday(d.dateStr);
          const off = isOffCode(d.shiftCode, defs);
          const cls = [
            'cell',
            isExportable(d) ? 'confirmed' : '',
            d.state === CellState.UNRESOLVED ? 'unknown' : '',
            d.state === CellState.RECOGNIZED ? 'uncertain' : '',
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
              aria-label={`${d.dateStr}, ${d.shiftCode ?? 'unresolved'}, ${STATE_LABEL[d.state]}`}
              data-state={d.state}
            >
              <span className="date">
                {WEEKDAYS[wd]} {Number(d.dateStr.slice(8))}
              </span>
              <span className={`code ${d.shiftCode ? '' : 'empty'}`}>
                {d.shiftCode ?? '—'}
              </span>
              <span className="state">
                {d.state === CellState.EDITED
                  ? 'edited'
                  : d.state === CellState.CONFIRMED
                    ? '✓'
                    : STATE_LABEL[d.state]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="legend">
        <span>
          <i style={{ background: 'var(--ok)' }} />
          settled by you
        </span>
        <span>
          <i style={{ background: 'var(--warn)' }} />
          read, needs your OK
        </span>
        <span>
          <i style={{ background: 'var(--danger)' }} />
          unclear, open it
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
          <button
            className="ghost grow"
            onClick={onAcceptRecognized}
            disabled={acceptable.length === 0}
          >
            Accept {acceptable.length} read {acceptable.length === 1 ? 'day' : 'days'}
          </button>
          <button className="ghost" onClick={onBack}>
            Re-align
          </button>
        </div>
      </div>
    </section>
  );
}
