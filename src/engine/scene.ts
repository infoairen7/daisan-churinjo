import {
  type V3, type Q, type M4, m4, m4Compose, m4Mul, m4Perspective, m4Invert, quatRotate, m4TransformPoint,
} from './math';

let geomId = 0;
export class Geometry {
  id = ++geomId;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array | null;
  indices: Uint32Array;
  targets: { pos: Float32Array; nrm: Float32Array | null }[] = [];
  center: V3 = [0, 0, 0];
  radius = 0;
  min: V3 = [0, 0, 0];
  max: V3 = [0, 0, 0];
  // GPU state (owned by renderer)
  vao: WebGLVertexArrayObject | null = null;
  buffers: WebGLBuffer[] = [];

  constructor(positions: Float32Array, normals: Float32Array, uvs: Float32Array | null, indices: Uint32Array) {
    this.positions = positions; this.normals = normals; this.uvs = uvs; this.indices = indices;
    this.computeBounds();
  }

  computeBounds() {
    const p = this.positions;
    const mn: V3 = [Infinity, Infinity, Infinity]; const mx: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) { const v = p[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
    }
    if (p.length === 0) { mn.fill(0); mx.fill(0); }
    this.min = mn; this.max = mx;
    this.center = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    // Morph targets can move vertices; pad a little.
    this.radius = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2 * (this.targets.length ? 1.3 : 1.0);
  }
}

export class Texture {
  source: TexImageSource | null;
  srgb = true;
  clamp = false;
  mipmaps = true;
  version = 1;
  gl: WebGLTexture | null = null;
  glVersion = 0;
  constructor(source: TexImageSource | null) { this.source = source; }
  update() { this.version++; }
}

export class Material {
  name: string;
  color: [number, number, number, number] = [1, 1, 1, 1]; // linear
  map: Texture | null = null;
  metallic = 0;
  roughness = 0.9;
  emissive: V3 = [0, 0, 0];
  emissiveIntensity = 1;
  unlit = false;
  transparent = false;
  additive = false;
  doubleSided = false;
  depthWrite = true;
  depthTest = true;
  fog = true;
  toneMapped = true;
  renderOrder = 0;
  constructor(name = 'mat') { this.name = name; }
  clone(name = this.name): Material {
    const m = new Material(name);
    Object.assign(m, this);
    m.name = name;
    m.color = [...this.color] as [number, number, number, number];
    m.emissive = [...this.emissive] as V3;
    return m;
  }
}

export interface Primitive { geometry: Geometry; material: Material }

export class Mesh {
  primitives: Primitive[];
  targetNames: string[];
  defaultWeights: number[];
  constructor(primitives: Primitive[], targetNames: string[] = [], defaultWeights: number[] = []) {
    this.primitives = primitives; this.targetNames = targetNames; this.defaultWeights = defaultWeights;
  }
}

export class Node {
  name: string;
  position: V3 = [0, 0, 0];
  quaternion: Q = [0, 0, 0, 1];
  scale: V3 = [1, 1, 1];
  children: Node[] = [];
  parent: Node | null = null;
  mesh: Mesh | null = null;
  morphWeights: number[] | null = null;
  visible = true;
  extras: Record<string, any> = {};
  world: M4 = m4();
  local: M4 = m4();
  /** per-node material override (e.g. highlight); applied to every primitive */
  materialOverride: Material | null = null;

  constructor(name = 'node') { this.name = name; }

  add(...nodes: Node[]) {
    for (const n of nodes) { if (n.parent) n.parent.remove(n); n.parent = this; this.children.push(n); }
    return this;
  }
  remove(n: Node) {
    const i = this.children.indexOf(n);
    if (i >= 0) { this.children.splice(i, 1); n.parent = null; }
  }
  clear() { for (const c of this.children) c.parent = null; this.children = []; }
  traverse(fn: (n: Node) => void) { fn(this); for (const c of this.children) c.traverse(fn); }
  find(name: string): Node | null {
    if (this.name === name) return this;
    for (const c of this.children) { const r = c.find(name); if (r) return r; }
    return null;
  }
  updateWorld(parent: M4 | null) {
    m4Compose(this.local, this.position, this.quaternion, this.scale);
    if (parent) m4Mul(this.world, parent, this.local); else this.world.set(this.local);
    for (const c of this.children) c.updateWorld(this.world);
  }
  /** World position (valid after updateWorld). */
  worldPos(): V3 { return [this.world[12], this.world[13], this.world[14]]; }
  localToWorld(p: V3): V3 { return m4TransformPoint(this.world, p); }
}

export class Camera {
  position: V3 = [0, 1.65, 0];
  quaternion: Q = [0, 0, 0, 1];
  fov = 65 * Math.PI / 180;
  near = 0.05;
  far = 80;
  aspect = 1;
  view: M4 = m4();
  proj: M4 = m4();
  viewProj: M4 = m4();
  invViewProj: M4 = m4();
  update() {
    const world = m4Compose(m4(), this.position, this.quaternion, [1, 1, 1]);
    m4Invert(this.view, world);
    m4Perspective(this.proj, this.fov, this.aspect, this.near, this.far);
    m4Mul(this.viewProj, this.proj, this.view);
    m4Invert(this.invViewProj, this.viewProj);
  }
  forward(): V3 { return quatRotate(this.quaternion, [0, 0, -1]); }
  /** Ray through normalised device coords (-1..1). */
  ray(ndcX: number, ndcY: number): { origin: V3; dir: V3 } {
    const a = m4TransformPoint(this.invViewProj, [ndcX, ndcY, -1]);
    const b = m4TransformPoint(this.invViewProj, [ndcX, ndcY, 1]);
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(d[0], d[1], d[2]);
    return { origin: a, dir: [d[0] / l, d[1] / l, d[2] / l] };
  }
}

export interface PointLight { position: V3; color: V3; intensity: number; range: number; enabled: boolean }
export interface SpotLight { position: V3; direction: V3; color: V3; intensity: number; range: number; angle: number; enabled: boolean }

export class Scene {
  root = new Node('scene');
  sky: V3 = [0.02, 0.02, 0.025];
  ground: V3 = [0.01, 0.01, 0.01];
  ambient = 1;
  envSpec = 0.6;
  points: PointLight[] = [];
  spot: SpotLight = { position: [0, 0, 0], direction: [0, 0, -1], color: [1, 0.97, 0.9], intensity: 0, range: 12, angle: 0.5, enabled: false };
  fogColor: V3 = [0.01, 0.01, 0.012];
  fogDensity = 0.04;
  exposure = 1;
  clearColor: V3 = [0, 0, 0];
}

/** Axis-aligned box helper geometry (for procedural walls, plates, hit volumes). */
export function boxGeometry(sx: number, sy: number, sz: number, uvScale = 1): Geometry {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const faces: [V3, V3, V3, number, number][] = [
    // normal, u axis, v axis, u size, v size
    [[1, 0, 0], [0, 0, -1], [0, 1, 0], sz, sy],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0], sz, sy],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1], sx, sz],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1], sx, sz],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0], sx, sy],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0], sx, sy],
  ];
  const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
  for (const [n, u, v, us, vs] of faces) {
    const base = P.length / 3;
    const c: V3 = [n[0] * hx, n[1] * hy, n[2] * hz];
    const hu = us / 2, hv = vs / 2;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      P.push(c[0] + u[0] * a * hu + v[0] * b * hv, c[1] + u[1] * a * hu + v[1] * b * hv, c[2] + u[2] * a * hu + v[2] * b * hv);
      N.push(...n);
      U.push(((a + 1) / 2) * us * uvScale, ((1 - b) / 2) * vs * uvScale);
    }
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return new Geometry(new Float32Array(P), new Float32Array(N), new Float32Array(U), new Uint32Array(I));
}

/** Quad in the XY plane facing +Z, uv (0,0) top-left. */
export function planeGeometry(w: number, h: number): Geometry {
  const hw = w / 2, hh = h / 2;
  return new Geometry(
    new Float32Array([-hw, -hh, 0, hw, -hh, 0, hw, hh, 0, -hw, hh, 0]),
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    new Uint32Array([0, 1, 2, 0, 2, 3]),
  );
}

export function meshNode(name: string, geometry: Geometry, material: Material): Node {
  const n = new Node(name);
  n.mesh = new Mesh([{ geometry, material }]);
  return n;
}

/**
 * Merge many (geometry, world-matrix) pairs that share a material into one geometry.
 * Used for static parked bicycles and racks so each floor stays well under the draw-call budget.
 */
export function mergeGeometries(items: { geometry: Geometry; matrix: M4 }[]): Geometry {
  let vcount = 0, icount = 0;
  for (const it of items) { vcount += it.geometry.positions.length / 3; icount += it.geometry.indices.length; }
  const P = new Float32Array(vcount * 3), N = new Float32Array(vcount * 3), U = new Float32Array(vcount * 2);
  const I = new Uint32Array(icount);
  let vo = 0, io = 0;
  for (const { geometry: g, matrix: m } of items) {
    const n = g.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const x = g.positions[i * 3], y = g.positions[i * 3 + 1], z = g.positions[i * 3 + 2];
      P[(vo + i) * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      P[(vo + i) * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      P[(vo + i) * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      const nx = g.normals[i * 3], ny = g.normals[i * 3 + 1], nz = g.normals[i * 3 + 2];
      // rigid transforms only (rotation + uniform scale), so the upper 3x3 is fine
      let tx = m[0] * nx + m[4] * ny + m[8] * nz, ty = m[1] * nx + m[5] * ny + m[9] * nz, tz = m[2] * nx + m[6] * ny + m[10] * nz;
      const l = Math.hypot(tx, ty, tz) || 1; tx /= l; ty /= l; tz /= l;
      N[(vo + i) * 3] = tx; N[(vo + i) * 3 + 1] = ty; N[(vo + i) * 3 + 2] = tz;
      if (g.uvs) { U[(vo + i) * 2] = g.uvs[i * 2]; U[(vo + i) * 2 + 1] = g.uvs[i * 2 + 1]; }
    }
    for (let k = 0; k < g.indices.length; k++) I[io + k] = g.indices[k] + vo;
    vo += n; io += g.indices.length;
  }
  return new Geometry(P, N, U, I);
}
