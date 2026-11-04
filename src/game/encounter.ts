// v2: the caretaker's floors. Meeting him is not a punishment — it happens every night, even with no
// wrong answers. Each scene ends in one timed choice; the night rules slip that comes out of the payment
// machine with the receipt tells you what to do. A wrong choice (or running out of time) is a game over,
// and 「この階から再開」 replays the scene.
import { L } from './i18n';
import type { Game } from './game';
import type { Caretaker } from './ending';
import { type V3, sub, quatLookDir, quatYawPitch } from '../engine/math';
import { EV_Z } from './world';
import { MY_SPACE, mulberry32 } from './puzzle';

export type EncounterId = 'lights' | 'ride' | 'rollcall';
export const ENCOUNTER_AT: Record<number, EncounterId> = { 8: 'lights', 5: 'ride', 3: 'rollcall' };

const EYE = 1.65;
/** where you stand in the car while he rides with you (back left; the panel is on the back wall) */
const RIDE_POS: V3 = [-0.5, EYE, EV_Z + 0.85];
const CAR_POS: V3 = [-0.35, EYE, EV_Z - 0.1];

type Choice = ReturnType<Game['ui']['choice']>;

export class Encounters {
  g: Game;
  active: EncounterId | null = null;
  private choiceH: Choice | null = null;
  private choiceLeft = 0;
  private choiceDur = 1;
  private choiceEnd: (() => void) | null = null;
  private queue: { t: number; fn: () => void }[] = [];
  private armedAt = -1;
  /** test hook: multiplies every choice's time limit (debug builds' scripted playtests take slow screenshots) */
  choiceScale = 1;

  constructor(g: Game) { this.g = g; }

  isCleared(floor: number) { return !!this.g.save?.cleared?.[String(floor)]; }
  private setCleared(floor: number) { const s = this.g.save; (s.cleared ||= {})[String(floor)] = true; }

  /** Abandon whatever is running (title, retry, new night). */
  reset() {
    this.active = null; this.armedAt = -1; this.queue = [];
    if (this.choiceH) { this.choiceH.close(); this.choiceH = null; }
    this.choiceEnd = null;
    this.g.ui.say(null);
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number) {
    const g = this.g;
    if (g.paused) return;
    if (this.queue.length) {
      for (const q of this.queue.slice()) { q.t -= dt; if (q.t <= 0) { this.queue.splice(this.queue.indexOf(q), 1); q.fn(); } }
    }
    if (this.choiceH) {
      this.choiceLeft -= dt;
      this.choiceH.progress(this.choiceLeft / this.choiceDur);
      if (this.choiceLeft <= 0) { const end = this.choiceEnd; this.choiceEnd = null; end?.(); }
    }
    // 8F: the lights go out a little after you arrive (sooner if you walk away from the car)
    const s = g.save;
    if (this.armedAt >= 0 && s && g.mode === 'world' && !g.ui.isOpen() && g.world.floor === 8 && !this.isCleared(8)) {
      const since = g.time - this.armedAt;
      const away = g.pos[2] < EV_Z - 4.4;
      if ((away && since > 4) || since > 17) { this.armedAt = -1; this.lightsOut(); }
    }
    // 8F after the patrol: back in the car → down
    if (s && g.mode === 'world' && g.world.floor === 8 && this.isCleared(8) && s.phase === 'EXPLORE' && g.world.isInsideCar(g.pos) && !g.ui.isOpen()) {
      s.currentFloor = 7; s.resumeFloor = 7; s.phase = 'TRANSIT'; g.persist();
      g.ui.toast(L('扉が閉まる。下降する。', 'The doors close. Going down.'), 2000);
      g.descend(7);
    }
  }

  private after(sec: number, fn: () => void) { this.queue.push({ t: sec, fn }); }

  /** Footsteps from a to b (no y), one every `interval` seconds; cancelled with the queue. */
  private steps(a: V3, b: V3, n: number, interval: number, gain = 0.9, rate = 0.82) {
    for (let i = 0; i < n; i++) {
      const k = n === 1 ? 1 : i / (n - 1);
      const p: V3 = [a[0] + (b[0] - a[0]) * k, 0, a[2] + (b[2] - a[2]) * k];
      this.after(i * interval, () => this.g.fx.playAt(i % 2 ? 'footstep_left' : 'footstep_right', p, gain, { rate }));
    }
  }

  /** Ask; resolves with an option id, or 'timeout'. */
  private choose(prompt: string, options: { id: string; label: string }[], seconds: number, who = ''): Promise<string> {
    const g = this.g;
    g.input.releaseAll();
    g.ui.say(null);
    return new Promise((res) => {
      const finish = (id: string) => { this.choiceH = null; this.choiceEnd = null; res(id); };
      const h = g.ui.choice({ prompt, who, options, onPick: (id) => finish(id) });
      this.choiceH = h; this.choiceDur = seconds * this.choiceScale; this.choiceLeft = this.choiceDur;
      this.choiceEnd = () => { h.close(); finish('timeout'); };
    });
  }

  private begin(id: EncounterId, floor: number) {
    const g = this.g; const s = g.save;
    this.reset();
    this.active = id;
    g.mode = 'cutscene';
    g.ui.closeAll();
    g.input.releaseAll();
    g.setHeldPublic(null);
    s.phase = 'ENCOUNTER'; s.currentFloor = floor; s.resumeFloor = floor;
    g.persist();
  }

  private async caretaker(): Promise<Caretaker | null> {
    try { await this.g.loadCaretaker(); } catch { return null; }
    const c = this.g.caretaker;
    if (!c) return null;
    c.mixer.stopAll(); c.resetPose(); c.exaggerate = 0;
    c.normal();
    c.root.visible = false; // each scene places him, then shows him
    return c;
  }

  /** Face the lens, change, lunge; cut to black and the game over. */
  private async kill(c: Caretaker | null, line: string, opts: { quick?: boolean; cam?: V3 } = {}) {
    const g = this.g; const ses = g.session; const a = g.audio;
    this.queue = [];
    g.mode = 'cutscene';
    g.ui.closeAll();
    a.music(null, { fade: 0.2 });
    a.setDrone(0, 0.3);
    a.setDuck(0.0, 0.4);
    if (c) {
      const cam: V3 = opts.cam ?? [...g.camera.position] as V3;
      c.headTurnGoal = 0; c.headTurnSpeed = 6;
      c.turnTo(c.yawToward(cam), opts.quick ? 0.18 : 0.5);
      await g.wait(opts.quick ? 0.2 : 0.5);
      if (ses !== g.session) return;
      const eye = c.eyeWorld();
      g.camTo(cam, quatLookDir(sub(eye, cam)), opts.quick ? 5 : 2);
      c.transform();
      a.sting('st_riser', { gain: 0.95, delay: opts.quick ? 0.05 : 0.35 });
      g.fovTarget = 44; g.fovSpeed = 1.4;
      await g.wait(opts.quick ? 0.95 : 1.9);
      if (ses !== g.session) return;
      if (g.settings.jumpScare) {
        c.exaggerate = 0.3;
        c.pounceAt(cam, 0.34, { dist: 0.3, lean: 0.2, rise: 0.1 });
        a.sting('st_scare', { gain: 1.0 });
        g.fx.shake = 1.6;
        g.fovTarget = 52; g.fovSpeed = 7;
        g.ui.scareFlash(0.85, g.settings.reduceFlash);
        await g.wait(0.5);
      } else { a.swell(1.4, 0.26); await g.wait(1.2); }
      if (ses !== g.session) return;
    } else {
      a.play('caretaker_presence'); await g.wait(1.2);
      if (ses !== g.session) return;
    }
    g.ui.say(null);
    g.ui.fadeInstant(1);
    a.setDuck(0, 0.02);
    await g.wait(1.0);
    if (ses !== g.session) return;
    g.ui.bigLine(line, 'fail');
    await g.wait(1.7);
    if (ses !== g.session) return;
    a.setDuck(1, 0.5);
    const s = g.save;
    s.hasFailed = true; s.failCount = (s.failCount || 0) + 1; s.phase = 'GAMEOVER';
    g.persist();
    this.active = null;
    g.showGameOver(line);
  }

  // ================================================================== arrival routing
  /** Called when the car has arrived (doors still closed for 3F) on an encounter floor. Returns true if it took over. */
  arrive(floor: number): boolean {
    if (this.isCleared(floor)) return false;
    if (floor === 8) { this.armedAt = this.g.time; return false; }
    if (floor === 3) { this.rollCall(); return true; }
    return false;
  }
  /** Continue / retry onto an encounter floor that is not cleared yet. Returns true if handled. */
  resume(floor: number): boolean {
    if (this.isCleared(floor)) return false;
    if (floor === 5) { this.ride(false); return true; }
    if (floor === 3) { this.g.setupCarAt(3); this.rollCall(); return true; }
    return false;
  }

  // ================================================================== 8F 「消灯」
  private async lightsOut() {
    const g = this.g; const w = g.world; const a = g.audio; const ses0 = g.session;
    this.begin('lights', 8);
    const ses = g.session; void ses0;
    const careP = this.caretaker();
    const inCar = w.isInsideCar(g.pos);
    a.play('power_cut'); g.ui.caption(L('［停電］', '[Power cut]'));
    a.sting('st_impact', { gain: 0.6 });
    a.music(null, { fade: 0.15 });
    w.setLighting('off');
    w.mood = { ...w.mood, ambient: 0.1 };
    if (g.lightOn) g.toggleLightPublic(false);
    g.ui.root.style.setProperty('--vig', '0.8');
    await g.wait(1.7);
    if (ses !== g.session) return;
    // someone walks toward you from behind
    const fwd: V3 = [-Math.sin(g.yaw), 0, -Math.cos(g.yaw)];
    const at = (d: number): V3 => [g.pos[0] + fwd[0] * d, 0, g.pos[2] + fwd[2] * d];
    this.steps(at(-11), at(-1.1), 14, 0.6);
    g.ui.caption(L('［足音］', '[Footsteps]'), 2400);
    a.setDrone(0.09, 4);
    await g.wait(1.3);
    if (ses !== g.session) return;
    const pick = await this.choose(L('照明が消えた。足音が近づいてくる。', 'The lights are out. Footsteps are coming closer.'), [
      { id: 'light', label: L('スマホのライトをつける', 'Turn on your phone light') },
      { id: 'eyes', label: L('動かずに、目を閉じる', 'Stay still and close your eyes') },
      { id: 'run', label: inCar ? L('「閉」を押して扉を閉める', 'Press CLOSE to shut the doors') : L('エレベーターまで走る', 'Run to the elevator') },
    ], 7);
    if (ses !== g.session) return;
    const c = await careP;
    if (ses !== g.session) return;
    if (pick === 'eyes') { await this.lightsSurvive(at, fwd); return; }
    this.queue = [];
    if (pick === 'light') {
      g.toggleLightPublic(true);
      this.standBefore(c, 0.85);
      a.play('panel_press', { gain: 0.6, rate: 1.4 });
      await this.kill(c, L('照らしてしまった。', 'You shone the light on him.'), { quick: true });
      return;
    }
    if (pick === 'run') {
      if (c) {
        // he is already standing in the car
        c.root.position = [0.05, 0, EV_Z - 1.15];
        c.root.quaternion = [0, 0, 0, 1];
        c.turnTo(c.yawToward(g.pos), 0.01);
        c.root.visible = true;
        w.setLighting('emergency');
        w.mood = { ...w.mood, ambient: 0.35 };
      }
      if (!inCar) {
        const towards = Math.atan2(-(0 - g.pos[0]), -(EV_Z - 1.6 - g.pos[2]));
        const p: V3 = [g.pos[0] + (0 - g.pos[0]) * 0.35, EYE, g.pos[2] + (EV_Z - 2.4 - g.pos[2]) * 0.35];
        g.camTo(p, quatYawPitch(towards, 0), 2.2);
        for (let i = 0; i < 4; i++) this.after(i * 0.28, () => a.play(i % 2 ? 'footstep_left' : 'footstep_right', { gain: 1.1, rate: 1.15 }));
        await g.wait(1.0);
        if (ses !== g.session) return;
        await this.kill(c, L('暗闇で、動いてしまった。', 'You moved in the dark.'), { quick: true, cam: p });
      } else {
        a.play('panel_press', { gain: 0.9 });
        await g.wait(0.4);
        if (ses !== g.session) return;
        g.camTo([...g.camera.position] as V3, quatYawPitch(0, 0), 3);
        await this.kill(c, L('暗闇で、動いてしまった。', 'You moved in the dark.'), { quick: true });
      }
      return;
    }
    // time ran out: he is right behind you
    const behind = this.standBefore(c, 0.85, true);
    if (behind) g.camTo([...g.camera.position] as V3, quatYawPitch(g.yaw + Math.PI, 0), 3.2);
    a.breath(0.12, 1.4, 0, 380);
    await g.wait(0.9);
    if (ses !== g.session) return;
    await this.kill(c, L('目を、開けたままだった。', 'Your eyes were open.'), { quick: true });
  }

  /** Put him `d` m in front of the camera (or behind, if the front is blocked / asked). Returns true if behind. */
  private standBefore(c: Caretaker | null, d: number, preferBehind = false): boolean {
    const g = this.g;
    if (!c) return false;
    const yaws = preferBehind ? [g.yaw + Math.PI, g.yaw] : [g.yaw, g.yaw + Math.PI];
    for (const [i, y] of yaws.entries()) {
      for (const dist of [d, d * 0.8]) {
        const x = g.pos[0] - Math.sin(y) * dist, z = g.pos[2] - Math.cos(y) * dist;
        if (g.pointFree(x, z, 0.28) || (i === yaws.length - 1 && dist < d)) {
          c.root.position = [x, 0, z];
          c.root.quaternion = [0, 0, 0, 1];
          c.turnTo(c.yawToward(g.pos), 0.01);
          c.still();
          c.root.visible = true;
          return y !== g.yaw;
        }
      }
    }
    return false;
  }

  private async lightsSurvive(at: (d: number) => V3, fwd: V3) {
    const g = this.g; const w = g.world; const a = g.audio; const ses = g.session;
    void fwd;
    g.ui.fade(1, 260);
    g.ui.say(L('（目を閉じた）', '(You close your eyes.)'), 0);
    await g.wait(2.2);
    if (ses !== g.session) return;
    // the steps come around you and stop, right in front
    this.queue = [];
    this.steps(at(-0.9), at(0.45), 3, 0.62, 1.0, 0.8);
    await g.wait(2.4);
    if (ses !== g.session) return;
    g.ui.caption(L('［すぐ前で、息の音］', '[Breathing, right in front of you]'), 3200);
    a.breath(0.14, 2.3, 0, 360);
    await g.wait(2.8);
    if (ses !== g.session) return;
    a.sting('st_whisper', { gain: 0.5 });
    a.breath(0.1, 2.0, 0.1, 340);
    await g.wait(2.6);
    if (ses !== g.session) return;
    // and walk on, past you
    g.ui.caption(L('［足音が遠ざかる］', '[Footsteps walk away]'), 2600);
    this.steps([g.pos[0] - 0.5, 0, g.pos[2]], at(9), 9, 0.66, 0.9, 0.82);
    await g.wait(6.4);
    if (ses !== g.session) return;
    g.ui.say(null);
    // power back; open your eyes
    a.play('power_cut', { gain: 0.35, rate: 1.35 });
    g.ui.caption(L('［照明が戻る］', '[The lights come back]'));
    w.setLighting('night');
    g.fx.applyMood();
    w.layFootprints([g.pos[0], g.pos[2]], g.yaw);
    await g.ui.fade(0, 1700);
    if (ses !== g.session) return;
    this.setCleared(8);
    const s = g.save; s.phase = 'EXPLORE'; g.persist();
    this.active = null;
    w.setPanelDisplay(L('下降', 'DOWN'));
    g.mode = 'world';
    g.ui.toast(L('濡れた足跡が、すぐ横を通っている。', 'Wet footprints pass right beside you.'), 3600);
    this.after(4.2, () => { if (g.world.floor === 8 && g.mode === 'world') g.ui.toast(L('操作盤に「下降」と出ている。エレベーターに戻ろう。', 'The panel says DOWN. Back to the elevator.'), 3200); });
    g.refreshHintsPublic();
  }

  // ================================================================== 5F 「同乗」
  /** The car stops at 5F on the way down from 6F and he gets in. fromDescent: the car is already moving. */
  async ride(fromDescent: boolean) {
    const g = this.g; const w = g.world; const a = g.audio;
    this.begin('ride', 5);
    const ses = g.session;
    const careP = this.caretaker();
    if (!fromDescent) { g.setupCarAt(6); a.loop('elevator_motor_loop', 1, 0.3); g.camOverride = null; g.placePlayerPublic(RIDE_POS, 0); }
    else g.camTo(RIDE_POS, quatYawPitch(0, 0), 1.1); // step back from the doors as the car slows
    g.ui.showHud(true);
    w.setIndicator('6', '▼');
    w.blackout = 0.35;
    await g.wait(fromDescent ? 0.6 : 1.6);
    if (ses !== g.session) return;
    w.setIndicator('5', '▼');
    await g.wait(0.9);
    if (ses !== g.session) return;
    g.camOverride = null;
    g.placePlayerPublic(RIDE_POS, 0);
    // it stops where nobody pressed
    a.stopLoop('elevator_motor_loop', 0.15);
    a.play('power_cut', { gain: 0.3, rate: 1.5 });
    g.fx.shake = 0.5;
    g.ui.caption(L('［停止］', '[Stopped]'));
    g.setFloor(5);
    w.setIndicator('5');
    w.setLighting('night');
    w.blackout = 0;
    w.mood = { night: 0.8, lamps: [0.02, 0.02, 0.02, 0.02, 0.02, 0.02], flicker: [0, 0, 0, 0, 0, 0], fog: 0.09, ambient: 0.35, tint: [0.8, 0.88, 0.86] };
    g.ui.setFloor('5F');
    a.music(null, { fade: 1.2 });
    a.setDrone(0.05, 2);
    await g.wait(1.6);
    if (ses !== g.session) return;
    const c = await careP;
    if (ses !== g.session) return;
    if (c) { c.root.position = [0.05, 0, EV_Z - 2.2]; c.root.quaternion = [0, 1, 0, 0]; c.root.visible = true; }
    g.ui.caption(L('［扉が開く］', '[Doors open]')); a.play('elevator_open');
    await w.openDoors();
    if (ses !== g.session) return;
    await g.wait(1.8);
    if (ses !== g.session) return;
    // he steps in and stands in front of you, facing the doors
    if (c) {
      c.walkTo([-0.45, 0, EV_Z - 0.72], 2.6);
      this.steps([0.05, 0, EV_Z - 2.0], [-0.45, 0, EV_Z - 0.72], 4, 0.62, 0.8, 0.8);
      await g.wait(2.8);
      if (ses !== g.session) return;
      c.turnTo(0, 1.4);
      await g.wait(1.5);
      if (ses !== g.session) return;
    }
    g.ui.caption(L('［扉が閉まる］', '[Doors close]')); a.play('elevator_close');
    await w.closeDoors();
    if (ses !== g.session) return;
    a.loop('elevator_motor_loop', 0.8, 0.6);
    w.setIndicator('－');
    w.blackout = 0.3;
    a.setDrone(0.08, 4);
    await g.wait(2.2);
    if (ses !== g.session) return;
    // the head turns — further than a head should
    if (c) { c.headTurnSpeed = 0.75; c.headTurnGoal = 2.35; a.clank(0.08, 0, 700); }
    await g.wait(1.6);
    if (ses !== g.session) return;
    g.ui.say(L('……何階ですか', '...Which floor?'), 0, L('管理人', 'Caretaker'));
    // your eyes are drawn to his face while you hesitate
    if (c) { const eye = c.eyeWorld(); g.camTo(RIDE_POS, quatLookDir(sub(eye, RIDE_POS)), 1 / 7.5); g.fovTarget = 55; g.fovSpeed = 0.3; }
    const pick = await this.choose(L('……何階ですか', '...Which floor?'), [
      { id: 'press', label: L('操作盤の「１」を押す', 'Press 1 on the control panel') },
      { id: 'answer', label: L('「１階です」と答える', 'Answer: "The first floor."') },
      { id: 'down', label: L('うつむいて、目をそらす', 'Look down and away from him') },
    ], 8, L('管理人', 'Caretaker'));
    if (ses !== g.session) return;
    g.ui.say(null);
    if (pick === 'down') { await this.rideSurvive(c); return; }
    if (pick === 'press') {
      a.play('panel_press', { gain: 1.0 }); w.pressButtonAnim(1);
      g.ui.caption(L('［ボタンの音］', '[Button click]'));
      await g.wait(0.5);
      if (ses !== g.session) return;
      await this.kill(c, L('操作盤に、触れてしまった。', 'You touched the control panel.'), { cam: RIDE_POS });
      return;
    }
    if (pick === 'answer') {
      g.ui.say(L('「……１階です」', '"...The first floor."'), 1500, L('あなた', 'You'));
      await g.wait(1.8);
      if (ses !== g.session) return;
      g.ui.say(L('……そうですか', '...I see.'), 1800, L('管理人', 'Caretaker'));
      await g.wait(1.4);
      if (ses !== g.session) return;
      await this.kill(c, L('答えてしまった。', 'You answered him.'), { cam: RIDE_POS });
      return;
    }
    await this.kill(c, L('目が、合ってしまった。', 'Your eyes met.'), { cam: RIDE_POS });
  }

  private async rideSurvive(c: Caretaker | null) {
    const g = this.g; const w = g.world; const a = g.audio; const ses = g.session;
    g.camTo(RIDE_POS, quatYawPitch(0.25, -1.05), 2.4);
    g.fovTarget = 65; g.fovSpeed = 1.5;
    if (c) { c.headTurnSpeed = 0.35; c.headTurnGoal = 0; }
    await g.wait(3.6);
    if (ses !== g.session) return;
    a.breath(0.06, 1.8, -0.2, 420);
    await g.wait(2.4);
    if (ses !== g.session) return;
    // the car stops somewhere; the doors open; he walks out
    a.stopLoop('elevator_motor_loop', 0.3);
    g.ui.caption(L('［停止］', '[Stopped]'));
    await g.wait(1.0);
    if (ses !== g.session) return;
    g.ui.caption(L('［扉が開く］', '[Doors open]')); a.play('elevator_open');
    await w.openDoors();
    if (ses !== g.session) return;
    if (c) {
      c.turnTo(Math.PI * 0.02, 0.3);
      c.walkTo([0.15, 0, EV_Z - 3.1], 2.8);
      this.steps([-0.45, 0, EV_Z - 0.72], [0.15, 0, EV_Z - 3.1], 5, 0.6, 0.85, 0.8);
    }
    await g.wait(3.2);
    if (ses !== g.session) return;
    if (c) c.root.visible = false;
    g.ui.caption(L('［扉が閉まる］', '[Doors close]')); a.play('elevator_close');
    await w.closeDoors();
    if (ses !== g.session) return;
    g.camTo(RIDE_POS, quatYawPitch(0, 0), 1.0);
    await g.wait(1.2);
    if (ses !== g.session) return;
    this.setCleared(5);
    const s = g.save; s.currentFloor = 4; s.resumeFloor = 4; s.phase = 'TRANSIT'; g.persist();
    this.active = null;
    g.camOverride = null;
    g.placePlayerPublic(RIDE_POS, 0);
    g.ui.toast(L('……彼は、何階で降りたのだろう。', '...Which floor did he get off at?'), 3000);
    g.descend(4);
  }

  // ================================================================== 3F 「点呼」
  /** The doors open at 3F and he is standing right there. Car at 3F, doors closed, player inside. */
  async rollCall() {
    const g = this.g; const w = g.world; const a = g.audio;
    this.begin('rollcall', 3);
    const ses = g.session;
    const c = await this.caretaker();
    if (ses !== g.session) return;
    g.camOverride = null;
    g.placePlayerPublic(CAR_POS, 0);
    if (c) { c.root.position = [0.04, 0, EV_Z - 1.82]; c.root.quaternion = [0, 1, 0, 0]; c.root.visible = true; }
    a.music(null, { fade: 1.0 });
    await g.wait(0.9);
    if (ses !== g.session) return;
    g.ui.caption(L('［扉が開く］', '[Doors open]')); a.play('elevator_open');
    await w.openDoors();
    if (ses !== g.session) return;
    a.setDuck(0.35, 0.6);
    if (c) { const eye = c.eyeWorld(); g.camTo(CAR_POS, quatLookDir(sub(eye, CAR_POS)), 1.2); }
    g.fovTarget = 54; g.fovSpeed = 0.7;
    await g.wait(1.8);
    if (ses !== g.session) return;
    const who = L('管理人', 'Caretaker');
    g.ui.say(L('夜分に失礼します。保管番号の確認です。', 'Sorry to trouble you so late. I need to check your space number.'), 3300, who);
    await g.wait(3.7);
    if (ses !== g.session) return;
    // most nights he gets the number wrong; some nights he gets it right (seeded per night)
    const wrongNo = mulberry32(g.save.seed ^ 0x3f3f)() < 0.65;
    const said = wrongNo ? MY_SPACE.slice(0, 2) + MY_SPACE[3] + MY_SPACE[2] : MY_SPACE; // 1017 → 1071
    g.ui.say(L(`……${said}番の方ですね？`, `...You're number ${said}, aren't you?`), 0, who);
    const pick = await this.choose(L(`……${said}番の方ですね？`, `...You're number ${said}, aren't you?`), [
      { id: 'yes', label: L('「はい」', '"Yes."') },
      { id: 'no', label: L(`「いいえ、${MY_SPACE}番です」`, `"No, I'm number ${MY_SPACE}."`) },
      { id: 'silent', label: L('黙っている', 'Say nothing') },
    ], 10, who);
    if (ses !== g.session) return;
    const right = wrongNo ? 'no' : 'yes';
    if (pick === right) {
      g.ui.say(null);
      await g.wait(1.7);
      if (ses !== g.session) return;
      g.ui.say(L('……失礼しました。', '...My apologies.'), 2200, who);
      await g.wait(1.6);
      if (ses !== g.session) return;
      if (c) {
        c.turnTo(Math.PI / 2, 0.9);
        await g.wait(0.9);
        if (ses !== g.session) return;
        c.walkTo([-4.4, 0, EV_Z - 2.5], 3.6);
        this.steps([0.04, 0, EV_Z - 1.82], [-4.4, 0, EV_Z - 2.5], 6, 0.6, 0.8, 0.8);
      }
      a.setDuck(1, 2);
      await g.wait(3.0);
      if (ses !== g.session) return;
      w.dipLamp(4, 0.6);
      g.ui.caption(L('［扉が閉まる］', '[Doors close]')); a.play('elevator_close');
      await w.closeDoors();
      if (ses !== g.session) return;
      if (c) c.root.visible = false;
      g.camOverride = null;
      g.placePlayerPublic(CAR_POS, 0);
      this.setCleared(3);
      const s = g.save; s.currentFloor = 2; s.resumeFloor = 2; s.phase = 'TRANSIT'; g.persist();
      this.active = null;
      g.descend(2);
      return;
    }
    if (pick === 'yes') {
      g.ui.say(L(`……${said}番の方は、もう帰られましたよ。`, `...Number ${said} went home a long time ago.`), 2600, who);
      await g.wait(2.3);
      if (ses !== g.session) return;
      await this.kill(c, L('番号を、偽った。', 'You gave the wrong number.'), { cam: CAR_POS });
      return;
    }
    if (pick === 'no') {
      g.ui.say(L('……いいえ？', '...No?'), 1600, who);
      await g.wait(1.3);
      if (ses !== g.session) return;
      await this.kill(c, L('番号を、偽った。', 'You gave the wrong number.'), { cam: CAR_POS });
      return;
    }
    g.ui.say(L('……番号を。', '...Your number.'), 1600, who);
    await g.wait(1.2);
    if (ses !== g.session) return;
    await this.kill(c, L('答えなかった。', 'You did not answer.'), { cam: CAR_POS });
  }
}

