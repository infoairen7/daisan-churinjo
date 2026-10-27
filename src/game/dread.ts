// Atmosphere director: per-floor mood, synthesized tension layers and scripted beats.
// Stays inside the spec's limits: no chase, no loud stingers, no strobing with 点滅軽減 on,
// evidence never moves, and the caretaker's face is only shown at the failure / normal ending.
import { L } from './i18n';
import type { Game } from './game';
import { Caretaker } from './ending';
import { Material } from '../engine/scene';
import { type V3, clamp } from '../engine/math';
import { EV_Z } from './world';

interface Mood { night: number; lamps: number[]; flicker: number[]; fog: number; ambient: number; tint: V3; drone: number; vig: number }

const MOODS: Record<string, Mood> = {
  normal: { night: 1, lamps: [1, 1, 1, 1, 1, 1], flicker: [0, 0, 0, 0, 0, 0], fog: 0.035, ambient: 1, tint: [0.9, 0.95, 0.97], drone: 0, vig: 0.28 },
  locked: { night: 0.8, lamps: [1, 1, 1, 1, 1, 1], flicker: [0, 0, 0, 0, 0, 0], fog: 0.05, ambient: 0.8, tint: [0.86, 0.93, 0.95], drone: 0.035, vig: 0.5 },
  f5: { night: 0.8, lamps: [1, 1, 1, 1, 1, 1], flicker: [0, 0, 0, 0, 1, 0], fog: 0.045, ambient: 0.9, tint: [0.86, 0.93, 0.95], drone: 0.028, vig: 0.4 },
  f4: { night: 0.7, lamps: [1, 1, 0.75, 1, 1, 1], flicker: [0, 0, 1, 0, 1, 0], fog: 0.05, ambient: 0.8, tint: [0.84, 0.93, 0.9], drone: 0.042, vig: 0.48 },
  f3: { night: 0.62, lamps: [0.7, 1, 1, 0.85, 1, 0.9], flicker: [2, 0, 0, 1, 0, 0], fog: 0.058, ambient: 0.7, tint: [0.82, 0.92, 0.86], drone: 0.056, vig: 0.56 },
  f2: { night: 0.56, lamps: [0.5, 1, 1, 0.45, 0.9, 1], flicker: [2, 0, 1, 2, 0, 0], fog: 0.066, ambient: 0.6, tint: [0.8, 0.91, 0.83], drone: 0.07, vig: 0.64 },
  f1: { night: 0.62, lamps: [1, 0.55, 1, 1, 0.55, 1], flicker: [0, 1, 0, 0, 1, 0], fog: 0.05, ambient: 0.75, tint: [0.84, 0.92, 0.9], drone: 0.04, vig: 0.5 },
};

export class Dread {
  g: Game;
  shake = 0;
  warning = false;
  private beatT = 0;
  private floorT = 0;
  private floor = 0;
  private done = new Set<string>();
  private flavorT = 10;
  private idleT = 0;
  private lastXZ: [number, number] = [0, 0];
  private sil: Caretaker | null = null;
  private silState: 'none' | 'shown' | 'gone' = 'none';
  private silHold = false;
  private silT = 0;
  private silSeen = 0;
  private wheelSpin = 0;
  private approachT = 6;
  private approachD = 16;
  private black = Object.assign(new Material('silhouette'), { unlit: true, fog: false, color: [0.002, 0.002, 0.003, 1] as [number, number, number, number] });
  /** dim wash on the wall behind the figure so it reads as a silhouette */
  private backLight = { position: [0.7, 1.2, -6.75] as V3, color: [0.72, 0.8, 0.86] as V3, intensity: 0, range: 2.8, enabled: true };
  private backAdded = false;

  constructor(g: Game) { this.g = g; }

  reset() {
    this.done.clear();
    this.warning = false;
    this.silState = 'none'; this.silHold = false;
    if (this.sil) this.sil.root.visible = false;
    this.backLight.intensity = 0;
    this.shake = 0;
    this.wheelSpin = 0;
  }

  // ------------------------------------------------------------- mood
  applyMood() {
    const g = this.g; const s = g.save; const w = g.world;
    let key = 'normal';
    if (s && (s.phase === 'BLACKOUT' || s.phase === 'LOCKED')) key = 'locked';
    else if (s?.flags.authenticated) key = 'f' + w.floor;
    const m = MOODS[key] || MOODS.normal;
    w.mood = { night: m.night, lamps: m.lamps.slice(), flicker: m.flicker.slice(), fog: m.fog, ambient: m.ambient, tint: m.tint };
    const endingSecret = s && s.phase === 'EXIT' && s.wrongTotal === 0 && !s.hasFailed;
    g.audio.setDrone((endingSecret ? 0.02 : m.drone) + (this.warning ? 0.03 : 0), 3);
    g.ui.root.style.setProperty('--vig', String(m.vig + (this.warning ? 0.12 : 0)));
    if (w.floor !== this.floor) { this.floor = w.floor; this.floorT = 0; this.flavorT = 9 + Math.random() * 6; this.idleT = 0; }
    this.updateMusic();
  }

  /** Pick the score for the current situation (crossfades; same track just changes level). */
  updateMusic() {
    const g = this.g; const s = g.save; const a = g.audio;
    if (g.mode === 'title') { a.music('bgm_title', { gain: 0.85, fade: 2.5 }); return; }
    if (!s) return;
    if (g.view === 'bedroom') return; // the bedroom scene drives its own music
    switch (s.phase) {
      case 'INTRO': case 'PAID': a.music(null, { fade: 2 }); return;
      case 'BLACKOUT': case 'LOCKED': a.music('bgm_explore1', { gain: 0.6, fade: 3 }); return;
      case 'FAIL_REVEAL': case 'GAMEOVER': case 'NORMAL_END': a.music(null, { fade: 0.4 }); return;
      case 'SECRET_END': a.music('bgm_secret', { gain: 0.9, fade: 4 }); return;
      case 'EXIT': a.music(s.wrongTotal === 0 && !s.hasFailed ? null : 'bgm_explore1', { gain: 0.55, fade: 3 }); return;
    }
    if (!s.flags.authenticated) { a.music(null, { fade: 2 }); return; }
    if (this.warning) { a.music('bgm_warning', { gain: 0.95, fade: 0.8 }); return; }
    const f = g.world.floor;
    a.music(f >= 4 ? 'bgm_explore1' : 'bgm_explore2', { gain: f >= 4 ? 0.85 : 0.95, fade: 3 });
  }

  /** 5F for the failure reveal: the floor beyond him goes dark, he is lit from above the doorway. */
  revealMood() {
    const w = this.g.world;
    w.mood = { night: 0.8, lamps: [0.1, 0.06, 0.16, 0.1, 0.06, 0.16], flicker: [0, 0, 0, 0, 0, 0], fog: 0.08, ambient: 0.45, tint: [0.8, 0.88, 0.86] };
    this.g.ui.root.style.setProperty('--vig', '0.7');
  }

  setWarning(on: boolean) {
    if (this.warning === on) return;
    this.warning = on;
    this.beatT = 0.2;
    this.applyMood();
  }

  /** Called when the doors open on a new floor of the main game. */
  arrive(floor: number) {
    this.applyMood();
    if (floor === 2 && !this.done.has('2-silence')) {
      // the garage hum is gone when the doors open; it creeps back
      this.done.add('2-silence');
      this.g.audio.setDuck(0.04, 0.2);
      this.g.audio.duckMusic(0, 0.15); // the score drops out too
      this.g.wait(4.5).then(() => { this.g.audio.setDuck(1, 4); this.g.audio.duckMusic(1, 6); });
    }
  }

  // ------------------------------------------------------------- positional helpers
  rel(p: V3) {
    const g = this.g;
    const dx = p[0] - g.pos[0], dz = p[2] - g.pos[2];
    const dist = Math.hypot(dx, dz) || 0.001;
    const fx = -Math.sin(g.yaw), fz = -Math.cos(g.yaw);
    const rx = Math.cos(g.yaw), rz = -Math.sin(g.yaw);
    const side = (dx * rx + dz * rz) / dist, front = (dx * fx + dz * fz) / dist;
    return { dist, pan: clamp(side * 0.9, -1, 1), behind: front < -0.2, front };
  }
  playAt(id: string, p: V3, gain = 1, opts: { rate?: number; delay?: number } = {}) {
    const r = this.rel(p);
    const att = 1 / (1 + r.dist * 0.12);
    this.g.audio.play(id, { gain: gain * att, pan: r.pan, lp: r.behind ? 1400 : 5000 - Math.min(3500, r.dist * 180), rate: opts.rate, delay: opts.delay });
  }
  knockAt(p: V3, gain = 0.55, n = 3) { const r = this.rel(p); this.g.audio.knock(gain / (1 + r.dist * 0.1), r.pan, n, 0.34, r.behind ? 600 : 1100); }
  clankAt(p: V3, gain = 0.2) { const r = this.rel(p); this.g.audio.clank(gain / (1 + r.dist * 0.08), r.pan, 2600 - Math.min(1800, r.dist * 90)); }

  /** 2F: someone walks a beat behind you. */
  footstep() {
    const g = this.g;
    if (g.world.floor !== 2 || !g.save?.flags.authenticated || g.save.phase === 'EXIT') return;
    if (Math.random() > 0.5) return;
    const back: V3 = [g.pos[0] + Math.sin(g.yaw) * 3.2, 0, g.pos[2] + Math.cos(g.yaw) * 3.2];
    this.playAt(Math.random() < 0.5 ? 'footstep_left' : 'footstep_right', back, 0.7, { delay: 0.38 + Math.random() * 0.08, rate: 0.86 });
    if (!this.done.has('2-steps-line') && this.floorT > 6) {
      this.done.add('2-steps-line');
      g.wait(1.4).then(() => { if (g.world.floor === 2) g.ui.toast(L('……足音が、ひとつ多い。', '…One footstep too many.'), 2600); });
    }
  }

  // ------------------------------------------------------------- per frame
  update(dt: number) {
    const g = this.g; const s = g.save; const w = g.world;
    this.shake = Math.max(0, this.shake - dt * 1.8);
    if (this.wheelSpin > 0) { this.wheelSpin -= dt; w.rollWheels(-dt * 0.9 * Math.min(1, this.wheelSpin)); }
    if (this.sil && this.sil.root.visible) this.sil.update(dt);
    if (!s || g.mode === 'title') return;
    if (this.warning) {
      this.beatT -= dt;
      if (this.beatT <= 0) { g.audio.heartbeat(0.32); this.beatT = 1.05; }
    }
    if (g.mode !== 'world' || !s.flags.authenticated || s.phase === 'EXIT' || g.view !== 'facility') return;
    this.floorT += dt;
    // warning armed: someone is walking this way, a little closer each time (never arrives)
    if (this.warning) {
      this.approachT -= dt;
      if (this.approachT <= 0) {
        this.approachT = 9 + Math.random() * 4;
        this.approachD = Math.max(5.5, this.approachD - 2.2);
        const a = g.yaw + Math.PI + (Math.random() - 0.5) * 1.6;
        const p: V3 = [g.pos[0] - Math.sin(a) * this.approachD, 0, g.pos[2] - Math.cos(a) * this.approachD];
        for (let i = 0; i < 4; i++) this.playAt(i % 2 ? 'footstep_left' : 'footstep_right', p, 0.9, { delay: i * 0.58, rate: 0.82 });
      }
    } else this.approachD = 16;
    const moved = Math.hypot(g.pos[0] - this.lastXZ[0], g.pos[2] - this.lastXZ[1]);
    this.lastXZ = [g.pos[0], g.pos[2]];
    this.idleT = moved > 0.002 ? 0 : this.idleT + dt;
    const f = w.floor;

    // 5F: someone crosses the floor above
    if (f === 5 && this.floorT > 28 && !this.done.has('5-ceiling')) {
      this.done.add('5-ceiling');
      for (let i = 0; i < 7; i++) {
        const p = -0.85 + i * 0.28;
        g.audio.play(i % 2 ? 'footstep_left' : 'footstep_right', { gain: 0.55, rate: 0.7, lp: 380, pan: p, delay: i * 0.62 });
      }
    }
    // 4F: the docked bicycle's wheel turns on its own when you come back to the car
    if (f === 4 && this.floorT > 22 && !this.done.has('4-wheel') && w.isInsideCar(g.pos) && w.bikeMode === 'docked') {
      this.done.add('4-wheel');
      this.wheelSpin = 3.2;
      this.playAt('bicycle_roll_loop', [0.8, 0.4, EV_Z], 0.5, { rate: 0.75 });
    }
    // 3F: knocking behind the steel door, then the shadow under it is gone
    if (f === 3 && !this.done.has('3-door')) {
      const d = Math.hypot(g.pos[0] - 6.6, g.pos[2] + 6.86);
      if (d < 4.6) {
        this.done.add('3-door');
        this.knockAt([6.6, 1.2, -6.9], 0.6, 3);
        g.wait(2.4).then(() => { if (w.floor === 3) { w.door3FShadow(false); w.dipLamp(3, 0.5); this.playAt('footstep_left', [6.6, 0, -8.2], 0.5, { rate: 0.8 }); g.audio.sting('st_whisper', { gain: 0.7, pan: this.rel([6.6, 1, -6.9]).pan }); } });
      }
    }
    // 2F: breath right behind you if you stand still
    if (f === 2 && this.idleT > 7 && !this.done.has('2-breath') && this.floorT > 10) {
      this.done.add('2-breath');
      g.audio.breath(0.075, 2.1, 0, 430);
      g.wait(2.6).then(() => g.audio.breath(0.06, 2.2, 0.15, 410));
    }
    if (f === 2) this.updateSilhouette(dt);

    // sparse flavour (sound only)
    this.flavorT -= dt;
    if (this.flavorT <= 0) {
      this.flavorT = 13 + Math.random() * 10;
      const far: V3 = [-g.pos[0] * 0.8 + (Math.random() - 0.5) * 4, 1, clamp(-g.pos[2] + (Math.random() - 0.5) * 6, -6.5, 6.5)];
      if (f === 4) Math.random() < 0.6 ? this.playAt('bicycle_roll_loop', far, 0.55, { rate: 0.8 }) : this.clankAt(far, 0.16);
      else if (f === 3) Math.random() < 0.5 ? this.clankAt(far, 0.2) : this.playAt('footstep_right', far, 0.35, { rate: 0.75 });
      else if (f === 2) this.clankAt(far, 0.22);
      else if (f === 5) this.clankAt(far, 0.12);
    }
  }

  // ------------------------------------------------------------- 2F silhouette (face never visible)
  private updateSilhouette(dt: number) {
    const g = this.g; const w = g.world;
    if (this.silState === 'gone') return;
    if (this.silState === 'none') {
      if (this.floorT < 12 || g.pos[2] < -1.2 || !g.caretakerTpl) return;
      const spot: V3 = [0.7, 0, -6.15];
      const r = this.rel(spot);
      if (r.front > 0.2) return; // only appear where the player is not looking
      if (!this.sil) {
        this.sil = new Caretaker(g.caretakerTpl);
        this.sil.root.traverse((n) => { if (n.mesh) n.materialOverride = this.black; });
        w.scene.root.add(this.sil.root);
      }
      if (!this.backAdded) { w.scene.points.push(this.backLight); this.backAdded = true; }
      this.backLight.intensity = 1.35;
      this.sil.mixer.stopAll();
      this.sil.root.position = spot;
      this.sil.root.quaternion = [0, 1, 0, 0];
      this.sil.root.visible = true;
      this.silState = 'shown'; this.silT = 0; this.silSeen = 0;
      return;
    }
    // shown
    const sil = this.sil!;
    if (this.silState === 'shown' && (sil.lunging || this.silHold)) return;
    const p = sil.root.position;
    const r = this.rel(p);
    this.silT += dt;
    const inView = r.front > Math.cos(0.42) && r.dist > 2;
    if (inView) {
      if (this.silSeen === 0) g.audio.sting('st_whisper', { gain: 0.55, pan: r.pan });
      this.silSeen += dt;
    }
    const pounce = g.settings.jumpScare;
    if (pounce && this.silSeen > 0.85) {
      // it runs at you
      const dx = g.pos[0] - p[0], dz = g.pos[2] - p[2];
      const d = Math.hypot(dx, dz) || 1;
      const yaw = Math.atan2(-dx, -dz); // model forward is -Z
      sil.root.quaternion = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
      g.audio.sting('st_stab', { gain: 0.9 });
      // the dark fills the lens, then it is gone
      sil.pounceAt([g.pos[0], g.pos[1], g.pos[2]], clamp(d / 16, 0.32, 0.6), {
        dist: 0.2, rise: 0.08, lean: 0.2,
        onDone: () => { this.silHold = true; g.wait(0.13).then(() => {
          this.silState = 'gone'; this.silHold = false;
          sil.root.visible = false; sil.resetPose();
          this.backLight.intensity = 0;
          w.dipLamp(0, 0.9); w.dipLamp(3, 0.9); w.dipLamp(1, 0.4); w.dipLamp(4, 0.4);
          g.audio.sting('st_impact', { gain: 0.75 });
          this.shake = 1.2;
          g.ui.scareFlash(0.55, g.settings.reduceFlash);
        }); },
      });
      this.silState = 'shown';
      return;
    }
    if ((!pounce && this.silSeen > 1.15) || r.dist < 6.2 || this.silT > 35) {
      this.silState = 'gone';
      w.dipLamp(0, 0.7); w.dipLamp(3, 0.7);
      g.wait(this.g.settings.reduceFlash ? 0.35 : 0.08).then(() => { if (this.sil) this.sil.root.visible = false; this.backLight.intensity = 0; });
      if (this.silSeen > 1.15) this.playAt('footstep_left', [p[0] + 1.5, 0, p[2] - 0.3], 0.45, { rate: 0.8, delay: 0.5 });
    }
  }

  // ------------------------------------------------------------- elevator stall between 3F and 2F
  async stall(): Promise<void> {
    const g = this.g; const w = g.world; const a = g.audio;
    a.stopLoop('elevator_motor_loop', 0.05);
    a.play('power_cut', { gain: 0.55, rate: 0.8 });
    a.sting('st_braam', { gain: 0.85 });
    a.duckMusic(0.1, 0.3);
    this.shake = 1;
    w.blackout = 0.85;
    w.setIndicator('－');
    g.ui.caption(L('［停止］', '[Stopped]'), 2200);
    await g.wait(1.6);
    this.knockAt([0, 1.3, EV_Z - 1.6], 0.65, 3);
    await g.wait(1.9);
    a.breath(0.07, 1.9, 0, 450);
    await g.wait(1.6);
    w.blackout = 0;
    a.duckMusic(1, 3);
    a.loop('elevator_motor_loop', 1, 0.3);
    g.ui.caption(L('［下降中］', '[Going down]'), 1800);
  }
}
