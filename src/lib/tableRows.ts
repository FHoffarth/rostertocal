/**
 * Header-anchored extraction of a printed table into raw evidence rows.
 *
 * Crew rosters are not the horizontal day-grid this app was first built
 * for. They are vertical tables with a printed header - Day, Pairing,
 * Duty, Start, End, ... - and one or more rows per calendar day.
 *
 * The same principle applies as everywhere else here: geometry owns the
 * mapping. The *printed header* decides which column a piece of text
 * belongs to. Text never decides that for itself, and a token that falls
 * in no column is reported as unassigned rather than nudged into the
 * nearest one.
 *
 * This module extracts. It does not interpret. It has no idea what a
 * "duty" is, what "C132" means, whether 20:30 is a report time, or which
 * timezone anything is in - and it must stay that way, because those
 * answers differ per airline and guessing them is how wrong calendar
 * entries get made.
 */

/** Minimal shape; PdfTextItem from the PDF text layer satisfies it. */
export interface TableTextItem {
  text: string;
  x0: number;
  x1: number;
  /** Baseline y, top-down. */
  y: number;
  height?: number;
}

export interface TableColumn {
  /** The header label exactly as printed. */
  name: string;
  /** Boundaries in source x, midway to the neighbouring headers. */
  x0: number;
  x1: number;
  /** Where the header label itself sat. */
  headerX0: number;
  headerX1: number;
}

export interface TableRow {
  /** Text found under each column header, joined left to right. */
  cells: Record<string, string>;
  /** Baseline y of the line that opened this row. */
  y: number;
  /** How many printed lines were folded into this row. */
  lineCount: number;
}

export interface TableExtraction {
  ok: boolean;
  columns: TableColumn[];
  rows: TableRow[];
  /** Text that sat under no column. Never silently reassigned. */
  unassigned: TableTextItem[];
  /** Expected headers that were not found on the header line. */
  missingHeaders: string[];
  /** Developer-only. */
  diagnostic?: string;
}

/** Lines closer together than this share of a line height are one line. */
export const LINE_TOLERANCE_RATIO = 0.6;

/**
 * How many labels must match before a line is even *considered* the
 * header. Locating the line is allowed to be lenient; trusting its
 * column map is not - see the all-labels rule in extractTableRows.
 */
export const MIN_HEADER_MATCHES = 3;

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Group items into printed lines by baseline proximity.
 *
 * Tolerance comes from the median glyph height rather than a constant,
 * so it holds whatever size the roster was rendered at.
 */
export function groupIntoLines(items: TableTextItem[]): TableTextItem[][] {
  if (items.length === 0) return [];
  const heights = items
    .map((i) => i.height ?? 0)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  const tolerance = Math.max(1, medianHeight * LINE_TOLERANCE_RATIO);

  const sorted = [...items].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const lines: TableTextItem[][] = [];
  let current: TableTextItem[] = [];
  let anchorY = Number.NaN;

  for (const item of sorted) {
    if (current.length === 0 || Math.abs(item.y - anchorY) <= tolerance) {
      if (current.length === 0) anchorY = item.y;
      current.push(item);
    } else {
      lines.push(current.sort((a, b) => a.x0 - b.x0));
      current = [item];
      anchorY = item.y;
    }
  }
  if (current.length) lines.push(current.sort((a, b) => a.x0 - b.x0));
  return lines;
}

/**
 * Find the printed header line and turn it into column boundaries.
 *
 * Boundaries sit midway between neighbouring header labels; the first
 * and last extend outward by half their own span. A multi-word header
 * ("Length sch/act") is matched by its words appearing adjacently on the
 * header line.
 */
export function findColumns(
  lines: TableTextItem[][],
  headerLabels: string[],
): { columns: TableColumn[]; headerLineIndex: number } | null {
  const wanted = headerLabels.map((h) => ({ label: h, words: normalise(h).split(' ') }));

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const found: { name: string; x0: number; x1: number }[] = [];

    for (const { label, words } of wanted) {
      for (let i = 0; i + words.length <= line.length; i++) {
        const slice = line.slice(i, i + words.length);
        if (slice.every((item, k) => normalise(item.text) === words[k])) {
          found.push({
            name: label,
            x0: slice[0].x0,
            x1: slice[slice.length - 1].x1,
          });
          break;
        }
      }
    }

    if (found.length < MIN_HEADER_MATCHES) continue;

    found.sort((a, b) => a.x0 - b.x0);
    const columns: TableColumn[] = found.map((f, i) => {
      const prev = found[i - 1];
      const next = found[i + 1];
      const halfSelf = (f.x1 - f.x0) / 2;
      return {
        name: f.name,
        headerX0: f.x0,
        headerX1: f.x1,
        x0: prev ? (prev.x1 + f.x0) / 2 : f.x0 - halfSelf,
        x1: next ? (f.x1 + next.x0) / 2 : f.x1 + halfSelf,
      };
    });
    return { columns, headerLineIndex: li };
  }
  return null;
}

function columnFor(columns: TableColumn[], item: TableTextItem): TableColumn | null {
  const centre = (item.x0 + item.x1) / 2;
  return columns.find((c) => centre >= c.x0 && centre < c.x1) ?? null;
}

function emptyCells(columns: TableColumn[]): Record<string, string> {
  const cells: Record<string, string> = {};
  for (const c of columns) cells[c.name] = '';
  return cells;
}

function addToCells(
  cells: Record<string, string>,
  columns: TableColumn[],
  line: TableTextItem[],
  unassigned: TableTextItem[],
): void {
  for (const item of line) {
    const col = columnFor(columns, item);
    if (!col) {
      unassigned.push(item);
      continue;
    }
    cells[col.name] = cells[col.name] ? `${cells[col.name]} ${item.text}` : item.text;
  }
}

export interface ExtractOptions {
  /** Header labels to look for, exactly as printed. */
  headerLabels: string[];
  /**
   * The column whose presence starts a new row. A printed line with no
   * text in this column is a wrapped continuation of the row above -
   * which is how a long activity sequence spills onto a second line.
   */
  rowAnchorColumn: string;
}

/**
 * Extract raw rows. Every value is the text as printed; blank stays
 * blank. Nothing is parsed, completed or inferred.
 */
export function extractTableRows(
  items: TableTextItem[],
  options: ExtractOptions,
): TableExtraction {
  const lines = groupIntoLines(items);
  const header = findColumns(lines, options.headerLabels);

  if (!header) {
    return {
      ok: false,
      columns: [],
      rows: [],
      unassigned: [],
      missingHeaders: [...options.headerLabels],
      diagnostic: `no header line matched at least ${MIN_HEADER_MATCHES} of: ${options.headerLabels.join(', ')}`,
    };
  }

  const { columns, headerLineIndex } = header;
  const missingHeaders = options.headerLabels.filter(
    (label) => !columns.some((c) => c.name === label),
  );

  /**
   * Every expected header must be present, not merely enough of them.
   *
   * Column boundaries are midpoints between the headers that *were*
   * found, so a header the recogniser missed does not leave a gap - its
   * territory is absorbed by its neighbours, and the values printed
   * under it are then reported inside the wrong column with no sign
   * that anything went wrong. Observed on a low-resolution roster
   * render: with "Length sch/act" undetected, its values were served up
   * inside the "End" cell.
   *
   * Wrong evidence presented confidently is the one outcome worse than
   * no evidence, so a partial header map fails closed.
   */
  if (missingHeaders.length > 0) {
    return {
      ok: false,
      columns,
      rows: [],
      unassigned: [],
      missingHeaders,
      diagnostic: `header line found but ${missingHeaders.length} column(s) were not located: ${missingHeaders.join(', ')} - the remaining columns would absorb their values`,
    };
  }

  if (!columns.some((c) => c.name === options.rowAnchorColumn)) {
    return {
      ok: false,
      columns,
      rows: [],
      unassigned: [],
      missingHeaders,
      diagnostic: `row anchor column "${options.rowAnchorColumn}" is not among the headers found`,
    };
  }

  const rows: TableRow[] = [];
  const unassigned: TableTextItem[] = [];

  for (const line of lines.slice(headerLineIndex + 1)) {
    const probe = emptyCells(columns);
    const probeUnassigned: TableTextItem[] = [];
    addToCells(probe, columns, line, probeUnassigned);

    const opensRow = probe[options.rowAnchorColumn].trim() !== '';

    if (opensRow || rows.length === 0) {
      // A line before the first anchor has no row to belong to; keeping
      // it would attach page furniture to roster data.
      if (!opensRow) {
        unassigned.push(...line);
        continue;
      }
      rows.push({ cells: probe, y: line[0].y, lineCount: 1 });
      unassigned.push(...probeUnassigned);
      continue;
    }

    // Continuation: fold into the row above, column by column.
    const target = rows[rows.length - 1];
    for (const c of columns) {
      const extra = probe[c.name];
      if (!extra) continue;
      target.cells[c.name] = target.cells[c.name]
        ? `${target.cells[c.name]} ${extra}`
        : extra;
    }
    target.lineCount += 1;
    unassigned.push(...probeUnassigned);
  }

  return { ok: true, columns, rows, unassigned, missingHeaders };
}
