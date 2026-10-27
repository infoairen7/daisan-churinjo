// HTML HUD and overlays. Keyboard: W/S/A/D or arrows move focus, Space/Enter select, Esc close.
// Touch: selection items need a double tap (same item, ≤320 ms, ≤20 px); nav buttons are single taps.
import { UI } from './ui_assets.gen';
import type { FloorPuzzle } from './puzzle';
import type { Bike } from './puzzle';
import type { MemoEntry, Settings, Records } from './save';
import { L, isEn, GAME_TITLE, clueText, colorLabel, shapeLabel, typeLabel, rowLabel, basketLabel } from './i18n';

const S_JA = {
  title: '第３駐輪場', newGame: 'はじめから', cont: 'つづきから', settings: '設定', tools: '道具', use: '使う', inspect: '調べる',
  close: '閉じる', confirm: '開', clear: '閉', reinspect: '再点検',
  warning: '照合できませんでした。次の誤答で管理人が来ます。調べ直せます。',
  incomplete: '必要な桁数を入力してください', failed: '管理人と目が合った。', retry: 'この階から再開',
  retryNote: '再開しても誤答の記録は残ります', normalEnd: '帰宅', clearEn: 'GAME CLEAR', secretLine: 'この駐輪場を使うのはやめよう',
  scope: 'Ａ・Ｂ列の駐輪車のみ。自分の自転車・空き枠は除外。', authHint: '運搬認証口に票を通し、前輪をレールへ合わせる。',
  wrongTarget: 'ここでは使えない', tooFar: 'もう少し近づこう', pcHint: 'SPACEで調べる', touchHint: '同じ対象をダブルタップで調べる',
  noSave: 'この環境では中断保存できません', toTitle: 'タイトルへ', again: 'もう一度', share: 'Xでポスト',
  recNormal: '帰宅', recSecret: '使うのはやめよう',
};
const S_EN: Record<keyof typeof S_JA, string> = {
  title: 'Bicycle Parking No.3', newGame: 'New Game', cont: 'Continue', settings: 'Settings', tools: 'Items', use: 'Use', inspect: 'Inspect',
  close: 'Close', confirm: 'OPEN', clear: 'CLOSE', reinspect: 'Recheck',
  warning: 'Check failed. One more wrong answer and the caretaker will come. You can look again.',
  incomplete: 'Enter every digit first.', failed: 'You met the caretaker\'s eyes.', retry: 'Retry this floor',
  retryNote: 'Your wrong answers stay on record.', normalEnd: 'HOME', clearEn: 'GAME CLEAR', secretLine: 'I should stop using this parking lot.',
  scope: 'Rows A and B only. Your own bicycle and empty slots don\'t count.', authHint: 'Insert the receipt into the reader and set the front wheel on the rail.',
  wrongTarget: 'Can\'t use that here.', tooFar: 'Get a little closer.', pcHint: 'SPACE to inspect', touchHint: 'Double-tap something to inspect it',
  noSave: 'Progress can\'t be saved in this browser', toTitle: 'Title', again: 'Play again', share: 'Post on X',
  recNormal: 'Home', recSecret: 'Never again',
};
/** Reads the current language on every access. */
export const S = new Proxy(S_JA, { get: (t, k) => (isEn() ? (S_EN as any)[k] : (t as any)[k]) }) as Record<keyof typeof S_JA, string>;

interface ItemInfo { name: string; icon: string; desc: string; usable: boolean }
const itemInfo = (id: string): ItemInfo => {
  switch (id) {
    case 'key': return { name: L('自転車の鍵', 'Bike key'), icon: 'key', desc: L('517番の自転車の鍵。後輪の錠を外せる。', 'The key to bicycle 517. It opens the rear wheel lock.'), usable: true };
    case 'receipt': return { name: L('精算済票', 'Paid receipt'), icon: 'receipt', desc: L('５Ｆの精算機で受け取った票。保管階５Ｆ、保管番号517。', 'From the 5F payment machine. Floor 5F, space 517.'), usable: true };
    case 'light': return { name: L('スマホライト', 'Phone light'), icon: 'light', desc: L('手元を照らす。電池は気にしなくていい。', 'Lights up what\'s in front of you. The battery is fine.'), usable: true };
    default: return { name: L('観察メモ', 'Notes'), icon: 'note', desc: L('調べた自転車の色・種類・前カゴを記録する。台数は数えてくれない。', 'Records the color, type and basket of each bicycle you inspect. It won\'t count them for you.'), usable: true };
  }
};
export const ITEM_INFO = new Proxy({} as Record<string, ItemInfo>, { get: (_, k) => itemInfo(String(k)) });

type Handler = () => void;
interface Overlay { el: HTMLElement; onClose?: Handler; modal: boolean; name: string }

const icon = (name: string, cls = 'ico') => `<img class="${cls}" src="${UI[name]}" alt="" aria-hidden="true">`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export class GameUI {
  root: HTMLElement;
  hud: HTMLElement;
  layer: HTMLElement;
  fadeEl: HTMLElement;
  stack: Overlay[] = [];
  touch = false;
  subtitles = true;
  private toastTimer = 0;
  private captionTimer = 0;
  private armed: { el: HTMLElement; t: number; x: number; y: number } | null = null;
  onToolsButton: Handler = () => {};
  onPauseButton: Handler = () => {};

  constructor(root: HTMLElement) {
    this.root = root;
    this.hud = root.querySelector('#hud')!;
    this.layer = root.querySelector('#overlays')!;
    this.fadeEl = root.querySelector('#fade')!;
    this.hud.querySelector<HTMLElement>('#btn-tools')!.addEventListener('click', (e) => { e.stopPropagation(); this.onToolsButton(); });
    this.hud.querySelector<HTMLElement>('#btn-pause')!.addEventListener('click', (e) => { e.stopPropagation(); this.onPauseButton(); });
    // icons for static markup
    root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon!) + el.innerHTML; });
    // global delegated activation for overlay buttons (mouse = click, touch = double tap on [data-dbl])
    this.layer.addEventListener('pointerup', (e) => this.pointerActivate(e));
    this.layer.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button');
      if (b && (e as PointerEvent).pointerType === undefined && e.detail === 0) return; // keyboard-synthesised clicks handled elsewhere
    });
    for (const ev of ['touchend', 'dblclick'] as const) this.layer.addEventListener(ev, (e) => { if ((e.target as HTMLElement).closest('button')) e.preventDefault(); }, { passive: false });
  }

  // ------------------------------------------------------------- activation helpers
  private pointerActivate(e: PointerEvent) {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b || b.disabled || !this.layer.contains(b)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.pointerType !== 'mouse' && b.hasAttribute('data-dbl')) {
      const now = performance.now();
      if (this.armed && this.armed.el === b && now - this.armed.t <= 320 && Math.hypot(e.clientX - this.armed.x, e.clientY - this.armed.y) <= 20) {
        this.armed.el.classList.remove('is-armed'); this.armed = null;
        this.activate(b);
      } else {
        this.armed?.el.classList.remove('is-armed');
        this.armed = { el: b, t: now, x: e.clientX, y: e.clientY };
        b.classList.add('is-armed');
        this.focus(b);
        window.setTimeout(() => { if (this.armed?.el === b && performance.now() - this.armed.t > 320) { b.classList.remove('is-armed'); this.armed = null; } }, 360);
      }
      return;
    }
    this.focus(b);
    this.activate(b);
  }
  private activate(b: HTMLElement) {
    b.classList.add('is-pressed'); window.setTimeout(() => b.classList.remove('is-pressed'), 140);
    (b as any).__act?.();
  }
  private bind(b: HTMLElement | null, fn: Handler) { if (b) (b as any).__act = fn; }
  focus(b: HTMLElement | null) {
    if (!b) return;
    this.top()?.el.querySelectorAll('.is-focus').forEach((x) => x.classList.remove('is-focus'));
    b.classList.add('is-focus');
    try { b.focus({ preventScroll: true }); } catch { b.focus(); }
    b.scrollIntoView?.({ block: 'nearest' });
  }
  private focusables(el: HTMLElement): HTMLElement[] {
    return [...el.querySelectorAll<HTMLElement>('button:not([disabled]), input[type=range]')].filter((x) => x.offsetParent !== null);
  }
  private moveFocus(dir: 'up' | 'down' | 'left' | 'right') {
    const top = this.top(); if (!top) return;
    const items = this.focusables(top.el);
    if (!items.length) return;
    const cur = (document.activeElement && items.includes(document.activeElement as HTMLElement)) ? document.activeElement as HTMLElement : top.el.querySelector<HTMLElement>('.is-focus');
    if (!cur || !items.includes(cur)) { this.focus(items[0]); return; }
    if (cur instanceof HTMLInputElement && cur.type === 'range' && (dir === 'left' || dir === 'right')) {
      const step = Number(cur.step || 0.1);
      cur.value = String(Math.min(Number(cur.max), Math.max(Number(cur.min), Number(cur.value) + (dir === 'right' ? step : -step))));
      cur.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let best: HTMLElement | null = null, bestScore = Infinity;
    for (const it of items) {
      if (it === cur) continue;
      const q = it.getBoundingClientRect();
      const x = q.left + q.width / 2 - cx, y = q.top + q.height / 2 - cy;
      const along = dir === 'up' ? -y : dir === 'down' ? y : dir === 'left' ? -x : x;
      const across = dir === 'up' || dir === 'down' ? Math.abs(x) : Math.abs(y);
      if (along <= 4) continue;
      const score = along + across * 2.2;
      if (score < bestScore) { bestScore = score; best = it; }
    }
    if (best) this.focus(best);
  }

  /** Keyboard routing; returns true if an overlay consumed the action. */
  handleKey(type: string, dir?: 'up' | 'down' | 'left' | 'right', digit?: number): boolean {
    const top = this.top();
    if (!top) return false;
    if (type === 'nav' && dir) { this.moveFocus(dir); return true; }
    if (type === 'interact' || type === 'enter') {
      const cur = top.el.querySelector<HTMLElement>('.is-focus') || (document.activeElement as HTMLElement);
      if (cur && top.el.contains(cur) && cur.tagName === 'BUTTON' && !(cur as HTMLButtonElement).disabled) this.activate(cur);
      return true;
    }
    if (type === 'pause' || type === 'close') {
      if (top.onClose) top.onClose();
      return true;
    }
    if (type === 'digit' && digit) {
      const b = top.el.querySelector<HTMLElement>(`[data-digit="${digit}"]`);
      if (b) { this.focus(b); this.activate(b); }
      return true;
    }
    if (type === 'backspace') {
      const b = top.el.querySelector<HTMLElement>('[data-clear]');
      if (b) { this.focus(b); this.activate(b); }
      return true;
    }
    return top.modal;
  }

  top(): Overlay | undefined { return this.stack[this.stack.length - 1]; }
  isOpen(name?: string) { return name ? this.stack.some((o) => o.name === name) : this.stack.length > 0; }

  private open(name: string, html: string, opts: { onClose?: Handler; cls?: string; modal?: boolean } = {}): HTMLElement {
    const el = document.createElement('div');
    el.className = 'overlay ' + (opts.cls || '');
    el.setAttribute('role', 'dialog');
    el.innerHTML = html;
    this.layer.appendChild(el);
    this.stack.push({ el, onClose: opts.onClose, modal: opts.modal ?? true, name });
    el.querySelectorAll<HTMLElement>('[data-close]').forEach((b) => this.bind(b, () => opts.onClose?.()));
    requestAnimationFrame(() => el.classList.add('is-in'));
    return el;
  }
  close(name?: string) {
    const idx = name ? this.stack.map((o) => o.name).lastIndexOf(name) : this.stack.length - 1;
    if (idx < 0) return;
    const [o] = this.stack.splice(idx, 1);
    o.el.remove();
    this.armed = null;
    const t = this.top(); if (t) this.focus(t.el.querySelector<HTMLElement>('.is-focus') || this.focusables(t.el)[0] || null);
  }
  closeAll() { while (this.stack.length) this.close(); }

  // ------------------------------------------------------------- HUD
  showHud(v: boolean) { this.hud.hidden = !v; }
  setFloor(text: string) { this.hud.querySelector('#hud-floor')!.textContent = text; }
  setPrompt(label: string | null, action = S.inspect) {
    const el = this.hud.querySelector<HTMLElement>('#hud-prompt')!;
    if (!label) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = this.touch
      ? `<strong>${esc(label)}</strong><span>${esc(L(`ダブルタップで${action}`, `Double-tap: ${action}`))}</span>`
      : `<kbd>SPACE</kbd><span>${esc(L(`${label}を${action}`, `${action} ${label}`))}</span>`;
  }
  setHint(text: string, sub = '') {
    const el = this.hud.querySelector<HTMLElement>('#hud-hint')!;
    el.innerHTML = `<div>${esc(text)}</div>${sub ? `<div class="muted">${esc(sub)}</div>` : ''}`;
    el.hidden = !text;
  }
  controlsHint(): string {
    return this.touch ? L('十字キー：上下で前後　左右で向きを変える', 'D-pad: up/down to move, left/right to turn') : L('W 前進　S 後退　A／D 旋回　Shift 早歩き', 'W forward · S back · A/D turn · Shift walk faster');
  }
  setWarning(on: boolean) { this.root.classList.toggle('is-warning', on); this.hud.querySelector<HTMLElement>('#hud-warn')!.hidden = !on; }
  setHeld(item: string | null) {
    const el = this.hud.querySelector<HTMLElement>('#hud-held')!;
    if (!item) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `${icon(ITEM_INFO[item].icon)}<span>${L('使用中：', 'Using: ')}${ITEM_INFO[item].name}</span><small>${this.touch ? L('道具で解除', 'Items to cancel') : L('Escで解除', 'Esc to cancel')}</small>`;
  }
  setLightOn(on: boolean) { this.hud.querySelector<HTMLElement>('#hud-light')!.hidden = !on; }
  toast(text: string, ms = 2600) {
    const el = this.root.querySelector<HTMLElement>('#toast')!;
    el.textContent = text; el.hidden = false; el.classList.remove('is-out');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { el.classList.add('is-out'); window.setTimeout(() => { el.hidden = true; }, 260); }, ms);
  }
  caption(text: string, ms = 1800) {
    if (!this.subtitles) return;
    const el = this.root.querySelector<HTMLElement>('#caption')!;
    el.textContent = text; el.hidden = false;
    window.clearTimeout(this.captionTimer);
    this.captionTimer = window.setTimeout(() => { el.hidden = true; }, ms);
  }
  setLoading(p: number, text?: string) {
    const el = this.root.querySelector<HTMLElement>('#loading')!;
    el.querySelector<HTMLElement>('.bar i')!.style.width = `${Math.round(p * 100)}%`;
    if (text) el.querySelector('.msg')!.textContent = text;
  }
  hideLoading() { this.root.querySelector<HTMLElement>('#loading')!.hidden = true; }

  fade(to: number, ms: number): Promise<void> {
    const el = this.fadeEl;
    el.style.transition = `opacity ${ms}ms linear`;
    // force style flush so the transition runs
    void el.offsetWidth;
    el.style.opacity = String(to);
    return new Promise((r) => window.setTimeout(r, ms));
  }
  fadeInstant(to: number) { this.fadeEl.style.transition = 'none'; this.fadeEl.style.opacity = String(to); void this.fadeEl.offsetWidth; }

  async chapterCard(lines: string[], holdMs = 2600) {
    const el = this.root.querySelector<HTMLElement>('#chapter')!;
    el.innerHTML = lines.map((l, i) => `<p class="${i === 0 ? 'time' : ''}" style="animation-delay:${i * 700}ms">${esc(l)}</p>`).join('');
    el.hidden = false;
    await new Promise((r) => window.setTimeout(r, holdMs + lines.length * 700));
    el.classList.add('is-out');
    await new Promise((r) => window.setTimeout(r, 700));
    el.hidden = true; el.classList.remove('is-out');
  }

  /** Red flash + screen jolt for the scare moments. */
  scareFlash(strength = 0.8, reduce = false) {
    const el = this.root.querySelector<HTMLElement>('#flash')!;
    el.style.transition = 'none';
    el.style.opacity = String(reduce ? Math.min(0.3, strength) : strength);
    void el.offsetWidth;
    el.style.transition = 'opacity 520ms ease-out';
    el.style.opacity = '0';
    this.root.classList.remove('jolt'); void this.root.offsetWidth; this.root.classList.add('jolt');
    window.setTimeout(() => this.root.classList.remove('jolt'), 420);
  }

  bigLine(text: string | null, cls = '') {
    const el = this.root.querySelector<HTMLElement>('#bigline')!;
    if (!text) { el.hidden = true; return; }
    el.className = cls; el.textContent = text; el.hidden = false;
  }

  // ------------------------------------------------------------- title
  showTitle(opts: { canContinue: boolean; records: Records; storageOk: boolean }, h: { onNew: Handler; onContinue: Handler; onSettings: Handler; onHelp: Handler; onLang: Handler }) {
    const r = opts.records;
    const el = this.open('title', `
      <div class="title-wrap">
        <img class="title-lockup" src="${UI.title_lockup}" alt="${esc(GAME_TITLE())}">
        ${isEn() ? '<p class="title-en">BICYCLE PARKING No.3</p>' : ''}
        <p class="title-sub">${L('深夜23時。５階から自転車を降ろすだけのはずだった。', '11 p.m. All I had to do was bring my bike down from the fifth floor.')}</p>
        <div class="menu">
          <button class="btn primary" data-act="new">${S.newGame}</button>
          <button class="btn" data-act="cont" ${opts.canContinue ? '' : 'disabled'}>${S.cont}</button>
          <button class="btn" data-act="settings">${S.settings}</button>
          <button class="btn" data-act="help">${L('操作方法', 'Controls')}</button>
        </div>
        <div class="records" aria-label="${L('クリア記録', 'Clear records')}">
          <span class="slot ${r.normal ? 'got' : ''}">${r.normal ? S.recNormal : '―――'}</span>
          <span class="slot ${r.secret ? 'got' : ''}">${r.secret ? S.recSecret : '―――'}</span>
          <button class="btn lang-btn" data-act="lang" lang="${isEn() ? 'ja' : 'en'}">${isEn() ? '日本語' : 'English'}</button>
        </div>
        <p class="title-foot">${L('完全一人称の短編謎解きホラー　／　横画面推奨・音声あり（字幕付き）　／　突然の大きな音・閃光を含みます', 'A short first-person puzzle horror game  /  Landscape and sound recommended (subtitles available)  /  Contains sudden loud sounds and flashes')}${opts.storageOk ? '' : '　／　' + S.noSave}</p>
      </div>`, { cls: 'ov-title', modal: true });
    this.bind(el.querySelector('[data-act=new]'), h.onNew);
    this.bind(el.querySelector('[data-act=cont]'), h.onContinue);
    this.bind(el.querySelector('[data-act=settings]'), h.onSettings);
    this.bind(el.querySelector('[data-act=help]'), h.onHelp);
    this.bind(el.querySelector('[data-act=lang]'), h.onLang);
    this.focus(el.querySelector<HTMLElement>(opts.canContinue ? '[data-act=cont]' : '[data-act=new]'));
  }

  confirm(title: string, body: string, yes: string, no: string, onYes: Handler, onNo: Handler) {
    const el = this.open('confirm', `
      <div class="card small"><h2>${esc(title)}</h2><p>${esc(body)}</p>
      <div class="row"><button class="btn" data-act="no">${esc(no)}</button><button class="btn warn" data-act="yes">${esc(yes)}</button></div></div>`,
    { onClose: () => { this.close('confirm'); onNo(); } });
    this.bind(el.querySelector('[data-act=yes]'), () => { this.close('confirm'); onYes(); });
    this.bind(el.querySelector('[data-act=no]'), () => { this.close('confirm'); onNo(); });
    this.focus(el.querySelector<HTMLElement>('[data-act=no]'));
  }

  help(onClose: Handler) {
    const el = this.open('help', `
      <div class="card"><h2>${L('操作方法', 'Controls')}</h2>
        <table class="keys">
          <tr><th>${L('前進／後退', 'Forward / back')}</th><td><kbd>W</kbd> <kbd>S</kbd>${L('（長押し）', ' (hold)')}</td><td>${L('十字キー 上／下', 'D-pad up / down')}</td></tr>
          <tr><th>${L('左右を向く', 'Turn')}</th><td><kbd>A</kbd> <kbd>D</kbd>${L('（横移動しない）', ' (no strafing)')}</td><td>${L('十字キー 左／右', 'D-pad left / right')}</td></tr>
          <tr><th>${L('早歩き', 'Walk faster')}</th><td><kbd>Shift</kbd>${L('（押しながら）', ' (hold)')}</td><td>―</td></tr>
          <tr><th>${L('見回す（任意）', 'Look around (optional)')}</th><td>${L('マウスでドラッグ', 'Drag with the mouse')}</td><td>${L('画面をドラッグ', 'Drag the screen')}</td></tr>
          <tr><th>${L('調べる・選ぶ', 'Inspect / select')}</th><td><kbd>SPACE</kbd></td><td>${L('同じ対象をダブルタップ', 'Double-tap the same thing')}</td></tr>
          <tr><th>${L('道具', 'Items')}</th><td>${L('「道具」で', '"Items" + ')}<kbd>SPACE</kbd>／<kbd>I</kbd></td><td>${L('「道具」をタップ', 'Tap "Items"')}</td></tr>
          <tr><th>${L('画面内の移動', 'Move between buttons')}</th><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>${L('でフォーカス', '')}</td><td>${L('項目をダブルタップ', 'Double-tap a button')}</td></tr>
          <tr><th>${L('閉じる・一時停止', 'Close / pause')}</th><td><kbd>Esc</kbd></td><td>${L('閉じる／一時停止ボタン', 'Close / pause button')}</td></tr>
        </table>
        <p class="muted">${L('照合盤では数字キー<kbd>1</kbd>〜<kbd>5</kbd>も使えます。マウスは不要です。', 'On the check panel you can also use the number keys <kbd>1</kbd>–<kbd>5</kbd>. No mouse needed.')}</p>
        <div class="row"><button class="btn primary" data-close>${S.close}</button></div></div>`, { onClose: () => { this.close('help'); onClose(); } });
    this.focus(el.querySelector('[data-close]'));
  }

  // ------------------------------------------------------------- generic dialog
  dialog(o: { title: string; body?: string; html?: string; image?: string; imageAlt?: string; actions: { label: string; primary?: boolean; dbl?: boolean; onSelect: Handler }[]; onClose: Handler; cls?: string }) {
    const el = this.open('dialog', `
      <div class="card ${o.cls || ''}">
        <h2>${esc(o.title)}</h2>
        ${o.image ? `<img class="dlg-img" src="${o.image}" alt="${esc(o.imageAlt || '')}">` : ''}
        ${o.body ? `<p>${esc(o.body).replace(/\n/g, '<br>')}</p>` : ''}
        ${o.html || ''}
        <div class="row">${o.actions.map((a, i) => `<button class="btn ${a.primary ? 'primary' : ''}" data-i="${i}" ${a.dbl ? 'data-dbl' : ''}>${esc(a.label)}</button>`).join('')}</div>
      </div>`, { onClose: o.onClose, cls: 'ov-dialog' });
    o.actions.forEach((a, i) => this.bind(el.querySelector(`[data-i="${i}"]`), a.onSelect));
    this.focus(el.querySelector<HTMLElement>('.btn.primary') || el.querySelector<HTMLElement>('[data-i="0"]'));
    return el;
  }

  /** Non-modal inspection card (stays while the bike is in front of you). */
  bikeCard(b: Bike | null) {
    const el = this.root.querySelector<HTMLElement>('#bike-card')!;
    if (!b) { el.classList.remove('is-in'); return; }
    el.innerHTML = `
      <span class="eyebrow">${L('駐輪中の自転車', 'Parked bicycle')}</span>
      <div class="bc-head"><strong>${b.id}</strong><img class="bc-img" src="${UI['bicycle_' + b.type]}" alt=""></div>
      <dl>
        <dt>${L('色', 'Color')}</dt><dd><img class="tag" src="${UI['color_tag_' + b.color]}" alt="">${colorLabel(b.color)}${L('／', ' / ')}${shapeLabel(b.color)}</dd>
        <dt>${L('種類', 'Type')}</dt><dd>${typeLabel(b.type)}</dd>
        <dt>${L('前カゴ', 'Basket')}</dt><dd>${basketLabel(b.basket)}</dd>
        <dt>${L('列', 'Row')}</dt><dd>${rowLabel(b.row)}</dd>
      </dl>`;
    el.classList.add('is-in');
  }

  inspectBike(b: Bike, onClose: Handler) {
    const typeImg = UI['bicycle_' + b.type];
    const el = this.open('inspect', `
      <div class="card inspect">
        <div class="inspect-head"><span class="eyebrow">${L('駐輪中の自転車', 'Parked bicycle')}</span><h2>${b.id}</h2></div>
        <div class="inspect-body">
          <img class="bike-img" src="${typeImg}" alt="${typeLabel(b.type)}">
          <dl>
            <dt>${L('色', 'Color')}</dt><dd><img class="tag" src="${UI['color_tag_' + b.color]}" alt="">${colorLabel(b.color)}${L('／', ' / ')}${shapeLabel(b.color)}</dd>
            <dt>${L('種類', 'Type')}</dt><dd>${typeLabel(b.type)}</dd>
            <dt>${L('前カゴ', 'Basket')}</dt><dd>${basketLabel(b.basket)}</dd>
            <dt>${L('列', 'Row')}</dt><dd>${rowLabel(b.row)}</dd>
          </dl>
        </div>
        <p class="muted small">${L('観察メモに記録した。台数は自分で数える。', 'Saved to your notes. Count them yourself.')}</p>
        <div class="row"><button class="btn primary" data-close>${S.close}</button></div>
      </div>`, { onClose, cls: 'ov-dialog' });
    this.focus(el.querySelector('[data-close]'));
  }

  // ------------------------------------------------------------- tools / memo
  tools(items: string[], h: { onUse: (id: string) => void; onView: (id: string) => void; onClose: Handler }, preselect?: string) {
    const el = this.open('tools', `
      <div class="card tools">
        <h2>${S.tools}</h2>
        <div class="tools-grid">
          <div class="tools-list" role="listbox">${items.map((id) => `<button class="btn item" data-dbl data-item="${id}">${icon(ITEM_INFO[id].icon)}<span>${ITEM_INFO[id].name}</span></button>`).join('')}</div>
          <div class="tools-detail"><p class="muted">${L('道具を選んでください。', 'Choose an item.')}</p></div>
        </div>
        <div class="row"><button class="btn" data-close>${S.close}</button></div>
      </div>`, { onClose: h.onClose, cls: 'ov-dialog' });
    const detail = el.querySelector<HTMLElement>('.tools-detail')!;
    const select = (id: string) => {
      el.querySelectorAll('.item').forEach((b) => b.classList.toggle('is-selected', (b as HTMLElement).dataset.item === id));
      const info = ITEM_INFO[id];
      const viewLabel = id === 'memo' ? L('開く', 'Open') : L('見る', 'View');
      detail.innerHTML = `<h3>${icon(info.icon)}${info.name}</h3><p>${info.desc}</p>
        <div class="row left">${id !== 'memo' ? `<button class="btn primary" data-dbl data-use>${id === 'light' ? L('点ける／消す', 'On / off') : S.use}</button>` : ''}
        ${id === 'receipt' || id === 'memo' || id === 'key' ? `<button class="btn" data-dbl data-view>${viewLabel}</button>` : ''}</div>`;
      this.bind(detail.querySelector('[data-use]'), () => h.onUse(id));
      this.bind(detail.querySelector('[data-view]'), () => h.onView(id));
      this.focus(detail.querySelector<HTMLElement>('[data-use]') || detail.querySelector<HTMLElement>('[data-view]'));
    };
    el.querySelectorAll<HTMLElement>('.item').forEach((b) => this.bind(b, () => select(b.dataset.item!)));
    if (preselect && items.includes(preselect)) select(preselect); else this.focus(el.querySelector<HTMLElement>('.item'));
  }

  memo(floor: number, entries: MemoEntry[], queries: string[] | null, onClose: Handler) {
    const clue = queries ? clueText(queries) : null;
    const rows = entries.length
      ? entries.slice().sort((a, b) => a.id.localeCompare(b.id)).map((e) => `<tr><th>${e.id}</th><td><img class="tag" src="${UI['color_tag_' + e.color]}" alt="">${colorLabel(e.color)}${L('／', ' / ')}${shapeLabel(e.color)}</td><td>${typeLabel(e.type)}</td><td>${L(`前カゴ${e.basket ? 'あり' : 'なし'}`, e.basket ? 'basket' : 'no basket')}</td></tr>`).join('')
      : `<tr><td colspan="4" class="muted">${L('この階ではまだ何も調べていない。', 'Nothing inspected on this floor yet.')}</td></tr>`;
    const el = this.open('memo', `
      <div class="card memo">
        <h2>${L('観察メモ', 'Notes')}　<span class="amber">${floor}F</span></h2>
        ${clue ? `<div class="memo-clue"><span class="eyebrow">${L('照合票', 'Checklist')}</span>${clue.map((c) => `<div>${esc(c)}</div>`).join('')}</div>` : ''}
        <div class="table-wrap"><table class="memo-table">${rows}</table></div>
        <p class="muted small">${L('調べた車の個別の記録だけを残す。台数は表示しない。', 'Individual records only. No totals.')}</p>
        <div class="row"><button class="btn primary" data-close>${S.close}</button></div>
      </div>`, { onClose, cls: 'ov-dialog' });
    this.focus(el.querySelector('[data-close]'));
  }

  // ------------------------------------------------------------- 運搬照合盤
  panel(model: PanelModel, h: PanelHandlers) {
    const el = this.open('panel', `
      <div class="panel-wrap ${model.mode}">
        <section class="clue-col">
          <div class="clue-card"></div>
          <button class="btn reinspect" data-dbl data-reinspect>${S.reinspect}</button>
          <p class="muted small panel-foot"></p>
        </section>
        <section class="pad-col" aria-label="${L('運搬照合盤', 'Check panel')}">
          <div class="pad-head"><span class="pad-title"></span><span class="amber pad-floor"></span><button class="icon-btn" data-close aria-label="${S.close}">${icon('close')}</button></div>
          <div class="pad-display"><span class="pad-label">${L('入力', 'Input')}</span><span class="pad-digits" aria-live="polite"></span></div>
          <div class="pad-msg" aria-live="assertive"></div>
          <div class="pad-grid">
            <button class="btn key" data-dbl data-digit="5">5</button><button class="btn key" data-dbl data-digit="4">4</button>
            <button class="btn key" data-dbl data-digit="3">3</button><button class="btn key" data-dbl data-digit="2">2</button>
            <button class="btn key" data-dbl data-digit="1">1</button><button class="btn key" data-dbl data-clear>${S.clear}</button>
            <button class="btn key open" data-dbl data-open>${S.confirm}</button>
          </div>
        </section>
      </div>`, { onClose: h.onClose, cls: 'ov-panel' });
    for (let d = 1; d <= 5; d++) this.bind(el.querySelector(`[data-digit="${d}"]`), () => h.onDigit(d));
    this.bind(el.querySelector('[data-clear]'), h.onClear);
    this.bind(el.querySelector('[data-open]'), h.onOpen);
    this.bind(el.querySelector('[data-reinspect]'), h.onReinspect);
    this.updatePanel(model);
    this.focus(el.querySelector<HTMLElement>('[data-digit="5"]'));
  }

  updatePanel(m: PanelModel) {
    const o = this.stack.find((x) => x.name === 'panel'); if (!o) return;
    const el = o.el;
    el.querySelector('.panel-wrap')!.className = `panel-wrap ${m.mode} ${m.warning ? 'is-warning' : ''}`;
    const card = el.querySelector<HTMLElement>('.clue-card')!;
    const foot = el.querySelector<HTMLElement>('.panel-foot')!;
    const re = el.querySelector<HTMLElement>('[data-reinspect]')!;
    el.querySelector('.pad-title')!.textContent = m.mode === 'normal' ? L('操作盤', 'Control panel') : L('運搬照合盤', 'Check panel');
    el.querySelector('.pad-floor')!.textContent = `${m.floor}F`;
    el.querySelector('.pad-label')!.textContent = m.mode === 'normal' ? L('行先階', 'Floor') : m.mode === 'dead' ? L('停止中', 'Stopped') : L('入力', 'Input');
    el.querySelector<HTMLElement>('[data-clear]')!.setAttribute('aria-label', m.mode === 'normal' ? L('閉（扉を閉める）', 'CLOSE (close the doors)') : L('閉（入力を消去）', 'CLOSE (clear input)'));
    el.querySelector<HTMLElement>('[data-open]')!.setAttribute('aria-label', m.mode === 'normal' ? L('開（扉を開ける）', 'OPEN (open the doors)') : L('開（照合する）', 'OPEN (check)'));
    if (m.mode === 'auth' && m.puzzle) {
      const p = m.puzzle;
      const colors = colorHints(p.queries);
      card.innerHTML = `
        <div class="clue-title"><h2>${L('照合票', 'Checklist')}</h2><span class="clue-no">${m.clueNo}</span></div>
        <p class="muted">${L('条件を満たす自転車を数える。', 'Count the bicycles that match.')}</p>
        <ol class="clue-lines">${clueText(p.queries).map((c) => `<li>${esc(c.replace(/^\d+\.\s*/, ''))}</li>`).join('')}</ol>
        <p class="muted small">${L('対象：Ａ列・Ｂ列の駐輪車<br>除外：自分の自転車・空き枠', 'Count: parked bicycles in Rows A and B<br>Exclude: your bicycle, empty slots')}</p>
        <p class="amber small">${L(`入力は${p.codeLength}桁${p.codeLength > 1 ? '（票の番号順に左から）' : ''}`, `Enter ${p.codeLength} digit${p.codeLength > 1 ? 's (in list order, left to right)' : ''}`)}${colors ? L('　／　色記号：', '  /  Color marks: ') + colors : ''}</p>
        ${m.warning ? `<p class="warn-text">${icon('warning')}${L('警告中：次の誤答で管理人が来る', 'WARNING: one more wrong answer brings the caretaker')}</p>` : ''}`;
      foot.textContent = L('「閉」で消去　／　「開」で照合', 'CLOSE clears  /  OPEN checks');
      re.hidden = false;
    } else if (m.mode === 'normal') {
      card.innerHTML = `<div class="clue-title"><h2>${L('行先階', 'Destination')}</h2></div><p class="muted">${L('数字で行先階を選ぶ。「開」「閉」は扉の開閉。', 'Choose a floor with the numbers. OPEN and CLOSE work the doors.')}</p>`;
      foot.textContent = '';
      re.hidden = true;
    } else {
      card.innerHTML = `<div class="clue-title"><h2>${L('非常電源', 'Emergency power')}</h2></div><p class="muted">${L('表示灯が消えている。足元のレールと、奥の認証口を調べよう。', 'The lights are out. Check the rail on the floor and the reader on the back wall.')}</p>`;
      foot.textContent = '';
      re.hidden = true;
    }
    const digits = el.querySelector<HTMLElement>('.pad-digits')!;
    if (m.mode === 'auth' && m.puzzle) {
      const slots = [];
      for (let i = 0; i < m.puzzle.codeLength; i++) slots.push(m.input[i] !== undefined ? `<b>${m.input[i]}</b>` : '<i>＿</i>');
      digits.innerHTML = slots.join('');
    } else digits.innerHTML = m.mode === 'dead' ? '<i>－</i>' : `<b>${m.floor}</b>`;
    const msg = el.querySelector<HTMLElement>('.pad-msg')!;
    msg.textContent = m.message || '';
    msg.className = 'pad-msg' + (m.messageWarn ? ' warn' : '');
    el.querySelectorAll<HTMLButtonElement>('.key').forEach((b) => { b.disabled = !!m.locked; });
    re.toggleAttribute('disabled', !!m.locked);
  }

  // ------------------------------------------------------------- pause & settings
  pause(h: { onResume: Handler; onRules: Handler; onSettings: Handler; onHelp: Handler; onTitle: Handler }) {
    const el = this.open('pause', `
      <div class="card small"><h2>${L('一時停止', 'Paused')}</h2>
        <div class="menu">
          <button class="btn primary" data-act="resume">${L('再開する', 'Resume')}</button>
          <button class="btn" data-act="rules">${L('照合手順を読む', 'Check procedure')}</button>
          <button class="btn" data-act="settings">${S.settings}</button>
          <button class="btn" data-act="help">${L('操作方法', 'Controls')}</button>
          <button class="btn" data-act="title">${L('タイトルへ戻る', 'Back to title')}</button>
        </div>
        <p class="muted small">${L('進行は区切りごとに保存されています。', 'Progress is saved at each checkpoint.')}</p></div>`, { onClose: h.onResume, cls: 'ov-dialog' });
    this.bind(el.querySelector('[data-act=resume]'), h.onResume);
    this.bind(el.querySelector('[data-act=rules]'), h.onRules);
    this.bind(el.querySelector('[data-act=settings]'), h.onSettings);
    this.bind(el.querySelector('[data-act=help]'), h.onHelp);
    this.bind(el.querySelector('[data-act=title]'), h.onTitle);
    this.focus(el.querySelector('[data-act=resume]'));
  }

  settings(s: Settings, onChange: (s: Settings) => void, onClose: Handler, onLang?: Handler) {
    const sl = (id: keyof Settings, label: string) => `<label class="set-row"><span>${label}</span><input id="set-${id}" type="range" min="0" max="1" step="0.05" value="${s[id]}"></label>`;
    const tg = (id: keyof Settings, label: string, on: string, off: string) => `<div class="set-row"><span>${label}</span><button class="btn toggle" data-set="${id}">${s[id] ? on : off}</button></div>`;
    const el = this.open('settings', `
      <div class="card settings"><h2>${S.settings}</h2>
        <div class="set-row"><span>言語 / Language</span><button class="btn toggle" data-set="lang">${isEn() ? 'English' : '日本語'}</button></div>
        ${sl('master', L('全体音量', 'Master volume'))}${sl('music', L('BGM', 'Music'))}${sl('sfx', L('効果音', 'Sound effects'))}${sl('amb', L('環境音', 'Ambience'))}
        ${tg('jumpScare', L('驚かし演出', 'Jump scares'), labels().jumpScare[0], labels().jumpScare[1])}
        ${tg('subtitles', L('字幕（音の手掛かり）', 'Subtitles (sound cues)'), labels().subtitles[0], labels().subtitles[1])}
        ${tg('reduceFlash', L('点滅軽減', 'Reduce flashing'), labels().reduceFlash[0], labels().reduceFlash[1])}
        ${tg('largeText', L('文字サイズ', 'Text size'), labels().largeText[0], labels().largeText[1])}
        <div class="set-row"><span>${L('描画品質', 'Graphics')}</span><button class="btn toggle" data-set="quality">${qualityLabel(s.quality)}</button></div>
        ${tg('caretakerHi', L('人物モデル', 'Character model'), labels().caretakerHi[0], labels().caretakerHi[1])}
        <div class="row"><button class="btn primary" data-close>${S.close}</button></div></div>`, { onClose, cls: 'ov-dialog' });
    for (const id of ['master', 'music', 'sfx', 'amb'] as const) {
      el.querySelector<HTMLInputElement>(`#set-${id}`)!.addEventListener('input', (e) => { (s as any)[id] = Number((e.target as HTMLInputElement).value); onChange(s); });
    }
    el.querySelectorAll<HTMLElement>('[data-set]').forEach((b) => this.bind(b, () => {
      const id = b.dataset.set as keyof Settings;
      if (id === 'lang') { onLang?.(); return; }
      if (id === 'quality') { s.quality = s.quality === 'low' ? 'mid' : s.quality === 'mid' ? 'high' : 'low'; b.textContent = qualityLabel(s.quality); }
      else {
        (s as any)[id] = !s[id];
        const lb = (labels() as any)[id] as [string, string];
        b.textContent = s[id] ? lb[0] : lb[1];
      }
      onChange(s);
    }));
    this.focus(el.querySelector<HTMLElement>('#set-master'));
  }

  // ------------------------------------------------------------- endings
  gameOver(h: { onRetry: Handler; onNew: Handler; onTitle: Handler; onShare: Handler; reached: string }) {
    const el = this.open('gameover', `
      <div class="go-wrap">
        <p class="go-line">${S.failed}</p>
        <p class="muted small">${esc(h.reached)}</p>
        <div class="menu">
          <button class="btn primary" data-act="retry">${S.retry}</button>
          <button class="btn" data-act="new">${S.newGame}</button>
          <button class="btn" data-act="share">${S.share}</button>
          <button class="btn" data-act="title">${S.toTitle}</button>
        </div>
        <p class="muted small">${S.retryNote}</p>
      </div>`, { cls: 'ov-gameover', modal: true });
    this.bind(el.querySelector('[data-act=retry]'), h.onRetry);
    this.bind(el.querySelector('[data-act=new]'), h.onNew);
    this.bind(el.querySelector('[data-act=share]'), h.onShare);
    this.bind(el.querySelector('[data-act=title]'), h.onTitle);
    this.focus(el.querySelector('[data-act=retry]'));
  }

  ending(kind: 'normal' | 'secret', records: Records, h: { onTitle: Handler; onNew: Handler; onShare: Handler }) {
    const el = this.open('ending', `
      <div class="end-wrap ${kind}">
        ${kind === 'normal' ? `<p class="end-ja">${S.normalEnd}</p><p class="end-en">${S.clearEn}</p>` : `<p class="end-en small">CLEAR</p>`}
        <div class="records">
          <span class="slot ${records.normal ? 'got' : ''}">${records.normal ? S.recNormal : '―――'}</span>
          <span class="slot ${records.secret ? 'got' : ''}">${records.secret ? S.recSecret : '―――'}</span>
        </div>
        <div class="menu row">
          <button class="btn" data-act="title">${S.toTitle}</button>
          <button class="btn" data-act="share">${S.share}</button>
          <button class="btn primary" data-act="new">${S.again}</button>
        </div>
      </div>`, { cls: 'ov-ending ' + kind, modal: true });
    this.bind(el.querySelector('[data-act=title]'), h.onTitle);
    this.bind(el.querySelector('[data-act=share]'), h.onShare);
    this.bind(el.querySelector('[data-act=new]'), h.onNew);
    this.focus(el.querySelector('[data-act=new]'));
  }

  /** Texts that live in the page markup (HUD, D-pad, loading). */
  applyStaticText() {
    const set = (sel: string, text: string) => { const e = this.root.querySelector<HTMLElement>(sel); if (e) e.textContent = text; };
    const aria = (sel: string, text: string) => this.root.querySelector<HTMLElement>(sel)?.setAttribute('aria-label', text);
    set('#hud-name', GAME_TITLE());
    set('#btn-tools', S.tools);
    set('#hud-warn [data-t]', L('警告中', 'WARNING'));
    set('#hud-light', L('ライト点灯中', 'Light on'));
    aria('#btn-pause', L('一時停止', 'Pause'));
    aria('#gl', L('第３駐輪場のゲーム画面', 'Game view'));
    aria('#dpad', L('移動', 'Movement'));
    aria('[data-move=fwd]', L('前進', 'Forward'));
    aria('[data-move=back]', L('後退', 'Back'));
    aria('[data-move=left]', L('左を向く', 'Turn left'));
    aria('[data-move=right]', L('右を向く', 'Turn right'));
    try { document.title = GAME_TITLE(); } catch { /* ignore */ }
  }

  /** When the X window cannot be opened from here (popup blocked), show the text and a link instead. */
  shareFallback(text: string, url: string) {
    const el = this.dialog({
      title: S.share, html: `<p class="share-text">${esc(text).replace(/\n/g, '<br>')}</p><p><a class="share-link" href="${esc(url)}" target="_blank" rel="noopener">${L('Xの投稿画面を開く', 'Open X to post')}</a></p>`,
      actions: [{ label: S.close, primary: true, onSelect: () => this.close('dialog') }], onClose: () => this.close('dialog'),
    });
    return el;
  }

  secretCaption(show: boolean) {
    const el = this.root.querySelector<HTMLElement>('#secret-caption')!;
    if (show) {
      el.innerHTML = isEn() ? `<div class="secret-text">${esc(S.secretLine)}</div>` : `<img src="${UI.secret_ending_caption}" alt="${S.secretLine}">`;
      el.hidden = false; requestAnimationFrame(() => el.classList.add('is-in'));
    }
    else { el.hidden = true; el.classList.remove('is-in'); }
  }
}

export interface PanelModel {
  mode: 'normal' | 'dead' | 'auth';
  floor: number;
  clueNo: string;
  puzzle: FloorPuzzle | null;
  input: number[];
  warning: boolean;
  message?: string;
  messageWarn?: boolean;
  locked?: boolean;
}
export interface PanelHandlers { onDigit: (d: number) => void; onClear: Handler; onOpen: Handler; onReinspect: Handler; onClose: Handler }

function colorHints(queries: string[]): string {
  const out: string[] = [];
  const add = (s: string) => { if (!out.includes(s)) out.push(s); };
  for (const q of queries) {
    if (q.includes('red')) add(L('赤＝丸', 'red = circle'));
    if (q.includes('blue')) add(L('青＝三角', 'blue = triangle'));
    if (q.includes('cream')) add(L('白系＝四角', 'white = square'));
  }
  return out.join(L('・', ', '));
}

const labels = () => ({
  jumpScare: [L('強', 'Strong'), L('控えめ', 'Mild')],
  subtitles: [L('表示する', 'On'), L('表示しない', 'Off')],
  reduceFlash: [L('オン', 'On'), L('オフ', 'Off')],
  largeText: [L('大', 'Large'), L('標準', 'Normal')],
  caretakerHi: [L('高精細', 'Detailed'), L('軽量', 'Light')],
});
const qualityLabel = (q: string) => (({ low: L('低', 'Low'), mid: L('標準', 'Medium'), high: L('高', 'High') } as any)[q]);
