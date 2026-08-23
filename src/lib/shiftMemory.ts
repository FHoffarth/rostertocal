import type { ShiftDef } from '../models/shifts';

/**
 * Local shift-code memory. localStorage only - no sync, no profile,
 * no server. Everything here stays on the device.
 */

export const STORAGE_KEY = 'rostertocal.shiftMemory';
export const SCHEMA_VERSION = 1;

export interface ShiftMemoryPayload {
  version: number;
  defs: ShiftDef[];
  /** Optional alarm setting, minutes before start. null = no alarm. */
  alarmMinutesBefore: number | null;
}

export const DEFAULT_DEFS: ShiftDef[] = [
  { code: 'F', label: 'Fruehdienst', start: '06:00', end: '14:00', isOff: false },
  { code: 'F1', label: 'Fruehdienst 1', start: '06:00', end: '14:30', isOff: false },
  { code: 'S', label: 'Spaetdienst', start: '13:30', end: '22:00', isOff: false },
  { code: 'N', label: 'Nachtdienst', start: '22:00', end: '06:00', isOff: false },
  { code: 'OFF', label: 'Frei', start: '00:00', end: '00:00', isOff: true },
];

function isShiftDef(v: unknown): v is ShiftDef {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.code === 'string' &&
    o.code.length > 0 &&
    typeof o.label === 'string' &&
    typeof o.start === 'string' &&
    typeof o.end === 'string' &&
    typeof o.isOff === 'boolean'
  );
}

export function defaultPayload(): ShiftMemoryPayload {
  return {
    version: SCHEMA_VERSION,
    defs: DEFAULT_DEFS.map((d) => ({ ...d })),
    alarmMinutesBefore: null,
  };
}

/**
 * Read memory. Any malformed, truncated or future-version payload falls
 * back to defaults rather than throwing - a broken cache must never
 * block the flow. Pass `null` for `store` to run without persistence.
 */
export function loadShiftMemory(store: Storage | null = safeStorage()): ShiftMemoryPayload {
  if (!store) return defaultPayload();
  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return defaultPayload();
  }
  if (!raw) return defaultPayload();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultPayload();
  }
  if (typeof parsed !== 'object' || parsed === null) return defaultPayload();

  const o = parsed as Record<string, unknown>;
  if (o.version !== SCHEMA_VERSION) return defaultPayload();
  if (!Array.isArray(o.defs)) return defaultPayload();

  const defs = o.defs.filter(isShiftDef).map((d) => ({ ...d, code: d.code.toUpperCase() }));
  if (defs.length === 0) return defaultPayload();

  const alarm = o.alarmMinutesBefore;
  return {
    version: SCHEMA_VERSION,
    defs,
    alarmMinutesBefore: typeof alarm === 'number' && Number.isFinite(alarm) ? alarm : null,
  };
}

export function saveShiftMemory(
  payload: ShiftMemoryPayload,
  store: Storage | null = safeStorage(),
): boolean {
  if (!store) return false;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify({ ...payload, version: SCHEMA_VERSION }));
    return true;
  } catch {
    // Quota or private-mode failure: the flow continues without memory.
    return false;
  }
}

export function upsertDef(defs: ShiftDef[], def: ShiftDef): ShiftDef[] {
  const code = def.code.trim().toUpperCase();
  const next = defs.filter((d) => d.code.toUpperCase() !== code);
  next.push({ ...def, code });
  return next.sort((a, b) => a.code.localeCompare(b.code));
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
