// GLB (glTF 2.0 binary) loader covering what the 第３駐輪場 assets use:
// triangles, float/uint attributes, indices, morph targets (POSITION/NORMAL),
// metallic-roughness factors, embedded base-colour images, node TRS hierarchy,
// extras, and LINEAR/STEP animations on translation/rotation/scale/weights.
import { Geometry, Material, Mesh, Node, Texture } from './scene';
import type { V3, Q } from './math';

export interface Track {
  node: number;
  path: 'translation' | 'rotation' | 'scale' | 'weights';
  times: Float32Array;
  values: Float32Array;
  stride: number;
  step: boolean;
}
export interface Clip { name: string; duration: number; tracks: Track[] }

interface NodeDesc {
  name: string; t: V3; r: Q; s: V3; mesh: number | null; children: number[]; extras: any; weights: number[] | null;
}

export class ModelTemplate {
  nodes: NodeDesc[];
  meshes: Mesh[];
  roots: number[];
  clips: Clip[];
  materials: Material[];
  constructor(nodes: NodeDesc[], meshes: Mesh[], roots: number[], clips: Clip[], materials: Material[]) {
    this.nodes = nodes; this.meshes = meshes; this.roots = roots; this.clips = clips; this.materials = materials;
  }

  /** Build a fresh node tree (geometry & materials shared unless remapped). */
  instantiate(materialMap?: (m: Material) => Material): ModelInstance {
    const nodes: Node[] = this.nodes.map((d) => {
      const n = new Node(d.name);
      n.position = [...d.t] as V3; n.quaternion = [...d.r] as Q; n.scale = [...d.s] as V3;
      n.extras = d.extras || {};
      if (d.mesh !== null) {
        const src = this.meshes[d.mesh];
        n.mesh = materialMap
          ? new Mesh(src.primitives.map((p) => ({ geometry: p.geometry, material: materialMap(p.material) })), src.targetNames, src.defaultWeights)
          : src;
        if (src.targetNames.length) n.morphWeights = d.weights ? [...d.weights] : [...src.defaultWeights];
      }
      return n;
    });
    this.nodes.forEach((d, i) => { for (const c of d.children) nodes[i].add(nodes[c]); });
    const root = new Node('model');
    for (const r of this.roots) root.add(nodes[r]);
    return new ModelInstance(root, nodes, this.clips);
  }
}

export class ModelInstance {
  root: Node; nodes: Node[]; clips: Clip[];
  constructor(root: Node, nodes: Node[], clips: Clip[]) { this.root = root; this.nodes = nodes; this.clips = clips; }
  node(name: string): Node | null { return this.nodes.find((n) => n.name === name) || null; }
}

const COMP: Record<number, any> = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array, 5122: Int16Array, 5120: Int8Array };
const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

async function decodeImage(bytes: Uint8Array, mime: string): Promise<TexImageSource> {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' } as ImageBitmapOptions);
    } catch {
      try { return await createImageBitmap(blob); } catch { /* fall through */ }
    }
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}

export async function loadGLB(buffer: ArrayBuffer): Promise<ModelTemplate> {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)));
  const binStart = 20 + jsonLen + 8;
  const binLen = dv.getUint32(20 + jsonLen, true);
  const bin = buffer.slice(binStart, binStart + binLen);

  const accessor = (i: number): { data: any; n: number } => {
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    const n = NCOMP[a.type];
    const Ctor = COMP[a.componentType];
    const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const stride = bv.byteStride || 0;
    const elemBytes = Ctor.BYTES_PER_ELEMENT * n;
    if (stride && stride !== elemBytes) {
      const out = new Ctor(a.count * n);
      const src = new DataView(bin);
      for (let k = 0; k < a.count; k++) {
        for (let c = 0; c < n; c++) {
          const o = off + k * stride + c * Ctor.BYTES_PER_ELEMENT;
          out[k * n + c] = Ctor === Float32Array ? src.getFloat32(o, true) : Ctor === Uint16Array ? src.getUint16(o, true) : Ctor === Uint32Array ? src.getUint32(o, true) : src.getUint8(o);
        }
      }
      return { data: out, n };
    }
    // copy so the template owns aligned arrays
    return { data: new Ctor(bin.slice(off, off + a.count * elemBytes)), n };
  };

  // textures
  const images: TexImageSource[] = await Promise.all((json.images || []).map((im: any) => {
    const bv = json.bufferViews[im.bufferView];
    return decodeImage(new Uint8Array(bin, bv.byteOffset || 0, bv.byteLength), im.mimeType || 'image/png');
  }));
  const textures: Texture[] = (json.textures || []).map((t: any) => new Texture(images[t.source]));

  const materials: Material[] = (json.materials || []).map((m: any) => {
    const mat = new Material(m.name || 'mat');
    const pbr = m.pbrMetallicRoughness || {};
    if (pbr.baseColorFactor) mat.color = [...pbr.baseColorFactor] as [number, number, number, number];
    mat.metallic = pbr.metallicFactor ?? 1;
    mat.roughness = pbr.roughnessFactor ?? 1;
    if (pbr.baseColorTexture) mat.map = textures[pbr.baseColorTexture.index];
    if (m.emissiveFactor) mat.emissive = [...m.emissiveFactor] as V3;
    mat.doubleSided = !!m.doubleSided;
    if (m.alphaMode === 'BLEND') mat.transparent = true;
    return mat;
  });
  const defaultMat = new Material('default');

  const meshes: Mesh[] = (json.meshes || []).map((m: any) => {
    const prims = m.primitives.map((p: any) => {
      const pos = accessor(p.attributes.POSITION).data as Float32Array;
      const nrm = p.attributes.NORMAL !== undefined ? accessor(p.attributes.NORMAL).data as Float32Array : new Float32Array(pos.length);
      const uv = p.attributes.TEXCOORD_0 !== undefined ? accessor(p.attributes.TEXCOORD_0).data as Float32Array : null;
      let idx: Uint32Array;
      if (p.indices !== undefined) {
        const raw = accessor(p.indices).data;
        idx = raw instanceof Uint32Array ? raw : Uint32Array.from(raw);
      } else {
        idx = new Uint32Array(pos.length / 3).map((_, i) => i);
      }
      const g = new Geometry(pos, nrm, uv, idx);
      if (p.targets) {
        g.targets = p.targets.map((t: any) => ({
          pos: t.POSITION !== undefined ? accessor(t.POSITION).data : new Float32Array(pos.length),
          nrm: t.NORMAL !== undefined ? accessor(t.NORMAL).data : null,
        }));
        g.computeBounds();
      }
      return { geometry: g, material: p.material !== undefined ? materials[p.material] : defaultMat };
    });
    const names: string[] = m.extras?.targetNames || [];
    const ntargets = m.primitives[0].targets?.length || 0;
    const weights = m.weights || new Array(ntargets).fill(0);
    return new Mesh(prims, names.length ? names : new Array(ntargets).fill('').map((_, i) => `t${i}`), weights);
  });

  const nodes: NodeDesc[] = (json.nodes || []).map((n: any) => ({
    name: n.name || '',
    t: n.translation || [0, 0, 0],
    r: n.rotation || [0, 0, 0, 1],
    s: n.scale || [1, 1, 1],
    mesh: n.mesh ?? null,
    children: n.children || [],
    extras: n.extras || {},
    weights: n.weights || null,
  }));

  const clips: Clip[] = (json.animations || []).map((a: any) => {
    let duration = 0;
    const tracks: Track[] = a.channels.map((c: any) => {
      const s = a.samplers[c.sampler];
      const times = accessor(s.input).data as Float32Array;
      const values = accessor(s.output).data as Float32Array;
      duration = Math.max(duration, times[times.length - 1]);
      const path = c.target.path;
      const stride = path === 'rotation' ? 4 : path === 'weights' ? values.length / times.length : 3;
      return { node: c.target.node, path, times, values, stride, step: s.interpolation === 'STEP' };
    });
    return { name: a.name || 'clip', duration, tracks };
  });

  const scene = json.scenes?.[json.scene || 0];
  const roots: number[] = scene ? scene.nodes : nodes.map((_, i) => i).filter((i) => !nodes.some((n) => n.children.includes(i)));
  return new ModelTemplate(nodes, meshes, roots, clips, materials);
}
