import { skewAt, type CropRect, type OcrToken, type RosterPage } from '../models/roster';
import {
  CellState,
  RecognitionSource,
  type CellEvidence,
  type DayShift,
} from '../models/shifts';
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

/**
 * Every cell gets an independent second reading. Measured at ~30 ms per
 * cell on the sample photo (under 1 s for a whole month) against the
 * single shared worker - a cheap price for never exporting a reading
 * that only one pass ever saw.
 */

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
  /** Time spent on the independent cell-local verification pass. */
  cellOcrMs: number;
  verifiedCells: number;
  /** Cells where the two passes did not agree on a code. */
  disagreements: number;
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

/** Readable description of one pass's result, for the disagreement note. */
function describe(code: string | null, cleaned: string): string {
  if (code) return `"${code}"`;
  return cleaned ? `"${cleaned}" (not a known code)` : 'nothing';
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

export interface PassReading {
  text: string;
  confidence: number;
}

export interface CellVerdict {
  shiftCode: string | null;
  confidence: number;
  state: CellState;
  evidence: CellEvidence;
}

/**
 * Decide what a cell is worth, from two independent readings.
 *
 * The one rule that matters: disagreement is never settled by picking
 * the more confident reading. The failure this exists to prevent had the
 * *wrong* answer at 99 % and the right one at 57 %, because a glyph that
 * merged with a printed rule was silently dropped from the row pass,
 * leaving a clean single character behind. Confidence describes a glyph,
 * never the contents of a day.
 *
 * A reading that only matched after repair is a guess as well, so it is
 * offered as a suggestion but never counts as recognised.
 */
export function adjudicateCell(
  row: PassReading,
  cell: PassReading,
  knownCodes: string[],
): CellVerdict {
  const rowNorm = normalizeShiftToken(row.text, knownCodes, row.confidence);
  const cellNorm = normalizeShiftToken(cell.text, knownCodes, cell.confidence);

  const agreed = rowNorm.code !== null && rowNorm.code === cellNorm.code;
  const repaired = rowNorm.repaired || cellNorm.repaired;

  let state: CellState;
  let reason: string | undefined;
  if (rowNorm.code === null && cellNorm.code === null) {
    state = CellState.UNRESOLVED;
    reason = 'Neither pass could read this cell';
  } else if (!agreed) {
    state = CellState.UNRESOLVED;
    reason = `Row pass read ${describe(rowNorm.code, rowNorm.cleaned)}, cell pass read ${describe(cellNorm.code, cellNorm.cleaned)}`;
  } else if (repaired) {
    state = CellState.UNRESOLVED;
    reason = 'The reading only matched a known code after repair';
  } else {
    state = CellState.RECOGNIZED;
  }

  const evidence: CellEvidence = {
    rowCode: rowNorm.code,
    cellCode: cellNorm.code,
    rowText: rowNorm.cleaned,
    cellText: cellNorm.cleaned,
    agreed,
    repaired,
    reason,
  };

  return {
    // An unresolved cell carries no value forward - the user picks.
    shiftCode: state === CellState.RECOGNIZED ? rowNorm.code : null,
    confidence:
      state === CellState.RECOGNIZED
        ? Math.min(rowNorm.confidence, cellNorm.confidence)
        : 0,
    state,
    evidence,
  };
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
        cellOcrMs: 0,
        verifiedCells: 0,
        disagreements: 0,
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

  // --- independent cell-local verification ---------------------------
  //
  // The row pass reads one wide strip, so a glyph pressed against a
  // printed rule can be lost without anything downstream noticing: the
  // cell then holds whatever survived, at that glyph's own high
  // confidence. A second reading of the isolated cell is the only thing
  // that catches it.
  //
  // The crop is exactly the day column - never wider - so a neighbour's
  // glyph cannot be pulled in.
  const rects = new Map(
    cellRects(alignment.columns, employeeStrip).map((r, i) => [
      alignment.columns[i].day,
      r,
    ]),
  );

  const cellReads = new Map<number, { text: string; confidence: number }>();
  let cellOcrMs = 0;
  let verifiedCells = 0;

  if (!usingText) {
    const tCell = performance.now();
    const engine = await ocr();
    for (const column of alignment.columns) {
      const rect = rects.get(column.day);
      if (!rect) continue;
      const crop = preprocessForOcr(cropToCanvas(page.canvas, rect, OCR_UPSCALE));
      try {
        const tokens = await engine.recognizeStrip(crop, {
          charset: engine.SHIFT_CHARSET,
          psm: engine.PSM_SINGLE_WORD,
          granularity: 'word',
        });
        verifiedCells += 1;
        const ordered = [...tokens].sort((a, b) => a.x0 - b.x0);
        cellReads.set(column.day, {
          text: ordered.map((t) => t.text).join(''),
          confidence: ordered.length
            ? Math.min(...ordered.map((t) => t.confidence))
            : 0,
        });
      } finally {
        releaseCanvas(crop);
      }
    }
    cellOcrMs = performance.now() - tCell;
  }

  // --- adjudicate -----------------------------------------------------
  const source = usingText ? RecognitionSource.PDF_TEXT : RecognitionSource.OCR;
  const days: DayShift[] = [];
  let disagreements = 0;

  for (let day = 1; day <= expected; day++) {
    const rowCell = cells.get(day);

    if (usingText) {
      // A PDF text layer is exact, so there is no second opinion to seek
      // and none is needed. It still has to be confirmed before export,
      // and a token that only matched after repair is still a guess.
      const norm = normalizeShiftToken(
        rowCell?.text ?? '',
        knownCodes,
        rowCell?.confidence ?? 0,
      );
      const settled = norm.code !== null && !norm.repaired;
      days.push({
        dateStr: ymd(month, day),
        shiftCode: settled ? norm.code : null,
        confidence: settled ? norm.confidence : 0,
        source,
        state: settled ? CellState.RECOGNIZED : CellState.UNRESOLVED,
        rawText: norm.cleaned,
        evidence: {
          rowCode: norm.code,
          cellCode: norm.code,
          rowText: norm.cleaned,
          cellText: norm.cleaned,
          agreed: true,
          repaired: norm.repaired,
          reason: settled
            ? undefined
            : norm.code
              ? 'The reading only matched a known code after repair'
              : 'Nothing readable in this cell',
        },
      });
      continue;
    }

    const read = cellReads.get(day);
    const verdict = adjudicateCell(
      { text: rowCell?.text ?? '', confidence: rowCell?.confidence ?? 0 },
      { text: read?.text ?? '', confidence: read?.confidence ?? 0 },
      knownCodes,
    );
    if (verdict.evidence.rowCode !== verdict.evidence.cellCode) disagreements += 1;

    days.push({
      dateStr: ymd(month, day),
      shiftCode: verdict.shiftCode,
      confidence: verdict.confidence,
      source,
      state: verdict.state,
      rawText: verdict.evidence.rowText || verdict.evidence.cellText,
      evidence: verdict.evidence,
    });
  }

  if (disagreements > 0) {
    warnings.push(
      `${disagreements} cell(s) were read differently by the two passes and need your decision`,
    );
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
      cellOcrMs,
      verifiedCells,
      disagreements,
      totalMs: performance.now() - t0,
    },
  };
}
