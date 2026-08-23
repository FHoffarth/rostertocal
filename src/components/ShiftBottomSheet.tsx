import { useState } from 'react';
import type { CellEvidence, ShiftDef } from '../models/shifts';

interface Props {
  dateStr: string;
  currentCode: string | null;
  rawText?: string;
  /** What each recognition pass saw, so the user can judge for themselves. */
  evidence?: CellEvidence;
  defs: ShiftDef[];
  onPick: (code: string) => void;
  onConfirm?: () => void;
  onClear: () => void;
  onCreate: (def: ShiftDef) => void;
  onClose: () => void;
}

/**
 * CONFIRM, one tap.
 *
 * Common shifts are tiles, not a text field: the system keyboard costs
 * more than a whole correction is worth. The keyboard only appears when
 * the user genuinely has a new code to teach the app.
 */
export function ShiftBottomSheet({
  dateStr,
  currentCode,
  rawText,
  evidence,
  defs,
  onPick,
  onConfirm,
  onClear,
  onCreate,
  onClose,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('16:00');
  const [err, setErr] = useState<string | null>(null);

  function submitNew() {
    const c = code.trim().toUpperCase();
    if (!c) {
      setErr('Give the shift a short code.');
      return;
    }
    if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) {
      setErr('Times must look like 06:00.');
      return;
    }
    onCreate({ code: c, label: label.trim() || c, start, end, isOff: false });
    onPick(c);
  }

  return (
    <div
      className="sheet-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Shift for ${dateStr}`}
    >
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grip" />
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>{dateStr}</strong>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {evidence && !evidence.agreed ? (
          <div className="banner err" style={{ marginTop: 8 }}>
            The two passes disagreed, so nothing was assumed.
            <div className="muted" style={{ marginTop: 4 }}>
              Whole row read {evidence.rowText ? `“${evidence.rowText}”` : 'nothing'};
              this cell alone read {evidence.cellText ? `“${evidence.cellText}”` : 'nothing'}.
            </div>
          </div>
        ) : evidence?.reason ? (
          <p className="muted">{evidence.reason}.</p>
        ) : rawText ? (
          <p className="muted">
            Read as “{rawText}”{currentCode ? '' : ' — not a shift code I know.'}
          </p>
        ) : (
          <p className="muted">Nothing was recognised here.</p>
        )}

        {!creating && (
          <>
            <div className="tiles" style={{ marginTop: 10 }}>
              {defs.map((d) => (
                <button
                  key={d.code}
                  className={`tile ${d.code === currentCode ? 'active' : ''}`}
                  onClick={() => onPick(d.code)}
                >
                  {d.code}
                  <small>{d.isOff ? d.label : `${d.start}–${d.end}`}</small>
                </button>
              ))}
              <button className="tile" onClick={() => setCreating(true)}>
                +<small>New code</small>
              </button>
            </div>
            {currentCode && onConfirm && (
              <button
                className="primary"
                style={{ marginTop: 10 }}
                onClick={onConfirm}
              >
                Keep {currentCode}
              </button>
            )}
            <button
              className="ghost"
              style={{ width: '100%', marginTop: 8 }}
              onClick={onClear}
            >
              Nothing on this day
            </button>
          </>
        )}

        {creating && (
          <div style={{ marginTop: 10 }}>
            <label className="field">
              <span>Code (as printed on the roster)</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoCapitalize="characters"
                placeholder="ZD"
              />
            </label>
            <label className="field">
              <span>Name (optional)</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Zwischendienst"
              />
            </label>
            <div className="row">
              <label className="field grow">
                <span>Start</span>
                <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
              </label>
              <label className="field grow">
                <span>End</span>
                <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
              </label>
            </div>
            <p className="muted">An end at or before the start becomes an overnight shift.</p>
            {err && <div className="banner err">{err}</div>}
            <button className="primary" onClick={submitNew}>
              Save and use
            </button>
            <button
              className="ghost"
              style={{ width: '100%', marginTop: 8 }}
              onClick={() => setCreating(false)}
            >
              Back to tiles
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
