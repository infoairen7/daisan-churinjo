// Keyboard + touch input. W/S move, A/D turn (never strafe), Space = one action per press.
// Touch: a separate D-pad (own pointer ids) and world taps for the double-tap rule (§10).

export type MoveKey = 'fwd' | 'back' | 'left' | 'right';
type Held = Record<MoveKey, boolean> & { run: boolean };
export type KeyAction =
  | { type: 'interact' } | { type: 'tools' } | { type: 'pause' } | { type: 'memo' } | { type: 'light' }
  | { type: 'nav'; dir: 'up' | 'down' | 'left' | 'right' } | { type: 'digit'; d: number } | { type: 'backspace' }
  | { type: 'enter' };

export class Input {
  held: Held = { fwd: false, back: false, left: false, right: false, run: false };
  onLook: (dx: number, dy: number) => void = () => {};
  private keyHeld = new Set<string>();
  private padHeld: Record<MoveKey, Set<number>> = { fwd: new Set(), back: new Set(), left: new Set(), right: new Set() };
  onKey: (a: KeyAction, e: KeyboardEvent) => void = () => {};
  onTap: (x: number, y: number, pointerType: string) => void = () => {};
  onAnyTouch: () => void = () => {};
  onAnyKey: () => void = () => {};
  touchMode = false;

  constructor(private canvas: HTMLCanvasElement, private dpad: HTMLElement) {
    window.addEventListener('keydown', (e) => this.keydown(e));
    window.addEventListener('keyup', (e) => this.keyup(e));
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });

    // touch devices: show the D-pad from the start; any touch anywhere switches hints to touch wording
    try { if (window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0) queueMicrotask(() => this.setTouch()); } catch { /* ignore */ }
    window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') this.setTouch(); }, { capture: true });

    // world taps + drag-to-look (separate pointer ids from the D-pad)
    let down: { id: number; x: number; y: number; t: number; type: string } | null = null;
    let drag: { id: number; x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') this.setTouch();
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType };
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      if (e.pointerType === 'mouse' && e.buttons === 0) { drag = null; return; }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      // ignore the first few pixels so a tap never turns the view
      if (down && down.id === e.pointerId && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8) return;
      if (dx || dy) this.onLook(dx, dy);
    });
    canvas.addEventListener('pointerup', (e) => {
      if (drag?.id === e.pointerId) drag = null;
      if (!down || down.id !== e.pointerId) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (moved <= 20 && performance.now() - down.t < 450) this.onTap(e.clientX, e.clientY, down.type);
      down = null;
    });
    canvas.addEventListener('pointercancel', () => { down = null; drag = null; });
    for (const ev of ['touchstart', 'touchend', 'touchmove', 'gesturestart', 'dblclick'] as const) {
      canvas.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
    }

    // D-pad buttons: hold to move/turn
    dpad.querySelectorAll<HTMLElement>('[data-move]').forEach((btn) => {
      const key = btn.dataset.move as MoveKey;
      const release = (e: PointerEvent) => { this.padHeld[key].delete(e.pointerId); btn.classList.remove('is-down'); this.recompute(); };
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        this.setTouch();
        try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        this.padHeld[key].add(e.pointerId); btn.classList.add('is-down'); this.recompute();
      });
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('lostpointercapture', release);
      for (const ev of ['touchstart', 'touchend', 'touchmove'] as const) btn.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });
  }

  private setTouch() {
    if (!this.touchMode) { this.touchMode = true; document.documentElement.classList.add('is-touch'); }
    this.onAnyTouch();
  }

  private keydown(e: KeyboardEvent) {
    const k = e.key;
    const code = e.code;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' && (e.target as HTMLInputElement).type === 'range' && (code.startsWith('Arrow'))) return;
    if (this.touchMode && !e.repeat) { this.touchMode = false; document.documentElement.classList.remove('is-touch'); }
    this.onAnyKey();
    const move = this.moveFor(code);
    if (move) {
      this.keyHeld.add(code); this.recompute();
      if (!e.repeat) this.onKey({ type: 'nav', dir: move === 'fwd' ? 'up' : move === 'back' ? 'down' : move }, e);
      if (code.startsWith('Arrow')) e.preventDefault();
      return;
    }
    if (code === 'ShiftLeft' || code === 'ShiftRight') { this.keyHeld.add(code); this.recompute(); return; }
    if (code === 'Space') { e.preventDefault(); if (!e.repeat) this.onKey({ type: 'interact' }, e); return; }
    if (e.repeat) return;
    if (code === 'Enter' || code === 'NumpadEnter') { e.preventDefault(); this.onKey({ type: 'enter' }, e); return; }
    if (code === 'Escape') { e.preventDefault(); this.onKey({ type: 'pause' }, e); return; }
    if (code === 'KeyI') { this.onKey({ type: 'tools' }, e); return; }
    if (code === 'KeyM') { this.onKey({ type: 'memo' }, e); return; }
    if (code === 'KeyF') { this.onKey({ type: 'light' }, e); return; }
    if (code === 'Backspace' || code === 'Delete') { e.preventDefault(); this.onKey({ type: 'backspace' }, e); return; }
    const d = /^(Digit|Numpad)([1-5])$/.exec(code) || (/^[1-5]$/.test(k) ? [k, '', k] : null);
    if (d) { this.onKey({ type: 'digit', d: +d[2] }, e); }
  }

  private keyup(e: KeyboardEvent) {
    if (this.keyHeld.delete(e.code)) this.recompute();
  }

  private moveFor(code: string): MoveKey | null {
    switch (code) {
      case 'KeyW': case 'ArrowUp': return 'fwd';
      case 'KeyS': case 'ArrowDown': return 'back';
      case 'KeyA': case 'ArrowLeft': return 'left';
      case 'KeyD': case 'ArrowRight': return 'right';
    }
    return null;
  }

  private recompute() {
    const k = (c: string[]) => c.some((x) => this.keyHeld.has(x));
    this.held.fwd = k(['KeyW', 'ArrowUp']) || this.padHeld.fwd.size > 0;
    this.held.back = k(['KeyS', 'ArrowDown']) || this.padHeld.back.size > 0;
    this.held.left = k(['KeyA', 'ArrowLeft']) || this.padHeld.left.size > 0;
    this.held.right = k(['KeyD', 'ArrowRight']) || this.padHeld.right.size > 0;
    this.held.run = k(['ShiftLeft', 'ShiftRight']);
  }

  releaseAll() {
    this.keyHeld.clear();
    for (const s of Object.values(this.padHeld)) s.clear();
    this.dpad.querySelectorAll('.is-down').forEach((b) => b.classList.remove('is-down'));
    this.recompute();
  }
}
