import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RosterPage } from '../models/roster';
import { validateQuad, type QuadSelection } from '../models/quad';
import { QuadCropper } from './QuadCropper';

/**
 * Fixed zoom stops rather than free pinch: a roster only ever needs
 * "fitted" or "close enough to see a day column", and discrete steps
 * cannot land on an awkward fraction mid-drag.
 */
export const ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const;

/**
 * Breathing room the scroller keeps around the picture, in CSS px.
 * A corner handle is centred on its corner, so at the edge of the image
 * it overhangs by half a touch target; the fitted width has to leave
 * space for that or the handle lands outside the visible stage.
 * Must match the `.zoom-layer` padding.
 */
export const STAGE_PADDING = 28;
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

export function zoomIn(z: number): number {
  return ZOOM_STEPS.find((s) => s > z) ?? MAX_ZOOM;
}

export function zoomOut(z: number): number {
  return [...ZOOM_STEPS].reverse().find((s) => s < z) ?? ZOOM_STEPS[0];
}

interface Props {
  page: RosterPage;
  month: string;
  dateQuad: QuadSelection;
  employeeQuad: QuadSelection;
  usingPdfText: boolean;
  busy: boolean;
  progress?: string | null;
  error?: string | null;
  onMonthChange: (m: string) => void;
  onDateQuad: (q: QuadSelection) => void;
  onEmployeeQuad: (q: QuadSelection) => void;
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
  dateQuad,
  employeeQuad,
  usingPdfText,
  busy,
  progress,
  error,
  onMonthChange,
  onDateQuad,
  onEmployeeQuad,
  onRecognize,
  onBack,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  const [fitWidth, setFitWidth] = useState(0);
  const [zoom, setZoom] = useState(1);

  // Mount the working canvas directly - no second copy, no data URL.
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    holder.replaceChildren(page.canvas);
    return () => holder.replaceChildren();
  }, [page]);

  // A new page starts fitted again.
  useEffect(() => setZoom(1), [page]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setFitWidth(Math.max(1, el.clientWidth - STAGE_PADDING * 2));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * Zoom is done by laying the canvas out wider and letting the stage
   * scroll, not by transforming it. Band rectangles stay in source-image
   * pixels either way - all that changes is the number they are
   * multiplied by to be drawn, so no geometry can drift with the view.
   */
  const displayWidth = Math.round(fitWidth * zoom);
  const displayHeight = page.width
    ? Math.round((displayWidth * page.height) / page.width)
    : 0;

  // Geometry is checked before the user can spend time on recognition.
  const dateCheck = validateQuad(dateQuad, page.width, page.height);
  const rowCheck = validateQuad(employeeQuad, page.width, page.height);
  const geometryProblem = !dateCheck.ok
    ? `Dates: ${dateCheck.reason}`
    : !rowCheck.ok
      ? `My row: ${rowCheck.reason}`
      : null;
  const canZoomIn = zoom < MAX_ZOOM;
  const canZoomOut = zoom > 1;

  return (
    <section>
      <div className="card">
        <h2>Mark the two rows</h2>
        <p className="muted">
          Blue corners around the row of dates, green around your own shift row.
          Drag each corner onto the row — that handles a crooked or angled photo
          on its own.
        </p>
      </div>

      <div className="stage" ref={stageRef}>
        <div className="zoom-layer">
          {/* The explicit width goes on the box the quads are positioned
              against, never on the padded layer: the padding would
              otherwise make the overlay wider than the image it covers. */}
          <div className="canvas-box" style={{ width: displayWidth || undefined }}>
            <div ref={holderRef} />
            {displayWidth > 0 && (
              <>
                <QuadCropper
                  label="Dates"
                  variant="date"
                  quad={dateQuad}
                  sourceWidth={page.width}
                  sourceHeight={page.height}
                  displayWidth={displayWidth}
                  displayHeight={displayHeight}
                  invalidReason={dateCheck.ok ? undefined : dateCheck.reason}
                  onChange={onDateQuad}
                />
                <QuadCropper
                  label="My row"
                  variant="employee"
                  quad={employeeQuad}
                  sourceWidth={page.width}
                  sourceHeight={page.height}
                  displayWidth={displayWidth}
                  displayHeight={displayHeight}
                  invalidReason={rowCheck.ok ? undefined : rowCheck.reason}
                  onChange={onEmployeeQuad}
                />
              </>
            )}
          </div>
        </div>
      </div>

      <div className="zoom-bar">
        <button
          type="button"
          onClick={() => setZoom((z) => zoomOut(z))}
          disabled={!canZoomOut}
          aria-label="Zoom out"
        >
          &minus;
        </button>
        <span className="zoom-level" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoom((z) => zoomIn(z))}
          disabled={!canZoomIn}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="ghost grow"
          onClick={() => setZoom(1)}
          disabled={zoom === 1}
        >
          Fit
        </button>
      </div>
      {zoom > 1 && (
        <p className="muted" style={{ marginTop: 4 }}>
          Drag the picture to move around it. Dragging a band still moves the band.
        </p>
      )}

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

      {geometryProblem && <div className="banner err">{geometryProblem}</div>}
      {error && <div className="banner err">{error}</div>}

      <div className="sticky-cta">
        <button
          className="primary"
          onClick={onRecognize}
          disabled={busy || !month || Boolean(geometryProblem)}
        >
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
