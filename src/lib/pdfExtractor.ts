import * as pdfjs from 'pdfjs-dist';
import type { OcrToken, RosterPage } from '../models/roster';
import { MAX_WORKING_EDGE } from './imageLoader';

/**
 * PDF handling.
 *
 * Native text extraction FIRST. A text PDF gives exact glyph positions,
 * which feeds the same geometry pipeline as OCR - only with perfect
 * confidence. The page is rasterised as well, because the user still
 * needs a picture to place the two strips on; OCR only runs when the
 * text layer carries no plausible roster content.
 */

export interface PdfTextItem extends OcrToken {
  /** Baseline y in canvas-style coordinates (top-down). */
  y: number;
  height: number;
}

export interface PdfTextPage {
  kind: 'pdf-text';
  items: PdfTextItem[];
  width: number;
  height: number;
  pageNumber: number;
}

export interface PdfRoster {
  /** Rasterised page, always present - it is what the user aligns on. */
  page: RosterPage;
  /** Text layer, or null when the PDF is effectively a scan. */
  textPage: PdfTextPage | null;
  numPages: number;
}

/** How many distinct day-of-month numbers we need to trust the text layer. */
export const MIN_DAY_TOKENS = 10;

/**
 * A text layer is "meaningful" when it contains a run of plausible
 * day-of-month numbers. Anything less and we treat the PDF as a scan.
 */
export function hasMeaningfulRosterText(items: { text: string }[]): boolean {
  const days = new Set<number>();
  for (const it of items) {
    for (const m of it.text.matchAll(/\b(\d{1,2})\b/g)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 31) days.add(n);
    }
  }
  return days.size >= MIN_DAY_TOKENS;
}

/**
 * pdf.js ships its worker as an ES module, so it has to be handed over
 * as a real module Worker - `workerSrc` with a plain URL is loaded as a
 * classic worker and never comes up.
 *
 * One worker per document, torn down with it: destroying a loading task
 * closes the port it was given, so a shared worker would be dead for
 * every file after the first.
 */
function newPdfWorker(): Worker {
  return new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), {
    type: 'module',
  });
}

function textItems(content: { items: unknown[] }, viewportHeight: number): PdfTextItem[] {
  const items: PdfTextItem[] = [];
  for (const raw of content.items) {
    const it = raw as {
      str?: string;
      width?: number;
      height?: number;
      transform?: number[];
    };
    const text = (it.str ?? '').trim();
    if (!text) continue;
    const tr = it.transform ?? [1, 0, 0, 1, 0, 0];
    const x0 = tr[4];
    const w = it.width ?? 0;
    items.push({
      text,
      confidence: 1,
      x0,
      x1: x0 + w,
      // pdf.js y grows upwards; flip so it matches the canvas path.
      y: viewportHeight - tr[5],
      height: it.height ?? 0,
    });
  }
  return items;
}

/**
 * Open one page of a PDF: text layer (if usable) plus a downscaled
 * raster of the same page. Document, page and worker are all released
 * before returning.
 */
export async function openPdfRoster(
  file: File,
  pageNumber = 1,
  maxEdge = MAX_WORKING_EDGE,
): Promise<PdfRoster> {
  const buf = await file.arrayBuffer();
  const worker = newPdfWorker();
  pdfjs.GlobalWorkerOptions.workerPort = worker;
  const task = pdfjs.getDocument({ data: new Uint8Array(buf) });
  const doc = await task.promise;
  const page = await doc.getPage(Math.min(pageNumber, doc.numPages));

  try {
    // --- text layer ---------------------------------------------------
    const unit = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = textItems(content, unit.height);
    const textPage: PdfTextPage | null = hasMeaningfulRosterText(items)
      ? { kind: 'pdf-text', items, width: unit.width, height: unit.height, pageNumber }
      : null;

    // --- raster -------------------------------------------------------
    const scale = Math.min(2, maxEdge / Math.max(unit.width, unit.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    return {
      page: {
        kind: textPage ? 'pdf-text' : 'pdf-render',
        canvas,
        width: canvas.width,
        height: canvas.height,
      },
      textPage,
      numPages: doc.numPages,
    };
  } finally {
    page.cleanup();
    await task.destroy();
    worker.terminate();
    pdfjs.GlobalWorkerOptions.workerPort = null;
  }
}

/** Tokens of the text layer that fall inside a horizontal band. */
export function itemsInBand(
  page: PdfTextPage,
  yTop: number,
  yBottom: number,
): PdfTextItem[] {
  return page.items.filter((i) => i.y >= yTop && i.y <= yBottom);
}
