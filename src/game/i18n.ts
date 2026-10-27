// Two languages, chosen at runtime. Every player-facing string is written as L('日本語', 'English') at its call site,
// so the two versions stay side by side. Puzzle data keeps its Japanese labels (they are part of the saved run);
// what the player reads is rebuilt from the query ids in the current language.
import type { Color, BikeType, Row } from './puzzle';
import { QUERIES } from './puzzle';

export type Lang = 'ja' | 'en';

let cur: Lang = 'ja';
const listeners: (() => void)[] = [];

export const lang = (): Lang => cur;
export const isEn = () => cur === 'en';
export function L(ja: string, en: string): string { return cur === 'en' ? en : ja; }

export function setLang(l: Lang) {
  if (l === cur) return;
  cur = l;
  try { document.documentElement.lang = l; } catch { /* no DOM in tests */ }
  for (const f of listeners) f();
}
export function onLangChange(f: () => void) { listeners.push(f); }

/** ?lang=en|ja wins (shareable links), then the saved choice, then the browser language. */
export function detectLang(saved?: Lang | null): Lang {
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'en' || q === 'ja') return q;
  } catch { /* ignore */ }
  if (saved === 'en' || saved === 'ja') return saved;
  try {
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'ja';
    return nav.toLowerCase().startsWith('ja') ? 'ja' : 'en';
  } catch { return 'ja'; }
}

export const GAME_TITLE = () => L('第３駐輪場', 'Bicycle Parking No.3');

// ---------------------------------------------------------------- puzzle vocabulary
const QUERY_EN: Record<string, string> = {
  red: 'red bicycles', blue: 'blue bicycles', cream: 'white bicycles', basket: 'bicycles with a front basket',
  folding: 'folding bicycles', row_a: 'bicycles in Row A', red_city: 'red city bikes', blue_basket: 'blue bicycles with a basket',
  cream_no_basket: 'white bicycles without a basket', city: 'city bikes', sport: 'sport bikes', row_a_blue: 'blue bicycles in Row A',
  row_b_city: 'city bikes in Row B', folding_no_basket: 'folding bicycles without a basket', red_sport: 'red sport bikes',
};
export const queryLabel = (q: string) => (cur === 'en' ? QUERY_EN[q] ?? q : QUERIES[q]?.label ?? q);
/** Checklist lines, numbered, in the current language. */
export const clueText = (queries: string[]) =>
  queries.map((q, i) => (cur === 'en' ? `${i + 1}. Number of ${queryLabel(q)}` : `${i + 1}. ${queryLabel(q)}の台数`));

export const colorLabel = (c: Color | string) => L(({ red: '赤', blue: '青', cream: '白系' } as any)[c], ({ red: 'Red', blue: 'Blue', cream: 'White' } as any)[c]);
export const shapeLabel = (c: Color | string) => L(({ red: '丸', blue: '三角', cream: '四角' } as any)[c], ({ red: 'circle', blue: 'triangle', cream: 'square' } as any)[c]);
export const typeLabel = (t: BikeType | string) => L(({ city: 'シティ車', sport: 'スポーツ車', folding: '小径折畳車' } as any)[t], ({ city: 'City bike', sport: 'Sport bike', folding: 'Folding bike' } as any)[t]);
export const rowLabel = (r: Row | string) => L(r === 'A' ? 'Ａ列' : 'Ｂ列', r === 'A' ? 'Row A' : 'Row B');
export const basketLabel = (b: boolean) => L(b ? 'あり' : 'なし', b ? 'Yes' : 'No');
