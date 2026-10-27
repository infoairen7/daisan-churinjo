// Bedroom (normal ending) scene and caretaker instances (v0.2 expression model).
import type { ModelTemplate, ModelInstance } from '../engine/gltf';
import { Mixer } from '../engine/anim';
import { Scene, Node, Material, boxGeometry, meshNode, planeGeometry } from '../engine/scene';
import { type V3, type Q, quatAxisAngle, quatLookDir, quatSlerp, quatMul, quatRotate, hexLinear, sub, add, scale, len, clamp } from '../engine/math';

export class Caretaker {
  inst: ModelInstance;
  mixer: Mixer;
  root: Node;
  constructor(tpl: ModelTemplate) {
    this.inst = tpl.instantiate();
    this.root = this.inst.root;
    this.mixer = new Mixer(this.inst);
  }
  eyeWorld(): V3 {
    this.root.updateWorld(this.root.parent ? this.root.parent.world : null);
    const n = this.inst.node('EYE_ANCHOR');
    return n ? n.worldPos() : [this.root.position[0], this.root.position[1] + 1.58, this.root.position[2]];
  }
  /** Standing, normal face, blinking. */
  normal() {
    this.mixer.stopAll();
    if (this.mixer.has('reset_normal')) this.mixer.pose('reset_normal', this.mixer.duration('reset_normal'));
    this.mixer.play('normal_blink', { loop: true });
  }
  /** Freeze on the normal face (0.0–0.5 s of the reveal). */
  still() {
    this.mixer.stopAll();
    this.mixer.pose('transform_terror', 0);
  }
  /** Transform once, hold the end pose, then the terror_hold loop. */
  transform(onDone?: () => void) {
    this.mixer.stopAll();
    this.mixer.play('transform_terror', {
      clamp: true,
      onFinish: () => { this.mixer.play('terror_hold', { loop: true }); onDone?.(); },
    });
  }
  /** Seated variant: keep the seated body clip, swap only the face/head clip. */
  transformSeated() {
    this.mixer.stop('normal_blink');
    this.mixer.play('transform_terror', { clamp: true, onFinish: () => this.mixer.play('terror_hold', { loop: true }) });
  }
  seated() {
    this.mixer.stopAll();
    // seated_breathe drives torso/legs; normal_blink drives the face — compatible per CLAUDE_REPLACEMENT.md
    this.mixer.play('seated_breathe', { loop: true });
    this.mixer.play('normal_blink', { loop: true });
  }
  // ---------------------------------------------------------------- the pounce (procedural, layered on the clips)
  armReach = 0; // 0..1 arms raised toward the camera
  twitch = 0; // 0..1 head jitter
  exaggerate = 0; // extra terror morph beyond 1.0 (0..0.4)
  private lungeS: { t: number; dur: number; from: V3; to: V3; baseQ: Q; rise: number; lean: number; onDone?: () => void } | null = null;
  private headBase: Q | null = null;

  /** Throw the body at `to` (world) in `dur` seconds: accelerating, leaning in, arms out. */
  lunge(to: V3, dur: number, opts: { rise?: number; lean?: number; onDone?: () => void } = {}) {
    this.lungeS = { t: 0, dur, from: [...this.root.position] as V3, to, baseQ: [...this.root.quaternion] as Q, rise: opts.rise ?? 0.08, lean: opts.lean ?? 0.42, onDone: opts.onDone };
  }
  /** Leap so the eyes end `dist` metres in front of `cam`, face to the lens (the body leaves the floor). */
  pounceAt(cam: V3, dur: number, opts: { dist?: number; lean?: number; rise?: number; onDone?: () => void } = {}) {
    const lean = opts.lean ?? 0.2, dist = opts.dist ?? 0.32;
    const r0 = [...this.root.position] as V3;
    const e0 = this.eyeWorld();
    const toCam = sub(cam, e0);
    const L = len(toCam) || 1;
    const eyeTo = add(e0, scale(toCam, Math.max(0, L - dist) / L));
    const q0 = this.root.quaternion as Q;
    const local = quatRotate([-q0[0], -q0[1], -q0[2], q0[3]], sub(e0, r0));
    const off = quatRotate(quatMul(q0, quatAxisAngle([1, 0, 0], -lean)), local);
    this.lunge(sub(eyeTo, off), dur, { rise: opts.rise ?? 0.06, lean, onDone: opts.onDone });
  }
  get lunging() { return !!this.lungeS; }
  resetPose() { this.armReach = 0; this.twitch = 0; this.exaggerate = 0; this.lungeS = null; this.headBase = null; }

  update(dt: number) {
    const head = this.inst.node('head');
    if (head && this.headBase) head.quaternion = this.headBase; // undo last frame's jitter
    this.mixer.update(dt);
    const L = this.lungeS;
    if (L) {
      L.t += dt;
      const k = clamp(L.t / L.dur, 0, 1);
      const e = k * k * (2.2 - 1.2 * k); // fast acceleration, slight settle at the very end
      this.root.position = [L.from[0] + (L.to[0] - L.from[0]) * e, L.from[1] + (L.to[1] - L.from[1]) * e + L.rise * Math.sin(k * Math.PI), L.from[2] + (L.to[2] - L.from[2]) * e];
      this.root.quaternion = quatMul(L.baseQ, quatAxisAngle([1, 0, 0], -L.lean * Math.min(1, k * 1.4)));
      this.armReach = Math.max(this.armReach, Math.min(1, k * 1.8));
      this.twitch = Math.max(this.twitch, k);
      if (k >= 1) { const cb = L.onDone; this.lungeS = null; cb?.(); }
    }
    // arms: shoulders swing forward and slightly out, elbows bend
    if (this.armReach > 0) {
      const r = this.armReach;
      for (const [name, side] of [['shoulder_L', -1], ['shoulder_R', 1]] as const) {
        const n = this.inst.node(name);
        if (n) n.quaternion = quatMul(quatAxisAngle([1, 0, 0], r * 1.38), quatAxisAngle([0, 0, 1], side * r * 0.18));
      }
      for (const name of ['elbow_L', 'elbow_R']) { const n = this.inst.node(name); if (n) n.quaternion = quatAxisAngle([1, 0, 0], r * 0.42); }
    }
    // head jitter (restored next frame, so it never accumulates)
    if (head) {
      this.headBase = [...head.quaternion] as Q;
      if (this.twitch > 0) {
        const a = 0.09 * this.twitch;
        head.quaternion = quatMul(head.quaternion, quatMul(quatAxisAngle([1, 0, 0], (Math.random() - 0.5) * a), quatAxisAngle([0, 0, 1], (Math.random() - 0.5) * a * 1.4)));
      }
    }
    // push the terror morph past its authored maximum while a face clip drives it
    if (this.exaggerate > 0 && (this.mixer.isPlaying('terror_hold') || this.mixer.isPlaying('transform_terror'))) {
      for (const n of this.inst.nodes) {
        if (!n.morphWeights || !n.mesh) continue;
        const ti = n.mesh.targetNames.indexOf('terror');
        if (ti >= 0) n.morphWeights[ti] = Math.min(1 + this.exaggerate, n.morphWeights[ti] * (1 + this.exaggerate));
      }
    }
  }
}

export class Bedroom {
  scene = new Scene();
  wake: V3 = [-0.65, 0.72, -0.7];
  lookAtCaretaker: V3 = [0.65, 1.14, -0.6];
  caretaker: Caretaker | null = null;
  qCeiling: Q;
  qCaretaker: Q;
  t = 0; // 0 = looking at the ceiling, 1 = looking at the caretaker
  constructor(roomTpl: ModelTemplate) {
    const room = roomTpl.instantiate();
    this.scene.root.add(room.root);
    const wake = room.node('WAKE_CAMERA');
    if (wake) {
      this.wake = [...wake.position] as V3;
      if (wake.extras?.lookAt) this.lookAtCaretaker = wake.extras.lookAt as V3;
    }
    const concrete = roomTpl.materials.find((m) => m.name === 'concrete')!;
    const ceiling = meshNode('ceiling', boxGeometry(3.3, 0.08, 3.7), concrete); ceiling.position = [0, 2.64, 0];
    const south = meshNode('south', boxGeometry(3.2, 2.6, 0.08), concrete); south.position = [0, 1.3, 1.84];
    const doorMat = roomTpl.materials.find((m) => m.name === 'wood')!;
    const door = meshNode('door', boxGeometry(0.85, 2.0, 0.04), doorMat); door.position = [1.0, 1.0, 1.79];
    // moonlight through the curtains
    const win = new Material('window_glow'); win.unlit = true; win.color = [0.05, 0.07, 0.11, 1];
    const wp = meshNode('win', planeGeometry(1.08, 1.6), win); wp.position = [0.7, 1.55, -1.775];
    this.scene.root.add(ceiling, south, door, wp);
    for (const n of room.nodes) for (const p of n.mesh?.primitives || []) if (p.material.name === 'lamp') p.material.emissiveIntensity = 0.6;
    this.scene.sky = hexLinear('#1c2333').map((v) => v * 0.5) as V3;
    this.scene.ground = hexLinear('#141214').map((v) => v * 0.4) as V3;
    this.scene.fogDensity = 0.02;
    this.scene.points.push(
      { position: [0.7, 1.7, -1.3], color: hexLinear('#8da6c8'), intensity: 1.2, range: 4.5, enabled: true },
      { position: [-1.27, 0.85, -0.8], color: hexLinear('#E9B96E'), intensity: 0.55, range: 3.0, enabled: true },
      { position: [0.2, 2.2, 0.6], color: hexLinear('#c9c2b8'), intensity: 0.35, range: 4, enabled: true },
    );
    // supine: looking at the ceiling, screen-top toward the feet so "right" turns toward +X (the chair)
    this.qCeiling = quatLookDir([0.05, 1, 0.12], [0, 0, 1]);
    this.qCaretaker = quatLookDir(sub(this.lookAtCaretaker, this.wake));
  }
  setCaretaker(c: Caretaker, roomTplSeat: { pos: V3; rotY: number }) {
    this.caretaker = c;
    c.root.position = roomTplSeat.pos;
    c.root.quaternion = quatAxisAngle([0, 1, 0], roomTplSeat.rotY);
    this.scene.root.add(c.root);
    c.seated();
    // aim at the real eye anchor once seated
    c.update(0.001);
    const eye = c.eyeWorld();
    this.qCaretaker = quatLookDir(sub(eye, this.wake));
  }
  cameraQuat(): Q { return quatSlerp(this.qCeiling, this.qCaretaker, this.t); }
}
