import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UploadStep } from './components/UploadStep';
import { AlignmentEditor } from './components/AlignmentEditor';
import { ShiftMatrixEditor } from './components/ShiftMatrixEditor';
import { ShiftBottomSheet } from './components/ShiftBottomSheet';
import { ExportStep } from './components/ExportStep';
import { InstallHint } from './components/InstallHint';
import type { RosterPage } from './models/roster';
import { quadFromBand, type QuadSelection } from './models/quad';
import {
  CellState,
  isBulkAcceptable,
  RecognitionSource,
  type DayShift,
  type ShiftDef,
} from './models/shifts';
import { isPdf, loadImageFile, releasePage } from './lib/imageLoader';
import type { PdfTextPage } from './lib/pdfExtractor';
import { defaultStrips } from './lib/stripCropper';
import { runRecognition, type PipelineMetrics } from './lib/recognitionPipeline';
import {
  loadShiftMemory,
  saveShiftMemory,
  upsertDef,
  type ShiftMemoryPayload,
} from './lib/shiftMemory';

type Step = 'upload' | 'align' | 'confirm' | 'export';

const STEPS: Step[] = ['upload', 'align', 'confirm', 'export'];

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export default function App() {
  const [step, setStep] = useState<Step>('upload');
  const [page, setPage] = useState<RosterPage | null>(null);
  const [textPage, setTextPage] = useState<PdfTextPage | null>(null);
  // Canonical selections, in source-image pixels.
  const [dateQuad, setDateQuad] = useState<QuadSelection>(() =>
    quadFromBand({ x: 0, y: 0, w: 1, h: 1 }),
  );
  const [employeeQuad, setEmployeeQuad] = useState<QuadSelection>(() =>
    quadFromBand({ x: 0, y: 0, w: 1, h: 1 }),
  );
  const [month, setMonth] = useState(currentMonth());
  const [days, setDays] = useState<DayShift[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null);
  const [loadMs, setLoadMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [memory, setMemory] = useState<ShiftMemoryPayload>(() => loadShiftMemory());

  // The File is held only long enough to raster/extract; never uploaded.
  const fileRef = useRef<File | null>(null);
  const pageRef = useRef<RosterPage | null>(null);
  pageRef.current = page;

  // One OCR worker per session, torn down with the page.
  useEffect(() => {
    return () => {
      // Only reach for the OCR module if this session actually loaded it.
      void import('./lib/ocrWorker').then((m) => m.terminateOcrWorker());
      releasePage(pageRef.current);
    };
  }, []);

  const persist = useCallback((next: ShiftMemoryPayload) => {
    setMemory(next);
    saveShiftMemory(next);
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      const t0 = performance.now();
      try {
        releasePage(pageRef.current);
        fileRef.current = file;
        let loaded: RosterPage;
        let text: PdfTextPage | null = null;

        if (isPdf(file)) {
          // pdf.js is ~1.3 MB with its worker; image users never load it.
          const pdf = await import('./lib/pdfExtractor');
          // Native text first; OCR only if the text layer is unusable.
          const roster = await pdf.openPdfRoster(file, 1);
          loaded = roster.page;
          text = roster.textPage;
        } else {
          loaded = await loadImageFile(file);
        }

        // The default guesses are still bands; they convert exactly.
        const strips = defaultStrips(loaded.width, loaded.height);
        setPage(loaded);
        setTextPage(text);
        setDateQuad(quadFromBand(strips.dateStrip));
        setEmployeeQuad(quadFromBand(strips.employeeStrip));
        setDays([]);
        setWarnings([]);
        setMetrics(null);
        setLoadMs(performance.now() - t0);
        setStep('align');
      } catch (e) {
        setError((e as Error).message || 'Could not read that file.');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const knownCodes = useMemo(() => memory.defs.map((d) => d.code), [memory.defs]);

  const recognize = useCallback(async () => {
    if (!page) return;
    setBusy(true);
    setError(null);
    setProgress(textPage ? 'Reading PDF text…' : 'Recognising…');
    try {
      const r = await runRecognition({
        page,
        textPage,
        dateQuad,
        employeeQuad,
        month,
        knownCodes,
      });
      setMetrics(r.metrics);
      setWarnings(r.warnings);
      if (!r.ok) {
        setError(
          r.failure ??
            'Could not line the dates up. Move the blue band onto the row of day numbers.',
        );
        return;
      }
      setDays(r.days);
      setStep('confirm');
    } catch (e) {
      setError((e as Error).message || 'Recognition failed on this device.');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [page, textPage, dateQuad, employeeQuad, month, knownCodes]);

  const setDay = useCallback((dateStr: string, patch: Partial<DayShift>) => {
    setDays((prev) => prev.map((d) => (d.dateStr === dateStr ? { ...d, ...patch } : d)));
  }, []);

  /** The user chose a code themselves - that is an edit, not a reading. */
  const pickShift = useCallback(
    (dateStr: string, code: string) => {
      setDay(dateStr, {
        shiftCode: code,
        confidence: 1,
        source: RecognitionSource.USER_CONFIRMED,
        state: CellState.EDITED,
      });
      setOpenDay(null);
    },
    [setDay],
  );

  /** The user looked at what was read and accepted it as-is. */
  const confirmShift = useCallback(
    (dateStr: string) => {
      setDay(dateStr, { state: CellState.CONFIRMED });
      setOpenDay(null);
    },
    [setDay],
  );

  /** "Nothing on this day" is a decision too, so the cell is settled. */
  const clearShift = useCallback(
    (dateStr: string) => {
      setDay(dateStr, {
        shiftCode: null,
        confidence: 0,
        source: RecognitionSource.USER_CONFIRMED,
        state: CellState.EDITED,
      });
      setOpenDay(null);
    },
    [setDay],
  );

  const createDef = useCallback(
    (def: ShiftDef) => {
      persist({ ...memory, defs: upsertDef(memory.defs, def) });
    },
    [memory, persist],
  );

  /**
   * The bulk review step. It accepts only cells the machine settled and
   * both passes agreed on; a disputed cell is deliberately out of its
   * reach and has to be opened one by one.
   */
  const acceptRecognized = useCallback(() => {
    setDays((prev) =>
      prev.map((d) => (isBulkAcceptable(d) ? { ...d, state: CellState.CONFIRMED } : d)),
    );
  }, []);

  const restart = useCallback(() => {
    releasePage(pageRef.current);
    fileRef.current = null;
    setPage(null);
    setTextPage(null);
    setDays([]);
    setWarnings([]);
    setMetrics(null);
    setError(null);
    setStep('upload');
  }, []);

  const metricsLine = metrics
    ? [
        loadMs !== null ? `load ${Math.round(loadMs)} ms` : null,
        metrics.rectifyMs ? `rectify ${Math.round(metrics.rectifyMs)} ms` : null,
        metrics.rowStripPx !== 'pdf-text' ? `strip ${metrics.rowStripPx}` : null,
        `dates ${Math.round(metrics.dateOcrMs)} ms`,
        `row ${Math.round(metrics.rowOcrMs)} ms`,
        metrics.verifiedCells
          ? `${metrics.verifiedCells} cells verified ${Math.round(metrics.cellOcrMs)} ms`
          : null,
        metrics.disagreements ? `${metrics.disagreements} disagreed` : null,
        `total ${Math.round(metrics.totalMs)} ms`,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  const openDayShift = days.find((d) => d.dateStr === openDay) ?? null;
  const stepIndex = STEPS.indexOf(step);

  return (
    <main>
      <h1>RosterToCal</h1>
      <div className="privacy" role="note">
        <span aria-hidden="true">🔒</span>
        <span>Your roster stays on this device. No upload, no account.</span>
      </div>
      <InstallHint />
      <div className="steps" aria-hidden="true">
        {STEPS.map((s, i) => (
          <span key={s} className={i < stepIndex ? 'done' : i === stepIndex ? 'current' : ''} />
        ))}
      </div>

      {step === 'upload' && <UploadStep onFile={handleFile} busy={busy} error={error} />}

      {step === 'align' && page && (
        <AlignmentEditor
          page={page}
          month={month}
          dateQuad={dateQuad}
          employeeQuad={employeeQuad}
          usingPdfText={Boolean(textPage)}
          busy={busy}
          progress={progress}
          error={error}
          onMonthChange={setMonth}
          onDateQuad={setDateQuad}
          onEmployeeQuad={setEmployeeQuad}
          onRecognize={recognize}
          onBack={restart}
        />
      )}

      {step === 'confirm' && (
        <ShiftMatrixEditor
          days={days}
          defs={memory.defs}
          warnings={warnings}
          metricsLine={metricsLine}
          onOpenDay={setOpenDay}
          onAcceptRecognized={acceptRecognized}
          onContinue={() => setStep('export')}
          onBack={() => setStep('align')}
        />
      )}

      {step === 'export' && (
        <ExportStep
          days={days}
          defs={memory.defs}
          month={month}
          alarmMinutesBefore={memory.alarmMinutesBefore}
          onAlarmChange={(v) => persist({ ...memory, alarmMinutesBefore: v })}
          onBack={() => setStep('confirm')}
          onRestart={restart}
        />
      )}

      {openDayShift && (
        <ShiftBottomSheet
          dateStr={openDayShift.dateStr}
          currentCode={openDayShift.shiftCode}
          rawText={openDayShift.rawText}
          evidence={openDayShift.evidence}
          defs={memory.defs}
          onPick={(code) => pickShift(openDayShift.dateStr, code)}
          onConfirm={
            openDayShift.state === CellState.RECOGNIZED
              ? () => confirmShift(openDayShift.dateStr)
              : undefined
          }
          onClear={() => clearShift(openDayShift.dateStr)}
          onCreate={createDef}
          onClose={() => setOpenDay(null)}
        />
      )}
    </main>
  );
}
