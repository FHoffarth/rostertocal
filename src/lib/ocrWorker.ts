import { createWorker, type Worker } from 'tesseract.js';
import type { OcrToken } from '../models/roster';

/**
 * One shared Tesseract worker for the whole session.
 *
 * Spawning a worker per recognition is the classic way to OOM a phone:
 * each one loads its own ~15 MB traineddata. We keep exactly one, and
 * expose an explicit terminate for teardown.
 */

let workerPromise: Promise<Worker> | null = null;

/**
 * All Tesseract assets are served from this origin (public/tesseract).
 * The library would otherwise pull worker, WASM core and the language
 * model from a public CDN on first use - no roster data in those
 * requests, but a third-party request all the same. Self-hosting keeps
 * the "stays on this device" promise literally true and lets the whole
 * flow work offline after first load.
 */
const ASSET_BASE = `${import.meta.env.BASE_URL}tesseract`;

export const OCR_ASSET_PATHS = {
  workerPath: `${ASSET_BASE}/worker.min.js`,
  corePath: `${ASSET_BASE}/`,
  langPath: `${ASSET_BASE}/lang`,
};

/**
 * How long to wait for the engine to come up. If the model file is
 * missing from the deployment the worker just never answers, and an
 * indefinite "Recognising..." is the worst possible failure - so the
 * wait is bounded and the user gets told.
 */
export const WORKER_START_TIMEOUT_MS = 45_000;

export async function getOcrWorker(): Promise<Worker> {
  if (!workerPromise) {
    const started = createWorker('eng', undefined, {
      ...OCR_ASSET_PATHS,
      // eng.traineddata.gz is stored gzipped next to the worker.
      gzip: true,
    });
    workerPromise = Promise.race([
      started,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                'The on-device recogniser did not start. Reload the page and try again.',
              ),
            ),
          WORKER_START_TIMEOUT_MS,
        ),
      ),
    ]);
    // A failed start must not be cached, or every later try fails too.
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

export async function terminateOcrWorker(): Promise<void> {
  if (!workerPromise) return;
  const w = await workerPromise.catch(() => null);
  workerPromise = null;
  if (w) await w.terminate().catch(() => undefined);
}

/** Digits only - the date strip can never contain a letter we care about. */
export const DATE_CHARSET = '0123456789';
/**
 * Restricted alphabet for shift cells; shrinks the OCR search space.
 * The separators stay in deliberately: a printed grid line is read as
 * one of them, and letting Tesseract say "that was a line" beats forcing
 * it to guess a letter. They are dropped again in `collectSymbols`.
 */
export const SHIFT_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/|-';

type PsmValue = string;
/** 6 = uniform block, 7 = single text line, 8 = single word. */
export const PSM_BLOCK: PsmValue = '6';
export const PSM_SINGLE_LINE: PsmValue = '7';
export const PSM_SINGLE_WORD: PsmValue = '8';

export interface RecognizeOptions {
  charset?: string;
  psm?: PsmValue;
  /**
   * 'symbol' returns one token per character. A roster row has no spaces
   * between cells - only printed grid lines - so Tesseract glues the
   * whole row into one "word". Characters carry their own x-extent, and
   * geometry puts them back into the right day.
   */
  granularity?: 'symbol' | 'word';
}

interface RawBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface RawSymbol {
  text: string;
  confidence: number;
  bbox: RawBox;
}

interface RawWord extends RawSymbol {
  symbols?: RawSymbol[];
}

/**
 * A glyph that spans the full height of the band is a printed rule, not
 * a character. Anything at or above this fraction is discarded.
 *
 * Note what this costs: when a real glyph *touches* a rule the two merge
 * into one full-height blob and the character is dropped with it, which
 * is how a cell reading "OFF" once came back as a lone, 99 %-confident
 * "F". Nothing here can tell the two cases apart, which is exactly why
 * the pipeline never trusts a single pass - see adjudicateCell.
 */
export const RULE_HEIGHT_RATIO = 0.85;

/** tesseract.js moved word data around across majors; handle both shapes. */
function collectWords(data: unknown): RawWord[] {
  const d = data as {
    words?: RawWord[];
    blocks?: {
      paragraphs?: { lines?: { words?: RawWord[] }[] }[];
    }[];
  };
  if (Array.isArray(d?.words) && d.words.length > 0) return d.words;
  const out: RawWord[] = [];
  for (const b of d?.blocks ?? []) {
    for (const p of b.paragraphs ?? []) {
      for (const l of p.lines ?? []) {
        for (const w of l.words ?? []) out.push(w);
      }
    }
  }
  return out;
}

/** Flatten to characters, dropping separators and printed rules. */
function collectSymbols(words: RawWord[], canvasHeight: number): RawSymbol[] {
  const out: RawSymbol[] = [];
  for (const w of words) {
    for (const s of w.symbols ?? []) {
      const text = (s.text ?? '').trim();
      if (!/^[A-Za-z0-9]$/.test(text)) continue;
      const h = (s.bbox?.y1 ?? 0) - (s.bbox?.y0 ?? 0);
      if (h >= canvasHeight * RULE_HEIGHT_RATIO) continue;
      out.push({ ...s, text });
    }
  }
  return out;
}

/**
 * Recognise one cropped canvas and return tokens with their horizontal
 * extent *in the coordinates of that canvas*. Callers translate back
 * into source pixels.
 */
export async function recognizeStrip(
  canvas: HTMLCanvasElement,
  opts: RecognizeOptions = {},
): Promise<OcrToken[]> {
  const worker = await getOcrWorker();
  await worker.setParameters({
    tessedit_char_whitelist: opts.charset ?? SHIFT_CHARSET,
    tessedit_pageseg_mode: (opts.psm ?? PSM_BLOCK) as never,
  });
  const result = await worker.recognize(canvas, {}, { blocks: true });
  const words = collectWords(result.data);
  const raw =
    opts.granularity === 'word'
      ? words.filter((w) => (w.text ?? '').trim().length > 0)
      : collectSymbols(words, canvas.height);

  return raw.map((t) => ({
    text: t.text.trim(),
    // tesseract reports 0..100.
    confidence: Math.max(0, Math.min(1, (t.confidence ?? 0) / 100)),
    x0: t.bbox?.x0 ?? 0,
    x1: t.bbox?.x1 ?? 0,
    y0: t.bbox?.y0 ?? 0,
    y1: t.bbox?.y1 ?? 0,
  }));
}

/** Scale token x-coordinates from a cropped/upscaled canvas back to source px. */
export function tokensToSourceSpace(
  tokens: OcrToken[],
  cropX: number,
  upscale: number,
): OcrToken[] {
  return tokens.map((t) => ({
    ...t,
    x0: cropX + t.x0 / upscale,
    x1: cropX + t.x1 / upscale,
  }));
}
