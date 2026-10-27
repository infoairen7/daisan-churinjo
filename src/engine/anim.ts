// Keyframe mixer. One action per clip; actions that target the same node property are not
// blended (the caretaker guide forbids overlapping head tracks), the most recently started wins.
import type { Clip, Track, ModelInstance } from './gltf';
import type { Node } from './scene';
import { quatSlerp, type Q } from './math';

export interface PlayOptions {
  loop?: boolean;
  clamp?: boolean; // hold last frame when finished (default true for one-shots)
  speed?: number;
  startAt?: number;
  onFinish?: () => void;
}

export class Action {
  clip: Clip;
  time = 0;
  loop = false;
  clamp = true;
  speed = 1;
  playing = false;
  finished = false;
  order = 0;
  onFinish?: () => void;
  constructor(clip: Clip) { this.clip = clip; }
}

const tmpQ: Q = [0, 0, 0, 1];

function findKey(times: Float32Array, t: number): number {
  // last index i with times[i] <= t
  let lo = 0, hi = times.length - 1;
  if (t <= times[0]) return 0;
  if (t >= times[hi]) return hi;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
  return lo;
}

function sampleTrack(track: Track, node: Node, t: number) {
  const { times, values, stride } = track;
  const i = findKey(times, t);
  const j = Math.min(i + 1, times.length - 1);
  const span = times[j] - times[i];
  const f = track.step || span <= 0 ? 0 : Math.min(1, Math.max(0, (t - times[i]) / span));
  const a = i * stride, b = j * stride;
  if (track.path === 'rotation') {
    const qa: Q = [values[a], values[a + 1], values[a + 2], values[a + 3]];
    const qb: Q = [values[b], values[b + 1], values[b + 2], values[b + 3]];
    quatSlerp(qa, qb, f, tmpQ);
    node.quaternion = [tmpQ[0], tmpQ[1], tmpQ[2], tmpQ[3]];
  } else if (track.path === 'weights') {
    if (!node.morphWeights) node.morphWeights = new Array(stride).fill(0);
    for (let k = 0; k < stride; k++) node.morphWeights[k] = values[a + k] + (values[b + k] - values[a + k]) * f;
  } else {
    const v: [number, number, number] = [
      values[a] + (values[b] - values[a]) * f,
      values[a + 1] + (values[b + 1] - values[a + 1]) * f,
      values[a + 2] + (values[b + 2] - values[a + 2]) * f,
    ];
    if (track.path === 'translation') node.position = v; else node.scale = v;
  }
}

export class Mixer {
  nodes: Node[];
  actions = new Map<string, Action>();
  private counter = 0;
  constructor(instance: ModelInstance) {
    this.nodes = instance.nodes;
    for (const c of instance.clips) this.actions.set(c.name, new Action(c));
  }
  has(name: string) { return this.actions.has(name); }
  duration(name: string) { return this.actions.get(name)?.clip.duration ?? 0; }
  play(name: string, opts: PlayOptions = {}): Action | null {
    const a = this.actions.get(name);
    if (!a) return null;
    a.loop = !!opts.loop;
    a.clamp = opts.clamp ?? true;
    a.speed = opts.speed ?? 1;
    a.time = opts.startAt ?? 0;
    a.playing = true;
    a.finished = false;
    a.onFinish = opts.onFinish;
    a.order = ++this.counter;
    this.apply(a);
    return a;
  }
  stop(name: string) { const a = this.actions.get(name); if (a) { a.playing = false; } }
  stopAll() { for (const a of this.actions.values()) a.playing = false; }
  isPlaying(name: string) { return !!this.actions.get(name)?.playing; }
  /** Pose a clip at a fixed time without leaving it playing. */
  pose(name: string, time: number) {
    const a = this.actions.get(name); if (!a) return;
    a.time = time; this.apply(a);
  }
  private apply(a: Action) {
    for (const tr of a.clip.tracks) {
      const node = this.nodes[tr.node];
      if (node) sampleTrack(tr, node, a.time);
    }
  }
  update(dt: number) {
    const active = [...this.actions.values()].filter((a) => a.playing).sort((p, q) => p.order - q.order);
    for (const a of active) {
      a.time += dt * a.speed;
      const d = a.clip.duration;
      let done = false;
      if (a.time >= d) {
        if (a.loop && d > 0) a.time %= d;
        else { a.time = d; done = true; }
      }
      this.apply(a);
      if (done) {
        a.playing = false;
        a.finished = true;
        const cb = a.onFinish; a.onFinish = undefined;
        cb?.();
      }
    }
  }
}
