import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CropRect, RosterPage } from '../models/roster';
import { StripCropper } from './StripCropper';

interface Props {
  page: RosterPage;
  month: string;
  dateStrip: CropRect;
  employeeStrip: CropRect;
  usingPdfText: boolean;
  busy: boolean;
  progress?: string | null;
  error?: string | null;
  onMonthChange: (m: string) => void;
  onDateStrip: (r: CropRect) => void;
  onEmployeeStrip: (r: CropRect) => void;
  onRecognize: () => void;
  onBack: () => void;
}

/**
 * ALIGN. Two strips, not a table parser.
 *
 * The user tells us where the dates are and where their own row is.
 * That single act removes the hardest part of roster OCR - deciding
 * which cell belongs to which day - from the recogniser entirely.
 */
export function AlignmentEditor({
  page,
  month,
  dateStrip,
  employeeStrip,
  usingPdfText,
  busy,
  progress,
  error,
  onMonthChange,
  onDateStrip,
  onEmployeeStrip,
  onRecognize,
  onBack,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  const [displayWidth, setDisplayWidth] = useState(0);

  // Mount the working canvas directly - no second copy, no data URL.
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    holder.replaceChildren(page.canvas);
    return () => holder.replaceChildren();
  }, [page]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setDisplayWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <section>
      <div className="card">
        <h2>Mark the two rows</h2>
        <p className="muted">
          Blue over the row of dates. Green over your own shift row. Drag the top
          and bottom circles to fit the row, and the left and right ones to follow
          a photo that sits slightly crooked.
        </p>
      </div>

      <div className="stage" ref={stageRef}>
        <div ref={holderRef} />
        {displayWidth > 0 && (
          <>
            <StripCropper
              label="Dates"
              variant="date"
              rect={dateStrip}
              sourceWidth={page.width}
              sourceHeight={page.height}
              displayWidth={displayWidth}
              onChange={onDateStrip}
            />
            <StripCropper
              label="My row"
              variant="employee"
              rect={employeeStrip}
              sourceWidth={page.width}
              sourceHeight={page.height}
              displayWidth={displayWidth}
              onChange={onEmployeeStrip}
            />
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <label className="field">
          <span>Roster month</span>
          <input
            type="month"
            value={month}
            onChange={(e) => onMonthChange(e.target.value)}
          />
        </label>
        <p className="muted">
          {usingPdfText
            ? 'This PDF has a real text layer — no OCR needed.'
            : 'Recognised on this device. First run loads the local OCR model.'}
        </p>
      </div>

      {error && <div className="banner err">{error}</div>}

      <div className="sticky-cta">
        <button className="primary" onClick={onRecognize} disabled={busy || !month}>
          {busy ? (progress ?? 'Reading…') : 'Read this roster'}
        </button>
        <button
          className="ghost"
          style={{ width: '100%', marginTop: 8 }}
          onClick={onBack}
          disabled={busy}
        >
          Use a different file
        </button>
      </div>
    </section>
  );
}
