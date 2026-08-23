import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DEFS,
  loadShiftMemory,
  saveShiftMemory,
  SCHEMA_VERSION,
  STORAGE_KEY,
  upsertDef,
  defaultPayload,
} from '../lib/shiftMemory';

function memStore(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  } as Storage;
}

let store: Storage;
beforeEach(() => {
  store = memStore();
});

describe('shift memory persistence', () => {
  it('returns defaults on a cold start', () => {
    const p = loadShiftMemory(store);
    expect(p.version).toBe(SCHEMA_VERSION);
    expect(p.defs.map((d) => d.code)).toEqual(DEFAULT_DEFS.map((d) => d.code));
    expect(p.alarmMinutesBefore).toBeNull();
  });

  it('round-trips a saved payload', () => {
    const p = defaultPayload();
    p.defs = upsertDef(p.defs, {
      code: 'z1',
      label: 'Zwischendienst',
      start: '09:00',
      end: '17:00',
      isOff: false,
    });
    p.alarmMinutesBefore = 30;
    expect(saveShiftMemory(p, store)).toBe(true);
    const back = loadShiftMemory(store);
    expect(back.alarmMinutesBefore).toBe(30);
    expect(back.defs.find((d) => d.code === 'Z1')?.start).toBe('09:00');
  });

  it('writes a schema version into the payload', () => {
    saveShiftMemory(defaultPayload(), store);
    expect(JSON.parse(store.getItem(STORAGE_KEY)!).version).toBe(SCHEMA_VERSION);
  });
});

describe('failing safely on bad data', () => {
  const bad = ['not json at all', '{', 'null', '[]', '"string"', '123'];
  it.each(bad)('falls back to defaults for %s', (raw) => {
    store.setItem(STORAGE_KEY, raw);
    expect(loadShiftMemory(store).defs.length).toBe(DEFAULT_DEFS.length);
  });

  it('ignores a payload from an unknown schema version', () => {
    store.setItem(STORAGE_KEY, JSON.stringify({ version: 99, defs: [{ code: 'Q' }] }));
    expect(loadShiftMemory(store).defs.map((d) => d.code)).toEqual(
      DEFAULT_DEFS.map((d) => d.code),
    );
  });

  it('drops malformed individual definitions', () => {
    store.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: SCHEMA_VERSION,
        defs: [
          { code: 'A', label: 'ok', start: '06:00', end: '14:00', isOff: false },
          { code: 'B' },
          null,
          42,
        ],
        alarmMinutesBefore: 'soon',
      }),
    );
    const p = loadShiftMemory(store);
    expect(p.defs.map((d) => d.code)).toEqual(['A']);
    expect(p.alarmMinutesBefore).toBeNull();
  });

  it('survives a storage that throws (private mode)', () => {
    const hostile = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    } as unknown as Storage;
    expect(loadShiftMemory(hostile).defs.length).toBe(DEFAULT_DEFS.length);
    expect(saveShiftMemory(defaultPayload(), hostile)).toBe(false);
  });

  it('works when there is no storage at all', () => {
    expect(loadShiftMemory(null).defs.length).toBe(DEFAULT_DEFS.length);
    expect(saveShiftMemory(defaultPayload(), null)).toBe(false);
  });
});

describe('upsertDef', () => {
  it('replaces by code, case-insensitively', () => {
    const next = upsertDef(DEFAULT_DEFS, {
      code: 'n',
      label: 'Nacht neu',
      start: '21:45',
      end: '06:15',
      isOff: false,
    });
    expect(next.filter((d) => d.code === 'N')).toHaveLength(1);
    expect(next.find((d) => d.code === 'N')?.start).toBe('21:45');
    expect(next).toHaveLength(DEFAULT_DEFS.length);
  });

  it('adds a new custom code', () => {
    const next = upsertDef(DEFAULT_DEFS, {
      code: 'BD',
      label: 'Bereitschaft',
      start: '18:00',
      end: '08:00',
      isOff: false,
    });
    expect(next).toHaveLength(DEFAULT_DEFS.length + 1);
  });
});
