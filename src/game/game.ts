// 第３駐輪場 — game flow / state machine (spec §4–§16).
import { Camera } from '../engine/scene';
import type { Renderer } from '../engine/renderer';
import type { ModelTemplate } from '../engine/gltf';
import { loadGLB } from '../engine/gltf';
import { fetchModel } from '../engine/fetchmodel';
import { type V3, type Q, quatYawPitch, quatLookDir, quatSlerp, quatAxisAngle, sub, clamp, lerp, smooth } from '../engine/math';
import { World, EV_Z, slotZ, type Collider } from './world';
import { Bedroom, Caretaker } from './ending';
import { Dread } from './dread';
import { GameUI, ITEM_INFO, S, type PanelModel } from './ui';
import { UI } from './ui_assets.gen';
import { L, isEn, lang, setLang, onLangChange, detectLang, GAME_TITLE, type Lang } from './i18n';
import * as C from './canvas';
import { AudioManager } from './audio';
import { Input, type KeyAction } from './input';
import {
  generateRun, newSeed, commitAnswer, resumeAfterFail, endingFor, type FloorPuzzle, type Bike, type Progress,
} from './puzzle';
import {
  type SaveData, type Settings, type Records, type Phase, loadSave, writeSave, clearSave, loadSettings, writeSettings,
  loadRecords, writeRecords, storageAvailable,
} from './save';

interface Target {
  id: string;
  label: () => string;
  verb?: () => string;
  min: V3;
  max: V3;
  range: number;
  enabled: () => boolean;
  activate: () => void;
  useItem?: (item: string) => boolean;
  accepts?: string[];
}

type Mode = 'title' | 'world' | 'cutscene' | 'bedroom';

declare const __SHARE_URL__: string;
declare const __DEBUG__: boolean;
/** The public page to link in posts (set at build time); English posts link the English version. */
function shareUrl(): string {
  let base = '';
  try { base = typeof __SHARE_URL__ === 'string' ? __SHARE_URL__ : ''; } catch { base = ''; }
  if (!base) {
    try { if (/^https?:$/.test(location.protocol) && !/claude|localhost|127\.0\.0\.1/.test(location.hostname)) base = location.origin + location.pathname; } catch { /* ignore */ }
  }
  if (!base) return '';
  return isEn() ? base + (base.includes('?') ? '&' : '?') + 'lang=en' : base;
}

const EYE = 1.65;
const RADIUS = 0.25;
const WALK = 2.3; // m/s (spec value 1.6 felt slow in play)
const PUSH = 1.55;
const RUN_MUL = 1.4; // Shift: brisk walk (optional, not required anywhere)
const TURN = (118 * Math.PI) / 180;
const ACCEL = 14; // m/s² — reaches walking speed in ~0.16 s
const DECEL = 22;
const LOOK_YAW = 0.0042; // rad per CSS px of drag
const LOOK_PITCH = 0.0034;
const PLAYER_INSIDE: V3 = [-0.35, EYE, EV_Z - 0.1];

export class Game {
  ui: GameUI;
  world: World;
  camera = new Camera();
  input: Input;
  audio: AudioManager;
  renderer: Renderer;
  templates: Record<string, ModelTemplate>;
  bedroom: Bedroom | null = null;
  caretaker: Caretaker | null = null; // facility instance (game over)
  caretakerBed: Caretaker | null = null; // bedroom instance
  caretakerTpl: ModelTemplate | null = null;
  caretakerLoading: Promise<ModelTemplate> | null = null;

  save!: SaveData;
  settings: Settings;
  records: Records;
  mode: Mode = 'title';
  view: 'facility' | 'bedroom' = 'facility';
  paused = false;
  session = 0;
  time = 0;

  pos: V3 = [0, EYE, 0];
  yaw = 0;
  pitch = 0;
  camOverride: { fromPos: V3; fromQuat: Q; pos: V3; quat: Q; k: number; speed: number } | null = null;
  fx!: Dread;
  bob = 0;
  vel = 0;
  turnVel = 0;
  lookPitch = 0;
  viewW = 1;
  viewH = 1;
  colCache: Collider[] = [];
  private frameAcc = 0;
  private frameN = 0;
  private fastWindows = 0;

  targets: Target[] = [];
  bikeTargets: Target[] = [];
  current: Target | null = null;
  heldItem: string | null = null;
  lightOn = false;
  tapPending: { id: string; t: number; x: number; y: number } | null = null;

  panelInput: number[] = [];
  panelMsg = '';
  panelMsgWarn = false;
  panelLocked = false;

  introStage: 'outside' | '1F' | 'up' | '5F' = 'outside';
  stepAcc = 0;
  footLeft = true;
  rolling = false;
  lockedSince = 0;
  hintShown = { back: false, glow: false, key: false, card: false };
  lastBarrierMsg = 0;
  leftCarAt = -1;
  flavorT = 8;
  outsideZone: boolean | null = null;
  storageWarned = false;
  private waits: { t: number; r: () => void }[] = [];
  fps = 60;
  reverbZone = -1;
  cutFlag = false;
  fovTarget = 65;
  fovSpeed = 3;
  maxDt = 0.1;
  dbgFreeze = false;
  dbgGrab: ((url: string) => void) | null = null;
  /** debug-build camera override for trailer capture (tools/trailer_capture.mjs) */
  dbgCam: { pos: V3; quat: Q; fov?: number } | null = null;
  dbgBudget = 0;
  private lastFrame = 0;

  constructor(root: HTMLElement, canvas: HTMLCanvasElement, renderer: Renderer, templates: Record<string, ModelTemplate>, images: Record<string, HTMLImageElement>, audio: AudioManager) {
    this.renderer = renderer;
    this.templates = templates;
    this.audio = audio;
    this.ui = new GameUI(root);
    this.world = new World(templates, renderer, images);
    this.input = new Input(canvas, root.querySelector('#dpad')!);
    this.settings = loadSettings();
    this.records = loadRecords();
    this.fx = new Dread(this);
    const firstGesture = () => {
      window.removeEventListener('pointerdown', firstGesture, true); window.removeEventListener('keydown', firstGesture, true);
      this.audio.unlock().then(() => this.fx.updateMusic());
    };
    window.addEventListener('pointerdown', firstGesture, true); window.addEventListener('keydown', firstGesture, true);
    this.applySettings();
    this.ui.applyStaticText();
    this.buildTargets();
    this.world.exitBarrier = () => this.save?.phase === 'EXIT' && this.world.bikeMode !== 'held';

    this.input.onKey = (a, e) => this.onKey(a, e);
    this.input.onTap = (x, y, type) => this.onTap(x, y, type);
    this.input.onLook = (dx, dy) => this.onLook(dx, dy);
    this.input.onAnyTouch = () => { if (!this.ui.touch) { this.ui.touch = true; this.refreshHints(); } };
    this.input.onAnyKey = () => { if (this.ui.touch) { this.ui.touch = false; this.refreshHints(); } };
    this.ui.onToolsButton = () => { if (this.mode === 'world' && !this.ui.isOpen()) this.openTools(); };
    this.ui.onPauseButton = () => { if ((this.mode === 'world' || this.mode === 'bedroom') && !this.ui.isOpen()) this.openPause(); };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'world' && !this.ui.isOpen()) this.openPause();
    });
    this.camera.fov = (65 * Math.PI) / 180;
    // a quiet establishing view behind the title
    this.world.setFloor(1, null);
    this.world.setLighting('normal');
    this.pos = [0.4, EYE, -16.5]; this.yaw = Math.PI;
    // test hooks exist only in debug builds (node tools/build.mjs --debug); release builds drop them
    if (__DEBUG__) (window as any).__p3 = this.debugApi();
  }

  // ================================================================= loop
  start() {
    this.measure();
    window.addEventListener('resize', () => this.measure());
    window.addEventListener('orientationchange', () => setTimeout(() => this.measure(), 200));
    try { new ResizeObserver(() => this.measure()).observe(this.renderer.canvas); } catch { /* resize event is enough */ }
    const frame = (t: number) => {
      const raw = Math.max(0, (t - (this.lastFrame || t)) / 1000);
      this.fps = this.fps * 0.9 + (raw > 0 ? 1 / raw : 60) * 0.1;
      let dt = Math.min(this.maxDt, raw);
      if (this.dbgFreeze) { dt = Math.min(this.dbgBudget, 1 / 30); this.dbgBudget -= dt; }
      this.adapt(raw);
      this.lastFrame = t;
      this.tick(dt);
      // debug capture: hand back this exact frame (the drawing buffer is still intact inside the rAF callback)
      if (this.dbgGrab && this.dbgBudget <= 1e-6) { const r = this.dbgGrab; this.dbgGrab = null; r(this.renderer.canvas.toDataURL('image/jpeg', 0.93)); }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  wait(sec: number): Promise<void> { return new Promise((r) => this.waits.push({ t: sec, r })); }

  private measure() {
    const r = this.renderer.canvas.getBoundingClientRect();
    this.viewW = r.width; this.viewH = r.height;
  }

  /** Keep ~60 fps: lower the render resolution when frames are slow, raise it back when there is headroom. */
  adaptEnabled = true;
  private adapt(raw: number) {
    if (!this.adaptEnabled) return;
    if (raw <= 0 || raw > 0.25 || this.paused || document.hidden) return;
    this.frameAcc += raw; this.frameN++;
    if (this.frameAcc < 1.0) return;
    const avg = this.frameAcc / this.frameN;
    this.frameAcc = 0; this.frameN = 0;
    const r = this.renderer;
    if (avg > 1 / 50 && r.dynamicScale > 0.5) { r.dynamicScale = Math.max(0.5, r.dynamicScale * 0.85); this.fastWindows = 0; }
    else if (avg < 1 / 58) { if (++this.fastWindows >= 3 && r.dynamicScale < 1) { r.dynamicScale = Math.min(1, r.dynamicScale * 1.08); this.fastWindows = 0; } }
    else this.fastWindows = 0;
  }

  private tick(dt: number) {
    this.renderer.resize(this.viewW, this.viewH);
    this.refreshColliders();
    const cut = this.mode === 'cutscene' || this.mode === 'bedroom';
    if (cut !== this.cutFlag) { this.cutFlag = cut; this.ui.root.classList.toggle('is-cutscene', cut); }
    if (!this.paused) {
      this.time += dt;
      for (const w of this.waits.slice()) { w.t -= dt; if (w.t <= 0) { this.waits.splice(this.waits.indexOf(w), 1); w.r(); } }
      if (this.view === 'facility') this.tickFacility(dt);
      else this.tickBedroom(dt);
    }
    if (this.view === 'facility') this.renderer.render(this.world.scene, this.camera);
    else if (this.bedroom) this.renderer.render(this.bedroom.scene, this.camera);
  }

  private tickFacility(dt: number) {
    if (this.mode === 'world' && !this.ui.isOpen()) this.movePlayer(dt);
    else if (this.rolling) { this.audio.stopLoop('bicycle_roll_loop', 0.2); this.rolling = false; }
    if (this.mode === 'title') this.yaw += dt * 0.03;
    this.world.update(dt, this.time, this.camera);
    this.caretaker?.update(dt);
    this.fx.update(dt);
    // concrete garage rings; the car is tighter; outdoors is dry
    const rz = this.world.floor === 1 && this.pos[2] < -7.05 ? 0.06 : this.world.isInsideCar(this.pos) ? 0.18 : 0.32;
    if (rz !== this.reverbZone) { this.reverbZone = rz; this.audio.setReverb(rz); }
    this.updateTarget();
    this.updateCard(dt);
    this.watchers(dt);
    // camera
    const auto = this.mode === 'world' && this.current ? this.autoPitch(this.current) : 0;
    const targetPitch = Math.abs(this.lookPitch) > 0.02 ? this.lookPitch : auto;
    this.pitch = lerp(this.pitch, targetPitch, Math.min(1, dt * (Math.abs(this.lookPitch) > 0.02 ? 20 : 5)));
    let q = quatYawPitch(this.yaw, this.pitch);
    let p: V3 = [this.pos[0], this.pos[1] + Math.sin(this.bob) * 0.012, this.pos[2]];
    if (this.camOverride) {
      const o = this.camOverride;
      o.k = Math.min(1, o.k + dt * o.speed);
      const s = smooth(o.k);
      q = quatSlerp(o.fromQuat, o.quat, s);
      p = [lerp(o.fromPos[0], o.pos[0], s), lerp(o.fromPos[1], o.pos[1], s), lerp(o.fromPos[2], o.pos[2], s)];
    }
    if (this.dbgCam) { p = this.dbgCam.pos; q = this.dbgCam.quat; }
    if (this.fx.shake > 0) {
      const a = this.fx.shake * 0.035;
      p = [p[0] + (Math.random() - 0.5) * a, p[1] + (Math.random() - 0.5) * a, p[2] + (Math.random() - 0.5) * a];
    }
    this.camera.position = p; this.camera.quaternion = q;
    const fovNow = this.camera.fov, fovGoal = (this.fovTarget * Math.PI) / 180;
    this.camera.fov = this.dbgCam?.fov ? (this.dbgCam.fov * Math.PI) / 180 : fovNow + (fovGoal - fovNow) * Math.min(1, dt * this.fovSpeed);
    // flashlight follows the view
    const sp = this.world.scene.spot;
    sp.enabled = this.lightOn;
    if (this.lightOn) {
      const f = this.camera.forward();
      sp.position = [p[0] + f[0] * 0.1, p[1] - 0.15, p[2] + f[2] * 0.1];
      sp.direction = f; sp.intensity = 7; sp.range = 10; sp.angle = 0.42;
    }
  }

  private autoPitch(t: Target): number {
    // only the floor rail needs the view to dip (spec §10); everything else stays level
    if (t.id !== 'rail') return 0;
    const cy = 0.1;
    const cx = (t.min[0] + t.max[0]) / 2, cz = (t.min[2] + t.max[2]) / 2;
    const d = Math.max(0.6, Math.hypot(cx - this.pos[0], cz - this.pos[2]));
    return clamp(Math.atan2(cy - EYE, d) * 0.7, -0.5, 0);
  }

  // ================================================================= movement & collision
  private movePlayer(dt: number) {
    const h = this.input.held;
    // turning: snappy exponential ramp (no strafing; A/D always turn)
    const turnTarget = ((h.left ? 1 : 0) - (h.right ? 1 : 0)) * TURN;
    this.turnVel += (turnTarget - this.turnVel) * (1 - Math.exp(-dt * 18));
    if (Math.abs(this.turnVel) < 1e-3 && turnTarget === 0) this.turnVel = 0;
    this.yaw += this.turnVel * dt;
    const dirMove = (h.fwd ? 1 : 0) - (h.back ? 1 : 0);
    const held = this.world.bikeMode === 'held';
    const top = (held ? PUSH : WALK) * (h.run ? RUN_MUL : 1) * (dirMove < 0 ? 0.75 : 1);
    const target = dirMove * top;
    const rate = Math.abs(target) > Math.abs(this.vel) && Math.sign(target) === Math.sign(this.vel || target) ? ACCEL : DECEL;
    if (this.vel < target) this.vel = Math.min(target, this.vel + rate * dt);
    else if (this.vel > target) this.vel = Math.max(target, this.vel - rate * dt);
    if (dirMove !== 0 && Math.abs(this.lookPitch) > 0) this.lookPitch *= Math.exp(-dt * 1.6); // walking re-centres a manual look
    let moved = 0;
    if (Math.abs(this.vel) > 1e-4) {
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const dx = fx * this.vel * dt, dz = fz * this.vel * dt;
      const before: V3 = [this.pos[0], this.pos[1], this.pos[2]];
      // sub-step so slow frames can never tunnel through thin colliders
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.06));
      for (let i = 0; i < steps; i++) {
        const px = this.pos[0], pz = this.pos[2];
        this.pos[0] += dx / steps; this.resolve(0);
        this.pos[2] += dz / steps; this.resolve(2);
        if (held && this.bikeBlocked()) { this.pos[0] = px; this.pos[2] = pz; this.vel = 0; break; }
      }
      moved = Math.hypot(this.pos[0] - before[0], this.pos[2] - before[2]);
      if (moved < Math.abs(this.vel) * dt * 0.2) this.vel *= 0.5; // pressed against a wall
    }
    if (held) {
      this.world.placeBikeHeld(this.pos, this.yaw);
      if (moved > 0) this.world.rollWheels(moved * Math.sign(this.vel || 1));
      const isRolling = moved > 0.0005;
      if (isRolling && !this.rolling) { this.audio.loop('bicycle_roll_loop', 1, 0.15); this.rolling = true; }
      if (!isRolling && this.rolling) { this.audio.stopLoop('bicycle_roll_loop', 0.15); this.rolling = false; }
    }
    if (moved > 0) {
      this.bob += moved * 5.2;
      this.stepAcc += moved;
      const stride = held ? 0.85 : 0.78;
      if (this.stepAcc >= stride) {
        this.stepAcc = 0;
        this.footLeft = !this.footLeft;
        this.audio.play(this.footLeft ? 'footstep_left' : 'footstep_right', { gain: held ? 0.6 : 1, rate: 0.95 + Math.random() * 0.1 });
        this.onFootstep();
      }
    }
  }

  private onFootstep() { this.fx?.footstep(); }

  /** Drag-to-look (optional aid; every action stays reachable with the keys alone). */
  private onLook(dx: number, dy: number) {
    if (this.mode !== 'world' || this.ui.isOpen()) return;
    this.yaw -= dx * LOOK_YAW;
    this.lookPitch = clamp(this.lookPitch - dy * LOOK_PITCH, -0.7, 0.55);
  }

  private refreshColliders() { this.colCache = this.world.colliders.filter((c) => !c.enabled || c.enabled()); }
  private colliders(): Collider[] { return this.colCache; }

  private resolve(axis: 0 | 2) {
    for (const c of this.colliders()) {
      const px = this.pos[0], pz = this.pos[2];
      const nx = clamp(px, c.minX, c.maxX), nz = clamp(pz, c.minZ, c.maxZ);
      const dx = px - nx, dz = pz - nz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= RADIUS * RADIUS) continue;
      if (d2 > 1e-10) {
        const d = Math.sqrt(d2); const push = RADIUS - d;
        if (axis === 0) this.pos[0] += (dx / d) * push * (Math.abs(dx) > 1e-6 ? 1 : 0) || 0;
        else this.pos[2] += (dz / d) * push * (Math.abs(dz) > 1e-6 ? 1 : 0) || 0;
        // corner case: resolve along the other axis if still overlapping
        const nx2 = clamp(this.pos[0], c.minX, c.maxX), nz2 = clamp(this.pos[2], c.minZ, c.maxZ);
        const ddx = this.pos[0] - nx2, ddz = this.pos[2] - nz2;
        const dd = Math.hypot(ddx, ddz);
        if (dd < RADIUS && dd > 1e-6) { this.pos[0] += (ddx / dd) * (RADIUS - dd); this.pos[2] += (ddz / dd) * (RADIUS - dd); }
      } else {
        // centre inside the box: push out along the movement axis
        if (axis === 0) this.pos[0] = px - (c.minX + c.maxX) / 2 < 0 ? c.minX - RADIUS : c.maxX + RADIUS;
        else this.pos[2] = pz - (c.minZ + c.maxZ) / 2 < 0 ? c.minZ - RADIUS : c.maxZ + RADIUS;
      }
    }
  }

  private bikeBlocked(): boolean {
    // front wheel point of the pushed bike must stay clear of walls/racks
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const pts = [[1.25, 0.42], [0.45, 0.42]];
    for (const [f, r] of pts) {
      const x = this.pos[0] + fx * f + rx * r, z = this.pos[2] + fz * f + rz * r;
      for (const c of this.colliders()) {
        if (c.tag === 'exitBarrier') continue;
        if (x > c.minX - 0.12 && x < c.maxX + 0.12 && z > c.minZ - 0.12 && z < c.maxZ + 0.12) return true;
      }
    }
    return false;
  }

  // ================================================================= targets
  private box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): [V3, V3] {
    return [[cx - sx / 2, cy - sy / 2, cz - sz / 2], [cx + sx / 2, cy + sy / 2, cz + sz / 2]];
  }

  private buildTargets() {
    const w = this.world;
    const T = (t: Target) => this.targets.push(t);
    const inCar = () => w.isInsideCar(this.pos);
    let [mn, mx] = this.box(4.5, 1.4, 5.21, 1.3, 1.0, 0.12);
    T({ id: 'notice', label: () => L('掲示板', 'notice board'), verb: () => L('読む', 'Read'), min: mn, max: mx, range: 2.2, enabled: () => true, activate: () => this.readNotice() });
    [mn, mx] = this.box(-4.6, 0.95, 5.1, 0.58, 1.3, 0.44);
    T({ id: 'terminal', label: () => L('精算機', 'payment machine'), min: mn, max: mx, range: 1.8, enabled: () => w.floor !== 1, activate: () => this.useTerminal() });
    [mn, mx] = this.box(-7.4, 0.6, 5.5, 1.9, 1.15, 0.64);
    T({ id: 'bike517', label: () => L('自分の自転車 517', 'your bicycle 517'), min: mn, max: mx, range: 1.8, enabled: () => w.floor === 5 && w.bikeMode === 'parked',
      activate: () => this.inspect517(), useItem: (it) => (it === 'key' ? (this.unlock517(), true) : false), accepts: ['key'] });
    [mn, mx] = this.box(1.22, 1.18, EV_Z - 1.63, 0.2, 0.26, 0.1);
    T({ id: 'call', label: () => L('呼出ボタン', 'call button'), verb: () => L('押す', 'Press'), min: mn, max: mx, range: 1.8, enabled: () => !inCar() && this.pos[2] < EV_Z - 1.5, activate: () => this.pressCall() });
    [mn, mx] = this.box(-0.85, 1.15, EV_Z + 1.44, 0.5, 1.2, 0.12);
    T({ id: 'panel', label: () => L('操作盤', 'control panel'), min: mn, max: mx, range: 2.1, enabled: () => inCar(), activate: () => this.openPanelFromWorld() });
    [mn, mx] = this.box(-0.18, 1.1, EV_Z + 1.45, 0.36, 0.26, 0.1);
    T({ id: 'reader', label: () => L('運搬認証口', 'transport reader'), min: mn, max: mx, range: 1.8, enabled: () => inCar(), activate: () => this.inspectReader(),
      useItem: (it) => (it === 'receipt' ? this.useReceipt() : false), accepts: ['receipt'] });
    T({ id: 'rail', label: () => L('運搬レール', 'transport rail'), min: [0.5, 0, EV_Z - 0.75], max: [1.1, 1.0, EV_Z + 1.2], range: 1.9, enabled: () => inCar() || w.bikeMode === 'docked', activate: () => this.inspectRail() });
    [mn, mx] = this.box(6.6, 1.05, -6.86, 1.0, 2.1, 0.08);
    T({ id: 'door3f', label: () => L('鉄扉', 'steel door'), min: mn, max: mx, range: 1.8, enabled: () => w.floor === 3, activate: () => this.ui.toast(L('鍵が掛かっている。', 'It\'s locked.')) });
    [mn, mx] = this.box(0, 1.2, -7.0, 2.6, 2.3, 0.2);
    T({ id: 'exit', label: () => L('出入口', 'exit'), min: mn, max: mx, range: 1.6, enabled: () => w.floor === 1 && this.pos[2] > -7, activate: () => this.inspectExit() });
  }

  private refreshBikeTargets(p: FloorPuzzle | null) {
    this.bikeTargets = (p?.bikes || []).map((b) => {
      const x = b.row === 'A' ? -5.4 : 4.6, z = slotZ(b.slot);
      return { id: 'bike:' + b.id, label: () => L(`駐輪中の自転車 ${b.id}`, `parked bicycle ${b.id}`), min: [x - 0.95, 0, z - 0.32] as V3, max: [x + 0.95, 1.15, z + 0.32] as V3, range: 1.8,
        enabled: () => true, activate: () => this.inspectBike(b) };
    });
  }

  private allTargets(): Target[] { return this.targets.concat(this.bikeTargets).filter((t) => t.enabled()); }

  private rayBox2D(ox: number, oz: number, dx: number, dz: number, mn: V3, mx: V3, m: number): number | null {
    let tmin = -Infinity, tmax = Infinity;
    for (const [o, d, a, b] of [[ox, dx, mn[0] - m, mx[0] + m], [oz, dz, mn[2] - m, mx[2] + m]] as const) {
      if (Math.abs(d) < 1e-9) { if (o < a || o > b) return null; }
      else { let t1 = (a - o) / d, t2 = (b - o) / d; if (t1 > t2) [t1, t2] = [t2, t1]; tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); }
    }
    if (tmax < Math.max(0, tmin)) return null;
    return Math.max(0, tmin);
  }

  private losClear(x1: number, z1: number, x2: number, z2: number): boolean {
    const dx = x2 - x1, dz = z2 - z1;
    const L = Math.hypot(dx, dz); if (L < 0.05) return true;
    for (const c of this.colliders()) {
      if (!c.occludes) continue;
      const t = this.rayBox2D(x1, z1, dx / L, dz / L, [c.minX, 0, c.minZ], [c.maxX, 0, c.maxZ], -0.02);
      if (t !== null && t < L - 0.08) return false;
    }
    return true;
  }

  private distToBox(t: Target): number {
    const x = clamp(this.pos[0], t.min[0], t.max[0]), z = clamp(this.pos[2], t.min[2], t.max[2]);
    return Math.hypot(this.pos[0] - x, this.pos[2] - z);
  }

  private pickCenter(): Target | null {
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    let best: Target | null = null, bestScore = Infinity;
    for (const t of this.allTargets()) {
      let score = Infinity;
      const hit = this.rayBox2D(this.pos[0], this.pos[2], fx, fz, t.min, t.max, 0.12);
      if (hit !== null && hit <= t.range) score = hit;
      else {
        const d = this.distToBox(t);
        if (d <= t.range) {
          const cx = (t.min[0] + t.max[0]) / 2, cz = (t.min[2] + t.max[2]) / 2;
          const ang = Math.acos(clamp((fx * (cx - this.pos[0]) + fz * (cz - this.pos[2])) / (Math.hypot(cx - this.pos[0], cz - this.pos[2]) || 1), -1, 1));
          if (ang < 0.2) score = d + 0.6 + ang;
        }
      }
      if (score < bestScore) {
        const cx = clamp(this.pos[0] + fx * (hit ?? 0), t.min[0], t.max[0]);
        const cz = clamp(this.pos[2] + fz * (hit ?? 0), t.min[2], t.max[2]);
        if (this.losClear(this.pos[0], this.pos[2], cx, cz)) { best = t; bestScore = score; }
      }
    }
    return best;
  }

  private updateTarget() {
    if (this.mode !== 'world' || this.ui.isOpen()) { if (this.current) { this.current = null; this.ui.setPrompt(null); } return; }
    const t = this.pickCenter();
    if (t !== this.current) {
      this.current = t;
      this.refreshPrompt();
    }
  }

  private refreshPrompt() {
    const t = this.current;
    if (!t) { this.ui.setPrompt(null); return; }
    if (this.heldItem) this.ui.setPrompt(t.label(), L(`${ITEM_INFO[this.heldItem].name}を使う`, `Use ${ITEM_INFO[this.heldItem].name.toLowerCase()} on`));
    else {
      const label = t.id === 'panel' && this.save?.flags.authenticated ? L('運搬照合盤', 'check panel') : t.label();
      this.ui.setPrompt(label, t.verb ? t.verb() : S.inspect);
    }
  }

  private activateTarget(t: Target) {
    if (this.heldItem) {
      const item = this.heldItem;
      if (t.useItem && t.useItem(item)) { this.setHeld(null); return; }
      this.ui.toast(S.wrongTarget);
      return;
    }
    t.activate();
  }

  private onTap(x: number, y: number, type: string) {
    if (this.mode === 'bedroom' || this.mode !== 'world' || this.ui.isOpen()) return;
    const rect = this.renderer.canvas.getBoundingClientRect();
    const ndcX = ((x - rect.left) / rect.width) * 2 - 1, ndcY = -(((y - rect.top) / rect.height) * 2 - 1);
    const ray = this.camera.ray(ndcX, ndcY);
    let best: Target | null = null, bestT = Infinity;
    for (const t of this.allTargets()) {
      const hit = this.rayBox3D(ray.origin, ray.dir, t.min, t.max, 0.06);
      if (hit !== null && hit < bestT) {
        const p: V3 = [ray.origin[0] + ray.dir[0] * hit, 0, ray.origin[2] + ray.dir[2] * hit];
        if (this.losClear(this.pos[0], this.pos[2], p[0], p[2])) { best = t; bestT = hit; }
      }
    }
    if (!best) { this.tapPending = null; return; }
    const now = performance.now();
    const inRange = this.distToBox(best) <= best.range + 0.15;
    if (type === 'mouse' || (this.tapPending && this.tapPending.id === best.id && now - this.tapPending.t <= 320 && Math.hypot(x - this.tapPending.x, y - this.tapPending.y) <= 20)) {
      this.tapPending = null;
      if (!inRange) { this.ui.toast(S.tooFar); return; }
      this.activateTarget(best);
    } else {
      this.tapPending = { id: best.id, t: now, x, y };
      // first tap: soft highlight via the prompt
      this.current = best; this.refreshPrompt();
    }
  }

  private rayBox3D(o: V3, d: V3, mn: V3, mx: V3, m: number): number | null {
    let tmin = 0, tmax = Infinity;
    for (let i = 0; i < 3; i++) {
      const a = mn[i] - m, b = mx[i] + m;
      if (Math.abs(d[i]) < 1e-9) { if (o[i] < a || o[i] > b) return null; continue; }
      let t1 = (a - o[i]) / d[i], t2 = (b - o[i]) / d[i]; if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmax < tmin) return null;
    }
    return tmin;
  }

  // ================================================================= keys
  private onKey(a: KeyAction, _e: KeyboardEvent) {
    if (this.mode === 'bedroom' && !this.ui.isOpen()) {
      if (a.type === 'pause') this.openPause();
      return;
    }
    if (this.ui.isOpen()) {
      if (a.type === 'tools' && this.ui.isOpen('tools')) { this.ui.handleKey('close'); return; }
      this.ui.handleKey(a.type, (a as any).dir, (a as any).d);
      return;
    }
    if (this.mode !== 'world') return;
    switch (a.type) {
      case 'interact':
        this.updateTarget();
        if (this.current) this.activateTarget(this.current);
        else if (this.heldItem) {
          const near = this.allTargets().some((t) => t.accepts?.includes(this.heldItem!) && this.distToBox(t) < 6);
          this.ui.toast(near ? S.tooFar : S.wrongTarget);
        }
        break;
      case 'tools': this.openTools(); break;
      case 'memo': if (this.save?.items.includes('memo')) this.openMemo(); break;
      case 'light': this.toggleLight(); break;
      case 'pause': if (this.heldItem) { this.setHeld(null); this.ui.toast(L('道具をしまった。', 'Put the item away.'), 1400); } else this.openPause(); break;
    }
  }

  // ================================================================= settings
  applySettings() {
    const s = this.settings;
    this.audio.setVolumes(s.master, s.sfx, s.amb, s.music);
    this.world.reduceFlash = s.reduceFlash;
    this.ui.subtitles = s.subtitles;
    document.documentElement.classList.toggle('large-text', s.largeText);
    this.renderer.maxPixelRatio = s.quality === 'low' ? 1 : s.quality === 'mid' ? 1.5 : 2;
    this.renderer.pixelBudget = s.quality === 'low' ? 1.0 : s.quality === 'mid' ? 2.0 : 3.6;
    this.renderer.dynamicScale = 1;
  }
  openSettings(after: () => void) {
    this.ui.settings({ ...this.settings }, (s) => { this.settings = { ...s, lang: this.settings.lang, warned: this.settings.warned }; writeSettings(this.settings); this.applySettings(); },
      () => { this.ui.close('settings'); after(); }, () => this.changeLang(isEn() ? 'ja' : 'en'));
  }

  // ================================================================= title / run start
  showTitle() {
    this.session++;
    this.fovTarget = 65; this.fovSpeed = 50;
    this.mode = 'title';
    this.view = 'facility';
    this.paused = false;
    this.ui.closeAll();
    this.ui.showHud(false);
    this.ui.root.classList.add('mode-title');
    this.ui.bigLine(null);
    this.ui.secretCaption(false);
    this.ui.setWarning(false);
    this.camOverride = null;
    this.lightOn = false;
    this.setHeld(null);
    if (this.caretaker) this.caretaker.root.visible = false;
    this.audio.stopAllLoops(0.6);
    this.world.setFloor(1, null);
    this.world.setLighting('normal');
    this.world.setDoorsInstant(false);
    this.pos = [0.4, EYE, -16.5]; this.yaw = Math.PI;
    this.ui.fadeInstant(0.55);
    this.audio.duckMusic(1, 0.5);
    this.fx.updateMusic();
    this.audio.setReverb(0.06); this.reverbZone = -1;
    this.titleMenu();
  }

  private titleMenu() {
    this.ui.close('title');
    const save = loadSave();
    const canContinue = !!save && !['NORMAL_END', 'SECRET_END'].includes(save.phase);
    const go = () => this.contentNotice(() => this.startNewGame());
    this.ui.showTitle({ canContinue, records: this.records, storageOk: storageAvailable() }, {
      onNew: () => {
        if (canContinue) this.ui.confirm(S.newGame, L('進行中の記録を消して、新しい夜を始めますか？', 'Erase your current progress and start a new night?'), S.newGame, L('戻る', 'Back'), go, () => {});
        else go();
      },
      onContinue: () => { const s = loadSave(); if (s) this.continueGame(s); },
      onSettings: () => this.openSettings(() => {}),
      onHelp: () => this.ui.help(() => {}),
      onLang: () => this.changeLang(isEn() ? 'ja' : 'en'),
    });
  }

  /** Shown once per browser before the first night: what kind of scares to expect, and where to tone them down. */
  private contentNotice(then: () => void) {
    if (this.settings.warned) { then(); return; }
    const done = () => { this.ui.close('dialog'); this.settings.warned = true; writeSettings(this.settings); then(); };
    this.ui.dialog({
      title: L('はじめる前に', 'Before you start'),
      body: L('この作品には、暗い場面での突然の大きな音、閃光、画面に向かって飛びかかってくる演出が含まれます。\n「設定」で驚かし演出と点滅を弱められます。ヘッドホンでの音量にご注意ください。',
        'This game has sudden loud sounds, flashes and jump scares in dark scenes.\nYou can tone down scares and flashing in Settings. Mind your headphone volume.'),
      actions: [
        { label: S.settings, onSelect: () => { this.ui.close('dialog'); this.openSettings(() => {}); } },
        { label: L('はじめる', 'Start'), primary: true, onSelect: done },
      ],
      onClose: () => this.ui.close('dialog'),
    });
  }

  /** Switch the language everywhere: signage, HUD, open menus. */
  changeLang(l: Lang) {
    setLang(l);
    this.settings.lang = l;
    writeSettings(this.settings);
    this.world.applyLang();
    this.ui.applyStaticText();
    this.refreshHints();
    this.refreshPrompt();
    const settingsOpen = this.ui.isOpen('settings');
    if (settingsOpen) this.ui.close('settings');
    if (this.ui.isOpen('pause')) { this.ui.close('pause'); this.paused = false; this.openPause(); }
    if (this.mode === 'title') this.titleMenu();
    if (settingsOpen) this.openSettings(() => {});
  }

  // ================================================================= sharing
  /** Post how far you got to X (opens the post composer; nothing is sent automatically). */
  share(kind: 'fail' | 'normal' | 'secret') {
    const s = this.save;
    const wrong = s?.wrongTotal ?? 0;
    const f = s?.resumeFloor ?? 5;
    let text: string;
    if (kind === 'fail') {
      text = L(`「第３駐輪場」${f}Ｆで管理人と目が合った……\n突破 ${5 - f}／4フロア・誤答${wrong}回`,
        `Bicycle Parking No.3: I met the caretaker's eyes on ${f}F...\n${5 - f} of 4 floors cleared, ${wrong} wrong answer${wrong === 1 ? '' : 's'}.`);
    } else if (kind === 'normal') {
      text = L(`「第３駐輪場」4フロアを突破して帰宅。GAME CLEAR\n誤答${wrong}回${s?.hasFailed ? '・一度失敗' : ''}`,
        `Bicycle Parking No.3: cleared all 4 floors and made it home. GAME CLEAR\n${wrong} wrong answer${wrong === 1 ? '' : 's'}${s?.hasFailed ? ', one failure' : ''}.`);
    } else {
      text = L('「第３駐輪場」誤答0回で4フロアを突破。シークレットエンドに到達した。', 'Bicycle Parking No.3: cleared all 4 floors with zero wrong answers. Secret ending reached.');
    }
    const r = this.records;
    const recs = L(`記録：帰宅 ${r.normal ? '✓' : '—'}　シークレット ${r.secret ? '✓' : '—'}`, `Records: Home ${r.normal ? '✓' : '—'}  Secret ${r.secret ? '✓' : '—'}`);
    text += `\n${recs}\n${L('#第3駐輪場', '#BicycleParkingNo3')}`;
    const url = shareUrl();
    const intent = `https://x.com/intent/post?text=${encodeURIComponent(text)}${url ? `&url=${encodeURIComponent(url)}` : ''}`;
    let w: Window | null = null;
    try { w = window.open(intent, '_blank'); } catch { w = null; }
    if (w) { try { w.opener = null; } catch { /* ignore */ } }
    else this.ui.shareFallback(url ? `${text}\n${url}` : text, intent);
  }

  private async begin() {
    const unlocking = this.audio.unlock();
    this.session++;
    this.audio.duckMusic(1, 0.3);
    this.ui.root.classList.remove('mode-title');
    this.ui.closeAll();
    this.ui.secretCaption(false);
    this.ui.bigLine(null);
    this.audio.stopAllLoops(0.3);
    this.secretShown = false; this.secretT = 0;
    this.fx.reset();
    this.hintShown = { back: false, glow: false, key: false, card: false };
    this.fovTarget = 65; this.fovSpeed = 50;
    this.camOverride = null;
    this.paused = false;
    this.setHeld(null);
    this.lightOn = false; this.ui.setLightOn(false);
    if (this.caretaker) { this.caretaker.root.visible = false; this.caretaker.mixer.stopAll(); this.caretaker.resetPose(); }
    this.view = 'facility';
    await unlocking;
    this.ui.showHud(true);
    if (!storageAvailable() && !this.storageWarned) { this.storageWarned = true; this.ui.toast(S.noSave, 4200); }
  }

  async startNewGame() {
    await this.begin();
    const firstRun = this.records.completedRuns === 0;
    const seed = this.forcedSeed ?? newSeed();
    const run = generateRun(seed, firstRun);
    this.save = {
      version: 1, runId: `${seed}-${Date.now().toString(36)}`, seed, firstRun, generatedFloors: run.floors,
      currentFloor: 5, resumeFloor: 5, phase: 'INTRO', wrongTotal: 0, warningArmed: false, hasFailed: false,
      flags: { bikeUnlocked: false, paid: false, receiptAuth: false, wheelDocked: false, authenticated: false, memoUnlocked: false },
      memo: {}, items: ['key', 'light'], savedAt: 0,
    };
    this.persist();
    this.beginIntro();
  }
  forcedSeed: number | null = null;

  async continueGame(s: SaveData) {
    await this.begin();
    this.save = s;
    const ph = s.phase;
    if (ph === 'INTRO' || ph === 'BLACKOUT') { this.resetIntroFlags(); this.beginIntro(); return; }
    if (ph === 'PAID') { this.resumePaid(); return; }
    if (ph === 'LOCKED') { this.resumeLocked(); return; }
    if (ph === 'FAIL_REVEAL' || ph === 'GAMEOVER') { this.save.phase = 'GAMEOVER'; this.persist(); this.showGameOver(); return; }
    // AUTHENTICATED / EXPLORE / INPUT / WARNING / TRANSIT / EXIT: arrive at the committed floor
    if (!s.flags.authenticated) { this.resumeLocked(); return; }
    this.arriveInstant(s.currentFloor);
  }

  private resetIntroFlags() {
    const s = this.save;
    s.phase = 'INTRO';
    s.flags = { ...s.flags, bikeUnlocked: false, paid: false, receiptAuth: false, wheelDocked: false, authenticated: false };
    s.items = s.items.filter((i) => i !== 'receipt');
    if (!s.items.includes('key')) s.items.unshift('key');
    this.persist();
  }

  persist(phase?: Phase) {
    if (!this.save) return;
    if (phase) this.save.phase = phase;
    writeSave(this.save);
  }

  puzzleFor(floor: number): FloorPuzzle | null { return this.save.generatedFloors.find((f) => f.floor === floor) || null; }
  progress(): Progress { const s = this.save; return { currentFloor: s.currentFloor, resumeFloor: s.resumeFloor, wrongTotal: s.wrongTotal, warningArmed: s.warningArmed, hasFailed: s.hasFailed }; }

  private setFloor(floor: number) {
    const p = floor >= 2 ? this.puzzleFor(floor) : null;
    this.world.setFloor(floor, p);
    if (p) this.world.addBikeColliders(p.bikes);
    this.refreshBikeTargets(p);
    this.ui.setFloor(`${floor}F`);
    this.outsideZone = null;
    this.fx.applyMood();
  }

  private setHeld(item: string | null) { this.heldItem = item; this.ui.setHeld(item); this.refreshPrompt(); }
  private toggleLight() {
    this.lightOn = !this.lightOn; this.ui.setLightOn(this.lightOn);
    this.audio.play('panel_press', { gain: 0.6, rate: 1.4 });
  }
  private refreshHints() {
    this.refreshPrompt();
    if (this.mode === 'world' && this.save) this.ui.setHint(this.ui.controlsHint(), this.statusLine());
    this.ui.setHeld(this.heldItem);
  }
  private statusLine(): string {
    const s = this.save; if (!s) return '';
    if (s.phase === 'INTRO' && this.introStage !== '5F') return '';
    if (s.phase === 'INTRO' || s.phase === 'PAID') {
      if (this.world.bikeMode === 'held') return s.flags.paid ? L('自転車を押している。エレベーターの呼出ボタンへ。', 'Pushing your bicycle. Go to the elevator call button.') : L('自転車を押している。精算機で精算する。', 'Pushing your bicycle. Pay at the payment machine.');
      return L('５Ｆ。自分の自転車は南西の区画、517番。', '5F. Your bicycle is in space 517, in the corner left of the elevator.');
    }
    if (s.phase === 'LOCKED' || s.phase === 'BLACKOUT') return L('閉じ込められた。レールと認証口を調べる。', 'Trapped. Check the rail and the reader.');
    if (s.phase === 'EXIT') return this.world.bikeMode === 'held' ? L('自転車を押して出入口へ。', 'Push your bicycle to the exit.') : L('前輪をレールから外して、自転車と出る。', 'Release the front wheel from the rail and leave with your bicycle.');
    if (s.flags.authenticated) return this.world.bikeMode === 'docked' ? L('自転車は運搬レールに固定されています', 'Your bicycle is locked to the transport rail') : '';
    return '';
  }

  /** Move the camera from wherever it is now to pos/quat. */
  private camTo(pos: V3, quat: Q, speed = 1.6) {
    this.camOverride = { fromPos: [...this.camera.position] as V3, fromQuat: [...this.camera.quaternion] as Q, pos, quat, k: 0, speed };
  }

  private placePlayer(p: V3, yaw: number) { this.pos = [p[0], EYE, p[2]]; this.yaw = yaw; this.pitch = 0; this.lookPitch = 0; this.vel = 0; this.turnVel = 0; this.camOverride = null; }

  // ================================================================= intro (§4)
  beginIntro() {
    const ses = this.session;
    this.mode = 'cutscene';
    this.introStage = 'outside';
    this.view = 'facility';
    this.lightOn = false; this.ui.setLightOn(false);
    this.ui.setWarning(false);
    this.world.placeBikeParked();
    this.setFloor(1);
    this.world.setLighting('normal');
    this.world.setDoorsInstant(false);
    this.world.setPanelPower('normal');
    this.world.setPanelDisplay('1');
    this.placePlayer([0, EYE, -17.2], Math.PI);
    this.outsideZone = null;
    this.ui.fadeInstant(1);
    this.ui.setHint('');
    this.ui.chapterCard(['23:00', L('残業を終えた。', 'Overtime is finally over.'), L('今日は、もう帰ろう。', 'Time to go home.')]).then(async () => {
      if (ses !== this.session) return;
      await this.ui.fade(0, 1200);
      if (ses !== this.session) return;
      this.mode = 'world';
      this.ui.setHint(this.ui.controlsHint(), '');
    });
  }

  private resumePaid() {
    this.mode = 'world';
    this.introStage = '5F';
    this.save.phase = 'PAID';
    if (!this.save.items.includes('receipt')) this.save.items.push('receipt');
    this.setFloor(5);
    this.world.setLighting('normal');
    this.world.setPanelPower('normal');
    this.world.setPanelDisplay('5');
    this.world.setDoorsInstant(false);
    this.placePlayer([-1.2, EYE, 2.2], Math.PI);
    this.world.placeBikeHeld(this.pos, this.yaw);
    this.outsideZone = null;
    this.ui.fadeInstant(1); this.ui.fade(0, 900);
    this.refreshHints();
  }

  private readNotice() {
    const f = this.world.floor;
    if (f === 1) {
      this.ui.dialog({ title: L('ご利用案内', 'Notice'), html: L(`<ul class="plain"><li>自転車は各階へエレベーターで運べます</li><li>料金は各階の精算機でお支払いください</li><li>精算済票は退場まで保管してください</li><li class="muted">夜間は管理人が巡回しています</li></ul>`, `<ul class="plain"><li>Bicycles can be taken to every floor by elevator</li><li>Please pay at the payment machine on each floor</li><li>Keep your paid receipt until you leave</li><li class="muted">A caretaker patrols at night</li></ul>`),
        actions: [{ label: S.close, primary: true, onSelect: () => this.ui.close('dialog') }], onClose: () => this.ui.close('dialog') });
    } else this.showRules(() => {});
  }

  private langImages: Record<string, string> = {};
  /** The pack's rule board and receipt are Japanese artwork; English gets the same layout drawn on a canvas. */
  rulesImage(): string { return isEn() ? (this.langImages.rules ||= C.rulesBoardEn().toDataURL('image/png')) : UI.operating_rules; }
  receiptImage(): string { return isEn() ? (this.langImages.receipt ||= C.receiptEn().toDataURL('image/png')) : UI.paid_receipt; }

  showRules(after: () => void) {
    this.ui.dialog({ title: L('夜間運搬の照合手順', 'Night transport check'), image: this.rulesImage(), imageAlt: L('1 票に書かれた条件を調べる。2 台数を左から順に入力する。3 「開」を押して照合する。「閉」は入力消去、「再点検」は戻る。警告後の再誤答は管理人を呼びます。自分の自転車・空き枠は数えません。', '1 Read the conditions on the checklist. 2 Enter the counts from left to right. 3 Press OPEN to check. CLOSE clears input, Recheck goes back. A wrong answer after a warning calls the caretaker. Your bicycle and empty slots do not count.'),
      body: L('数字は照合番号です。行先階ではありません。', 'The numbers are check codes, not floors.'), cls: 'rules',
      actions: [{ label: L('わかった', 'Got it'), primary: true, onSelect: () => { this.ui.close('dialog'); after(); } }], onClose: () => { this.ui.close('dialog'); after(); } });
  }

  private useTerminal() {
    const s = this.save;
    if (this.world.floor === 5 && !s.flags.paid && (s.phase === 'INTRO')) {
      s.flags.paid = true;
      if (!s.items.includes('receipt')) s.items.push('receipt');
      this.audio.play('receipt_feed'); this.ui.caption(L('［票が出る］', '[Receipt prints]'));
      this.persist(this.world.bikeMode === 'held' ? 'PAID' : 'INTRO');
      this.ui.dialog({ title: L('200円を支払った', 'Paid 200 yen'), image: this.receiptImage(), imageAlt: L('精算済票。保管階5F、保管番号517、料金200円、精算時刻23:07。運搬認証口に票を通し、前輪をレールへ合わせる。', 'Paid receipt. Floor 5F, space 517, fee 200 yen, paid at 23:07. Insert into the transport reader and set the front wheel on the rail.'),
        body: L('精算済票を受け取った。「道具」に入れておく。', 'You got the paid receipt. It\'s in your Items.'), cls: 'receipt',
        actions: [{ label: S.close, primary: true, onSelect: () => { this.ui.close('dialog'); this.refreshHints(); } }], onClose: () => { this.ui.close('dialog'); this.refreshHints(); } });
      return;
    }
    this.ui.toast(s.flags.paid ? L('精算は済んでいる。', 'Already paid.') : L('この階の精算機。', 'This floor\'s payment machine.'));
  }

  private inspect517() {
    if (!this.save.flags.bikeUnlocked) {
      this.ui.dialog({ title: L('自分の自転車　517', 'Your bicycle 517'), body: L('生成り色のシティ車。後輪の錠が掛かったままだ。', 'An off-white city bike. The rear wheel is still locked.'), image: UI.bicycle_city, imageAlt: L('シティ車', 'City bike'),
        html: `<p class="amber small">${L(`${this.ui.touch ? '「道具」ボタン' : '「道具」（I キー）'}から自転車の鍵を選んで「使う」。`, `Choose the bike key from ${this.ui.touch ? 'the Items button' : 'Items (I key)'} and select Use.`)}</p>`,
        actions: [
          { label: L('鍵を使う', 'Use the key'), primary: true, dbl: true, onSelect: () => { this.ui.close('dialog'); this.unlock517(); } },
          { label: S.close, onSelect: () => this.ui.close('dialog') },
        ], onClose: () => this.ui.close('dialog') });
    }
  }

  private unlock517() {
    if (this.world.bikeMode !== 'parked') return;
    this.save.flags.bikeUnlocked = true;
    this.audio.play('wheel_latch', { gain: 0.8, rate: 1.3 });
    this.ui.caption(L('［錠が外れる］', '[Lock opens]'));
    this.world.placeBikeHeld(this.pos, this.yaw);
    // step back a little so the bike clears the bay wall
    this.persist(this.save.flags.paid ? 'PAID' : 'INTRO');
    this.ui.toast(L('鍵を外した。押して運ぼう。', 'Unlocked. Push it along.'));
    this.refreshHints();
  }

  private async pressCall() {
    const s = this.save; const w = this.world; const ses = this.session;
    this.audio.play('panel_press', { gain: 0.9 });
    if (s.phase === 'INTRO' || s.phase === 'PAID') {
      if (w.floor === 1) {
        if (w.doorState === 'closed') {
          this.ui.caption(L('［扉が開く］', '[Doors open]')); this.audio.play('elevator_open');
          await w.openDoors();
        }
        return;
      }
      if (w.floor === 5) {
        if (w.bikeMode !== 'held') { this.ui.toast(L('先に自分の自転車を取ってこよう。', 'Get your bicycle first.')); return; }
        if (!s.flags.paid) { this.ui.toast(L('先に精算を済ませよう。精算機はエレベーターの左。', 'Pay first. The payment machine is beside the elevator.')); return; }
        await this.blackout(false);
        void ses;
        return;
      }
    }
    this.ui.toast(L('ボタンは反応しない。', 'The button doesn\'t respond.'));
  }

  private async rideUp() {
    // normal operation: 1F → 5F
    const w = this.world; const ses = this.session;
    this.mode = 'cutscene';
    this.introStage = 'up';
    this.ui.caption(L('［扉が閉まる］', '[Doors close]')); this.audio.play('elevator_close');
    await w.closeDoors();
    if (ses !== this.session) return;
    this.audio.loop('elevator_motor_loop', 1, 0.3); this.ui.caption(L('［上昇中］', '[Going up]'), 2600);
    for (let f = 2; f <= 5; f++) {
      await this.wait(1.1);
      if (ses !== this.session) return;
      w.setIndicator(String(f), '▲'); w.setPanelDisplay(String(f));
      if (f === 4) { this.setFloor(5); w.setIndicator('4', '▲'); w.setPanelDisplay('4'); this.ui.setFloor('4F'); }
    }
    w.setIndicator('5'); this.ui.setFloor('5F');
    this.audio.stopLoop('elevator_motor_loop', 0.4);
    await this.wait(0.5);
    this.ui.caption(L('［扉が開く］', '[Doors open]')); this.audio.play('elevator_open');
    await w.openDoors();
    if (ses !== this.session) return;
    this.introStage = '5F';
    this.mode = 'world';
    this.leftCarAt = -1;
    this.refreshHints();
  }

  // ================================================================= blackout & lock-in (§4.5–4.8)
  private async blackout(inside: boolean) {
    const w = this.world; const ses = this.session;
    this.mode = 'cutscene';
    this.save.phase = 'BLACKOUT';
    this.persist();
    this.audio.play('power_cut'); this.ui.caption(L('［停電］', '[Power cut]'));
    this.audio.sting('st_impact', { gain: 0.85 });
    this.audio.setDuck(0.2, 0.05);
    w.setLighting('off');
    this.ui.fadeInstant(0.97);
    await this.wait(0.65);
    if (ses !== this.session) return;
    if (!inside) w.setDoorsInstant(false);
    w.setLighting('emergency');
    w.setPanelPower('off');
    w.setIndicator('5', '');
    this.fx.applyMood();
    this.audio.setDuck(1, 0.6);
    this.audio.stopLoop('outdoor_air_loop', 0.3);
    this.outsideZone = null;
    this.ui.fade(0, 350);
    await this.wait(0.8);
    if (ses !== this.session) return;
    if (inside) { await this.lockIn(); return; }
    this.ui.caption(L('［扉が開く］', '[Doors open]')); this.audio.play('elevator_open');
    await w.openDoors();
    if (ses !== this.session) return;
    this.mode = 'world';
    this.ui.toast(L('非常灯が点いた。扉と昇降機だけは動いている。', 'Emergency lights. Only the doors and the lift still work.'), 3400);
    this.refreshHints();
  }

  private async lockIn() {
    const w = this.world; const ses = this.session;
    this.mode = 'cutscene';
    await this.wait(0.5);
    if (ses !== this.session) return;
    this.ui.caption(L('［扉が閉まる］', '[Doors close]')); this.audio.play('elevator_close');
    await w.closeDoors();
    if (ses !== this.session) return;
    this.save.phase = 'LOCKED';
    this.persist();
    this.audio.sting('st_hit', { gain: 0.6 });
    this.fx.applyMood();
    this.lockedSince = this.time;
    this.hintShown.back = false; this.hintShown.glow = false;
    this.mode = 'world';
    this.ui.toast(L('扉が閉まった。開かない。', 'The doors closed. They won\'t open.'), 3000);
    this.refreshHints();
  }

  private resumeLocked() {
    const s = this.save; const w = this.world;
    s.phase = 'LOCKED';
    if (!s.items.includes('receipt')) s.items.push('receipt');
    s.flags.paid = true; s.flags.bikeUnlocked = true;
    this.setFloor(5);
    w.setLighting('emergency');
    w.setPanelPower('off');
    w.setDoorsInstant(false);
    this.placePlayer(PLAYER_INSIDE, Math.PI * 0.85);
    if (s.flags.wheelDocked) w.placeBikeDocked(); else { this.placePlayer([-0.6, EYE, EV_Z + 0.6], Math.PI); w.placeBikeHeld(this.pos, this.yaw); }
    this.lockedSince = this.time;
    this.mode = 'world';
    this.ui.fadeInstant(1); this.ui.fade(0, 900);
    this.persist();
    this.refreshHints();
    if (s.flags.receiptAuth && s.flags.wheelDocked) this.authenticate();
  }

  private inspectReader() {
    const s = this.save;
    if (s.phase === 'LOCKED') {
      if (s.flags.receiptAuth) { this.ui.toast(L('票は読み取り済み。琥珀色の表示が点いている。', 'Receipt already read. An amber light is on.')); return; }
      this.ui.dialog({ title: L('運搬認証口', 'Transport reader'), body: L('票を差し込む細い口がある。非常電源で表示だけが薄く光っている。', 'A narrow slot for a receipt. Only its display glows on emergency power.'),
        html: `<p class="amber small">${L(`${this.ui.touch ? '「道具」' : '「道具」（I キー）'}から精算済票を選んで「使う」。`, `Choose the paid receipt from ${this.ui.touch ? 'Items' : 'Items (I key)'} and select Use.`)}</p>`,
        actions: [
          { label: L('精算済票を通す', 'Insert the paid receipt'), primary: true, dbl: true, onSelect: () => { this.ui.close('dialog'); if (s.items.includes('receipt')) this.useReceipt(); else this.ui.toast(L('票を持っていない。', 'You don\'t have a receipt.')); } },
          { label: S.close, onSelect: () => this.ui.close('dialog') },
        ], onClose: () => this.ui.close('dialog') });
      return;
    }
    this.ui.toast(s.flags.authenticated ? L('認証済み。', 'Authenticated.') : L('運搬認証口。今は使わない。', 'The transport reader. Not needed now.'));
  }

  private useReceipt(): boolean {
    const s = this.save;
    if (s.phase !== 'LOCKED') { this.ui.toast(s.flags.authenticated ? L('認証は済んでいる。', 'Already authenticated.') : S.wrongTarget); return true; }
    if (s.flags.receiptAuth) { this.ui.toast(L('票は読み取り済み。', 'Receipt already read.')); return true; }
    s.flags.receiptAuth = true;
    this.audio.play('receipt_feed'); this.ui.caption(L('［票の読み取り］', '[Reading receipt]'));
    this.ui.toast(L('票が読み取られ、手元に戻ってきた。', 'The receipt was read and came back out.'));
    this.world.setReaderHint(0);
    this.persist();
    this.checkAuth();
    return true;
  }

  private inspectRail() {
    const s = this.save; const w = this.world;
    if (s.phase === 'LOCKED' || s.phase === 'BLACKOUT') {
      if (w.bikeMode === 'held') {
        this.ui.dialog({ title: L('運搬レール', 'Transport rail'), body: L('床の溝に銘板がある。\n「運搬認証後、前輪をレールへ合わせてください」', 'A plate in the floor groove reads:\n"After authentication, set your front wheel on the rail."'),
          actions: [
            { label: L('前輪を合わせる', 'Set the front wheel'), primary: true, dbl: true, onSelect: () => { this.ui.close('dialog'); this.dock(); } },
            { label: S.close, onSelect: () => this.ui.close('dialog') },
          ], onClose: () => this.ui.close('dialog') });
      } else this.ui.toast(L('前輪はレールに固定されている。', 'The front wheel is locked to the rail.'));
      return;
    }
    if (s.phase === 'EXIT' && w.bikeMode === 'docked') {
      this.ui.dialog({ title: L('運搬レール', 'Transport rail'), body: L('前輪はストッパーに収まっている。', 'The front wheel sits in the stopper.'), actions: [
        { label: L('前輪を外す', 'Release the front wheel'), primary: true, dbl: true, onSelect: () => { this.ui.close('dialog'); this.undock(); } },
        { label: S.close, onSelect: () => this.ui.close('dialog') },
      ], onClose: () => this.ui.close('dialog') });
      return;
    }
    if (w.bikeMode === 'docked') this.ui.toast(L('自転車は運搬レールに固定されている。', 'Your bicycle is locked to the transport rail.'));
    else this.ui.toast(L('床の運搬レール。', 'The transport rail in the floor.'));
  }

  private dock() {
    const w = this.world;
    w.placeBikeDocked();
    this.audio.play('wheel_latch'); this.ui.caption(L('［前輪が固定される］', '[Front wheel locks]'));
    this.save.flags.wheelDocked = true;
    // keep the player clear of the docked bike
    if (this.pos[0] > 0.2) this.pos[0] = 0.15;
    this.persist();
    this.refreshHints();
    if (this.save.phase === 'LOCKED') this.checkAuth();
  }

  private undock() {
    this.save.flags.wheelDocked = false;
    this.audio.play('wheel_latch', { rate: 0.85 }); this.ui.caption(L('［前輪を外す］', '[Front wheel released]'));
    this.placePlayer([0.2, EYE, EV_Z + 0.4], 0);
    this.world.placeBikeHeld(this.pos, this.yaw);
    this.persist();
    this.refreshHints();
  }

  private checkAuth() {
    const f = this.save.flags;
    if (f.receiptAuth && f.wheelDocked && !f.authenticated) this.authenticate();
  }

  private async authenticate() {
    const w = this.world; const ses = this.session;
    this.mode = 'cutscene';
    this.save.flags.authenticated = true;
    this.save.phase = 'AUTHENTICATED';
    this.persist();
    await this.wait(0.6);
    if (ses !== this.session) return;
    w.setPanelPower('auth');
    w.setPanelDisplay(L('入力', 'INPUT'), '', '#E9B96E');
    this.audio.play('answer_correct', { gain: 0.7 }); this.ui.caption(L('［照合盤が点灯］', '[Check panel lights up]'));
    w.setLighting('night');
    this.fx.applyMood();
    await this.wait(1.0);
    if (ses !== this.session) return;
    this.showRules(async () => {
      if (ses !== this.session) return;
      this.ui.toast(L('「閉」は照合中、入力の消去になる。', 'During checks, CLOSE clears your input.'), 3200);
      this.ui.caption(L('［扉が開く］', '[Doors open]')); this.audio.play('elevator_open');
      await w.openDoors();
      if (ses !== this.session) return;
      this.save.phase = 'EXPLORE';
      this.save.currentFloor = 5; this.save.resumeFloor = 5;
      this.persist();
      this.mode = 'world';
      this.ui.setFloor('5F');
      this.ui.toast(L('５Ｆの扉が開いた。照合票は操作盤で読める。', 'The 5F doors opened. The checklist is on the control panel.'), 3600);
      this.refreshHints();
    });
  }

  // ================================================================= panel (§8)
  private openPanelFromWorld() {
    const s = this.save;
    if (s.phase === 'EXIT') { this.ui.toast(L('照合はもう必要ない。前輪を外して出よう。', 'No more checks. Release the front wheel and get out.')); return; }
    this.panelInput = []; this.panelMsg = ''; this.panelMsgWarn = false; this.panelLocked = false;
    if (s.flags.authenticated && (s.phase === 'EXPLORE' || s.phase === 'WARNING' || s.phase === 'INPUT')) {
      s.phase = 'INPUT';
    }
    this.ui.panel(this.panelModel(), {
      onDigit: (d) => this.panelDigit(d), onClear: () => this.panelClear(), onOpen: () => this.panelOpen(),
      onReinspect: () => this.panelReinspect(), onClose: () => this.closePanel(),
    });
  }

  private panelMode(): PanelModel['mode'] {
    const s = this.save;
    if (s.flags.authenticated) return 'auth';
    if (s.phase === 'LOCKED' || s.phase === 'BLACKOUT') return 'dead';
    return 'normal';
  }

  private panelModel(): PanelModel {
    const s = this.save; const f = this.world.floor;
    return {
      mode: this.panelMode(), floor: f, clueNo: `0${6 - f}`, puzzle: this.panelMode() === 'auth' ? this.puzzleFor(f) : null,
      input: this.panelInput, warning: s.warningArmed, message: this.panelMsg, messageWarn: this.panelMsgWarn, locked: this.panelLocked,
    };
  }
  private refreshPanel() { this.ui.updatePanel(this.panelModel()); }

  private closePanel() {
    if (this.panelLocked) return;
    this.ui.close('panel');
    if (this.save.phase === 'INPUT') this.save.phase = this.save.warningArmed ? 'WARNING' : 'EXPLORE';
  }

  private panelDigit(d: number) {
    const mode = this.panelMode();
    this.audio.play('panel_press', { restart: true });
    this.world.pressButtonAnim(d);
    if (mode === 'dead') { this.panelMsg = L('反応しない。', 'No response.'); this.panelMsgWarn = false; this.refreshPanel(); return; }
    if (mode === 'normal') { this.normalDestination(d); return; }
    const p = this.puzzleFor(this.world.floor)!;
    if (this.panelInput.length >= p.codeLength) { this.panelMsg = L(`入力は${p.codeLength}桁。「閉」で消して入れ直せる。`, `The code has ${p.codeLength} digit${p.codeLength > 1 ? 's' : ''}. CLOSE clears it.`); this.panelMsgWarn = false; }
    else { this.panelInput.push(d); this.panelMsg = ''; }
    this.world.setPanelDisplay(this.panelInput.join(' ') || L('入力', 'INPUT'));
    this.refreshPanel();
  }

  private panelClear() {
    const mode = this.panelMode();
    this.audio.play('panel_press', { restart: true, rate: 0.9 });
    if (mode === 'dead') { this.panelMsg = L('反応しない。', 'No response.'); this.refreshPanel(); return; }
    if (mode === 'normal') { this.normalDoor(false); return; }
    this.panelInput = []; this.panelMsg = L('入力を消去した。', 'Input cleared.'); this.panelMsgWarn = false;
    this.world.setPanelDisplay(L('入力', 'INPUT'));
    this.refreshPanel();
  }

  private normalDestination(d: number) {
    const w = this.world; const s = this.save;
    if (w.floor === 1) {
      if (d === 5) { this.ui.close('panel'); this.rideUp(); return; }
      this.panelMsg = d === 1 ? L('ここは１階だ。', 'This is 1F.') : L('自転車は５階に停めてある。', 'Your bicycle is on 5F.'); this.refreshPanel(); return;
    }
    if (w.floor === 5) {
      if (d === 5) { this.panelMsg = L('ここは５階だ。', 'This is 5F.'); this.refreshPanel(); return; }
      if (w.bikeMode === 'held' && s.flags.paid) {
        // a downward call from inside also triggers the outage (handoff: 「下降操作の際に停電」)
        if (w.isInsideCar(this.pos) && w.isInsideCar(w.bike517.root.position)) { this.ui.close('panel'); this.blackout(true); return; }
        this.panelMsg = L('自転車ごと乗り込んでから。', 'Get in with your bicycle first.'); this.refreshPanel(); return;
      }
      this.panelMsg = w.bikeMode === 'held' ? L('先に精算を済ませよう。', 'Pay first.') : L('先に自分の自転車を取ってこよう。', 'Get your bicycle first.'); this.refreshPanel(); return;
    }
  }

  private async normalDoor(open: boolean) {
    const w = this.world;
    if (open && w.doorState === 'closed') { this.audio.play('elevator_open'); this.ui.caption(L('［扉が開く］', '[Doors open]')); await w.openDoors(); }
    else if (!open && w.doorState === 'open') { this.audio.play('elevator_close'); this.ui.caption(L('［扉が閉まる］', '[Doors close]')); await w.closeDoors(); }
  }

  private async panelOpen() {
    const mode = this.panelMode();
    this.audio.play('panel_press', { restart: true, rate: 0.8 });
    if (mode === 'dead') { this.panelMsg = L('反応しない。', 'No response.'); this.refreshPanel(); return; }
    if (mode === 'normal') { this.normalDoor(true); return; }
    const s = this.save;
    const p = this.puzzleFor(this.world.floor)!;
    const { result, next } = commitAnswer(this.progress(), p, this.panelInput);
    if (result === 'incomplete') { this.panelMsg = S.incomplete; this.panelMsgWarn = false; this.refreshPanel(); return; }
    // persist BEFORE any presentation (§16)
    Object.assign(s, { currentFloor: next.currentFloor, resumeFloor: next.resumeFloor, wrongTotal: next.wrongTotal, warningArmed: next.warningArmed, hasFailed: next.hasFailed });
    this.panelInput = [];
    if (result === 'correct') {
      s.phase = 'TRANSIT'; this.persist();
      this.ui.setWarning(false);
      this.fx.setWarning(false);
      this.audio.play('answer_correct'); this.ui.caption(L('［照合完了］', '[Check complete]'));
      this.panelMsg = L('照合完了。', 'Check complete.'); this.panelMsgWarn = false; this.panelLocked = true; this.refreshPanel();
      this.world.setPanelDisplay('OK');
      await this.wait(0.9);
      this.panelLocked = false;
      this.ui.close('panel');
      this.descend(next.currentFloor);
      return;
    }
    if (result === 'warning') {
      s.phase = 'WARNING'; this.persist();
      this.audio.play('warning_buzzer', { restart: true }); this.ui.caption(L('［ブザー］', '[Buzzer]'));
      this.ui.setWarning(true);
      this.fx.setWarning(true);
      this.audio.sting('st_hit', { gain: 0.8 });
      this.wait(1.1).then(() => this.fx.knockAt([0, 1.3, EV_Z - 1.6], 0.7, 4));
      this.panelMsg = S.warning; this.panelMsgWarn = true;
      this.world.setPanelDisplay('×', '', '#D9877D');
      this.refreshPanel();
      if (this.world.doorState === 'open') { this.audio.play('elevator_close'); this.ui.caption(L('［扉が閉まる］', '[Doors close]')); this.world.closeDoors(); }
      return;
    }
    // fail
    s.phase = 'FAIL_REVEAL'; this.persist();
    this.failReveal();
  }

  private async panelReinspect() {
    if (this.panelMode() !== 'auth') return;
    this.audio.play('panel_press', { restart: true, rate: 0.85 });
    this.panelInput = [];
    this.ui.close('panel');
    this.save.phase = this.save.warningArmed ? 'WARNING' : 'EXPLORE';
    this.world.setPanelDisplay(L('入力', 'INPUT'));
    if (this.world.doorState !== 'open') {
      this.ui.caption(L('［扉が開く］', '[Doors open]')); this.audio.play('elevator_open');
      await this.world.openDoors();
    }
    this.ui.toast(this.save.warningArmed ? L('再点検。警告は解除されていない。', 'Recheck. The warning is still on.') : L('再点検。この階を調べ直せる。', 'Recheck. You can look around this floor again.'), 2600);
  }

  // ================================================================= descent (§5)
  private async descend(next: number) {
    const w = this.world; const ses = this.session; const from = w.floor;
    this.mode = 'cutscene';
    if (!w.isInsideCar(this.pos)) this.camTo(PLAYER_INSIDE, quatYawPitch(0, 0));
    if (w.doorState !== 'closed') { this.ui.caption(L('［扉が閉まる］', '[Doors close]')); this.audio.play('elevator_close'); await w.closeDoors(); }
    if (ses !== this.session) return;
    if (this.camOverride) { this.placePlayer(PLAYER_INSIDE, 0); }
    this.audio.loop('elevator_motor_loop', 1, 0.3); this.ui.caption(L('［下降中］', '[Going down]'), 2400);
    w.setIndicator(String(from), '▼');
    w.blackout = 0.35;
    await this.wait(1.6);
    if (ses !== this.session) return;
    if (from === 4) { w.blackout = 0.8; this.fx.shake = 0.35; await this.wait(0.45); w.blackout = 0.35; }
    if (from === 3) { await this.fx.stall(); if (ses !== this.session) return; w.blackout = 0.35; }
    this.setFloor(next);
    w.setIndicator(String(next), '▼');
    w.setPanelDisplay(next === 1 ? String(next) : L('入力', 'INPUT'));
    await this.wait(1.6);
    if (ses !== this.session) return;
    w.setIndicator(String(next));
    this.audio.stopLoop('elevator_motor_loop', 0.4);
    w.blackout = 0;
    await this.wait(0.4);
    this.save.phase = next === 1 ? 'EXIT' : 'EXPLORE';
    this.persist();
    this.ui.caption(L('［扉が開く］', '[Doors open]')); this.audio.play('elevator_open');
    await w.openDoors();
    if (ses !== this.session) return;
    this.mode = 'world';
    this.flavorT = 6 + Math.random() * 6;
    this.outsideZone = null;
    this.fx.arrive(next);
    if (next === 1) this.ui.toast(L('１Ｆに着いた。前輪をレールから外して、出よう。', '1F. Release the front wheel and get out.'), 3600);
    else this.ui.toast(L(`${next}Ｆ。照合票は操作盤で読める。`, `${next}F. The checklist is on the control panel.`), 2600);
    this.refreshHints();
  }

  private arriveInstant(floor: number) {
    const s = this.save; const w = this.world;
    this.view = 'facility';
    if (this.caretaker) this.caretaker.root.visible = false;
    s.currentFloor = floor;
    this.setFloor(floor);
    w.setLighting('night');
    w.setPanelPower('auth');
    w.setPanelDisplay(floor === 1 ? '1' : L('入力', 'INPUT'));
    w.setDoorsInstant(true);
    if (s.phase !== 'EXIT' || s.flags.wheelDocked !== false) w.placeBikeDocked();
    if (floor === 1 && !s.flags.wheelDocked) { w.placeBikeHeld([0.2, EYE, EV_Z + 0.4], 0); }
    this.placePlayer(PLAYER_INSIDE, 0);
    if (w.bikeMode === 'held') { this.placePlayer([0.2, EYE, EV_Z + 0.4], 0); w.placeBikeHeld(this.pos, this.yaw); }
    s.phase = floor === 1 ? 'EXIT' : (s.warningArmed ? 'WARNING' : 'EXPLORE');
    this.ui.setWarning(s.warningArmed);
    this.fx.setWarning(s.warningArmed);
    this.persist();
    this.fx.applyMood();
    this.mode = 'world';
    this.outsideZone = null;
    this.ui.fadeInstant(1); this.ui.fade(0, 900);
    this.refreshHints();
  }

  // ================================================================= failure (§9 game over)
  async loadCaretaker(): Promise<ModelTemplate> {
    const want = this.settings.caretakerHi ? 'caretaker_hi' : 'caretaker_lod';
    if (this.caretakerTpl && (this.caretakerTpl as any).__name === want) return this.caretakerTpl;
    if (!this.caretakerLoading || (this.caretakerLoading as any).__name !== want) {
      const pr = (async () => {
        const tpl = await loadGLB(await fetchModel(want));
        (tpl as any).__name = want;
        return tpl;
      })();
      (pr as any).__name = want;
      this.caretakerLoading = pr;
    }
    const tpl = await this.caretakerLoading;
    if (this.caretakerTpl !== tpl) {
      this.caretakerTpl = tpl;
      if (this.caretaker) this.caretaker.root.parent?.remove(this.caretaker.root);
      this.caretaker = new Caretaker(tpl);
      this.caretaker.root.visible = false;
      this.world.scene.root.add(this.caretaker.root);
      this.renderer.prepare(this.caretaker.root);
      this.caretakerBed = null;
    }
    return tpl;
  }

  private async failReveal() {
    const w = this.world; const ses = this.session;
    this.mode = 'cutscene';
    this.panelLocked = true; this.refreshPanel();
    this.audio.play('warning_buzzer', { restart: true, rate: 0.8 }); this.ui.caption(L('［ブザー］', '[Buzzer]'));
    this.world.setPanelDisplay('×', '', '#D9877D');
    await this.wait(0.9);
    if (ses !== this.session) return;
    this.panelLocked = false;
    this.ui.closeAll();
    this.ui.setWarning(false);
    this.fx.setWarning(false);
    const careLoad = this.loadCaretaker();
    if (w.doorState !== 'closed') { this.ui.caption(L('［扉が閉まる］', '[Doors close]')); this.audio.play('elevator_close'); await w.closeDoors(); }
    if (ses !== this.session) return;
    // the car climbs back to 5F
    this.camTo([0, EYE, EV_Z - 0.05], quatYawPitch(0, 0));
    this.audio.loop('elevator_motor_loop', 1.2, 0.2); this.ui.caption(L('［上昇している］', '[It\'s going up]'), 2600);
    w.setPanelDisplay('');
    const from = w.floor;
    for (let f = from; f <= 5; f++) { w.setIndicator(String(f), f < 5 ? '▲' : ''); this.ui.setFloor(`${f}F`); await this.wait(from === 5 ? 1.2 : 0.7); if (ses !== this.session) return; }
    let loaded = true;
    try { await careLoad; } catch { loaded = false; }
    if (ses !== this.session) return;
    this.setFloor(5);
    w.setIndicator('5');
    if (!loaded || !this.caretaker) {
      // model unavailable (network): keep the outcome, skip the figure
      this.audio.stopLoop('elevator_motor_loop', 0.3);
      this.ui.caption(L('［扉が開く］', '[Doors open]')); this.audio.play('elevator_open'); await w.openDoors();
      this.audio.play('caretaker_presence'); this.ui.bigLine(S.failed, 'fail');
      await this.wait(2.0); await this.ui.fade(1, 900);
      this.save.phase = 'GAMEOVER'; this.persist(); this.showGameOver(); return;
    }
    const c = this.caretaker;
    this.fx.revealMood();
    c.resetPose();
    c.root.position = [0, 0, EV_Z - 2.25];
    c.root.quaternion = [0, 1, 0, 0]; // rotate π: face +Z into the car
    c.root.visible = true;
    c.still();
    this.placePlayer([0, EYE, EV_Z - 0.05], 0);
    this.camOverride = null;
    this.ui.showHud(false);
    this.audio.stopLoop('elevator_motor_loop', 0.3);
    await this.wait(0.6);
    if (ses !== this.session) return;
    // eyes meet as the doors open; camera fixed on his eyes
    const eye = c.eyeWorld();
    const start: V3 = [0, EYE, EV_Z - 0.05];
    this.camTo(start, quatLookDir(sub(eye, start)), 2.2);
    this.audio.setDuck(0.0, 0.5); // the building goes quiet
    this.audio.setDrone(0, 0.3);
    this.ui.caption(L('［扉が開く］', '[Doors open]')); this.audio.play('elevator_open');
    this.fovTarget = 50; this.fovSpeed = 0.9;
    await w.openDoors();
    if (ses !== this.session) return;
    // he just looks at you, normal face; then the change; then he comes for the lens
    this.audio.music(null, { fade: 0.3 });
    this.audio.play('caretaker_presence', { gain: 0.6 });
    const scare = this.settings.jumpScare;
    await this.wait(0.7);
    if (ses !== this.session) return;
    c.transform();
    this.audio.sting('st_riser', { gain: 0.95, delay: 0.55 });
    const near: V3 = [0, EYE - 0.02, EV_Z - 0.55];
    this.camTo(near, quatLookDir(sub(eye, near)), 0.5);
    this.fovTarget = 38; this.fovSpeed = 1.0;
    await this.wait(2.3);
    if (ses !== this.session) return;
    if (scare) {
      c.exaggerate = 0.3;
      c.pounceAt(near, 0.34, { dist: 0.3, lean: 0.2, rise: 0.1 });
      this.audio.sting('st_scare', { gain: 1.0 });
      this.fx.shake = 1.6;
      this.fovTarget = 52; this.fovSpeed = 7; // widen as he closes: the face distorts and fills the screen
      this.ui.scareFlash(0.85, this.settings.reduceFlash);
      await this.wait(0.5);
    } else {
      this.audio.swell(1.4, 0.26);
      c.root.position = [0, 0, c.root.position[2] + 0.3];
      await this.wait(1.2);
    }
    if (ses !== this.session) return;
    // hard cut; the line comes up on black
    this.ui.fadeInstant(1);
    this.audio.setDuck(0, 0.02);
    await this.wait(1.0);
    if (ses !== this.session) return;
    this.ui.bigLine(S.failed, 'fail');
    await this.wait(1.6);
    if (ses !== this.session) return;
    this.audio.setDuck(1, 0.5);
    this.save.phase = 'GAMEOVER';
    this.persist();
    this.showGameOver();
  }

  private showGameOver() {
    this.mode = 'cutscene';
    this.fovTarget = 65; this.fovSpeed = 50;
    this.audio.stopAllLoops(0.4);
    this.ui.showHud(false);
    this.ui.fadeInstant(1);
    const f = this.save.resumeFloor;
    this.ui.gameOver({
      onRetry: () => this.retryFloor(),
      onNew: () => this.startNewGame(),
      onTitle: () => this.showTitle(),
      onShare: () => this.share('fail'),
      reached: L(`${f}Ｆで失敗　／　突破 ${5 - f}／4フロア　／　誤答 ${this.save.wrongTotal}回`, `Failed on ${f}F  /  ${5 - f} of 4 floors cleared  /  ${this.save.wrongTotal} wrong answer${this.save.wrongTotal === 1 ? '' : 's'}`),
    });
    this.ui.bigLine(null);
  }

  private retryFloor() {
    const s = this.save;
    const next = resumeAfterFail(this.progress());
    Object.assign(s, { currentFloor: next.currentFloor, warningArmed: false });
    s.phase = 'EXPLORE';
    this.audio.duckMusic(1, 0.3); this.audio.setDuck(1, 0.3);
    this.persist();
    this.ui.closeAll();
    this.ui.showHud(true);
    this.camOverride = null;
    if (this.caretaker) { this.caretaker.root.visible = false; this.caretaker.mixer.stopAll(); this.caretaker.resetPose(); }
    this.ui.bigLine(null);
    this.arriveInstant(s.currentFloor);
    this.ui.toast(S.retryNote, 3000);
  }

  // ================================================================= exit & endings (§9)
  private inspectExit() {
    const s = this.save;
    if (s.phase === 'EXIT') { this.ui.toast(this.world.bikeMode === 'held' ? L('外の風が入ってくる。', 'Wind blows in from outside.') : L('自転車を置いていけない。', 'You can\'t leave your bicycle.')); return; }
    this.ui.toast(L('５階の自転車を取りに来たのだ。', 'You came for your bicycle on 5F.'));
  }

  private async startEnding() {
    const s = this.save; const ses = this.session;
    const kind = endingFor(this.progress());
    this.records.completedRuns += 1;
    if (kind === 'normal') this.records.normal = true; else this.records.secret = true;
    writeRecords(this.records);
    s.phase = kind === 'normal' ? 'NORMAL_END' : 'SECRET_END';
    clearSave();
    this.fx.updateMusic();
    if (kind === 'secret') {
      // no blackout: keep walking out with the bike (§9 シークレットクリア)
      this.audio.stopLoop('garage_air_loop', 1.5);
      this.audio.loop('outdoor_air_loop', 1.3, 1.5);
      this.ui.setHint('');
      return; // caption is triggered by position in watchers()
    }
    // normal: the view slowly goes black while still moving
    this.ui.setHint('');
    await this.ui.fade(1, 2800);
    if (ses !== this.session) return;
    this.mode = 'cutscene';
    this.audio.stopAllLoops(1.0);
    await this.wait(1.6);
    if (ses !== this.session) return;
    await this.enterBedroom();
  }

  secretShown = false;
  private async secretCaption() {
    const ses = this.session;
    this.secretShown = true;
    this.ui.showHud(false);
    this.ui.secretCaption(true);
    await this.wait(3.6);
    if (ses !== this.session) return;
    this.ui.ending('secret', this.records, { onTitle: () => this.showTitle(), onNew: () => this.startNewGame(), onShare: () => this.share('secret') });
  }

  private async enterBedroom() {
    const ses = this.session;
    if (!this.bedroom) this.bedroom = new Bedroom(this.templates.bedroom);
    let tpl: ModelTemplate | null = null;
    try { tpl = await this.loadCaretaker(); } catch { tpl = null; }
    if (ses !== this.session) return;
    if (tpl && !this.caretakerBed) {
      this.caretakerBed = new Caretaker(tpl);
      const seat = this.templates.bedroom.nodes.find((n) => n.name === 'CARETAKER_SEAT');
      this.bedroom.setCaretaker(this.caretakerBed, { pos: (seat?.t as V3) || [0.65, 0, -0.6], rotY: seat?.extras?.rotationY ?? Math.PI / 2 });
      this.renderer.prepare(this.bedroom.scene.root);
    }
    if (!tpl) this.bedLookHeld = 0;
    this.caretakerBed?.resetPose();
    if (this.caretakerBed && this.bedroom.caretaker === this.caretakerBed) {
      const seat = this.templates.bedroom.nodes.find((n) => n.name === 'CARETAKER_SEAT');
      this.caretakerBed.root.position = [...((seat?.t as V3) || [0.65, 0, -0.6])] as V3;
      this.caretakerBed.root.quaternion = quatAxisAngle([0, 1, 0], seat?.extras?.rotationY ?? Math.PI / 2);
      this.caretakerBed.seated();
    }
    this.bedroom.t = 0;
    this.view = 'bedroom';
    this.mode = 'bedroom';
    this.ui.showHud(false);
    this.camera.position = [...this.bedroom.wake] as V3;
    this.camera.quaternion = this.bedroom.cameraQuat();
    this.audio.loop('bedroom_roomtone_loop', 1, 2);
    this.audio.music('bgm_bedroom', { gain: 0.8, fade: 4 });
    this.audio.setReverb(0.1); this.reverbZone = -1;
    this.bedLookHeld = 0; this.bedIdle = 0; this.bedDone = false; this.bedHint = false; this.breathT = 1.5;
    this.bedZoom = 0; this.bedFov = 0;
    await this.ui.fade(0, 3200);
  }
  bedLookHeld = 0; bedIdle = 0; bedDone = false; bedHint = false; breathT = 0;

  private tickBedroom(dt: number) {
    const b = this.bedroom; if (!b) return;
    this.caretakerBed?.update(dt);
    if (this.mode === 'bedroom' && !this.ui.isOpen() && !this.bedDone) {
      const h = this.input.held;
      const dir = (h.right ? 1 : 0) - (h.left ? 1 : 0);
      if (dir !== 0) this.bedIdle = 0; else this.bedIdle += dt;
      let v = dir * 0.42;
      if (this.bedIdle > 9 && b.t < 1) v = 0.25; // accessibility: turn on its own after a while
      b.t = clamp(b.t + v * dt, 0, 1);
      if (!this.bedHint && this.time > 0 && this.bedIdle > 3.5 && b.t < 0.2) {
        this.bedHint = true;
        this.ui.toast(this.ui.touch ? L('十字キーの右で、右を向く', 'Press right on the D-pad to look right') : L('D／→ で右を向く', 'D / → to look right'), 6000);
      }
      if (b.t > 0.97) {
        this.bedLookHeld += dt;
        if (this.bedLookHeld > 1.3 && !this.bedDone) {
          this.bedDone = true;
          this.bedFinale();
        }
      } else this.bedLookHeld = 0;
    }
    this.breathT -= dt;
    if (this.breathT <= 0) { this.audio.breath(this.bedDone ? 0.11 : 0.07, 1.8); this.breathT = (this.bedDone ? 1.6 : 3.8) + Math.random(); }
    const sh = this.fx.shake * 0.035;
    this.fx.shake = Math.max(0, this.fx.shake - dt * 1.8);
    this.camera.position = [b.wake[0] + (Math.random() - 0.5) * sh, b.wake[1] + (Math.random() - 0.5) * sh, b.wake[2] + (Math.random() - 0.5) * sh];
    this.camera.quaternion = b.cameraQuat();
    if (this.bedZoom > 0) this.camera.fov = lerp(this.camera.fov, (27 * Math.PI) / 180, Math.min(1, dt * 0.7));
    else if (this.bedFov) this.camera.fov = lerp(this.camera.fov, (this.bedFov * Math.PI) / 180, Math.min(1, dt * 7));
  }
  bedZoom = 0;
  bedFov = 0;

  /** Eyes meet; a beat later his face changes; cut to black, then 帰宅 / GAME CLEAR. */
  private async bedFinale() {
    const ses = this.session;
    const c = this.caretakerBed;
    const scare = this.settings.jumpScare;
    this.ui.showHud(false);
    if (c) {
      this.audio.music(null, { fade: 1.6 });
      this.audio.setDuck(0.25, 1.5);
      await this.wait(0.7);
      if (ses !== this.session) return;
      this.bedZoom = 1;
      c.transformSeated();
      this.audio.sting('st_riser', { gain: 0.9, delay: 0.5 });
      await this.wait(2.3);
      if (ses !== this.session) return;
      if (scare) {
        c.exaggerate = 0.3;
        c.pounceAt(this.bedroom!.wake, 0.34, { dist: 0.3, lean: 0.25, rise: 0.12 });
        this.bedZoom = 0; this.bedFov = 54;
        this.audio.sting('st_scare', { gain: 1.0 });
        this.fx.shake = 1.6;
        this.ui.scareFlash(0.85, this.settings.reduceFlash);
        await this.wait(0.5);
        if (ses !== this.session) return;
      }
    }
    this.ui.fadeInstant(1);
    this.audio.stopAllLoops(0.05);
    this.audio.setDuck(1, 0.5);
    this.bedZoom = 0; this.bedFov = 0;
    this.camera.fov = (65 * Math.PI) / 180;
    await this.wait(1.4);
    if (ses !== this.session) return;
    this.ui.ending('normal', this.records, { onTitle: () => this.showTitle(), onNew: () => this.startNewGame(), onShare: () => this.share('normal') });
  }

  // ================================================================= tools / memo / pause
  openTools(preselect?: string) {
    const s = this.save; if (!s) return;
    const items = s.items.slice();
    if (s.flags.memoUnlocked && !items.includes('memo')) items.push('memo');
    this.ui.tools(items, {
      onUse: (id) => {
        if (id === 'light') { this.toggleLight(); return; }
        this.ui.close('tools');
        this.setHeld(id);
        this.ui.toast(L(`${ITEM_INFO[id].name}を使う対象を選ぶ。`, `Choose what to use the ${ITEM_INFO[id].name.toLowerCase()} on.`), 2200);
      },
      onView: (id) => {
        if (id === 'memo') { this.ui.close('tools'); this.openMemo(); return; }
        if (id === 'receipt') this.viewReceipt(); else this.ui.dialog({ title: ITEM_INFO[id].name, body: ITEM_INFO[id].desc, actions: [{ label: S.close, primary: true, onSelect: () => this.ui.close('dialog') }], onClose: () => this.ui.close('dialog') });
      },
      onClose: () => this.ui.close('tools'),
    }, preselect);
  }

  private viewReceipt() {
    let back = false;
    const show = () => {
      this.ui.close('dialog');
      this.ui.dialog(back
        ? { title: L('精算済票（裏）', 'Paid receipt (back)'), body: L('夜間（23時以降）の運搬には認証が必要です。\n運搬認証口に本票を通し、前輪をレールへ合わせてください。\n照合盤の表示に従ってください。', 'Night transport (after 11 p.m.) requires authentication.\nInsert this receipt into the transport reader and set your front wheel on the rail.\nFollow the instructions on the check panel.'), cls: 'receipt-back',
          actions: [{ label: L('表を見る', 'View front'), dbl: true, onSelect: () => { back = false; show(); } }, { label: S.close, primary: true, onSelect: () => this.ui.close('dialog') }], onClose: () => this.ui.close('dialog') }
        : { title: L('精算済票', 'Paid receipt'), image: this.receiptImage(), imageAlt: L('精算済票。保管階5F、保管番号517、料金200円、精算時刻23:07。運搬認証口に票を通し、前輪をレールへ合わせる。', 'Paid receipt. Floor 5F, space 517, fee 200 yen, paid at 23:07. Insert into the transport reader and set the front wheel on the rail.'), cls: 'receipt',
          actions: [{ label: L('裏を見る', 'View back'), dbl: true, onSelect: () => { back = true; show(); } }, { label: S.close, primary: true, onSelect: () => this.ui.close('dialog') }], onClose: () => this.ui.close('dialog') });
    };
    show();
  }

  openMemo() {
    const f = this.world.floor;
    const p = this.save.flags.authenticated ? this.puzzleFor(f) : null;
    this.ui.memo(f, this.save.memo[String(f)] || [], p ? p.queries : null, () => this.ui.close('memo'));
  }

  private inspectBike(b: Bike) {
    const s = this.save;
    const key = String(this.world.floor);
    const list = s.memo[key] || (s.memo[key] = []);
    if (!list.some((e) => e.id === b.id)) list.push({ id: b.id, row: b.row, color: b.color, type: b.type, basket: b.basket });
    if (!s.flags.memoUnlocked) { s.flags.memoUnlocked = true; this.ui.toast(L('観察メモが使えるようになった（道具）。', 'Notes unlocked (Items).'), 3000); }
    this.persist();
    this.ui.bikeCard(b);
    this.cardBike = b.id; this.cardAway = 0;
    this.audio.play('panel_press', { gain: 0.35, rate: 1.6 });
    if (!this.hintShown.card) { this.hintShown.card = true; this.ui.toast(L('調べた内容は観察メモ（道具）に残る。', 'What you inspect is saved in Notes (Items).'), 2600); }
  }
  cardBike: string | null = null;
  cardAway = 0;
  private updateCard(dt: number) {
    if (!this.cardBike) return;
    const looking = this.mode === 'world' && !this.ui.isOpen() && this.current?.id === 'bike:' + this.cardBike;
    this.cardAway = looking ? 0 : this.cardAway + dt;
    if (this.cardAway > 0.5) { this.cardBike = null; this.ui.bikeCard(null); }
  }

  openPause() {
    if (this.ui.isOpen('pause')) return;
    this.paused = true;
    this.input.releaseAll();
    const resume = () => { this.ui.close('pause'); this.paused = false; };
    this.ui.pause({
      onResume: resume,
      onRules: () => this.showRules(() => {}),
      onSettings: () => this.openSettings(() => {}),
      onHelp: () => this.ui.help(() => {}),
      onTitle: () => { this.paused = false; this.showTitle(); },
    });
  }

  // ================================================================= per-frame watchers
  private watchers(dt: number) {
    const s = this.save; const w = this.world;
    if (!s || this.mode === 'title') return;
    // ambience by zone
    if (this.mode !== 'cutscene' || this.view === 'facility') {
      const outside = w.floor === 1 && this.pos[2] < -7.05;
      if (outside !== this.outsideZone && s.phase !== 'SECRET_END' && s.phase !== 'NORMAL_END' && s.phase !== 'GAMEOVER' && s.phase !== 'FAIL_REVEAL') {
        this.outsideZone = outside;
        const powered = !['BLACKOUT', 'LOCKED'].includes(s.phase);
        this.audio.loop('garage_air_loop', outside ? 0.35 : 1);
        if (w.floor === 1) this.audio.loop('outdoor_air_loop', outside ? 1.2 : 0.4);
        else if (w.floor === 5 && powered) this.audio.loop('outdoor_air_loop', 0.25);
        else if (w.floor === 2) this.audio.loop('outdoor_air_loop', 0.55);
        else this.audio.stopLoop('outdoor_air_loop');
      }
    }
    if (this.mode !== 'world') return;
    // intro: entering 1F, getting in the car
    if (s.phase === 'INTRO' || s.phase === 'PAID') {
      if (this.introStage === 'outside' && this.pos[2] > -6.6) { this.introStage = '1F'; this.ui.toast(L('１Ｆ。エレベーターで５階へ。', '1F. Take the elevator to 5F.'), 2600); }
      if (w.floor === 1 && w.doorState === 'open' && w.isInsideCar(this.pos) && !this.ui.isOpen() && this.introStage === '1F' && !this.hintShown.key) {
        this.hintShown.key = true; this.ui.toast(L('操作盤で５を押す。', 'Press 5 on the control panel.'), 2400);
      }
      // 5F: doors close on their own once the player walks away
      if (w.floor === 5 && w.doorState === 'open' && !w.isInsideCar(this.pos)) {
        if (this.leftCarAt < 0) this.leftCarAt = this.time;
        if (this.time - this.leftCarAt > 4 && this.pos[2] < EV_Z - 2.5) { this.leftCarAt = -1; this.audio.play('elevator_close', { gain: 0.7 }); w.closeDoors(); }
      } else this.leftCarAt = -1;
    }
    // blackout: once the player and bike are inside, the doors shut
    if (s.phase === 'BLACKOUT' && w.doorState === 'open' && w.isInsideCar(this.pos) && w.bikeMode === 'held' && w.isInsideCar(w.bike517.root.position)) {
      this.lockIn();
    }
    // locked: progressive hints (§4: 30 s / 60 s)
    if (s.phase === 'LOCKED') {
      const idle = this.time - this.lockedSince;
      if (idle > 30 && !this.hintShown.back) { this.hintShown.back = true; this.ui.toast(L('精算済票の裏にも文字がある。', 'There\'s writing on the back of the receipt.'), 4200); }
      if (idle > 60 && !s.flags.receiptAuth) w.setReaderHint(0.35 + 0.25 * Math.sin(this.time * 2.5));
    }
    // floor flavour (sound only; never moves evidence)
    if (s.flags.authenticated && s.phase !== 'EXIT') {
      this.flavorT -= dt;
      if (this.flavorT <= 0) {
        this.flavorT = 12 + Math.random() * 10;
        if (w.floor === 4) this.audio.play('bicycle_roll_loop', { gain: 0.35, rate: 0.8, pan: (Math.random() - 0.5) * 0.8 });
        if (w.floor === 3) this.audio.play('footstep_left', { gain: 0.18, rate: 0.75, pan: 0.6 });
      }
    }
    // 1F exit
    if (s.phase === 'EXIT' && w.floor === 1) {
      if (w.bikeMode !== 'held' && this.pos[2] < -6.3 && this.time - this.lastBarrierMsg > 3) { this.lastBarrierMsg = this.time; this.ui.toast(L('自転車を置いていけない。', 'You can\'t leave your bicycle.')); }
      if (w.bikeMode === 'held' && this.pos[2] < -7.3) this.startEnding();
    }
    if (s.phase === 'SECRET_END' && !this.secretShown && (this.pos[2] < -15.6 || this.pos[2] < -9 && this.time > 0 && this.secretTimer(dt))) this.secretCaption();
  }
  private secretT = 0;
  private secretTimer(dt: number) { this.secretT += dt; return this.secretT > 7; }

  // ================================================================= debug / test hooks
  private debugApi() {
    const g = this;
    return {
      game: g,
      state: () => ({ phase: g.save?.phase, floor: g.world.floor, mode: g.mode, view: g.view, wrongTotal: g.save?.wrongTotal, warningArmed: g.save?.warningArmed, hasFailed: g.save?.hasFailed, doors: g.world.doorState, bike: g.world.bikeMode, pos: g.pos.map((v) => +v.toFixed(2)), yaw: +g.yaw.toFixed(2), target: g.current?.id ?? null, ui: g.ui.stack.map((o) => o.name), held: g.heldItem, flags: g.save?.flags, drawCalls: g.renderer.drawCalls, tris: g.renderer.triangles, fps: +g.fps.toFixed(1) }),
      tp: (x: number, z: number, yaw: number) => { g.pos = [x, EYE, z]; g.yaw = yaw; if (g.world.bikeMode === 'held') g.world.placeBikeHeld(g.pos, g.yaw); },
      answer: () => g.puzzleFor(g.world.floor)?.answer,
      seed: (n: number) => { g.forcedSeed = n; },
      setMaxDt: (v: number) => { g.maxDt = v; },
      freeze: (on: boolean) => { g.dbgFreeze = on; g.dbgBudget = 0; },
      step: (sec: number) => new Promise<string>((res) => { g.dbgBudget = sec; g.dbgGrab = res; }),
      cam: (pos: V3 | null, yaw = 0, pitch = 0, fov = 0) => { g.dbgCam = pos ? { pos, quat: quatYawPitch(yaw, pitch), fov: fov || undefined } : null; },
      advance: (sec: number) => new Promise<void>((res) => { g.dbgBudget += sec; const chk = () => (g.dbgBudget <= 1e-6 ? requestAnimationFrame(() => res()) : requestAnimationFrame(chk)); chk(); }),
      noAdapt: () => { g.adaptEnabled = false; g.renderer.dynamicScale = 1; },
      fx: () => g.fx,
      jump: (floor: number) => {
        const s = g.save;
        s.flags = { bikeUnlocked: true, paid: true, receiptAuth: true, wheelDocked: true, authenticated: true, memoUnlocked: true };
        s.items = ['key', 'light', 'receipt'];
        s.currentFloor = floor; s.resumeFloor = floor; s.phase = floor === 1 ? 'EXIT' : 'EXPLORE';
        g.ui.closeAll(); g.ui.showHud(true); g.ui.bigLine(null);
        g.arriveInstant(floor);
      },
      setBedT: (t: number) => { if (g.bedroom) g.bedroom.t = t; },
    };
  }
}
