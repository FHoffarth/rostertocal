import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildIcsBlob,
  exportIcs,
  ICS_MIME,
  icsFilename,
  type ExportDeps,
} from '../lib/calendarExport';

const ICS = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';

interface Harness {
  deps: Partial<ExportDeps>;
  created: Blob[];
  revoked: string[];
  downloads: { url: string; filename: string }[];
  shared: ShareData[];
  timers: (() => void)[];
}

function harness(over: Partial<ExportDeps> = {}): Harness {
  const created: Blob[] = [];
  const revoked: string[] = [];
  const downloads: { url: string; filename: string }[] = [];
  const shared: ShareData[] = [];
  const timers: (() => void)[] = [];
  return {
    created,
    revoked,
    downloads,
    shared,
    timers,
    deps: {
      createObjectURL: (b) => {
        created.push(b);
        return `blob:mock/${created.length}`;
      },
      revokeObjectURL: (u) => void revoked.push(u),
      canShareFiles: () => false,
      share: async (d) => void shared.push(d),
      triggerDownload: (url, filename) => void downloads.push({ url, filename }),
      setTimeoutFn: (fn) => void timers.push(fn),
      revokeDelayMs: 0,
      ...over,
    },
  };
}

describe('buildIcsBlob', () => {
  it('uses the calendar MIME type', () => {
    const blob = buildIcsBlob(ICS);
    expect(blob.type).toBe(ICS_MIME);
    expect(blob.type).toContain('text/calendar');
    expect(blob.type).toContain('charset=utf-8');
  });

  it('preserves the payload byte-for-byte', async () => {
    expect(await buildIcsBlob(ICS).text()).toBe(ICS);
  });
});

describe('icsFilename', () => {
  it('names the file after the roster month', () => {
    expect(icsFilename('2026-08')).toBe('roster-2026-08.ics');
  });

  it('falls back for a missing or malformed month', () => {
    expect(icsFilename(undefined)).toBe('roster.ics');
    expect(icsFilename('nonsense')).toBe('roster.ics');
  });
});

describe('exportIcs - download path', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('falls back to a blob URL download when sharing is unavailable', async () => {
    const r = await exportIcs(ICS, 'roster-2026-08.ics', h.deps);
    expect(r.method).toBe('download');
    expect(r.fellBack).toBe(false);
    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0].filename).toBe('roster-2026-08.ics');
    expect(h.downloads[0].url).toBe(r.objectUrl);
  });

  it('never uses a data: URL', async () => {
    const r = await exportIcs(ICS, 'roster.ics', h.deps);
    expect(r.objectUrl?.startsWith('data:')).toBe(false);
    expect(r.objectUrl?.startsWith('blob:')).toBe(true);
  });

  it('creates the blob with the calendar MIME type', async () => {
    await exportIcs(ICS, 'roster.ics', h.deps);
    expect(h.created[0].type).toBe(ICS_MIME);
  });

  it('schedules object URL cleanup and revokes exactly what it created', async () => {
    const r = await exportIcs(ICS, 'roster.ics', h.deps);
    expect(h.revoked).toEqual([]);
    h.timers.forEach((fn) => fn());
    expect(h.revoked).toEqual([r.objectUrl]);
  });

  it('leaks no object URL across repeated exports', async () => {
    const urls: string[] = [];
    for (let i = 0; i < 3; i++) {
      urls.push((await exportIcs(ICS, 'roster.ics', h.deps)).objectUrl!);
    }
    h.timers.forEach((fn) => fn());
    expect(new Set(h.revoked)).toEqual(new Set(urls));
  });
});

describe('exportIcs - Web Share path', () => {
  it('shares a File when the platform supports file sharing', async () => {
    const h = harness({ canShareFiles: () => true });
    const r = await exportIcs(ICS, 'roster-2026-08.ics', h.deps);
    expect(r.method).toBe('share');
    expect(h.downloads).toHaveLength(0);
    expect(h.created).toHaveLength(0);
    const files = h.shared[0].files as File[];
    expect(files[0].name).toBe('roster-2026-08.ics');
    expect(files[0].type).toBe(ICS_MIME);
  });

  it('falls back to download when the share call rejects', async () => {
    const h = harness({
      canShareFiles: () => true,
      share: () => Promise.reject(new Error('NotAllowedError')),
    });
    const r = await exportIcs(ICS, 'roster.ics', h.deps);
    expect(r.method).toBe('download');
    expect(r.fellBack).toBe(true);
    expect(h.downloads).toHaveLength(1);
  });

  it('treats a user-dismissed share sheet as done, not as a failure', async () => {
    const abort = Object.assign(new Error('dismissed'), { name: 'AbortError' });
    const h = harness({ canShareFiles: () => true, share: () => Promise.reject(abort) });
    const r = await exportIcs(ICS, 'roster.ics', h.deps);
    expect(r.method).toBe('share');
    expect(h.downloads).toHaveLength(0);
  });

  it('falls back to download when canShare itself throws', async () => {
    const h = harness({
      canShareFiles: () => {
        throw new Error('boom');
      },
    });
    const r = await exportIcs(ICS, 'roster.ics', h.deps);
    expect(r.method).toBe('download');
    expect(h.downloads).toHaveLength(1);
  });
});

describe('exportIcs - no network', () => {
  it('performs no fetch while exporting', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const h = harness();
    await exportIcs(ICS, 'roster.ics', h.deps);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
