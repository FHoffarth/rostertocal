import { useMemo, useState } from 'react';
import { isExportable, type DayShift, type ShiftDef } from '../models/shifts';
import { generateIcs } from '../lib/icsGenerator';
import { exportIcs, icsFilename, type ExportResult } from '../lib/calendarExport';
import { disputedDays, isOffCode, openDays } from './ShiftMatrixEditor';

interface Props {
  days: DayShift[];
  defs: ShiftDef[];
  month: string;
  alarmMinutesBefore: number | null;
  onAlarmChange: (v: number | null) => void;
  onBack: () => void;
  onRestart: () => void;
}

/**
 * EXPORT.
 *
 * Two hard gates before a file exists: nothing unresolved may slip
 * through silently, and the user sees exactly which days will and will
 * not become events.
 */
export function ExportStep({
  days,
  defs,
  month,
  alarmMinutesBefore,
  onAlarmChange,
  onBack,
  onRestart,
}: Props) {
  const [result, setResult] = useState<ExportResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [showIcs, setShowIcs] = useState(false);

  // The gate: a cell reaches the calendar only after a human settles it.
  // Recogniser confidence has no vote here, by design.
  const open = openDays(days);
  const disputed = disputedDays(days);
  const blocked = open.length > 0;

  const exportable = useMemo(
    () =>
      days.filter((d) => isExportable(d) && d.shiftCode && !isOffCode(d.shiftCode, defs)),
    [days, defs],
  );
  const offDays = useMemo(
    () => days.filter((d) => isExportable(d) && isOffCode(d.shiftCode, defs)),
    [days, defs],
  );
  const skipped = useMemo(
    () => days.filter((d) => isExportable(d) && !d.shiftCode),
    [days],
  );

  const ics = useMemo(
    () => (blocked ? '' : generateIcs(days, defs, { alarmMinutesBefore })),
    [blocked, days, defs, alarmMinutesBefore],
  );

  async function doExport() {
    setFailure(null);
    try {
      setResult(await exportIcs(ics, icsFilename(month)));
    } catch (e) {
      setFailure((e as Error).message || 'Could not hand the file to the system.');
    }
  }

  return (
    <section>
      <div className="card">
        <h2>Export to your calendar</h2>
        <p className="muted">
          {exportable.length} shift{exportable.length === 1 ? '' : 's'} become events.{' '}
          {offDays.length} free day{offDays.length === 1 ? '' : 's'} and {skipped.length}{' '}
          blank day{skipped.length === 1 ? '' : 's'} are left out. Only days you settled
          yourself are included.
        </p>
      </div>

      {blocked && (
        <div className="banner err">
          {open.length} day{open.length === 1 ? '' : 's'} not settled yet
          {disputed.length > 0
            ? `, ${disputed.length} of them unclear`
            : ''}. Go back and review them. A reading the recogniser was sure about
          still does not count as your decision.
        </div>
      )}

      <div className="card">
        <label className="field">
          <span>Reminder</span>
          <select
            value={alarmMinutesBefore === null ? 'none' : String(alarmMinutesBefore)}
            onChange={(e) =>
              onAlarmChange(e.target.value === 'none' ? null : Number(e.target.value))
            }
          >
            <option value="none">No reminder (default)</option>
            <option value="30">30 minutes before</option>
            <option value="60">1 hour before</option>
            <option value="120">2 hours before</option>
          </select>
        </label>
      </div>

      {result && (
        <div className="banner ok">
          {result.method === 'share'
            ? 'Handed to the system share sheet. Pick your calendar app there.'
            : `Saved as ${result.filename}. Open it from your downloads to add the shifts.`}
          {result.fellBack && ' (Sharing was refused, so the file was saved instead.)'}
          <div className="muted" style={{ marginTop: 4 }}>
            What happens next is up to your OS and calendar app — this page cannot write
            into a calendar directly.
          </div>
        </div>
      )}

      {failure && <div className="banner err">{failure}</div>}

      <div className="sticky-cta">
        <button className="primary" onClick={doExport} disabled={blocked}>
          {result ? 'Save calendar file again' : 'Add to calendar'}
        </button>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="ghost grow" onClick={onBack}>
            Back to check
          </button>
          <button className="ghost" onClick={() => setShowIcs((v) => !v)} disabled={blocked}>
            {showIcs ? 'Hide' : 'Show'} file
          </button>
          <button className="ghost" onClick={onRestart}>
            New roster
          </button>
        </div>
      </div>

      {showIcs && !blocked && <pre className="ics">{ics}</pre>}
    </section>
  );
}
