import { skewAt, type CropRect, type OcrToken, type RosterPage } from '../models/roster';
import { RecognitionSource, type DayShift } from '../models/shifts';
import {
  buildDayColumns,
  cellRects,
  groupTokens,
  mapTokensToDays,
  type DayAnchor,
} from './gridAlignment';
import { daysInMonth } from './icsGenerator';
import type { PdfTextPage } from './pdfExtractor';
import type * as OcrModule from './ocrWorker';
import { normalizeShiftToken, parseDayToken } from './shiftNormalizer';
import { cropToCanvas, preprocessForOcr } from './stripCropper';
import { releaseCanvas } from './imageLoader';

/**
 * Orchestration of ALIGN -> RECOGNIZE.
 *
 * Geometry first, OCR second: day columns are built from the date strip
 * before a single shift cell is read, and OCR output is only ever asked
 * "what did you read here", never "which day is this".
 */

/**
 * Crops are upscaled before OCR. Roster glyphs in a phone photo are
 * around 25 px tall; Tesseract wants roughly 30-40 px of x-height, and
 * 3x measurably recovers two-digit day numbers that 2x drops.
 */
export const OCR_UPSCALE = 3;

/** Cells at or below this get a second, per-cell OCR pass. */
export const RETRY_CONFIDENCE = 0.8;

/**
 * tesseract.js is ~200 kB of JS before it even fetches its WASM core.
 * A text PDF never needs it, so it is pulled in on demand rather than
 * on first paint.
 */
let ocrModule: typeof OcrModule | null = null;
async function ocr(): Promise<typeof OcrModule> {
  if (!ocrModule) ocrModule = await import('./ocrWorker');
  return ocrModule;
}

export interface PipelineInput {
  page: RosterPage;
  /** Present only when the PDF carried a usable text layer. */
  textPage?: PdfTextPage | null;
  dateStrip: CropRect;
  employeeStrip: CropRect;
  /** "YYYY-MM" */
  month: string;
  knownCodes: string[];
}

export interface PipelineMetrics {
  dateOcrMs: number;
  rowOcrMs: number;
  retryOcrMs: number;
  retriedCells: number;
  totalMs: number;
}

export interface PipelineResult {
  ok: boolean;
  days: DayShift[];
  warnings: string[];
  /** Why recognition could not proceed. Present only when ok is false. */
  failure?: string;
  interpolatedDays: number[];
  unmappedTokens: number;
  source: RecognitionSource;
  metrics: PipelineMetrics;
}

function ymd(month: string, day: number): string {
  return `${month}-${String(day).padStart(2, '0')}`;
}

function monthLength(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return daysInMonth(y, m);
}

/** PDF text tokens live in PDF units; the preview canvas is scaled. */
function pdfTokensInBand(
  textPage: PdfTextPage,
  strip: CropRect,
  canvasWidth: number,
  canvasHeight: number,
): OcrToken[] {
  const sx = canvasWidth / textPage.width;
  const sy = canvasHeight / textPage.height;
  const out: OcrToken[] = [];
  for (const it of textPage.items) {
    const y = it.y * sy;
    const x0 = it.x0 * sx;
    const x1 = it.x1 * sx;
    if (x1 < strip.x || x0 > strip.x + strip.w) continue;
    // The band may be tilted; test against its height at this token.
    const top = strip.y + skewAt(strip, (x0 + x1) / 2);
    if (y < top || y > top + strip.h) continue;
    out.push({ text: it.text, confidence: it.confidence, x0, x1 });
  }
  return out;
}

async function ocrBand(source: HTMLCanvasElement, strip: CropRect, charset: string) {
  const engine = await ocr();
  const crop = preprocessForOcr(cropToCanvas(source, strip, OCR_UPSCALE));
  try {
    const raw = await engine.recognizeStrip(crop, {
      charset,
      psm: engine.PSM_BLOCK,
      granularity: 'symbol',
    });
    return engine.tokensToSourceSpace(raw, strip.x, OCR_UPSCALE);
  } finally {
    releaseCanvas(crop);
  }
}

/**
 * Run the full recognition pass. Returns one DayShift per day of the
 * month; unresolved days come back with shiftCode null rather than a
 * guess.
 */
export async function runRecognition(input: PipelineInput): Promise<PipelineResult> {
  const t0 = performance.now();
  const { page, textPage, dateStrip, employeeStrip, month, knownCodes } = input;
  const expected = monthLength(month);
  const usingText = Boolean(textPage);
  const warnings: string[] = [];

  // --- date strip -> day anchors -------------------------------------
  const tDate = performance.now();
  const dateTokens = usingText
    ? pdfTokensInBand(textPage!, dateStrip, page.width, page.height)
    : await ocrBand(page.canvas, dateStrip, (await ocr()).DATE_CHARSET);
  const dateOcrMs = performance.now() - tDate;

  // Character-level OCR splits "12" into "1" and "2"; put numbers back
  // together before anything is read as a day.
  const dateGroups = usingText ? dateTokens : groupTokens(dateTokens);

  const anchors: DayAnchor[] = [];
  for (const t of dateGroups) {
    const day = parseDayToken(t.text);
    if (day === null) continue;
    anchors.push({ day, center: (t.x0 + t.x1) / 2 });
  }

  const alignment = buildDayColumns(anchors, expected, page.width);
  warnings.push(...alignment.warnings);

  if (!alignment.ok) {
    return {
      ok: false,
      days: [],
      warnings,
      failure: alignment.failure,
      interpolatedDays: [],
      unmappedTokens: 0,
      source: usingText ? RecognitionSource.PDF_TEXT : RecognitionSource.OCR,
      metrics: {
        dateOcrMs,
        rowOcrMs: 0,
        retryOcrMs: 0,
        retriedCells: 0,
        totalMs: performance.now() - t0,
      },
    };
  }

  // --- employee strip -> per-day tokens ------------------------------
  const tRow = performance.now();
  const rowTokens = usingText
    ? pdfTokensInBand(textPage!, employeeStrip, page.width, page.height)
    : await ocrBand(page.canvas, employeeStrip, (await ocr()).SHIFT_CHARSET);
  const rowOcrMs = performance.now() - tRow;

  const mapped = mapTokensToDays(alignment.columns, rowTokens);
  const cells = new Map(mapped.cells.map((c) => [c.day, c]));

  // --- targeted second pass on weak cells ----------------------------
  // A whole-strip pass is far cheaper than 31 crops, so we only re-OCR
  // the cells that came back empty or unconvincing.
  let retryOcrMs = 0;
  let retriedCells = 0;
  if (!usingText) {
    const weak = mapped.cells.filter((c) => c.confidence <= RETRY_CONFIDENCE);
    if (weak.length > 0) {
      const tRetry = performance.now();
      const rects = new Map(
        cellRects(alignment.columns, employeeStrip).map((r, i) => [
          alignment.columns[i].day,
          r,
        ]),
      );
      for (const cell of weak) {
        const rect = rects.get(cell.day);
        if (!rect) continue;
        const engine = await ocr();
        const crop = preprocessForOcr(cropToCanvas(page.canvas, rect, OCR_UPSCALE));
        try {
          const tokens = await engine.recognizeStrip(crop, {
            charset: engine.SHIFT_CHARSET,
            psm: engine.PSM_SINGLE_WORD,
            granularity: 'word',
          });
          retriedCells += 1;
          const best = tokens.sort((a, b) => b.confidence - a.confidence)[0];
          if (best && best.confidence > cell.confidence) {
            cells.set(cell.day, {
              day: cell.day,
              text: best.text,
              confidence: best.confidence,
              tokenCount: 1,
            });
          }
        } finally {
          releaseCanvas(crop);
        }
      }
      retryOcrMs = performance.now() - tRetry;
    }
  }

  // --- normalise ------------------------------------------------------
  const source = usingText ? RecognitionSource.PDF_TEXT : RecognitionSource.OCR;
  const days: DayShift[] = [];
  for (let day = 1; day <= expected; day++) {
    const cell = cells.get(day);
    const norm = normalizeShiftToken(cell?.text ?? '', knownCodes, cell?.confidence ?? 0);
    days.push({
      dateStr: ymd(month, day),
      shiftCode: norm.code,
      confidence: norm.code ? norm.confidence : 0,
      source,
      confirmed: false,
      rawText: norm.cleaned,
    });
  }

  if (mapped.unmapped.length > 0) {
    warnings.push(
      `${mapped.unmapped.length} recognised token(s) fell outside every day column and were ignored`,
    );
  }

  return {
    ok: true,
    days,
    warnings,
    interpolatedDays: alignment.interpolatedDays,
    unmappedTokens: mapped.unmapped.length,
    source,
    metrics: {
      dateOcrMs,
      rowOcrMs,
      retryOcrMs,
      retriedCells,
      totalMs: performance.now() - t0,
    },
  };
}
