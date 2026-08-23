import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CropRect, RosterPage } from '../models/roster';
import { StripCropper } from './StripCropper';

/**
 * Fixed zoom stops rather than free pinch: a roster only ever needs
 * "fitted" or "close enough to see a day column", and discrete steps
 * cannot land on an awkward fraction mid-drag.
 */
export const ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const;
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
    const update = () => setFitWidth(el.clientWidth);
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
  const canZoomIn = zoom < MAX_ZOOM;
  const canZoomOut = zoom > 1;

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
        <div className="zoom-layer" style={{ width: displayWidth || undefined }}>
          <div className="canvas-box">
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
