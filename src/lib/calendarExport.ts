/**
 * Handing the .ics file to the device.
 *
 * We deliberately do NOT use data:text/calendar;base64 as the primary
 * mechanism: several mobile browsers refuse to navigate to data: URLs,
 * and base64 payloads inflate memory for a whole month of events.
 *
 * What actually happens after the file leaves the page is platform
 * dependent. This module reports which mechanism it used; it does not
 * claim the calendar imported anything.
 */

export const ICS_MIME = 'text/calendar;charset=utf-8';

export type ExportMethod = 'share' | 'download';

export interface ExportDeps {
  createObjectURL: (b: Blob) => string;
  revokeObjectURL: (u: string) => void;
  canShareFiles: (files: File[]) => boolean;
  share: (data: ShareData) => Promise<void>;
  triggerDownload: (url: string, filename: string) => void;
  /** ms to keep the object URL alive before revoking. */
  revokeDelayMs: number;
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
}

export interface ExportResult {
  method: ExportMethod;
  filename: string;
  /** Object URL used for the download path; undefined on the share path. */
  objectUrl?: string;
  /** True when a share attempt failed and we fell back to download. */
  fellBack: boolean;
}

export function buildIcsBlob(ics: string): Blob {
  return new Blob([ics], { type: ICS_MIME });
}

/** "2026-08" -> "roster-2026-08.ics". Falls back to a generic name. */
export function icsFilename(month?: string): string {
  return /^\d{4}-\d{2}$/.test(month ?? '') ? `roster-${month}.ics` : 'roster.ics';
}

function defaultDeps(): ExportDeps {
  return {
    createObjectURL: (b) => URL.createObjectURL(b),
    revokeObjectURL: (u) => URL.revokeObjectURL(u),
    canShareFiles: (files) => {
      const nav = navigator as Navigator & {
        canShare?: (d: ShareData) => boolean;
      };
      return (
        typeof nav.share === 'function' &&
        typeof nav.canShare === 'function' &&
        nav.canShare({ files })
      );
    },
    share: (data) => navigator.share(data),
    triggerDownload: (url, filename) => {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    revokeDelayMs: 60_000,
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
  };
}

/**
 * Strategy A: Web Share with a File (iOS/Android "Add to Calendar" sheet).
 * Strategy B: blob URL + download anchor.
 * The caller is expected to also render a visible "Save calendar file"
 * fallback, because both paths can be silently ignored by the OS.
 */
export async function exportIcs(
  ics: string,
  filename: string,
  overrides: Partial<ExportDeps> = {},
): Promise<ExportResult> {
  const deps = { ...defaultDeps(), ...overrides };
  const blob = buildIcsBlob(ics);
  let fellBack = false;

  if (typeof File === 'function') {
    const file = new File([blob], filename, { type: ICS_MIME });
    let shareable = false;
    try {
      shareable = deps.canShareFiles([file]);
    } catch {
      shareable = false;
    }
    if (shareable) {
      try {
        await deps.share({ files: [file], title: filename });
        return { method: 'share', filename, fellBack: false };
      } catch (err) {
        // AbortError means the user dismissed the sheet on purpose.
        if ((err as Error)?.name === 'AbortError') {
          return { method: 'share', filename, fellBack: false };
        }
        fellBack = true;
      }
    }
  }

  const url = deps.createObjectURL(blob);
  deps.triggerDownload(url, filename);
  deps.setTimeoutFn(() => deps.revokeObjectURL(url), deps.revokeDelayMs);
  return { method: 'download', filename, objectUrl: url, fellBack };
}
