// localStorage wrapper. Every access is guarded: private windows, previews and blocked
// storage must not break the game (spec §16: continue in-session and tell the player once).
import type { FloorPuzzle } from './puzzle';

export type Phase =
  | 'INTRO' | 'PAID' | 'BLACKOUT' | 'LOCKED' | 'AUTHENTICATED' | 'EXPLORE' | 'INPUT' | 'WARNING'
  | 'TRANSIT' | 'FAIL_REVEAL' | 'GAMEOVER' | 'EXIT' | 'NORMAL_END' | 'SECRET_END';

export interface MemoEntry { id: string; row: string; color: string; type: string; basket: boolean }

export interface SaveData {
  version: 1;
  runId: string;
  seed: number;
  firstRun: boolean;
  generatedFloors: FloorPuzzle[];
  currentFloor: number;
  resumeFloor: number;
  phase: Phase;
  wrongTotal: number;
  warningArmed: boolean;
  hasFailed: boolean;
  flags: {
    bikeUnlocked: boolean;
    paid: boolean;
    receiptAuth: boolean;
    wheelDocked: boolean;
    authenticated: boolean;
    memoUnlocked: boolean;
  };
  memo: Record<string, MemoEntry[]>;
  items: string[];
  savedAt: number;
}

export interface Settings {
  master: number;
  sfx: number;
  amb: number;
  music: number;
  jumpScare: boolean;
  reduceFlash: boolean;
  subtitles: boolean;
  largeText: boolean;
  quality: 'low' | 'mid' | 'high';
  caretakerHi: boolean;
  /** null = follow the browser language */
  lang: 'ja' | 'en' | null;
  /** the content notice has been shown once */
  warned: boolean;
}

export interface Records { normal: boolean; secret: boolean; completedRuns: number }

const KEY_SAVE = 'parking3.save.v1';
const KEY_SETTINGS = 'parking3.settings.v1';
const KEY_RECORDS = 'parking3.records.v1';

export const DEFAULT_SETTINGS: Settings = {
  master: 0.7, sfx: 1, amb: 1, music: 0.8, jumpScare: true, reduceFlash: true, subtitles: true, largeText: false, quality: 'mid', caretakerHi: false, lang: null, warned: false,
};

let storageOk: boolean | null = null;
const memory = new Map<string, string>();

function probe(): boolean {
  if (storageOk !== null) return storageOk;
  try {
    const k = '__p3_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    storageOk = true;
  } catch { storageOk = false; }
  return storageOk;
}

export function storageAvailable(): boolean { return probe(); }

function read<T>(key: string): T | null {
  let raw: string | null = null;
  if (probe()) { try { raw = localStorage.getItem(key); } catch { raw = null; } }
  if (raw === null) raw = memory.get(key) ?? null;
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function write(key: string, value: unknown) {
  const raw = JSON.stringify(value);
  memory.set(key, raw);
  if (probe()) { try { localStorage.setItem(key, raw); } catch { storageOk = false; } }
}

function remove(key: string) {
  memory.delete(key);
  if (probe()) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
}

export function loadSave(): SaveData | null {
  const s = read<SaveData>(KEY_SAVE);
  if (!s || s.version !== 1 || !Array.isArray(s.generatedFloors) || s.generatedFloors.length !== 4) return null;
  return s;
}
export function writeSave(s: SaveData) { s.savedAt = Date.now(); write(KEY_SAVE, s); }
export function clearSave() { remove(KEY_SAVE); }

export function loadSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...(read<Partial<Settings>>(KEY_SETTINGS) || {}) };
}
export function writeSettings(s: Settings) { write(KEY_SETTINGS, s); }

export function loadRecords(): Records {
  return { normal: false, secret: false, completedRuns: 0, ...(read<Partial<Records>>(KEY_RECORDS) || {}) };
}
export function writeRecords(r: Records) { write(KEY_RECORDS, r); }
