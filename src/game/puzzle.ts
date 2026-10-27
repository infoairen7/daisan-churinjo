// 第３駐輪場 — 照合エンジン
// Port of the spec in 01_GAME_DESIGN.md §6–§8 (the original source/puzzle_engine.mjs was not
// recoverable from the delivered archive). Pure functions only: no DOM, no Math.random.

export type Color = 'red' | 'blue' | 'cream';
export type BikeType = 'city' | 'sport' | 'folding';
export type Tier = 'easy' | 'normal' | 'hard';
export type Row = 'A' | 'B';

export interface Bike {
  id: string;
  row: Row;
  slot: number;
  color: Color;
  type: BikeType;
  basket: boolean;
  occupied: true;
  isPlayer: false;
}

export interface FloorPuzzle {
  schemaVersion: 1;
  seed: number;
  floor: number;
  nextFloor: number;
  tier: Tier;
  templateId: string;
  bikes: Bike[];
  queries: string[];
  clue: string[];
  answer: number[];
  codeLength: number;
  scope: 'parked_only';
  fallback: boolean;
}

export interface RunData {
  schemaVersion: 1;
  seed: number;
  firstRun: boolean;
  tiers: Tier[];
  floors: FloorPuzzle[];
}

export interface Template { id: string; tier: Tier; queries: string[] }

export const TEMPLATES: Template[] = [
  { id: 'E01', tier: 'easy', queries: ['red'] },
  { id: 'E02', tier: 'easy', queries: ['basket'] },
  { id: 'E03', tier: 'easy', queries: ['folding'] },
  { id: 'E04', tier: 'easy', queries: ['row_a'] },
  { id: 'N01', tier: 'normal', queries: ['red_city'] },
  { id: 'N02', tier: 'normal', queries: ['blue_basket'] },
  { id: 'N03', tier: 'normal', queries: ['cream_no_basket'] },
  { id: 'N04', tier: 'normal', queries: ['city', 'sport'] },
  { id: 'H01', tier: 'hard', queries: ['red_city', 'blue_basket', 'cream_no_basket'] },
  { id: 'H02', tier: 'hard', queries: ['row_a_blue', 'row_b_city'] },
  { id: 'H03', tier: 'hard', queries: ['folding_no_basket', 'red_sport'] },
  { id: 'H04', tier: 'hard', queries: ['red', 'blue', 'cream'] },
];

interface QueryDef { label: string; test: (b: Bike) => boolean }

export const QUERIES: Record<string, QueryDef> = {
  red: { label: '赤い車', test: (b) => b.color === 'red' },
  blue: { label: '青い車', test: (b) => b.color === 'blue' },
  cream: { label: '白系の車', test: (b) => b.color === 'cream' },
  basket: { label: '前カゴがある車', test: (b) => b.basket },
  folding: { label: '小径折畳車', test: (b) => b.type === 'folding' },
  row_a: { label: 'Ａ列の車', test: (b) => b.row === 'A' },
  red_city: { label: '赤いシティ車', test: (b) => b.color === 'red' && b.type === 'city' },
  blue_basket: { label: '青く前カゴがある車', test: (b) => b.color === 'blue' && b.basket },
  cream_no_basket: { label: '白系で前カゴがない車', test: (b) => b.color === 'cream' && !b.basket },
  city: { label: 'シティ車', test: (b) => b.type === 'city' },
  sport: { label: 'スポーツ車', test: (b) => b.type === 'sport' },
  row_a_blue: { label: 'Ａ列の青い車', test: (b) => b.row === 'A' && b.color === 'blue' },
  row_b_city: { label: 'Ｂ列のシティ車', test: (b) => b.row === 'B' && b.type === 'city' },
  folding_no_basket: { label: '前カゴがない小径折畳車', test: (b) => b.type === 'folding' && !b.basket },
  red_sport: { label: '赤いスポーツ車', test: (b) => b.color === 'red' && b.type === 'sport' },
};

export const COLOR_LABEL: Record<Color, string> = { red: '赤', blue: '青', cream: '白系' };
export const COLOR_SHAPE: Record<Color, string> = { red: '丸', blue: '三角', cream: '四角' };
export const COLOR_SYMBOL: Record<Color, string> = { red: '○', blue: '△', cream: '□' };
export const TYPE_LABEL: Record<BikeType, string> = { city: 'シティ車', sport: 'スポーツ車', folding: '小径折畳車' };

export const FLOOR_ORDER = [5, 4, 3, 2];
export const MAX_ATTEMPTS = 256;

// ---------------------------------------------------------------- seeded RNG
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function shuffle<T>(rng: () => number, arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

// ---------------------------------------------------------------- generation
export function bikeId(row: Row, slot: number): string {
  return `${row}0${slot}`;
}

export function randomBikes(rng: () => number): Bike[] {
  const all: { row: Row; slot: number }[] = [];
  for (const row of ['A', 'B'] as Row[]) for (let s = 1; s <= 6; s++) all.push({ row, slot: s });
  const count = randInt(rng, 6, 10);
  const chosen = shuffle(rng, all).slice(0, count);
  chosen.sort((p, q) => (p.row === q.row ? p.slot - q.slot : p.row < q.row ? -1 : 1));
  return chosen.map(({ row, slot }) => {
    const color = pick(rng, ['red', 'blue', 'cream'] as Color[]);
    const r = rng();
    const type: BikeType = r < 0.5 ? 'city' : r < 0.75 ? 'sport' : 'folding';
    const basket = type === 'sport' ? false : rng() < (type === 'city' ? 0.6 : 0.4);
    return { id: bikeId(row, slot), row, slot, color, type, basket, occupied: true, isPlayer: false };
  });
}

export function countQuery(bikes: Bike[], q: string): number {
  const def = QUERIES[q];
  if (!def) throw new Error(`unknown query ${q}`);
  // The player's own bicycle (517) and empty slots never appear in `bikes`.
  return bikes.filter((b) => b.occupied && !b.isPlayer && def.test(b)).length;
}

export function computeAnswer(bikes: Bike[], queries: string[]): number[] {
  return queries.map((q) => countQuery(bikes, q));
}

export function clueLines(queries: string[]): string[] {
  return queries.map((q, i) => `${i + 1}. ${QUERIES[q].label}の台数`);
}

function fallbackFloor(seed: number, floor: number, tier: Tier): FloorPuzzle {
  const colors: Color[] = ['red', 'blue', 'red', 'blue', 'red', 'blue'];
  const slots: [Row, number][] = [['A', 1], ['A', 3], ['A', 5], ['B', 2], ['B', 4], ['B', 6]];
  const bikes: Bike[] = slots.map(([row, slot], i) => ({
    id: bikeId(row, slot), row, slot, color: colors[i], type: 'city', basket: i % 2 === 0,
    occupied: true, isPlayer: false,
  }));
  const queries = ['red'];
  return {
    schemaVersion: 1, seed, floor, nextFloor: floor - 1, tier, templateId: 'E01', bikes, queries,
    clue: clueLines(queries), answer: computeAnswer(bikes, queries), codeLength: 1,
    scope: 'parked_only', fallback: true,
  };
}

export function generateFloor(
  rng: () => number, seed: number, floor: number, tier: Tier, used: Set<string>,
): FloorPuzzle {
  let candidates = TEMPLATES.filter((t) => t.tier === tier && !used.has(t.id));
  if (candidates.length === 0) candidates = TEMPLATES.filter((t) => t.tier === tier);
  const tpl = pick(rng, candidates);
  used.add(tpl.id);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const bikes = randomBikes(rng);
    const answer = computeAnswer(bikes, tpl.queries);
    if (answer.every((n) => n >= 1 && n <= 5)) {
      return {
        schemaVersion: 1, seed, floor, nextFloor: floor - 1, tier, templateId: tpl.id, bikes,
        queries: tpl.queries.slice(), clue: clueLines(tpl.queries), answer,
        codeLength: tpl.queries.length, scope: 'parked_only', fallback: false,
      };
    }
  }
  return fallbackFloor(seed, floor, tier);
}

export function generateRun(seed: number, firstRun: boolean): RunData {
  const rng = mulberry32(seed);
  const tiers: Tier[] = firstRun
    ? ['easy', ...shuffle(rng, ['normal', 'normal', 'hard'] as Tier[])]
    : shuffle(rng, ['easy', 'normal', 'normal', 'hard'] as Tier[]);
  const used = new Set<string>();
  const floors = FLOOR_ORDER.map((floor, i) => generateFloor(rng, seed, floor, tiers[i], used));
  return { schemaVersion: 1, seed, firstRun, tiers, floors };
}

export function newSeed(): number {
  // Only called once, when 「はじめから」 is chosen. Everything else derives from the saved seed.
  const buf = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
  else buf[0] = (Date.now() * 2654435761) >>> 0;
  return (buf[0] % 900000) + 100000;
}

// ---------------------------------------------------------------- grading & progress
export interface Progress {
  currentFloor: number; // floor the car is at (5..1)
  resumeFloor: number; // floor to restart from after a failure
  wrongTotal: number;
  warningArmed: boolean;
  hasFailed: boolean;
}

export type CommitResult = 'incomplete' | 'correct' | 'warning' | 'fail';

export function isComplete(p: FloorPuzzle, input: number[]): boolean {
  return input.length === p.codeLength && input.every((d) => d >= 1 && d <= 5);
}

export function isCorrect(p: FloorPuzzle, input: number[]): boolean {
  return isComplete(p, input) && input.every((d, i) => d === p.answer[i]);
}

/** Pure transition for pressing 「開」 with the given input. */
export function commitAnswer(
  prog: Progress, p: FloorPuzzle, input: number[],
): { result: CommitResult; next: Progress } {
  if (!isComplete(p, input)) return { result: 'incomplete', next: { ...prog } };
  if (isCorrect(p, input)) {
    return {
      result: 'correct',
      next: { ...prog, warningArmed: false, currentFloor: p.nextFloor, resumeFloor: p.nextFloor },
    };
  }
  if (!prog.warningArmed) {
    return { result: 'warning', next: { ...prog, wrongTotal: prog.wrongTotal + 1, warningArmed: true } };
  }
  return {
    result: 'fail',
    next: { ...prog, wrongTotal: prog.wrongTotal + 1, hasFailed: true, resumeFloor: prog.currentFloor },
  };
}

/** 「この階から再開」: same floor & puzzle, warning cleared, history kept. */
export function resumeAfterFail(prog: Progress): Progress {
  return { ...prog, currentFloor: prog.resumeFloor, warningArmed: false };
}

export function endingFor(prog: Progress): 'secret' | 'normal' {
  return prog.wrongTotal === 0 && !prog.hasFailed ? 'secret' : 'normal';
}
